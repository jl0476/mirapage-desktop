<script setup lang="ts">
/**
 * FileBrowser.vue — 模块 #1 主屏
 *
 * v0.1.0-module1.22: 全面重构 —
 *  - 排 / 视图 / 选中 / hideFinished 状态全在 store, FileBrowser 只消费
 *  - 原生 <select> 全部替换为 Xplorer 风格 dropdown (ShortcutDropdown / SortDropdown / ViewModeDropdown)
 *  - 单击接 store.selectFile (Ctrl/Shift 多选), 双击 emit open
 *  - 集成 StatusBar (3 段式) + EntryDetailPanel (1 选中时显示)
 *  - FileList 接收 sortedEntries (不再内部 sort)
 *
 * v0.1.0-module2.0: 触发阅读 / 加入书库 —
 *  - 移除双击 emit open (双击只进目录)
 *  - 选中目录后启用 toolbar 「立即阅读」按钮
 *  - EntryDetailPanel 显示 3 个 CTA: 立即阅读 / 加入书库 / 下载全部 (stub)
 *  - 右键菜单 (RowContextMenu) 加 立即阅读 / 加入书库 项
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getSetting, setSetting } from '@/lib/tauri';
import { useFileBrowserStore, setScrollToIndexCallback } from '@/stores/fileBrowser';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useReadStatusStore } from '@/stores/readStatus';
import { useSettingsStore } from '@/stores/settings';
import { useReaderActions } from '@/composables/useReaderActions';
import { useMasonrySettings } from '@/composables/useMasonrySettings';
import { useToast } from '@/composables/useToast';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import { findNextVolume } from '@/lib/tauri';
import FileList from './FileList.vue';
import Breadcrumb from './Breadcrumb.vue';
import RowContextMenu from './RowContextMenu.vue';
import SortDropdown from './SortDropdown.vue';
import ShortcutDropdown from './ShortcutDropdown.vue';
import SearchInput from './SearchInput.vue';
import StatusBar from './StatusBar.vue';
import EntryDetailPanel from './EntryDetailPanel.vue';
import MasonrySettingsPopup from './MasonrySettingsPopup.vue';
// v0.1.0-module3.0.7-masonry: 视图切换按钮用 SVG 资产 (v-html 渲染, 保留 fill +
// viewBox 0 0 1024 1024 原貌). 资产文件位于 src/icons/, 与 src-tauri/icons/
// 设计源镜像 (后者不进 IPC, 仅为 Tauri 打包资源).
import ICON_DETAILS_SVG from '@/icons/详情列表_view-list.svg?raw';
import ICON_MASONRY_SVG from '@/icons/瀑布流.svg?raw';
import type { MediaEntry, SourceDescriptor, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

const { t } = useI18n();
const fb = useFileBrowserStore();
const shortcuts = useShortcutsStore();
const readStatus = useReadStatusStore();
const settings = useSettingsStore();
const readerActions = useReaderActions({
  resolveRootPath: () => fb.rootPath ?? '',
  buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath }),
  // v0.1.0-module3.0.3-hotfix2: 用 lastFetchedPath 而非 currentPath.
  // fileBrowser store 中:
  //   - currentPath: navigate() 同步更新 (用户在视觉上"想去"的位置)
  //   - lastFetchedPath: fetch 成功后更新 (entries 真正来源, = entry.path 的基准)
  // 之前用 currentPath 在 race condition 下出错 (双击 260715 触发 navigate → currentPath
  // 立即变 output/260715, 但 fetch 9613 文件期间 entries 仍是 output/; 用户在 1.7s
  // 内点立即阅读, entry.path='260715' (相对 output/) 拼上 currentPath='output/260715'
  // → absPath='output/260715/260715' 错位). 用 lastFetchedPath 避免此竞争.
  getLastFetchedPath: () => fb.lastFetchedPath || fb.rootPath || '',
  // ensureBookId 用 lastFetchedPath (entry.path 的基准) + entry.path 拼出 absPath
  getCurrentPath: () => fb.lastFetchedPath,
  // v0.1.0-module3.0.3-hotfix (Bug 2): reader 退出时恢复 currentPath.
  // 注意: 这里仍用 currentPath (= 用户想去的位置), 不是 lastFetchedPath.
  // 退出时如果 fetch 已成功, 两者一致; 若 fetch 在 navigate 后失败, 恢复 currentPath
  // 会让 FileBrowser 重 fetch (用户主动选择的目录).
  saveNavigationContext: () => fb.saveNavigationContext(),
  onLibraryChanged: async () => {
    await readStatus.refresh();
  },
});

const showSaveDialog = ref(false);
const saveLabel = ref('');
// 右键菜单状态
const ctxMenu = ref<{ entry?: MediaEntry | null; entries?: MediaEntry[] | null; x: number; y: number } | null>(null);

// v0.1.0-module3.0.4-virtuallist Task 3.4: FileList ref 绑定, 拿 scrollToPath expose.
// onMounted 注册 setScrollToIndexCallback, 让 fb.scrollToPath(path) 能滚到 FileList 对应行.
const fileListRef = ref<InstanceType<typeof FileList> | null>(null);

/**
 * v0.1.0-module3.0.3-hotfix (Bug: 隐藏已读完失效) — displayedEntries
 * 之前 store.visibleEntries 是空壳 (注释说过滤, 实现没过滤), 且模板用 fb.sortedEntries.
 * marks 在 readStatus store (不在 fileBrowser store), 所以过滤放这里组合三者.
 * 判定与 FileList.markFor 一致: marks key 以 `|${entry.path}` 结尾且 value==='finished'.
 *
 * v0.1.0-module3.0.4-virtuallist Task 1.4: 合并 hideFinished + searchQuery 为单次循环.
 * 之前: sort → filter(hideFinished) → filter(searchQuery) 三次 O(n) 遍历 + 三次数组分配.
 * 之后: sort → single loop (一次遍历 + 一次分配, 仅当 filter 启用).
 * fast path (!q && !hide) 直接返回 sortedEntries 引用, 避免 Vue computed 重算触发下游.
 * isFinished 走 Task 1.3 的 finishedSet O(1).
 */
