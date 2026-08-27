/**
 * fileBrowser store — 模块 #1
 * 管理当前根目录 + 相对当前路径 + 条目列表 + loading/error
 *
 * v0.1.0-module1.12+: 加 `lastFetchedPath` 锁住"列表 base path"语义.
 * 区别于 `currentPath` (导航目标):
 *   - currentPath: 已被 navigate() 更新, 但 entries 还在拉取中
 *   - lastFetchedPath: 当前 entries 的实际生成路径 (反映用户看到列表时的状态)
 *
 * v0.1.0-module1.22: 升维度 — sortField/viewMode 上提 (搬 FileList 内嵌),
 *   selectedPaths/anchorPath (多选 anchor), searchQuery (搜索 query).
 *   持久化: sortField/sortAscending/viewMode → settings store (fb_sort_* / fb_view_mode).
 *   hideFinished 从 FileBrowser.vue 搬入 store, 跟 sortField 一组持久化.
 */
import { defineStore } from 'pinia';
import { computed, ref, triggerRef } from 'vue';
import { listen } from '@tauri-apps/api/event';
import {
  listDirectory,
  listAccounts,
  beginArchiveSession,
  prepareArchive,
  unlockArchive,
  commitArchiveOpen,
  cancelArchivePrepare,
} from '@/lib/tauri';
import type {
  AccountItem,
  ArchiveAccessError,
  ArchiveAccessMode,
  ArchiveRequestId,
} from '@/lib/tauri';
import { log } from '@/lib/logger';
import { sortEntries, type SortField } from '@/lib/fileSort';
import { getSetting, setSetting } from '@/lib/tauri';
import { useDirectorySortStore } from '@/stores/directorySort';
import { useShortcutsStore } from '@/stores/shortcuts';
import { validateSourceRelativePath } from '@/lib/relativePath';
import type {
  ArchiveFormat,
  MediaEntry,
  SourceDescriptor,
  SourceDescriptorArchive,
  SourceDescriptorLocal,
} from '@/lib/sourceDescriptor';

export type FileBrowserError =
  | { kind: 'notFound'; message: string }
  | { kind: 'permissionDenied'; message: string }
  | { kind: 'io'; message: string };

// v0.1.0-module3.0.5-masonry (阶段 B / B4): 收窄为 details | masonry.
// 老值 list/grid 仅用于历史持久化兼容 (loadLayout fallback → details).
// UI 彻底清理 (删 grid/list 分支 + ViewModeDropdown) 留 E2-E4.
export type ViewMode = 'details' | 'masonry';

// ─── v0.1.0-module3.0.10: likes「浏览」跳转意图（一次性）───
// Likes.vue 点「浏览」→ requestOpenLocation + push('/')；FileBrowser.onMounted
// 在 loadLayout 之后 consume（spec §4.3：消费点后置让 setViewMode('masonry')
// 不被 loadLayout 读到的旧持久化值覆盖）。
// module3.2.0：rootPath 形态 → descriptor 形态（远程源浏览跳瀑布流，spec rev5 §3.2；
// Likes 是唯一 caller，直接换签名不留兼容）。
export interface PendingOpenLocation {
  descriptor: SourceDescriptor;
  relPath: string;
}

// ─── M3 任务 7 + 任务 12: 远程 archive 物化进度（archive://progress 事件载荷）───
// 后端 materializer.rs 统一类型化 emit：{ requestId, progressKey, relPath,
// downloaded, totalBytes, phase }（phase: "downloading" / "ready"）。
// 任务 12 双分支匹配：候选事件（requestId ≠ null）只认 pending 的 requestId；
// 已进入后的后台物化/预载事件固定 requestId=null，只认 Ready 保存的 opaque
// progressKey（不由前端派生 cacheKey）。
export interface ArchiveProgressPayload {
  requestId: ArchiveRequestId | null;
  progressKey: string;
  relPath: string;
  downloaded: number;
  totalBytes: number;
  phase: string;
}

// ─── 任务 12: 事务式 archive 打开的候选/请求类型 ───
/** prepare 成功前的候选导航（纯数据，不碰任何导航 ref） */
export interface ArchiveCandidate {
  descriptor: SourceDescriptorArchive;
  parent: { descriptor: SourceDescriptor; relPath: string };
  entryName: string;
}

/** 已注册到后端的候选请求（携带 epoch 竞态防护 + requestId 关联 id） */
export interface PendingArchiveOpen extends ArchiveCandidate {
  epoch: number;
  requestId: ArchiveRequestId;
}

// ─── v0.1.0-module3.0.4-virtuallist Phase 3 ───
// FileList 组件实例方法 scrollToPath 通过模块级 callback 注册机制反向传给 store.
// FileBrowser 在 onMounted 调 setScrollToIndexCallback(fileListRef.scrollToPath).
// 模块级 (非 store 字段): 因为 callback 是 Vue 组件实例方法, store 不能持有 ref;
// 跨 store 实例共享, 单实例 (实际不会多 FileList 同时挂载 — YAGNI).
let scrollToIndexCallback:
  | ((i: number, opts?: { align?: 'start' | 'center' | 'end' }) => void)
  | null = null;

export function setScrollToIndexCallback(
  cb: typeof scrollToIndexCallback,
): void {
  scrollToIndexCallback = cb;
}

// ─── 路径身份修复 (2026-08-12): 异步导航身份防护 (spec §6.5) ───
// fetch 是异步的, 跨 root/跨目录的多个并发请求可能乱序返回.
// 仅最新请求（id 最大）可提交 entries/lastFetchedPath/error/loading；
// 过期请求（setRoot 切换、新 navigate 触发）的回写被丢弃，避免不同 root/path 的
// entries 与路径状态混合。setRoot(null) 也要失效在途请求。
let fetchRequestId = 0;

// ─── 任务 12: 事务式 archive 打开的模块级纯函数 ───

/** requestId 身份比较：sessionId + sequence 两字段相等（不得用对象引用 / relPath 替代） */
function sameArchiveRequestId(a: ArchiveRequestId | null, b: ArchiveRequestId | null): boolean {
  if (!a || !b) return false;
  return a.sessionId === b.sessionId && a.sequence === b.sequence;
}

