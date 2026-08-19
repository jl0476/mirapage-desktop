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
import { listDirectory } from '@/lib/tauri';
import { log } from '@/lib/logger';
import { sortEntries, type SortField } from '@/lib/fileSort';
import { getSetting, setSetting } from '@/lib/tauri';
import { useDirectorySortStore } from '@/stores/directorySort';
import { useShortcutsStore } from '@/stores/shortcuts';
import { validateSourceRelativePath } from '@/lib/relativePath';
import type { MediaEntry, SourceDescriptor, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

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
    // 非 Local：置入 descriptor（navigate → fetch → activeDescriptor 取该源）
    currentDescriptor.value = descriptor;
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
    currentPath.value = normPath;
    searchQuery.value = ''; // v0.1.0-module3.0.3: 换目录清空搜索 (对齐 PV)
    await fetch(normPath);
  }

  async function refresh(): Promise<void> {
    await fetch(currentPath.value);
  }

  async function up(): Promise<void> {
    if (currentPath.value === '') return;
    const parts = currentPath.value.split(/[\\/]/).filter(Boolean);
    parts.pop();
    const parent = parts.join('/');
    // 路径身份修复: 防御性校验（up 结果理论上必合法，但 currentPath 可能被历史污染）。
    const normParent = assertRelPath(parent);
    if (normParent === null) return;
    currentPath.value = normParent;
    await fetch(normParent);
  }

  // ─── v0.1.0-module3.0.3-hotfix (Bug 2): 导航上下文保存/恢复 ───
  // useReaderActions.readNow/readFromImage 在 router.push 前调 saveNavigationContext
  // 记下 (rootPath, currentPath); FileBrowser.onMounted / ReaderView 退出时调
  // restoreNavigationContext 把上下文还原. 返回 true = 成功恢复, false = 无上下文.

  function saveNavigationContext(): void {
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
    openDescriptorAt,
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