const displayedEntries = computed<MediaEntry[]>(() => {
  const sorted = fb.sortedEntries;
  const q = fb.searchQuery.trim().toLowerCase();
  const hide = fb.hideFinished;
  // fast path: 两个 filter 都没启用 → 保持 sortedEntries 引用
  if (!q && !hide) return sorted;
  // single loop: 同时判断 hideFinished + searchQuery
  const result: MediaEntry[] = [];
  for (const e of sorted) {
    if (hide && readStatus.isFinished(e)) continue;
    if (q && !e.name.toLowerCase().includes(q)) continue;
    result.push(e);
  }
  return result;
});

// 1 选中时显示详情面板
const selectedEntry = computed<MediaEntry | null>(() => {
  if (fb.selectedPaths.size !== 1) return null;
  const path = [...fb.selectedPaths][0];
  return fb.sortedEntries.find((e) => e.path === path) ?? null;
});

const canSave = computed(() => fb.rootPath !== null);
const canUp = computed(() => fb.currentPath !== '');

// v0.1.0-module3.0.5-masonry (阶段 E2): 瀑布流视图的 source descriptor
// (MasonryView 需要 descriptor 才能 prefetch image dimensions via Rust IPC)
// Phase 1 只 Local; SMB/WebDAV descriptor 留 Phase 7-8 扩展.
const masonryDescriptor = computed<SourceDescriptorLocal>(() => ({
  type: 'local',
  rootPath: fb.rootPath || '',
}));

// v0.1.0-module3.0.5-masonry (阶段 E3): 工具栏图标按钮 + ⚙ popup 状态 +
// per-folder masonryParams resolve. 首次切到 masonry 用全局默认值, resolve 完成后更新.
const masonrySettings = useMasonrySettings(settings);
const masonryPopupOpen = ref(false);
const masonryParams = ref({
  colCount: settings.masonryDefaultCols,
  hGap: settings.masonryDefaultHGap,
  vGap: settings.masonryDefaultVGap,
});

// 当前目录是否有图片（masonry 守卫）
const hasImages = computed(() => fb.sortedEntries.some((e) => isImage(e.name)));

// v0.1.0-module3.0.8 (任务 10): 全序列图片名（不受 UI 过滤影响）
// 派生 fb.sortedEntries → 过滤图片 → name[]，按 sortedEntries 顺序（dir-first 自然顺序）。
// 传给 FileList → MasonryView，作为 useMasonryBrowsePosition.canonicalImageNames，
// 用于 topmostImage page 索引（filtered images.indexOf 不准 — 目录过滤时偏移）。
const canonicalImageNames = computed(() =>
  fb.sortedEntries.filter((e) => isImage(e.name)).map((e) => e.name),
);

// 进无图目录且当前是 masonry → 回落 details
watch([() => fb.viewMode, hasImages], ([mode, has]) => {
  if (mode === 'masonry' && !has) {
    fb.setViewMode('details');
  }
});

// 切到 masonry 或进新目录时 resolve per-folder 参数
watch([() => fb.viewMode, () => fb.currentPath], async ([mode]) => {
  if (mode === 'masonry' && fb.rootPath) {
    const desc = { type: 'local' as const, rootPath: fb.rootPath };
    masonryParams.value = await masonrySettings.resolve(desc, fb.currentPath);
  }
});

function onMasonryChange(partial: { colCount?: number; hGap?: number; vGap?: number }) {
  masonryParams.value = { ...masonryParams.value, ...partial };
  if (!fb.rootPath) return;
  const desc = { type: 'local' as const, rootPath: fb.rootPath };
  masonrySettings.set(desc, fb.currentPath, partial);
}
function onMasonryPopupClose() {
  masonryPopupOpen.value = false;
}

// v0.1.0-module3.0.6 UX: 详情面板默认不弹, 工具栏"属性"按钮按需唤起。
// 切视图/目录时自动关闭, 避免下次进入残留状态。
const showDetail = ref(false);
watch(() => fb.viewMode, () => { showDetail.value = false; });
watch(() => fb.currentPath, () => { showDetail.value = false; });
// v0.1.0-...: 切视图时刷 readStatus — 瀑布流滚动写了 progress 但 marks 没刷新,
// 切到详情视图时 readStatus 还是旧数据. 调 refresh 让 marks 立即反映当前状态.
watch(() => fb.viewMode, () => { void readStatus.refresh(); });
function toggleDetail() {
  showDetail.value = !showDetail.value;
}

