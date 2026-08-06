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
import { computed, ref } from 'vue';
import { listDirectory } from '@/lib/tauri';
import { log } from '@/lib/logger';
import { sortEntries, type SortField } from '@/lib/fileSort';
import { getSetting, setSetting } from '@/lib/tauri';
import { useDirectorySortStore } from '@/stores/directorySort';
import type { MediaEntry, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

export type FileBrowserError =
  | { kind: 'notFound'; message: string }
  | { kind: 'permissionDenied'; message: string }
  | { kind: 'io'; message: string };

export type ViewMode = 'list' | 'grid' | 'details';

export const useFileBrowserStore = defineStore('fileBrowser', () => {
  const rootPath = ref<string | null>(null);
  const currentPath = ref<string>('');
  const lastFetchedPath = ref<string>('');
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

  async function fetch(path: string): Promise<void> {
    if (rootPath.value === null) return;
    loading.value = true;
    error.value = null;
    log('[fileBrowser] fetch', { rootPath: rootPath.value, path });
    try {
      const descriptor = toDescriptor(rootPath.value);
      const result = await listDirectory(descriptor, path);
      log('[fileBrowser] listDirectory returned', result.length, 'entries');

      // v0.1.0-module3.0: per-folder 排序覆盖 → fallback 到 settings 默认
      const dsStore = useDirectorySortStore();
      const override = await dsStore.resolve(descriptor, path).catch(() => null);
      effectiveSortField.value = (override?.sortField as SortField) ?? sortField.value;
      effectiveSortAscending.value = override?.ascending ?? sortAscending.value;

      entries.value = result;
      lastFetchedPath.value = path;
      // browse_history 仅在 reader 真正打开时记录（useReaderActions.readNow），
      // 单纯文件夹浏览不写——避免根目录被默认加进去。
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('[fileBrowser] fetch error', msg);
      error.value = { kind: 'io', message: msg };
    } finally {
      loading.value = false;
    }
  }


  async function setRoot(root: string | null): Promise<void> {
    rootPath.value = root;
    currentPath.value = '';
    lastFetchedPath.value = '';
    entries.value = [];
    error.value = null;
    clearSelection();
    if (root !== null) {
      await fetch('');
    }
  }

  async function navigate(path: string): Promise<void> {
    currentPath.value = path;
    await fetch(path);
  }

  async function refresh(): Promise<void> {
    await fetch(currentPath.value);
  }

  async function up(): Promise<void> {
    if (currentPath.value === '') return;
    const parts = currentPath.value.split(/[\\/]/).filter(Boolean);
    parts.pop();
    currentPath.value = parts.join('/');
    await fetch(currentPath.value);
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
    if (rootPath.value !== ctx.rootPath) {
      await setRoot(ctx.rootPath);
    }
    if (ctx.currentPath) {
      await navigate(ctx.currentPath);
    }
    return true;
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
    if (vm === 'list' || vm === 'grid') viewMode.value = vm;
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
    const next = new Set(selectedPaths.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selectedPaths.value = next;
  }

  function replaceSelection(path: string): void {
    selectedPaths.value = new Set([path]);
  }

  function selectRange(from: string, to: string): void {
    const sorted = sortedEntries.value.map((e) => e.path);
    const i = sorted.indexOf(from);
    const j = sorted.indexOf(to);
    if (i === -1 || j === -1) return;
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    const next = new Set<string>();
    for (let k = lo; k <= hi; k++) next.add(sorted[k]);
    selectedPaths.value = next;
  }

  function clearSelection(): void {
    selectedPaths.value = new Set();
    anchorPath.value = null;
  }

  function selectAll(): void {
    selectedPaths.value = new Set(sortedEntries.value.map((e) => e.path));
  }

  function setSearchQuery(q: string): void {
    searchQuery.value = q;
  }

  // ─── v0.1.0-module1.22: computed ──

  const sortedEntries = computed<MediaEntry[]>(() =>
    sortEntries(entries.value, effectiveSortField.value, effectiveSortAscending.value),
  );

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
    // v0.1.0-module3.0.3-hotfix (Bug 2): 导航上下文保存/恢复
    saveNavigationContext,
    restoreNavigationContext,
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
    selectAll,
    setSearchQuery,
    // computed
    sortedEntries,
    selectedEntries,
    selectedCount,
    selectionSizeBytes,
  };
});