const ARCHIVE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'passwordRequired', 'wrongPassword', 'unsupportedCodec', 'multiVolumeUnsupported',
  'corruptArchive', 'emptyArchive', 'resourceLimitExceeded', 'entryNotFound',
  'remoteRangeUnavailable', 'cancelled', 'invalidRequest', 'io', 'network', 'timeout',
]);

/** 只接受 IPC 结构化 kind/message；未知值收敛为 { kind: 'io' }，不解析错误字符串 */
function normalizeArchiveAccessError(cause: unknown): ArchiveAccessError {
  if (typeof cause === 'object' && cause !== null) {
    const kind = (cause as { kind?: unknown }).kind;
    if (typeof kind === 'string' && ARCHIVE_ERROR_KINDS.has(kind)) {
      const message = (cause as { message?: unknown }).message;
      const base = { kind: kind as ArchiveAccessError['kind'] };
      return typeof message === 'string' ? { ...base, message } : base;
    }
  }
  return { kind: 'io' };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/** 远程相对路径拼接（module3.5.0 后续）：segments 归一（\ → /、去空段）后 '/' 连接。
 *  供「将当前目录设为根目录」拼接 SMB initialPath / WebDAV path 用。 */
function joinRemoteRel(base: string, rel: string): string {
  return [...base.split(/[\\/]+/), ...rel.split(/[\\/]+/)].filter(Boolean).join('/');
}

export const useFileBrowserStore = defineStore('fileBrowser', () => {
  const rootPath = ref<string | null>(null);
  const currentPath = ref<string>('');
  const lastFetchedPath = ref<string>('');
  // module3.2.0: 当前数据源 descriptor。null = Local 语义（rootPath 兜底构造 Local
  // descriptor），非 null = 跨源打开（WebDAV 浏览跳转 / ZIP 条目视图）置入。
  // fetch 一律经 activeDescriptor() 取源，普通 Local 流程零迁移成本。
  const currentDescriptor = ref<SourceDescriptor | null>(null);
  // v0.1.0-module3.0.3-hotfix (Bug 2): 保存「进入 reader 前」的导航上下文.
  // ReaderView 退出时调 restoreNavigationContext, FileBrowser.onMounted 优先恢复.
  // 取代之前的「每次 onMounted 都 setRoot(LAST_ROOT_KEY) 抹掉 currentPath」反模式.
  const savedNavigationContext = ref<{ rootPath: string; currentPath: string } | null>(null);
  // module3.2.0（spec §3.3）：ZIP 条目视图的进入前上下文（exitArchive 恢复）
  // M3 任务 7（spec §6.2）：形态从 { rootPath, path } 升级为 { descriptor, relPath } —
  // Local 与远程源通用；exitArchive 按 descriptor.type 分流恢复。唯一 caller 为 openArchive/exitArchive。
  const archiveParent = ref<{ descriptor: SourceDescriptor; relPath: string } | null>(null);
  // M3 任务 7：远程 archive 物化下载进度（null = 无进度数据，indeterminate 兜底展示）。
  // openArchive/exitArchive 时清空；监听在消费组件 onMounted 挂（startArchiveProgressListener）。
  const archiveProgress = ref<{ downloaded: number; total: number } | null>(null);
  const entries = ref<MediaEntry[]>([]);
  const loading = ref(false);
  const error = ref<FileBrowserError | null>(null);

  // v0.1.0-module1.22: 升维度
  const sortField = ref<SortField>('name');
  const sortAscending = ref<boolean>(true);
  // v0.1.0-module3.0: per-folder 排序覆盖的 effective 值（directorySort override 或 fallback）
  const effectiveSortField = ref<SortField>('name');
  const effectiveSortAscending = ref<boolean>(true);
  const viewMode = ref<ViewMode>('details');
  const hideFinished = ref<boolean>(false);  // 从 FileBrowser.vue 搬入
  const selectedPaths = ref<Set<string>>(new Set());
  const anchorPath = ref<string | null>(null);
  const searchQuery = ref<string>('');

  function toDescriptor(root: string): SourceDescriptorLocal {
    return { type: 'local', rootPath: root };
  }

  /** fetch 实际使用的数据源：currentDescriptor 优先，Local 兜底（rootPath）。 */
  function activeDescriptor(): SourceDescriptor | null {
    if (currentDescriptor.value) return currentDescriptor.value;
    return rootPath.value !== null ? toDescriptor(rootPath.value) : null;
  }

  /** 当前是否已有可浏览数据源；远程 descriptor 不依赖本地 rootPath。 */
  const hasActiveSource = computed(() => activeDescriptor() !== null);

  /** module3.2.0: 四类源打开指定目录（跨源浏览跳转/ZIP 进入共用）。
   *  Local → setRoot（rootPath 语义复用）；非 Local → currentDescriptor 置入后走同一取数链。 */
  async function openDescriptorAt(descriptor: SourceDescriptor, relPath: string): Promise<void> {
    const relCheck = validateSourceRelativePath(relPath);
    if (!relCheck.ok) {
      log('[fileBrowser] openDescriptorAt relPath 越界, 拒绝打开', { relPath, reason: relCheck.reason });
      error.value = { kind: 'io', message: '路径越出数据源根' };
      return;
    }
    if (descriptor.type === 'local') {
      await setRoot(descriptor.rootPath);
      if (relCheck.normalized) {
        await navigate(relCheck.normalized);
      }
      return;
    }
    // 非 Local：置入 descriptor（navigate → fetch → activeDescriptor 取该源）。
    // spec §6.1：跨源打开视为离开——非 Local 分支无 setRoot/navigate 入口，必须
    // 在此显式失效在途压缩包事务（Local 分支经 setRoot 守卫空过不双重取消）。
    invalidatePendingArchiveOnNavigate();
    currentDescriptor.value = descriptor;
    clearSelection(); // 旧目录选区不带入新源（对齐 setRoot 语义）
    if (relCheck.normalized) {
      await navigate(relCheck.normalized);
    } else {
      currentPath.value = '';
      searchQuery.value = '';
      await fetch('');
    }
  }

  /**
   * 校验 source-relative path（路径身份修复 2026-08-12）。
   * 合法返回 normalized 串；非法返回 null 并记 log + 设 error。
   * 调用方拿到 null 应中止导航（不改 currentPath、不发 IPC）。
   *
   * 绝对路径只允许出现在 rootPath；navigate/up/fetch 接收的 path 必须相对 root。
   * 根目录 '' 合法。拒绝盘符 / 绝对 / UNC / .. 遍历 / NUL。
   */
  function assertRelPath(input: string): string | null {
    const r = validateSourceRelativePath(input);
    if (r.ok) return r.normalized;
    log('[fileBrowser] 路径越出数据源根, 拒绝导航', { input, reason: r.reason });
    error.value = { kind: 'io', message: '路径越出数据源根' };
    return null;
  }

  async function fetch(path: string): Promise<void> {
    const descriptor = activeDescriptor();
    if (descriptor === null) return;
    // 路径身份修复: IPC 前最后一道校验。非法路径不发 listDirectory。
    const normPath = assertRelPath(path);
    if (normPath === null) return;
    // 异步身份防护: 捕获本次请求 id, await 后校验是否仍为最新。
    const myId = ++fetchRequestId;
    loading.value = true;
    error.value = null;
    log('[fileBrowser] fetch', { rootPath: rootPath.value, path: normPath });
    try {
      const result = await listDirectory(descriptor, normPath);
      // 过期请求（setRoot/navigate 触发了更新的请求）→ 丢弃回写，不动 entries/state。
      if (myId !== fetchRequestId) {
        log('[fileBrowser] fetch stale, discard', { myId, latest: fetchRequestId });
        return;
      }
      log('[fileBrowser] listDirectory returned', result.length, 'entries');

      // v0.1.0-module3.0: per-folder 排序覆盖 → fallback 到 settings 默认
      const dsStore = useDirectorySortStore();
      const override = await dsStore.resolve(descriptor, normPath).catch(() => null);
      // 第二次 await 后再次校验（resolve 期间也可能有新请求插入）。
      if (myId !== fetchRequestId) {
        log('[fileBrowser] fetch stale (after resolve), discard', { myId, latest: fetchRequestId });
        return;
      }
      effectiveSortField.value = (override?.sortField as SortField) ?? sortField.value;
      effectiveSortAscending.value = override?.ascending ?? sortAscending.value;

      entries.value = result;
      lastFetchedPath.value = normPath;
      // browse_history 仅在 reader 真正打开时记录（useReaderActions.readNow），
      // 单纯文件夹浏览不写——避免根目录被默认加进去。
    } catch (e) {
      if (myId !== fetchRequestId) return; // 过期请求的错误也不回写
      const msg = e instanceof Error ? e.message : String(e);
      log('[fileBrowser] fetch error', msg);
      error.value = { kind: 'io', message: msg };
    } finally {
      // 仅最新请求负责清 loading（过期请求不清，避免清掉新请求的 loading）。
      if (myId === fetchRequestId) {
        loading.value = false;
      }
    }
  }


  async function setRoot(root: string | null): Promise<void> {
    // spec §6.1：换根视为离开——先失效在途压缩包打开事务（防迟到 commit 劫持导航）。
    invalidatePendingArchiveOnNavigate();
    // 异步身份防护: 切 root 必失效所有在途请求（spec §6.5）。
    // setRoot(null) 不调 fetch, 必须显式 ++ 让旧请求 await 后判 stale 丢弃。
    ++fetchRequestId;
    rootPath.value = root;
    currentPath.value = '';
    lastFetchedPath.value = '';
    entries.value = [];
    error.value = null;
    currentDescriptor.value = null; // 回 Local 语义（rootPath 兜底）
    clearSelection();
    searchQuery.value = ''; // v0.1.0-module3.0.3: 换目录清空搜索 (对齐 PV)
    if (root !== null) {
      await fetch('');
    }
  }

  async function navigate(path: string): Promise<void> {
    // 路径身份修复: 校验失败不改 currentPath、不发 IPC。
    const normPath = assertRelPath(path);
    if (normPath === null) return;
    // spec §6.1：候选物化期间的页内导航 → 推进 epoch 并取消（迟到 ready 不提交导航）。
    invalidatePendingArchiveOnNavigate();
    currentPath.value = normPath;
    searchQuery.value = ''; // v0.1.0-module3.0.3: 换目录清空搜索 (对齐 PV)
    await fetch(normPath);
  }

  async function refresh(): Promise<void> {
    await fetch(currentPath.value);
  }

  async function up(): Promise<void> {
    // spec §6.1：up 同为页内导航——先失效在途压缩包事务（顶层 exitArchive 路径空过）。
    invalidatePendingArchiveOnNavigate();
    if (currentPath.value === '') {
      // module3.2.0（spec §3.3）：ZIP 条目视图在顶层再向上 = 退出压缩包
      if (archiveParent.value) {
        await exitArchive();
      }
      return;
    }
    const parts = currentPath.value.split(/[\\/]/).filter(Boolean);
    parts.pop();
    const parent = parts.join('/');
    // 路径身份修复: 防御性校验（up 结果理论上必合法，但 currentPath 可能被历史污染）。
    const normParent = assertRelPath(parent);
    if (normParent === null) return;
    currentPath.value = normParent;
    await fetch(normParent);
  }

  // ─── module3.5.0 后续: 远程会话「将当前目录设为根目录」───
  // 选根菜单（PickRootMenu）在 SMB/WebDAV 会话进入子目录后提供把当前目录提升为
  // 浏览根的入口——与本地选根同级语义（up() 作用域 / 跨重启记忆 / displayRoot 锚点）。
  // 注意：提升改变 (descriptor, relPath) 身份拆分方式，同一物理目录经不同根浏览会
  // 得到不同 library/progress 身份——与本地换根的既有语义一致（根 = 用户圈定作用域）。
  const canSetRootHere = computed(() => {
    const d = currentDescriptor.value;
    return !!d && (d.type === 'smb' || d.type === 'webdav') && currentPath.value !== '';
  });

  /** 把当前目录提升为浏览根。SMB 空 initialPath（share 根形态）必须查账户表补
   *  share 首段（契约：initialPath 首段 === share，直接拼 currentPath 会越权报错）；
   *  WebDAV 无 share 契约，直接拼 path。成功后 currentPath 归零重新取数。
   *  @returns 是否成功（账户已删 / 无 share / 非远程会话 / 停在根 = false） */
  async function setCurrentDirAsRoot(): Promise<boolean> {
    const d = currentDescriptor.value;
    if (!d || currentPath.value === '') return false;
    if (d.type === 'smb') {
      let base = d.initialPath;
      if (!base) {
        const accts = await listAccounts().catch(() => [] as AccountItem[]);
        const acct = accts.find((a) => a.id === d.accountId);
        const share = acct?.share?.trim();
        if (!share) {
          log('[fileBrowser] setCurrentDirAsRoot: 账户缺失或无 share，无法提升', { accountId: d.accountId });
          return false;
        }
        base = share;
      }
      await openDescriptorAt({ ...d, initialPath: joinRemoteRel(base, currentPath.value), path: '' }, '');
      return true;
    }
    if (d.type === 'webdav') {
      await openDescriptorAt({ ...d, path: joinRemoteRel(d.path, currentPath.value) }, '');
      return true;
    }
    return false;
  }

  // ─── module3.2.0（spec §3.3）+ M3 任务 7 + 任务 12: 压缩包事务式进入/退出 ───
  // 任务 12 契约：prepare 成功 → 前端原子提交导航 → commitArchiveOpen 才启动后台
  // 物化/预载；取消/失败恢复原状态（候选期间不碰任何导航 ref）。

  const pendingArchivePassword = ref<PendingArchiveOpen | null>(null);
  const pendingArchiveOpen = ref<PendingArchiveOpen | null>(null);
  const archiveOpening = ref(false);
  const archiveAccessMode = ref<ArchiveAccessMode | null>(null);
  const archiveProgressKey = ref<string | null>(null);
  const archiveOpenError = ref<ArchiveAccessError | null>(null);
  const archiveCommitPendingId = ref<ArchiveRequestId | null>(null);
  /** 替换旧打开的取消 IPC 在途（openArchive 清空三 ref → await cancel 的窗口）：
   *  窗口内导航守卫看不到任何 pending（epoch 已 ++ 但新请求未注册），不补此标记
   *  会让「取消返回 → 新请求 commitArchive」覆盖用户刚完成的导航（复审 P1-3） */
  const archiveSupersedeInFlight = ref(false);
  let archiveOpenEpoch = 0;
  let archiveSessionId = crypto.randomUUID();
  let archiveBootMs = Date.now(); // 页面代次：store 创建时捕获一次，随 begin 上报防旧 WebView 迟到 begin 反夺
  let archiveRequestSequence = 0;
  let archiveSessionReady: Promise<void> | null = null;

  async function ensureArchiveSession(): Promise<void> {
    archiveSessionReady ??= ensureArchiveSessionOnce().catch((cause) => {
      archiveSessionReady = null; // 初始化 IPC 恢复后允许下一次 open 重试
      throw cause;
    });
    await archiveSessionReady;
  }

  async function ensureArchiveSessionOnce(): Promise<void> {
    let effectiveBootMs = await beginArchiveSession(archiveSessionId, archiveBootMs);
    if (effectiveBootMs > archiveBootMs) {
      // 本页面 boot 已过期（Date.now() 非严格单调：时钟回拨后重载等已知场景）。
      // 换新 UUID、以生效代次 + 1 重试一次——恢复路径，不会与正常 reload 的死者 begin 竞争。
      archiveBootMs = effectiveBootMs + 1;
      archiveSessionId = crypto.randomUUID();
      effectiveBootMs = await beginArchiveSession(archiveSessionId, archiveBootMs);
      if (effectiveBootMs > archiveBootMs) {
        throw { kind: 'invalidRequest', message: 'archive session generation conflict' };
      }
    }
  }

  /** 把 Local/WebDAV/SMB descriptor 构造收拢为纯数据候选（不写任何 ref）。
   *  远程分支只认 webdav/smb——在 archive 条目视图里再开压缩包（ZIP 内 ZIP）时
   *  activeDescriptor 是 archive descriptor，走本地形态构造（name 直拼）。 */
  function buildArchiveCandidate(entry: MediaEntry): ArchiveCandidate {
    const dir = currentPath.value;
    const relInside = dir ? `${dir}/${entry.name}` : entry.name;
    const active = activeDescriptor();
    if (active && (active.type === 'webdav' || active.type === 'smb')) {
      // 远程源（M3 spec §6.2 rev2 统一）：虚拟 archivePath——WebDAV=URL 形态 /
      // SMB=`smb://{accountId}/{initialPath}/{rel}` 可读虚拟形态（非真 UNC：descriptor
      // 不含 host，host 查表太重且虚拟路径零解析消费方，仅展示与身份用）
      const origin = active;
      const virtualPath = origin.type === 'webdav'
        ? `${origin.baseUrl.replace(/\/+$/, '')}/${relInside}`
        : `smb://${origin.accountId}/${origin.initialPath ? origin.initialPath + '/' : ''}${relInside}`;
      return {
        descriptor: {
          type: 'archive', archivePath: virtualPath, entryPrefix: '',
          format: archiveFormatOf(entry.name),
          origin, originEntryPath: relInside, archiveRelPath: relInside,
        },
        parent: { descriptor: origin, relPath: dir },
        entryName: entry.name,
      };
    }
    // 本地源（module3.2.0 现状，零回归）
    // ⚠ 仅非 archive 会话可达：archive 条目视图内 currentPath 是包内相对路径，
    // 拼 rootPath 会产出假绝对路径（目录列表由后端 catalog 只列图片，压着不可达）。
    // 未来放行非图片条目时须改为 descriptor 感知的 rel 构造（module3.5.3 spec §2.H）。
    const root = rootPath.value ?? '';
    // entry.path 只是相对当前目录的文件名（local.rs:97），join root+dir+name 拼绝对路径
    const abs = [root, dir, entry.name]
      .filter((s) => s.length > 0)
      .join('/')
      .replace(/\\/g, '/');
    return {
      descriptor: {
        type: 'archive', archivePath: abs, entryPrefix: '',
        format: archiveFormatOf(entry.name),
      },
      parent: { descriptor: { type: 'local', rootPath: root }, relPath: dir },
      entryName: entry.name,
    };
  }

  /** prepare/unlock Ready 后的原子导航提交（唯一写入口） */
  function commitArchive(
    candidate: PendingArchiveOpen,
    mode: ArchiveAccessMode,
    progressKey: string | null,
  ): void {
    archiveParent.value = candidate.parent;
    currentDescriptor.value = candidate.descriptor;
    currentPath.value = '';
    searchQuery.value = '';
    archiveAccessMode.value = mode;
    archiveProgressKey.value = progressKey;
  }

  function recordArchiveDiagnostic(scope: string, cause: unknown): void {
    log(`[fileBrowser] ${scope} failed`, cause instanceof Error ? cause.message : String(cause));
  }

  /** 原子摘走在途压缩包打开事务（候选 / 密码弹窗 / commit-pending 任一形态）：
   *  推进 epoch 使迟到 ready/unlock/commit 因 epoch 失配全部丢弃，并 best-effort
   *  通知后端取消 Prepared（rejection 必须被捕获，不产生 unhandled promise）。
   *  cancelArchivePassword / cancelArchiveOpen / exitArchive 与导航失效守卫共用。 */
  function takeAndCancelPendingArchiveOpen(scope: string): void {
    const requestId = pendingArchiveOpen.value?.requestId
      ?? pendingArchivePassword.value?.requestId
      ?? archiveCommitPendingId.value;
    archiveOpenEpoch += 1;
    pendingArchiveOpen.value = null;
    pendingArchivePassword.value = null;
    archiveCommitPendingId.value = null;
    archiveOpening.value = false;
    archiveProgress.value = null;
    archiveProgressKey.value = null;
    archiveOpenError.value = null; // module3.5.3 任务 B：exitArchive/导航取消路径同步清残留错误
    if (requestId) {
      void cancelArchivePrepare(requestId).catch((cause) =>
        recordArchiveDiagnostic(scope, cause));
    }
  }

  /** spec §6.1 触发器补全：候选物化期间（远程 RAR/7z 下载，秒到分钟级）页内导航
   *  （navigate / up / setRoot / openDescriptorAt）视为离开——推进 epoch 并取消，
   *  防迟到 ready 无条件 commitArchive 覆写 currentDescriptor/currentPath（导航劫持）。
   *  无在途事务时空过；exitArchive 先清空再走 navigate/openDescriptorAt，路径天然空过。 */
  function invalidatePendingArchiveOnNavigate(): void {
    archiveOpenError.value = null; // module3.5.3 任务 B：上次打开失败的横幅不得跨导航残留
    if (
      pendingArchiveOpen.value === null
      && pendingArchivePassword.value === null
      && archiveCommitPendingId.value === null
      && !archiveSupersedeInFlight.value
    ) return;
    takeAndCancelPendingArchiveOpen('cancelNavigatedAwayArchive');
  }

  /** 打开压缩包：事务式进入条目视图。本地源 archivePath 绝对路径（rev2 §3.3）；
   *  远程源（M3 物化链）构造 origin descriptor + 虚拟 archivePath。
   *  本函数自身不 reject——一切失败落入 archiveOpenError（双击 handler 零泄漏）。 */
  async function openArchive(entry: MediaEntry): Promise<void> {
    archiveProgress.value = null;
    archiveOpenError.value = null;
    const epoch = ++archiveOpenEpoch;
    // 同步摘走旧 id；先完成 best-effort cancel，才允许新 request 注册。
    const supersededId = pendingArchiveOpen.value?.requestId
      ?? pendingArchivePassword.value?.requestId
      ?? archiveCommitPendingId.value;
    pendingArchiveOpen.value = null;
    pendingArchivePassword.value = null;
    archiveCommitPendingId.value = null;
    if (supersededId) {
      // 过渡标记覆盖 await 窗口：三个 pending ref 已清空而新请求未注册——
      // 此间导航必须仍能推进 epoch 使新请求整体失效（deferred-cancel）
      archiveSupersedeInFlight.value = true;
      try {
        await cancelArchivePrepare(supersededId).catch((cause) =>
          recordArchiveDiagnostic('cancelSupersededArchive', cause));
      } finally {
        archiveSupersedeInFlight.value = false;
      }
    }
    if (epoch !== archiveOpenEpoch) return;
    archiveOpening.value = true;
    // 同步注册候选：vi.waitFor 首检在微任务 flush 之前执行，若首个 await 之后才置
    // pendingArchiveOpen，`?.requestId` 类断言会对 null vacuous 通过。requestId 先用
    // 当前 session id 构造（provisional）；下方 ensureArchiveSession 若发生回拨换代，
    // 在 prepare 之前用最终 session id 重建（Rust 只见过最终 id）。
    const candidate: PendingArchiveOpen = {
      ...buildArchiveCandidate(entry),
      epoch,
      requestId: { sessionId: archiveSessionId, sequence: ++archiveRequestSequence },
    };
    pendingArchiveOpen.value = candidate;
    try {
      // session 初始化必须最先发生，且与 prepare 同处一个 try：begin IPC 失败要落入
      // archiveOpenError（经 archiveSessionReady 重置后，下一次 open 重试），不得从
      // 双击/click handler 泄漏 rejection。回拨恢复可能在此替换 archiveSessionId
      //（换新 UUID），requestId 必须在恢复之后用最终 session id 构造——顺序颠倒会让
      // prepare 携带已作废的旧 UUID，被 Rust 当作旧 session 的迟到请求拒绝。
      await ensureArchiveSession();
      if (epoch !== archiveOpenEpoch) return;
      if (candidate.requestId.sessionId !== archiveSessionId) {
        candidate.requestId = { sessionId: archiveSessionId, sequence: candidate.requestId.sequence };
        pendingArchiveOpen.value = candidate;
      }
      const result = await prepareArchive(candidate.descriptor, candidate.requestId);
      if (epoch !== archiveOpenEpoch) return;
      if (result.status === 'passwordRequired') {
        pendingArchivePassword.value = candidate;
        return;
      }
      commitArchive(candidate, result.accessMode, result.progressKey);
      // 先提交本地导航，再用同一 id 做有界幂等握手；失败不回滚导航。
      archiveCommitPendingId.value = candidate.requestId;
      await commitArchiveOpenWithCleanup(candidate.requestId, epoch);
      await fetch('');
    } catch (cause) {
      if (epoch !== archiveOpenEpoch) return;
      const error = normalizeArchiveAccessError(cause);
      if (error.kind !== 'cancelled') archiveOpenError.value = error;
    } finally {
      if (epoch === archiveOpenEpoch) {
        pendingArchiveOpen.value = null;
        archiveOpening.value = false;
      }
    }
  }

  /** commit 有界幂等握手：同一 id 最多 3 次（0/25/75ms 退避）；每次退避苏醒、
   *  发送 IPC 前复核 epoch。永久失败 best-effort cancel Prepared 并回收
   *  archiveProgressKey（后台物化已不存在，迟到 key 事件不再被接受）。 */
  async function commitArchiveOpenWithCleanup(
    requestId: ArchiveRequestId,
    epoch: number,
  ): Promise<void> {
    const backoffMs = [0, 25, 75] as const;
    for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
      if (epoch !== archiveOpenEpoch) break;
      if (backoffMs[attempt] > 0) {
        await delay(backoffMs[attempt]);
        // 退避苏醒后必须复核 epoch：等待期间的新 open/取消/退出已 cancel 该 id，
        // 而后端对已 commit id 的 cancel 是 no-op——迟到 commit 会把已取消的 Prepared
        // 变成无法停止的后台预载。失效请求直接跳出循环进入 cancel 清理。
        if (epoch !== archiveOpenEpoch) break;
      }
      try {
        await commitArchiveOpen(requestId);
        if (sameArchiveRequestId(archiveCommitPendingId.value, requestId)) {
          archiveCommitPendingId.value = null;
        }
        return;
      } catch (cause) {
        recordArchiveDiagnostic('commitArchiveOpen', cause);
      }
    }
    await cancelArchivePrepare(requestId).catch((cause) =>
      recordArchiveDiagnostic('cancelUncommittedArchive', cause));
    if (sameArchiveRequestId(archiveCommitPendingId.value, requestId)) {
      archiveCommitPendingId.value = null;
      // 后台物化已取消：回收 progressKey，迟到 key 事件不再把 UI 推入"后台缓存中"。
      archiveProgressKey.value = null;
    }
  }

  /** 密码弹窗提交：unlock 成功（epoch 仍为当前值）→ 同一提交流程；
   *  wrongPassword 向弹窗抛出且不清 pending；其他错误写 archiveOpenError。 */
  async function submitArchivePassword(password: string): Promise<void> {
    const candidate = pendingArchivePassword.value;
    if (!candidate) return;
    try {
      const result = await unlockArchive(candidate.descriptor, password, candidate.requestId);
      if (candidate.epoch !== archiveOpenEpoch) return;
      if (result.status === 'passwordRequired') {
        pendingArchivePassword.value = candidate;
        return;
      }
      pendingArchivePassword.value = null;
      commitArchive(candidate, result.accessMode, result.progressKey);
      archiveCommitPendingId.value = candidate.requestId;
      await commitArchiveOpenWithCleanup(candidate.requestId, candidate.epoch);
      await fetch('');
    } catch (cause) {
      const error = normalizeArchiveAccessError(cause);
      if (error.kind === 'wrongPassword') throw error;
      if (candidate.epoch === archiveOpenEpoch) {
        pendingArchivePassword.value = null;
        archiveOpenError.value = error;
      }
    }
  }

  /** 密码弹窗取消：保存 requestId → 推进 epoch → 清 pending/opening/progress →
   *  best-effort cancel（rejection 必须被捕获，不产生 unhandled promise）。 */
  function cancelArchivePassword(): void {
    takeAndCancelPendingArchiveOpen('cancelArchivePassword');
  }

  /** 打开事务取消（候选/commit-pending 阶段的「取消」按钮）：恢复原状态。 */
  function cancelArchiveOpen(): void {
    takeAndCancelPendingArchiveOpen('cancelArchiveOpen');
  }

  /** 退出压缩包：恢复进入前目录（Local=rootPath+navigate；远程=openDescriptorAt 复用）。
   *  同样取消 pending / commit-pending 的 Prepared，并清 accessMode/progressKey。 */
  async function exitArchive(): Promise<void> {
    takeAndCancelPendingArchiveOpen('cancelExitArchive');
    archiveAccessMode.value = null;
    const parent = archiveParent.value;
    archiveParent.value = null;
    currentDescriptor.value = null; // 回 activeDescriptor 的 rootPath 兜底（Local）
    if (!parent) return;
    if (parent.descriptor.type === 'local') {
      rootPath.value = parent.descriptor.rootPath;
      await navigate(parent.relPath);
    } else {
      await openDescriptorAt(parent.descriptor, parent.relPath);
    }
  }

  // ─── M3 任务 7 + 任务 12: archive://progress 监听（消费组件 onMounted 挂一次）───
  let archiveProgressAttached = false;

  /** 挂 archive://progress 事件监听（幂等，app 生命周期一次）。
   *  happy-dom / 普通浏览器环境无 __TAURI_INTERNALS__，listen() reject — 静默
   *  （3.0.8 useMasonryThumbnails 同款防御）。
   *  任务 12 双分支：候选事件只接受与 pending requestId 两字段相等的事件（同路径
   *  取消后重开的旧事件必须被拒绝——不得用 relPath / 对象引用 / 闭包 epoch 替代
   *  后端关联 id）；进入后的后台物化事件固定 requestId=null，只以 Ready 保存的
   *  opaque archiveProgressKey 匹配，不由前端派生 cacheKey，不与候选进度共用分支。
   *  phase === 'ready' 且匹配 → 清 archiveProgress（防陈旧数字残留）。 */
  function startArchiveProgressListener(): void {
    if (archiveProgressAttached) return;
    archiveProgressAttached = true;
    void listen<ArchiveProgressPayload>('archive://progress', (event) => {
      const p = event.payload;
      const rid = p.requestId ?? null;
      if (rid !== null) {
        const pending = pendingArchiveOpen.value;
        if (!pending || !sameArchiveRequestId(rid, pending.requestId)) return;
      } else {
        if (archiveProgressKey.value === null || p.progressKey !== archiveProgressKey.value) return;
      }
      if (p.phase === 'ready') {
        archiveProgress.value = null;
        return;
      }
      archiveProgress.value = {
        downloaded: p.downloaded,
        total: p.totalBytes,
      };
    }).catch(() => {
      // 非 Tauri 环境预期失败；重置标志允许消费组件下次挂载重试（Tauri 下零成本）
      archiveProgressAttached = false;
    });
  }

  function archiveFormatOf(name: string): ArchiveFormat {
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'zip';
    return (['cbz', 'cbr', 'zip', 'rar', '7z'] as const).includes(ext as ArchiveFormat)
      ? ext as ArchiveFormat
      : 'zip';
  }

  // ─── v0.1.0-module3.0.3-hotfix (Bug 2): 导航上下文保存/恢复 ───
  // useReaderActions.readNow/readFromImage 在 router.push 前调 saveNavigationContext
  // 记下 (rootPath, currentPath); FileBrowser.onMounted / ReaderView 退出时调
  // restoreNavigationContext 把上下文还原. 返回 true = 成功恢复, false = 无上下文.

  function saveNavigationContext(): void {
    // 远程/压缩包会话：rootPath 是陈旧 Local 值（openDescriptorAt 不动它），不能
    // 作为恢复身份——跳过保存。远程浏览状态由 Pinia 会话内存保留（FileBrowser
    // 重挂载 hasActiveSource 守卫不再重置）；压缩包条目视图由 archiveParent 恢复链负责。
    const d = currentDescriptor.value;
    if (d && d.type !== 'local') return;
    if (rootPath.value === null) return;
    savedNavigationContext.value = {
      rootPath: rootPath.value,
      currentPath: currentPath.value,
    };
    log('[fileBrowser] saveNavigationContext', savedNavigationContext.value);
  }

  async function restoreNavigationContext(): Promise<boolean> {
    const ctx = savedNavigationContext.value;
    if (!ctx) return false;
    savedNavigationContext.value = null;
    log('[fileBrowser] restoreNavigationContext', ctx);
    // 路径身份修复: 恢复的 currentPath 校验；非法（被污染的绝对路径）则停在 root。
    if (rootPath.value !== ctx.rootPath) {
      await setRoot(ctx.rootPath);
    }
    const normPath = assertRelPath(ctx.currentPath);
    if (normPath === null) return true; // root 已恢复，currentPath 非法则留在根目录
    if (normPath) {
      await navigate(normPath);
    }
    return true;
  }

  // ─── v0.1.0-module3.0.10: likes「浏览」跳转意图（一次性）───
  // 类型 PendingOpenLocation 定义在模块顶层（函数体内不允许 export 声明）。
  const pendingOpenLocation = ref<PendingOpenLocation | null>(null);

  function requestOpenLocation(descriptor: SourceDescriptor, relPath: string): void {
    pendingOpenLocation.value = { descriptor, relPath };
    // 显式新意图取代两类陈旧导航意图（spec 审查必须修复项）：
    // 1. reader 残留的 savedNavigationContext —— 否则本跳转 early-return 跳过
    //    restoreNavigationContext 后旧上下文滞留 store，下次挂载 '/' 会把用户拽回旧目录
    savedNavigationContext.value = null;
    // 2. shortcuts.activeId —— lastOpenedShortcutId 是 FileBrowser 组件局部变量，
    //    重挂载即重置失效；不清 activeId 的话离开再回 '/' 会重放旧快捷方式
    useShortcutsStore().clearActive();
  }

  function consumePendingOpenLocation(): PendingOpenLocation | null {
    const p = pendingOpenLocation.value;
    pendingOpenLocation.value = null;
    return p;
  }

  // ─── v0.1.0-module1.22: sort/viewMode/hideFinished actions ──

  function setSortField(f: SortField): void {
    if (sortField.value === f) {
      // 同字段 → toggle 方向
      sortAscending.value = !sortAscending.value;
    } else {
      sortField.value = f;
    }
    persist('fb_sort_field', sortField.value);
    persist('fb_sort_ascending', sortAscending.value ? '1' : '0');
    effectiveSortField.value = f;
    effectiveSortAscending.value = sortAscending.value;

    // v0.1.0-module3.0: 写 per-folder override（Android DirectorySortRepository.setSort）
    if (rootPath.value !== null) {
      const descriptor = toDescriptor(rootPath.value);
      const dsStore = useDirectorySortStore();
      void dsStore.set(descriptor, currentPath.value, {
        sortField: f,
        ascending: sortAscending.value,
      });
    }
  }

  function toggleSortOrder(): void {
    sortAscending.value = !sortAscending.value;
    persist('fb_sort_ascending', sortAscending.value ? '1' : '0');
    effectiveSortAscending.value = sortAscending.value;
    if (rootPath.value !== null) {
      const descriptor = toDescriptor(rootPath.value);
      const dsStore = useDirectorySortStore();
      void dsStore.set(descriptor, currentPath.value, {
        sortField: sortField.value,
        ascending: sortAscending.value,
      });
    }
  }

  function setViewMode(m: ViewMode): void {
    viewMode.value = m;
    persist('fb_view_mode', m);
  }

  function setHideFinished(v: boolean): void {
    hideFinished.value = v;
    persist('fb_hide_finished', v ? '1' : '0');
  }

  /** 加载持久化的 sort/viewMode/hideFinished (启动时从 FileBrowser onMounted 调) */
  async function loadLayout(): Promise<void> {
    const [field, asc, vm, hf] = await Promise.all([
      getSetting('fb_sort_field'),
      getSetting('fb_sort_ascending'),
      getSetting('fb_view_mode'),
      getSetting('fb_hide_finished'),
    ]);
    if (field === 'name' || field === 'modifiedAt' || field === 'size') {
      sortField.value = field;
    }
    if (asc === '0') sortAscending.value = false;
    if (vm === 'masonry') {
      viewMode.value = 'masonry';
    } else if (vm === 'list' || vm === 'grid') {
      // v0.1.0-module3.0.5-masonry (阶段 B / B4): 老持久化值 fallback 到 details.
      viewMode.value = 'details';
    }
    if (hf === '1') hideFinished.value = true;
  }

  async function persist(key: string, value: string): Promise<void> {
    try {
      await setSetting(key, value);
    } catch {
      // silent
    }
  }

  // ─── v0.1.0-module1.22: selection actions ──

  /**
   * 统一入口: 单击/Ctrl+Click/Shift+Click 都走这里.
   * @param event - 用于判断 modifier; 键盘事件可传合成 MouseEvent
   */
  function selectFile(entry: MediaEntry, event: MouseEvent | KeyboardEvent): void {
    const path = entry.path;
    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd+Click: toggle
      toggleSelection(path);
    } else if (event.shiftKey && anchorPath.value !== null) {
      // Shift+Click: 从 anchor 到当前的范围
      selectRange(anchorPath.value, path);
    } else {
      // 普通单击: 重置为单选
      replaceSelection(path);
    }
    anchorPath.value = path;
  }

  function toggleSelection(path: string): void {
    // v0.1.0-module3.0.4-virtuallist Phase 1: in-place + triggerRef.
    // 旧实现 `selectedPaths.value = new Set(...)` 每次 O(n) 拷贝, Ctrl+Click
    // 连续 add/remove 大选中累积 O(n²). 改 in-place delete/add + triggerRef:
    // - 引用保持不变 (依赖者用 refBefore === fb.selectedPaths 仍 true)
    // - Vue 响应式: triggerRef 强制通知依赖的 computed (selectedCount,
    //   selectedEntries, selectionSizeBytes), 因为 Set 是 raw (非 reactive())
    //   的, mutator 不会自动触发 ref-level deps.
    const set = selectedPaths.value;
    if (set.has(path)) set.delete(path);
    else set.add(path);
    triggerRef(selectedPaths);
  }

  function replaceSelection(path: string): void {
    selectedPaths.value = new Set([path]);
  }

  function selectRange(from: string, to: string): void {
    const i = pathIndex.value.get(from);
    const j = pathIndex.value.get(to);
    if (i === undefined || j === undefined) return;
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    const next = new Set<string>();
    for (let k = lo; k <= hi; k++) next.add(sortedEntries.value[k].path);
    selectedPaths.value = next;
  }

  function clearSelection(): void {
    selectedPaths.value = new Set();
    anchorPath.value = null;
  }

  /** 右键未选中项时清空旧选中并单选该项（Windows 资源管理器风格）。 */
  function selectSingle(entry: MediaEntry): void {
    selectedPaths.value = new Set([entry.path]);
    anchorPath.value = entry.path;
  }

  function selectAll(): void {
    selectedPaths.value = new Set(sortedEntries.value.map((e) => e.path));
  }

  function setSearchQuery(q: string): void {
    searchQuery.value = q;
  }

  // ─── v0.1.0-module3.0.4-virtuallist Phase 3: scrollToPath action ───
  // 用 pathIndex O(1) 找 index, 再调 scrollToIndexCallback(index, opts).
  // 没注册 callback / 路径不在 entries → no-op (FileList 未挂 / 已删条目场景安全).
  function scrollToPath(
    path: string,
    opts?: { align?: 'start' | 'center' | 'end' },
  ): void {
    if (!scrollToIndexCallback) return;
    const i = pathIndex.value.get(path);
    if (i === undefined) return;
    scrollToIndexCallback(i, opts);
  }

  // ─── v0.1.0-module1.22: computed ──

  const sortedEntries = computed<MediaEntry[]>(() =>
    sortEntries(entries.value, effectiveSortField.value, effectiveSortAscending.value),
  );

  // ─── v0.1.0-module3.0.4-virtuallist Phase 1 ───
  // selectRange 用 O(1) path→index Map 替代原 O(n) sorted.indexOf × 2.
  // 14949 entries 时 Shift+Click 从 ~30ms 降到 < 0.1ms.
  // computed 派生 sortedEntries — 排序变化时自动同步, 无需手动 invalidate.
  const pathIndex = computed<Map<string, number>>(() => {
    const m = new Map<string, number>();
    sortedEntries.value.forEach((e, i) => m.set(e.path, i));
    return m;
  });

  const selectedEntries = computed<MediaEntry[]>(() =>
    sortedEntries.value.filter((e) => selectedPaths.value.has(e.path)),
  );

  const selectedCount = computed<number>(() => selectedPaths.value.size);

  const selectionSizeBytes = computed<number>(() =>
    selectedEntries.value
      .filter((e) => !e.isDirectory)
      .reduce((s, e) => s + e.size, 0),
  );

  // v0.1.0-module3.0.3-hotfix: 删 visibleEntries 空壳 (注释说过滤但没实现,
  // 且 marks 在 readStatus store, 这里拿不到). 过滤改由 FileBrowser.displayedEntries 组合.

  return {
    // 状态
    rootPath,
    currentPath,
    lastFetchedPath,
    currentDescriptor,
    archiveParent,
    entries,
    loading,
    error,
    sortField,
    sortAscending,
    viewMode,
    hideFinished,
    effectiveSortField,
    effectiveSortAscending,
    selectedPaths,
    anchorPath,
    searchQuery,
    // 原有 actions
    setRoot,
    navigate,
    refresh,
    up,
    // module3.2.0: 四类源取数/打开
    activeDescriptor,
    hasActiveSource,
    openDescriptorAt,
    // module3.5.0 后续: 远程会话提升当前目录为根
    canSetRootHere,
    setCurrentDirAsRoot,
    // module3.2.0（spec §3.3）: ZIP 进入/退出
    openArchive,
    exitArchive,
    // M3 任务 7: 远程 archive 物化进度
    archiveProgress,
    startArchiveProgressListener,
    // 任务 12: 事务式 archive 打开状态/actions（Task 13 组件经这些公开成员访问）
    pendingArchiveOpen,
    pendingArchivePassword,
    archiveCommitPendingId,
    archiveOpening,
    archiveAccessMode,
    archiveProgressKey,
    archiveOpenError,
    submitArchivePassword,
    cancelArchivePassword,
    cancelArchiveOpen,
    // v0.1.0-module3.0.3-hotfix (Bug 2): 导航上下文保存/恢复
    saveNavigationContext,
    restoreNavigationContext,
    // v0.1.0-module3.0.10: likes「浏览」跳转意图（一次性）
    pendingOpenLocation,
    requestOpenLocation,
    consumePendingOpenLocation,
    // sort/viewMode/hideFinished
    setSortField,
    toggleSortOrder,
    setViewMode,
    setHideFinished,
    loadLayout,
    // selection
    selectFile,
    toggleSelection,
    replaceSelection,
    selectRange,
    clearSelection,
    selectSingle,
    selectAll,
    setSearchQuery,
    // v0.1.0-module3.0.4-virtuallist Phase 3: scrollToPath action (回调到 FileList 实例)
    scrollToPath,
    // computed
    sortedEntries,
    pathIndex,
    selectedEntries,
    selectedCount,
    selectionSizeBytes,
  };
});