/**
 * v0.1.0-module3.0.3: StatusBar 左段文案.
 * 始终按 displayedEntries 计数 (含 hideFinished + searchQuery 过滤后), 保证与列表行数一致.
 * 搜索态显示 "找到 N 项", 非搜索态显示 "N 项".
 */
const statusBarItemsText = computed(() => {
  const count = displayedEntries.value.length;
  if (fb.searchQuery) {
    return t('fileBrowser.searchResults', { count });
  }
  return t('fileBrowser.statusBar.items', { count });
});

/** 当前路径: rootPath + '/' + currentPath (空时仅 rootPath). 统一 '/' 分隔符 (Windows rootPath 用 \, 项目 path.ts 用 /, 显示统一) */
const displayPath = computed(() => {
  if (!fb.rootPath) return '';
  // 统一用 '/' 显示 — Windows / Unix 都接受, 对齐 path.ts crumbs() 实现
  const root = fb.rootPath.replace(/\\/g, '/');
  return fb.currentPath ? `${root}/${fb.currentPath}` : root;
});

const LAST_ROOT_KEY = 'file_browser_last_root';

onMounted(async () => {
  // v0.1.0-module3.0.4-virtuallist Task 3.4: 注册 scrollToPath callback.
  // store.scrollToPath(path) 走 pathIndex O(1) 找 sortedEntries 的 index i,
  // 这里直接透传给 FileList.scrollToIndex — 跳过 i→path→findIndex 双重反查
  // (14949 entries 时 ~60ms → < 1ms). filter (searchQuery / hideFinished) 启用
  // 时 displayedEntries ≠ sortedEntries, i 索引会错位 — 此调用原本就假设无 filter
  // (fb.scrollToPath 用于 viewMode 切换保留滚动位置, 此时 filter 通常不启用),
  // 故 fast path 安全.
  setScrollToIndexCallback((i, opts) => {
    if (fileListRef.value) {
      fileListRef.value.scrollToIndex(i, opts);
    }
  });
  await shortcuts.refresh();
  await readStatus.refresh();
  // v0.1.0-module1.22: 加载 sortField/sortAscending/viewMode/hideFinished 持久化
  await fb.loadLayout();
  // v0.1.0-module3.0.3-hotfix (Bug 2): 如果 reader 退出时已保存了导航上下文,
  // 先恢复 (rootPath + currentPath) 再决定是否走默认的 LAST_ROOT_KEY 路径.
  // 之前无脑 setRoot(stored) 会抹掉 currentPath, 导致嵌套目录下阅读后退回到 root.
  if (await fb.restoreNavigationContext()) {
    log('[FileBrowser] restored navigation context, skip setRoot');
    return;
  }
  // v0.1.0-module3.0.3-hotfix3 (Bug 4): 仅在 rootPath 为空时 (应用首次启动 / 刷新页面)
  // 才从 settings 恢复. Pinia store 同一会话内 rootPath 持续保留, setRoot 会抹掉
  // currentPath, 导致从 reader 退回时丢失滚动位置 — 哪怕 restoreNavigationContext 返回
  // false (例如使用快捷入口进入 reader 没保存上下文), 保留当前 rootPath 也比无脑重置好.
  if (fb.rootPath === null) {
    try {
      const stored = await getSetting(LAST_ROOT_KEY);
      if (stored && typeof stored === 'string' && stored.length > 0) {
        await fb.setRoot(stored);
      }
    } catch {
      // 静默回退: 显示 empty state
    }
  }
});

// v0.1.0-module3.0.4-virtuallist Task 3.4: 卸载清空 callback,
// 防止 stale ref (下次 mount 前若再 scrollToPath 会调到已死的 vm).
onUnmounted(() => {
  setScrollToIndexCallback(null);
});

// #1 rootPath 变化时持久化
watch(
  () => fb.rootPath,
  async (next) => {
    try {
      if (next) {
        await setSetting(LAST_ROOT_KEY, next);
      }
    } catch {
      // silent
    }
  },
);

// v0.1.0-module3.0.5: shortcut 切换 → 解码 descriptor + 两步打开 (setRoot + navigate relPath)
// 复用 History.vue openEntry 模式. Phase 1 只 Local; SMB/WebDAV 实装后扩展 TODO.
// 注意: setRoot 无条件调 (不做 rootPath 相等守卫) — 否则同根不同 relPath 的 shortcut
// 切换时 setRoot 被跳过, currentPath 残留旧路径, 列表不切到正确目录.
watch(
  () => shortcuts.activeId,
  async (id) => {
    if (id === null) return;
    const sc = shortcuts.items.find((s) => s.id === id);
    if (!sc) return;
    let desc: SourceDescriptor;
    try {
      desc = JSON.parse(sc.sourceDescriptorJson) as SourceDescriptor;
    } catch {
      return;
    }
    if (desc.type === 'local') {
      await fb.setRoot(desc.rootPath);
      if (sc.relPath) {
        await fb.navigate(sc.relPath);
      }
    }
    // TODO Phase 7-8: SMB/WebDAV descriptor 打开
  },
);

async function onUp() {
  await fb.up();
}

async function onRefresh() {
  await fb.refresh();
}

async function onPickRoot() {
  try {
    const mod = (await import('@tauri-apps/plugin-dialog').catch(() => null)) as
      | { open?: (opts: unknown) => Promise<string | null> }
      | null;
    if (!mod?.open) return;
    const path = await mod.open({ directory: true });
    if (path && typeof path === 'string') {
      await fb.setRoot(path);
    }
  } catch {
    // silent
  }
}

function onSaveClick() {
  saveLabel.value = '';
  showSaveDialog.value = true;
}

function onSaveCancel() {
  showSaveDialog.value = false;
  saveLabel.value = '';
}

async function onSaveSubmit() {
  if (!fb.rootPath) return;
  const label = saveLabel.value.trim() || null;
  // v0.1.0-module3.0.5: 存当前所在目录 (descriptor + currentPath 作 relPath), 支持子目录快捷方式
  const descriptor: SourceDescriptorLocal = { type: 'local', rootPath: fb.rootPath };
  await shortcuts.add(descriptor, fb.currentPath, label);
  showSaveDialog.value = false;
  saveLabel.value = '';
}

function truncatePath(p: string, head = 60, tail = 60): string {
  if (p.length <= head + tail + 5) return p;
  return `${p.slice(0, head)}…${p.slice(-tail)}`;
}

function errorMessage(kind: string, msg: string): string {
  if (kind === 'notFound' && msg.length > 200) {
    return t('error.pathTooLong') + ' — ' + truncatePath(msg, 50, 50);
  }
  const tr = truncatePath(msg);
  if (kind === 'notFound') return t('error.fileNotFound') + ': ' + tr;
  if (kind === 'permissionDenied') return t('error.permissionDenied') + ': ' + tr;
  return t('error.ioError') + ': ' + tr;
}

/**
 * FileList @open handler (双击进入)
 * v0.1.0-module2.0: 双击只进目录, 不再触发 reader. 进 reader 走:
 *  - toolbar 立即阅读按钮
 *  - EntryDetailPanel CTA
 *  - 右键菜单 readNow
 * v0.1.0-module3.0.2-reader-polish (Cluster A): 双击图片 → useReaderActions.readFromImage
 *  (从该图开始阅读, route 带 ?at=imageName)
 */
async function onEntryOpen(entry: MediaEntry) {
  log('[FileBrowser] onEntryOpen', entry.name, 'isDirectory=', entry.isDirectory, 'lastFetchedPath=', fb.lastFetchedPath);
  if (entry.isDirectory) {
    const newPath = fb.lastFetchedPath
      ? `${fb.lastFetchedPath}/${entry.path}`.replace(/\/+/g, '/')
      : entry.path;
    await fb.navigate(newPath);
    return;
  }
  if (isImage(entry.name)) {
    log('[FileBrowser] onEntryOpen: image file → readerActions.readFromImage');
    await readerActions.readFromImage(entry);
    return;
  }
  // 非图片非目录 (e.g. .cbz archive): 双击 no-op
  log('[FileBrowser] double-click on non-image file is no-op');
}

/** FileList @select handler (单击) → 走 store.selectFile 区分单选/Ctrl/Shift */
function onEntrySelect(entry: MediaEntry, event: MouseEvent | KeyboardEvent) {
  fb.selectFile(entry, event);
}

function onRowContextMenu(entry: MediaEntry, x: number, y: number) {
  // Windows 风格：右键的图在选中集内且 size > 1 -> 多选；不在选中集 -> 清空 + 单选该 entry
  if (fb.selectedPaths.has(entry.path) && fb.selectedPaths.size > 1) {
    const entries = fb.sortedEntries.filter((e) => fb.selectedPaths.has(e.path));
    ctxMenu.value = { entry: null, entries, x, y };
  } else {
    fb.selectSingle(entry);
    ctxMenu.value = { entry, entries: null, x, y };
  }
}

function onCtxClose() {
  ctxMenu.value = null;
}

/** 右键"重新生成缩略图"：多选时批量转发到 FileList.regenerateBatch，单图走 regenerateThumbnail。 */
function onRegenerateThumbnail(entries: MediaEntry[]) {
  fileListRef.value?.regenerateBatch(entries);
}

/** 右键"重试缩略图"：多选时批量转发到 FileList.retryBatch。 */
function onRetryFromCtx(items: MediaEntry[]) {
  fileListRef.value?.retryBatch(items);
}

async function onBreadcrumbNavigate(path: string) {
  await fb.navigate(path);
}

const rootLabel = computed(() => {
  if (!fb.rootPath) return t('nav.fileBrowser');
  const parts = fb.rootPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fb.rootPath;
});

/* ─── Lucide SVG 图标路径 ─── */
const ICON_EYE = 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const ICON_EYE_OFF = 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22';
const ICON_UP = 'M5 12l7-7 7 7M12 19V5';
const ICON_REFRESH = 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5';
const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
// v0.1.0-module3.0.5: PushPin 替代 STAR — 对齐 PV 教训 (Star 被多次误解为书签, 见 specs/2026-07-29-like-feature-design.md:301)
const ICON_PIN = 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 z';
const ICON_FOLDER_OPEN = 'M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2';
const ICON_ALERT = 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01';
// v0.1.0-module3.0.3-hotfix11: 加入书库 + 下载全部 移到 toolbar (一处可见, 跨视图复用).
const ICON_LIBRARY_PLUS = 'M12 6v6M12 12H6M12 12h6M12 12v6M4 6h16v14H4zM16 6L9 6L7.5 4h-3A2 2 0 0 0 2.5 5.5v12A2.5 2.5 0 0 0 5 20h14a2 2 0 0 0 2-2v-3';
const ICON_DOWNLOAD = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3';
// v0.1.0-module3.0.8 (任务 9): 下一卷按钮图标 (chevron-right + 加号, lucide skip-forward 风格)
const ICON_NEXT_VOLUME = 'M5 4l10 8-10 8V4zM19 5v14';

// v0.1.0-module2.0: emit 'open' 已废弃 (双击只进目录, 触发阅读走 useReaderActions)
//  保留 emit 类型仅出于向后兼容 — 不再 emit

// v0.1.0-module3.0.7-masonry-task14: 视图切换按钮图标用 SVG 资产
// (v-html 渲染保留 fill + viewBox 0 0 1024 1024 原貌, 尺寸 12px 由 scoped CSS 限制).
// 之前的 lucide path d 常量已被 SVG 资产替代 — 资产文件位于 src/icons/.

const canReadNow = computed(() => {
  const e = selectedEntry.value;
  if (e) return e.isDirectory === true || isImage(e.name);
  // 未选中: 详情视图看含图就亮（点击走 readFromCurrentPath 内部读取/创建进度 + 从上次/第一张进入）；
  // 瀑布流视图看浏览位置（保持现状）。
  return fb.viewMode === 'masonry'
    ? fileListRef.value?.masonryLastBrowseProgress?.imageName != null
    : hasImages.value;
});

// v0.1.0-module3.0.3-hotfix11: toolbar 加的「加入书库」/「下载全部」按钮
// 启用条件: 选中目录 (与详情面板一致).
const canAddToLibrary = computed(() => selectedEntry.value?.isDirectory === true);
// 下载全部: 暂 stub, 与 EntryDetailPanel 行为一致 — 本地文件无需下载, 永远 disabled
const canDownloadAll = computed(() => false);

function onReadNowClick() {
  const e = selectedEntry.value;
  if (e) {
    log('[FileBrowser] onReadNowClick: selectedEntry', e.name, 'isDir=', e.isDirectory);
    if (e.isDirectory) void readerActions.readNow(e);
    else void readerActions.readFromImage(e);
    return;
  }
  // 未选中: 直接调 readFromCurrentPath 让它内部读进度/从上次图或第一张进入阅读器.
  // 详情视图 + 有上次记录 → 跳到该图; 详情 + 没记录 → 跳到第一张.
  // 瀑布流视图 → masonryLastBrowseProgress 已通过 canReadNow 守门, 走 IPC 拿进度.
  log('[FileBrowser] onReadNowClick: no selection');
  void readerActions.readFromCurrentPath();
}

/** v0.1.0-module3.0.8 (任务 10): toolbar「↶ 跳到上次」按钮 — 转发到 MasonryView.jumpToLast */
function onJumpToLastClick() {
  log('[FileBrowser] onJumpToLastClick fired');
  void fileListRef.value?.masonryJumpToLast();
}

/** v0.1.0-module3.0.8 (任务 9): 工具栏「下一卷」按钮 (跨卷连续阅读 spec §14.2)
 *  流程:
 *    1. 早捕获 lastFetchedPath + rootPath (双重陈旧校验 — P1-4 修复)
 *    2. fileListRef.masonryFlushNow() → 立即 recordCurrentTop 保存当前浏览位置
 *    3. findNextVolume(descriptor, lastFetchedPath, 'next') (无 filter 参数 — P1-3 修复)
 *    4. 结果落地前校验 lastFetchedPath + rootPath 都没变 (用户可能切到另一根但有相同 relPath)
 *    5. 成功 → fb.navigate(result.relPath) → MasonryView 重载 → 自动 restoreAndScroll
 *  错误: toast 提示 + swapping 重置 (finally)
 *  disabled: swapping || !rootPath || !lastFetchedPath (根目录自身不能作"卷"起点,
 *    不绑 viewMode — P1-3 修复: 跳到无图目录自动回落 details 后仍可点)
 *  Pinia store refs 自动解包, 不写 .value; descriptor 用 masonryDescriptor 而非 descriptor. */
const { push: pushToast } = useToast();
const swapping = ref(false);
async function onCrossNextVolume() {
  if (swapping.value) return;
  const pathAtRequestStart = fb.lastFetchedPath;
  const rootAtRequestStart = masonryDescriptor.value.rootPath;
  if (!pathAtRequestStart || !rootAtRequestStart) return;
  swapping.value = true;
  try {
    await fileListRef.value?.masonryFlushNow();
    const result = await findNextVolume(masonryDescriptor.value, pathAtRequestStart, 'next');
    if (fb.lastFetchedPath !== pathAtRequestStart || masonryDescriptor.value.rootPath !== rootAtRequestStart) return;
    if (!result) {
      pushToast(t('reader.crossVolume.none'));
      return;
    }
    await fb.navigate(result.relPath);
    pushToast(t('reader.crossVolume.jumped', { title: result.title }));
  } catch (e) {
    log('[FileBrowser] onCrossNextVolume failed', e);
    pushToast(t('reader.crossVolume.failed'));
  } finally {
    swapping.value = false;
  }
}

function onAddToLibraryClick() {
  log('[FileBrowser] onAddToLibraryClick fired', selectedEntry.value?.name);
  if (selectedEntry.value) {
    void readerActions.addToLibrary(selectedEntry.value);
  } else {
    log('[FileBrowser] onAddToLibraryClick: no selectedEntry');
  }
}
// v0.1.0-module3.0.3-hotfix11: 下载全部 stub handler (与 EntryDetailPanel 一致 — 本地文件无需下载)
function onDownloadAllClick() {
  log('[FileBrowser] onDownloadAllClick: stub (本地文件无需下载)');
}

function onReadNowFromCtx(entry: MediaEntry) {
  if (entry.isDirectory) void readerActions.readNow(entry);
  else void readerActions.readFromImage(entry);
}
function onAddToLibraryFromCtx(entry: MediaEntry) {
  void readerActions.addToLibrary(entry);
}
</script>

<template>
  <main class="flex flex-col h-full gap-2 p-4" data-test="file-browser">
    <!-- empty state -->
    <div
      v-if="fb.rootPath === null"
      class="flex-1 flex flex-col items-center justify-center gap-5 p-8"
      data-test="empty-state"
    >
      <div
        class="w-16 h-16 rounded-2xl bg-surface-1 xp-bd flex items-center justify-center backdrop-blur-md"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
             stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path :d="ICON_FOLDER_OPEN" />
        </svg>
      </div>
      <p class="text-text-muted text-sm m-0">{{ t('fileBrowser.noShortcut') }}</p>
      <button
        data-test="btn-pick"
        class="flex items-center gap-2 px-5 py-2.5 bg-accent text-white border-0 rounded-md font-semibold cursor-pointer shadow-[0_0_12px_rgba(99,102,241,0.45)] transition-[background,transform,box-shadow] duration-100 hover:bg-accent-hover hover:shadow-[0_0_18px_rgba(99,102,241,0.65)] active:translate-y-px"
        @click="onPickRoot"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path :d="ICON_FOLDER" />
        </svg>
        {{ t('fileBrowser.pickRoot') }}
      </button>
      <RouterLink
        to="/shortcuts"
        class="text-accent no-underline text-sm transition-colors duration-100 hover:text-accent-hover hover:underline"
        data-test="link-to-shortcuts"
      >
        {{ t('fileBrowser.goShortcuts') }} →
      </RouterLink>
    </div>

    <!-- main view -->
    <template v-else>
      <!-- Toolbar -->
      <header
        class="bg-surface xp-bdb px-3 py-1.5 flex items-center gap-1 flex-wrap"
        data-test="toolbar"
      >
        <button data-test="btn-up" class="tb-btn" :disabled="!canUp" @click="onUp">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_UP" />
          </svg>
          {{ t('fileBrowser.up') }}
        </button>
        <button data-test="btn-refresh" class="tb-btn" :disabled="fb.loading" @click="onRefresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_REFRESH" />
          </svg>
          {{ t('fileBrowser.refresh') }}
        </button>
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <ShortcutDropdown />
        <button data-test="btn-pick" class="tb-btn" @click="onPickRoot">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_FOLDER" />
          </svg>
          {{ t('fileBrowser.pickRoot') }}
        </button>
        <button data-test="btn-save" class="tb-btn" :disabled="!canSave" @click="onSaveClick">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_PIN" />
          </svg>
          {{ t('fileBrowser.saveAsShortcut') }}
        </button>
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <button
          data-test="btn-read-now"
          class="tb-btn text-accent"
          :disabled="!canReadNow"
          :title="canReadNow ? t('fileBrowser.readNow') : t('fileBrowser.noImagesInFolder')"
          @click="onReadNowClick"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
          {{ t('fileBrowser.readNow') }}
        </button>
        <!-- v0.1.0-module3.0.8 (任务 10): masonry 浏览位置跳转按钮
             仅在 masonry 视图显示 (其他视图无浏览位置概念)
             disable 取决于 masonryLastBrowseProgress 是否有 imageName -->
        <button
          v-if="fb.viewMode === 'masonry'"
          data-test="btn-jump-to-last"
          type="button"
          class="tb-btn"
          :disabled="!fileListRef?.masonryLastBrowseProgress?.imageName"
          :title="fileListRef?.masonryLastBrowseProgress?.imageName ? t('fileBrowser.jumpToLast') : t('fileBrowser.noRecordedProgress')"
          @click="onJumpToLastClick"
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          {{ t('fileBrowser.jumpToLast') }}
        </button>
        <!-- v0.1.0-module3.0.8 (任务 9): 工具栏「下一卷」按钮 (跨卷连续阅读 spec §14.1)
             P1-3 修复: 不绑 viewMode,details 回落后仍可点; disabled 不含 !hasImages,
             无图目录仍可点跳过. 仅在 swapping / 无 rootPath / 无 lastFetchedPath 时禁用
             (根目录自身不能作"卷"起点). -->
        <button
          data-test="btn-next-volume"
          type="button"
          class="tb-btn"
          :disabled="swapping || !fb.rootPath || !fb.lastFetchedPath"
          :title="t('fileBrowser.nextVolume')"
          @click="onCrossNextVolume"
        >
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="ICON_NEXT_VOLUME" />
          </svg>
          {{ t('fileBrowser.nextVolume') }}
        </button>
        <!-- v0.1.0-module3.0.3-hotfix11: 加入书库 / 下载全部 提到顶栏, 跨视图复用.
             详情 (details) 视图已把属性显示在列上, attribute panel 隐藏; 但这两个
             action 按钮保留在 toolbar. -->
        <button
          data-test="btn-add-to-library"
          class="tb-btn"
          :disabled="!canAddToLibrary"
          :title="t('fileBrowser.addToLibrary')"
          @click="onAddToLibraryClick"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_LIBRARY_PLUS" />
          </svg>
          {{ t('fileBrowser.addToLibrary') }}
        </button>
        <button
          data-test="btn-download-all"
          class="tb-btn"
          :disabled="!canDownloadAll"
          :title="t('fileBrowser.downloadAllUnavailable')"
          @click="onDownloadAllClick"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_DOWNLOAD" />
          </svg>
          {{ t('fileBrowser.downloadAll') }}
        </button>
        <button
          data-test="btn-detail"
          class="tb-btn"
          :class="showDetail ? 'text-accent' : ''"
          :disabled="!selectedEntry"
          :title="selectedEntry ? (showDetail ? t('fileBrowser.hideDetail') : t('fileBrowser.showDetail')) : ''"
          @click="toggleDetail"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          {{ showDetail ? t('fileBrowser.hideDetail') : t('fileBrowser.showDetail') }}
        </button>
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <button
          data-test="btn-hide-finished"
          class="tb-btn"
          :title="fb.hideFinished ? t('fileBrowser.showFinished') : t('fileBrowser.hideFinished')"
          @click="fb.setHideFinished(!fb.hideFinished)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path v-if="fb.hideFinished" :d="ICON_EYE" />
            <path v-else :d="ICON_EYE_OFF" />
          </svg>
        </button>
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <SortDropdown />
        <!-- v0.1.0-module3.0.5-masonry (阶段 E3): 视图切换图标按钮
             (详情在前 + 瀑布流). ⚙ 仅 masonry 出现, 接 MasonrySettingsPopup. -->
        <div class="relative flex items-center gap-0.5">
          <button data-test="view-details" class="tb-btn"
                  :class="fb.viewMode === 'details' ? 'text-accent' : ''"
                  :title="t('fileBrowser.viewDetails')"
                  @click="fb.setViewMode('details')">
            <span class="vbtn-icon" aria-hidden="true" v-html="ICON_DETAILS_SVG" />
          </button>
          <button data-test="view-masonry" class="tb-btn"
                  :class="fb.viewMode === 'masonry' ? 'text-accent' : ''"
                  :disabled="!hasImages"
                  :title="hasImages ? t('fileBrowser.viewMasonry') : t('fileBrowser.noImagesForMasonry')"
                  @click="fb.setViewMode('masonry')">
            <span class="vbtn-icon" aria-hidden="true" v-html="ICON_MASONRY_SVG" />
          </button>
          <button v-if="fb.viewMode === 'masonry'" data-test="btn-masonry-settings"
                  class="tb-btn" :title="t('fileBrowser.masonrySettings')"
                  @click="masonryPopupOpen = !masonryPopupOpen">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <MasonrySettingsPopup
            v-if="masonryPopupOpen && fb.viewMode === 'masonry'"
            :col-count="masonryParams.colCount"
            :h-gap="masonryParams.hGap"
            :v-gap="masonryParams.vGap"
            @change="onMasonryChange"
            @close="onMasonryPopupClose"
          />
        </div>
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <SearchInput />
      </header>

      <div
        v-if="fb.searchQuery"
        class="bg-surface xp-bdb px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted"
        data-test="search-breadcrumb"
      >
        <span>{{ t('fileBrowser.searchCurrent') }}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span class="text-text-primary">{{ rootLabel }}</span>
      </div>
      <Breadcrumb
        v-else
        :root-label="rootLabel"
        :path="fb.currentPath"
        data-test="breadcrumb"
        @navigate="onBreadcrumbNavigate"
      />

      <!-- Error toast -->
      <p
        v-if="fb.error"
        class="flex items-center gap-3 px-4 py-3 bg-error/8 border border-error rounded text-sm text-text-primary shadow-[0_0_10px_rgba(248,113,113,0.3)]"
        data-test="error-toast"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="var(--color-error)" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path :d="ICON_ALERT" />
        </svg>
        <span data-test="error-message" class="text-error flex-1 min-w-0 break-all">
          {{ errorMessage(fb.error.kind, fb.error.message) }}
        </span>
        <span class="flex gap-2 shrink-0">
          <button
            v-if="fb.currentPath !== ''"
            data-test="error-up"
            class="px-3 py-1 border border-error bg-transparent text-error rounded-xs text-xs cursor-pointer transition-colors duration-100 hover:bg-error/20"
            @click="onUp"
          >
            ↑ {{ t('fileBrowser.up') }}
          </button>
          <button
            data-test="error-refresh"
            class="px-3 py-1 border border-error bg-transparent text-error rounded-xs text-xs cursor-pointer transition-colors duration-100 hover:bg-error/20"
            @click="onRefresh"
          >
            {{ t('fileBrowser.refresh') }}
          </button>
        </span>
      </p>

      <!-- Main: 左侧 FileList + 右侧 DetailPanel (1 选中时) -->
      <div class="flex-1 flex gap-2 min-h-0 overflow-hidden">
        <FileList
          ref="fileListRef"
          class="flex-1 min-w-0"
          :entries="displayedEntries"
          :loading="fb.loading"
          :marks="readStatus.marks"
          :selected-paths="fb.selectedPaths"
          :view-mode="fb.viewMode"
          :descriptor="masonryDescriptor"
          :root-path="fb.rootPath"
          :current-path="fb.lastFetchedPath"
          :col-count="masonryParams.colCount"
          :h-gap="masonryParams.hGap"
          :v-gap="masonryParams.vGap"
          :canonical-image-names="canonicalImageNames"
          data-test="filelist"
          @open="onEntryOpen"
          @select="onEntrySelect"
          @contextmenu="onRowContextMenu"
        />
        <EntryDetailPanel
          v-if="showDetail && selectedEntry && fb.viewMode !== 'details'"
          :entry="selectedEntry"
          :root-path="fb.rootPath"
          class="w-72 shrink-0 overflow-y-auto"
          @read-now="onReadNowClick"
          @add-to-library="onAddToLibraryClick"
          @close="showDetail = false"
        />
      </div>

      <p v-if="fb.loading" class="text-text-tertiary text-xs m-0 px-3 py-2">
        {{ t('common.loading') }}
      </p>

      <!-- StatusBar (v0.1.0-module1.22 新增) -->
      <StatusBar
        :total="fb.sortedEntries.length"
        :selected-count="fb.selectedCount"
        :selection-size-bytes="fb.selectionSizeBytes"
        :current-path="displayPath"
        :items-text="statusBarItemsText"
      />

      <!-- Save dialog -->
      <div
        v-if="showSaveDialog"
        class="absolute inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-[1000]"
        data-test="save-dialog"
        @click.self="onSaveCancel"
      >
        <div class="bg-surface-4 xp-bd rounded-lg p-6 flex flex-col gap-4 min-w-[380px] shadow-lg">
          <h3 class="m-0 text-base font-semibold text-text-primary flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="#6366f1" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <path :d="ICON_PIN" />
            </svg>
            {{ t('fileBrowser.saveAsShortcut') }}
          </h3>
          <label class="flex flex-col gap-2 text-xs text-text-secondary">
            {{ t('fileBrowser.shortcutLabel') }}
            <input
              v-model="saveLabel"
              data-test="save-label-input"
              class="px-3 py-2 bg-surface-inset xp-bd text-text-primary rounded text-sm transition-[border-color,box-shadow] duration-100 outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
            />
          </label>
          <div class="flex justify-end gap-2 mt-2">
            <button
              class="px-4 py-2 xp-bd bg-transparent text-text-secondary rounded cursor-pointer transition-[background,color] duration-100 hover:bg-surface-2 hover:text-text-primary"
              @click="onSaveCancel"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              data-test="btn-save-submit"
              class="flex items-center gap-1.5 px-4 py-2 bg-accent border border-accent text-white rounded cursor-pointer font-semibold shadow-[0_0_10px_rgba(99,102,241,0.4)] transition-[background,transform] duration-100 hover:bg-accent-hover active:translate-y-px"
              @click="onSaveSubmit"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <RowContextMenu
      v-if="ctxMenu"
      :entry="ctxMenu.entry"
      :entries="ctxMenu.entries"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      @close="onCtxClose"
      @read-now="onReadNowFromCtx"
      @add-to-library="onAddToLibraryFromCtx"
      @regenerate-thumbnail="onRegenerateThumbnail"
      @retry="onRetryFromCtx"
    />
  </main>
</template>

<style scoped>
/* ─── 工具栏按钮统一 base (Xplorer 风格) ─── */
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
}
.tb-btn:hover:not(:disabled) {
  background: var(--color-surface-light);
  color: var(--color-text-primary);
}
.tb-btn:active:not(:disabled) {
  color: var(--color-accent);
}
.tb-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* v0.1.0-module3.0.7-masonry-task14: 视图按钮 SVG 资产容器.
   v-html 注入的 SVG 不会带 Vue scoped data-attribute, 但因为是 .vbtn-icon 的
   descendant, 普通后代选择器 *.vbtn-icon svg* 仍能命中 — 不需要 :global()
   (后者会把选择器写成裸 svg, 影响本组件所有 svg 元素). */
.vbtn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  line-height: 0;
}
.vbtn-icon svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}
.vbtn-icon svg path {
  fill: currentColor;
}
</style>
