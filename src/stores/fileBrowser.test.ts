/**
 * fileBrowser store 单测 — 模块 #1
 * v0.1.0-module1.22: 升维度 — sortField / viewMode / selectedPaths / hideFinished
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFileBrowserStore, setScrollToIndexCallback } from './fileBrowser';
import { listDirectory, getSetting, setSetting } from '@/lib/tauri';
import type { MediaEntry } from '@/lib/sourceDescriptor';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listDirectory: vi.fn(),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined),
    recordHistory: vi.fn(async () => undefined),
    getDirectorySort: vi.fn(async () => null),
    setDirectorySort: vi.fn(async () => undefined),
  };
});
const mockedList = vi.mocked(listDirectory);
const mockedGet = vi.mocked(getSetting);
const mockedSet = vi.mocked(setSetting);

function makeEntries(...names: string[]): MediaEntry[] {
  return names.map((n) => ({
    name: n,
    path: n,
    isDirectory: !n.includes('.'),
    isArchive: n.endsWith('.cbz') || n.endsWith('.zip'),
    size: 100,
    modifiedAt: 0,
  }));
}

function makeEntry(name: string, opts: Partial<MediaEntry> = {}): MediaEntry {
  return {
    name,
    path: name,
    isDirectory: false,
    isArchive: false,
    size: 100,
    modifiedAt: 0,
    ...opts,
  };
}

function mkMouseEvent(modifiers: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}): MouseEvent {
  return { ctrlKey: false, shiftKey: false, metaKey: false, ...modifiers } as MouseEvent;
}

describe('fileBrowser store — 基础', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('初始状态', () => {
    const store = useFileBrowserStore();
    expect(store.rootPath).toBeNull();
    expect(store.currentPath).toBe('');
    expect(store.entries).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.selectedPaths.size).toBe(0);
    // v0.1.0-module1.23: 默认 details 视图
    expect(store.viewMode).toBe('details');
    expect(store.sortField).toBe('name');
    expect(store.sortAscending).toBe(true);
  });

  it('setRoot 更新 rootPath + 拉根目录', async () => {
    mockedList.mockResolvedValue(makeEntries('a', 'b'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    expect(store.rootPath).toBe('C:/comics');
    expect(store.entries.length).toBe(2);
  });

  it('setRoot(null) 清空 entries + 清空 selection', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    store.replaceSelection('a');
    await store.setRoot(null);
    expect(store.entries).toEqual([]);
    expect(store.selectedPaths.size).toBe(0);
  });

  it('navigate 更新 currentPath', async () => {
    mockedList.mockResolvedValue(makeEntries('chapter1'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    mockedList.mockResolvedValue(makeEntries('chapter1/page1.jpg'));
    await store.navigate('chapter1');
    expect(store.currentPath).toBe('chapter1');
  });

  it('up() 进上一级', async () => {
    mockedList.mockResolvedValue(makeEntries('chapter1'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    mockedList.mockResolvedValue(makeEntries('page1.jpg'));
    await store.navigate('chapter1');
    mockedList.mockResolvedValue(makeEntries('chapter1'));
    await store.up();
    expect(store.currentPath).toBe('');
  });

  it('listDirectory 抛错 → error 状态', async () => {
    mockedList.mockRejectedValueOnce(new Error('not found'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/missing');
    expect(store.error?.kind).toBe('io');
  });

  // ─── 导航上下文保存/恢复 (v0.1.0-module3.0.3-hotfix Bug 2) ───

  it('saveNavigationContext → restoreNavigationContext: 嵌套路径保存恢复 (rootPath 不变, currentPath 恢复)', async () => {
    mockedList.mockResolvedValue(makeEntries('260715'));
    const store = useFileBrowserStore();
    await store.setRoot('U:/H/AI');
    mockedList.mockResolvedValue(makeEntries('260301', '260501', '260715'));
    await store.navigate('output');
    expect(store.currentPath).toBe('output');
    // 进入 reader 前保存上下文
    store.saveNavigationContext();
    // 模拟 reader 期间 store 仍保持 (但 UI 假设 FileBrowser 卸载后 store 还在)
    // 重新挂载 FileBrowser 时调用 restore
    mockedList.mockResolvedValue(makeEntries('260301', '260501', '260715'));
    const restored = await store.restoreNavigationContext();
    expect(restored).toBe(true);
    expect(store.rootPath).toBe('U:/H/AI');
    expect(store.currentPath).toBe('output');
    // restore 后应清空 saved 上下文 (二次调用返回 false)
    const restoredAgain = await store.restoreNavigationContext();
    expect(restoredAgain).toBe(false);
  });

  it('restoreNavigationContext: rootPath 不同时先 setRoot 再 navigate', async () => {
    mockedList.mockResolvedValue(makeEntries('manga'));
    const store = useFileBrowserStore();
    await store.setRoot('U:/H/AI');
    mockedList.mockResolvedValue(makeEntries('260715'));
    await store.navigate('output');
    // 保存 (rootPath='U:/H/AI', currentPath='output')
    store.saveNavigationContext();
    // 模拟重启 / 切换根: 用户在另一处换了 rootPath
    mockedList.mockResolvedValue(makeEntries('photos'));
    await store.setRoot('D:/backup');
    expect(store.rootPath).toBe('D:/backup');
    expect(store.currentPath).toBe('');
    // 现在 restore → 应切回 U:/H/AI/output
    mockedList.mockResolvedValue(makeEntries('260301', '260501', '260715'));
    const restored = await store.restoreNavigationContext();
    expect(restored).toBe(true);
    expect(store.rootPath).toBe('U:/H/AI');
    expect(store.currentPath).toBe('output');
  });

  it('restoreNavigationContext: 无保存上下文时返回 false', async () => {
    const store = useFileBrowserStore();
    const restored = await store.restoreNavigationContext();
    expect(restored).toBe(false);
  });
});

describe('fileBrowser store — sortedEntries (dir-first)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('name 排序时目录永远在前', async () => {
    mockedList.mockResolvedValue([
      makeEntry('a.txt'),
      makeEntry('b-dir', { isDirectory: true }),
      makeEntry('c.txt'),
    ]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    expect(store.sortedEntries.map((e) => e.name)).toEqual(['b-dir', 'a.txt', 'c.txt']);
  });

  it('size 排序按 size 升序（目录 size=0 在前）', async () => {
    mockedList.mockResolvedValue([
      makeEntry('big.txt', { size: 1000 }),
      makeEntry('dir', { isDirectory: true, size: 0 }),
      makeEntry('medium.txt', { size: 100 }),
    ]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setSortField('size'); // 切到 size 字段
    expect(store.sortedEntries.map((e) => e.name)).toEqual(['dir', 'medium.txt', 'big.txt']);
  });

  it('setSortField 同字段 → toggle 方向', async () => {
    mockedList.mockResolvedValue([makeEntry('a'), makeEntry('b')]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    expect(store.sortAscending).toBe(true);
    // 切到 size → 不 toggle
    store.setSortField('size');
    expect(store.sortAscending).toBe(true);
    // 再次 'size' → toggle
    store.setSortField('size');
    expect(store.sortAscending).toBe(false);
  });

  it('setSortField 不同字段 → 不 toggle 方向', async () => {
    mockedList.mockResolvedValue([makeEntry('a')]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setSortField('modifiedAt'); // 不同字段
    expect(store.sortAscending).toBe(true);
    store.setSortField('size'); // 不同字段
    expect(store.sortAscending).toBe(true);
  });
});

describe('fileBrowser store — selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('单击 → 单选 + 设 anchor', async () => {
    mockedList.mockResolvedValue([makeEntry('a'), makeEntry('b'), makeEntry('c')]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.selectFile(makeEntry('b'), mkMouseEvent());
    expect(store.selectedPaths).toEqual(new Set(['b']));
    expect(store.anchorPath).toBe('b');
  });

  it('Ctrl+Click → toggle 已有选中', async () => {
    mockedList.mockResolvedValue([makeEntry('a'), makeEntry('b')]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.selectFile(makeEntry('a'), mkMouseEvent());
    store.selectFile(makeEntry('b'), mkMouseEvent({ ctrlKey: true }));
    expect(store.selectedPaths).toEqual(new Set(['a', 'b']));
    store.selectFile(makeEntry('a'), mkMouseEvent({ ctrlKey: true }));
    expect(store.selectedPaths).toEqual(new Set(['b']));
  });

  it('Shift+Click → 范围选 (anchor 到当前)', async () => {
    mockedList.mockResolvedValue([
      makeEntry('a'),
      makeEntry('b'),
      makeEntry('c'),
      makeEntry('d'),
    ]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    // 先单击 a 设 anchor
    store.selectFile(makeEntry('a'), mkMouseEvent());
    // Shift+Click d → 选 a, b, c, d
    store.selectFile(makeEntry('d'), mkMouseEvent({ shiftKey: true }));
    expect(store.selectedPaths).toEqual(new Set(['a', 'b', 'c', 'd']));
    // 改 anchor: 单击 c → 单选 c, anchor='c'
    store.selectFile(makeEntry('c'), mkMouseEvent());
    expect(store.selectedPaths).toEqual(new Set(['c']));
    expect(store.anchorPath).toBe('c');
    // Shift+Click a → 选 c, b, a (从 anchor 'c' 到 'a' 倒序)
    store.selectFile(makeEntry('a'), mkMouseEvent({ shiftKey: true }));
    expect(store.selectedPaths).toEqual(new Set(['c', 'b', 'a']));
  });

  it('selectAll → 全选当前 sortedEntries', async () => {
    mockedList.mockResolvedValue([makeEntry('a'), makeEntry('b')]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.selectAll();
    expect(store.selectedPaths).toEqual(new Set(['a', 'b']));
  });

  it('clearSelection → 清空 + anchor 复位', async () => {
    mockedList.mockResolvedValue([makeEntry('a')]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.selectFile(makeEntry('a'), mkMouseEvent());
    store.clearSelection();
    expect(store.selectedPaths.size).toBe(0);
    expect(store.anchorPath).toBeNull();
  });

  it('selectedCount / selectionSizeBytes computed', async () => {
    mockedList.mockResolvedValue([
      makeEntry('a', { size: 100 }),
      makeEntry('b', { size: 200 }),
      makeEntry('dir', { isDirectory: true, size: 0 }),
    ]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.selectAll();
    expect(store.selectedCount).toBe(3);
    // dir 排除, 100 + 200 = 300
    expect(store.selectionSizeBytes).toBe(300);
  });
});

describe('fileBrowser store — viewMode + persist', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('setViewMode 写入 settings (masonry)', async () => {
    mockedList.mockResolvedValue([]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    // v0.1.0-module3.0.5-masonry (阶段 B / B4): 用 masonry 验证 (旧 grid 已收窄)
    store.setViewMode('masonry');
    expect(store.viewMode).toBe('masonry');
    expect(mockedSet).toHaveBeenCalledWith('fb_view_mode', 'masonry');
  });

  it('setHideFinished 写入 settings', async () => {
    mockedList.mockResolvedValue([]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setHideFinished(true);
    expect(store.hideFinished).toBe(true);
    expect(mockedSet).toHaveBeenCalledWith('fb_hide_finished', '1');
  });

  it('loadLayout 读 settings 恢复状态 (masonry)', async () => {
    mockedGet.mockImplementation(async (key) => {
      if (key === 'fb_sort_field') return 'size';
      if (key === 'fb_sort_ascending') return '0';
      if (key === 'fb_view_mode') return 'masonry';
      if (key === 'fb_hide_finished') return '1';
      return null;
    });
    const store = useFileBrowserStore();
    await store.loadLayout();
    expect(store.sortField).toBe('size');
    expect(store.sortAscending).toBe(false);
    expect(store.viewMode).toBe('masonry');
    expect(store.hideFinished).toBe(true);
  });

  // v0.1.0-module3.0.5-masonry (阶段 B / B4): 老 list/grid 持久化值 fallback → details.
  // 老用户升级到 v0.1.0-module3.0+ 不会因为历史 fb_view_mode='list'/'grid'
  // 而落到 ViewMode 类型外, loadLayout 白名单 fallback 保证类型边界.
  it.each([
    ['list', 'details'],
    ['grid', 'details'],
  ] as const)('loadLayout 老 fb_view_mode=%s → fallback details', async (legacy, expected) => {
    mockedGet.mockImplementation(async (key) => {
      if (key === 'fb_view_mode') return legacy;
      return null;
    });
    const store = useFileBrowserStore();
    await store.loadLayout();
    expect(store.viewMode).toBe(expected);
  });

  it('loadLayout 无持久化 → 保持默认', async () => {
    mockedGet.mockResolvedValue(null);
    const store = useFileBrowserStore();
    await store.loadLayout();
    expect(store.sortField).toBe('name');
    expect(store.viewMode).toBe('details');
    expect(store.hideFinished).toBe(false);
  });
});

describe('fileBrowser store — v0.1.0-module3.0 集成', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('fetch 成功后不调 recordHistory（仅目录浏览不进 history，进 reader 才进）', async () => {
    const { recordHistory } = await import('@/lib/tauri');
    mockedList.mockResolvedValue(makeEntries('Vol.01', 'Vol.02'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    // v0.1.0-module3.0.1: fetch 只列目录, 不写 history. recordHistory 由 useReaderActions.readNow 调.
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('fetch 失败不调 recordHistory', async () => {
    const { recordHistory } = await import('@/lib/tauri');
    mockedList.mockRejectedValue(new Error('io'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('setSortField 写 per-folder override（getDirectorySort null 时）', async () => {
    const { setDirectorySort } = await import('@/lib/tauri');
    mockedList.mockResolvedValue(makeEntries('Vol.01'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    store.setSortField('size');  // 同字段切换 → toggle
    store.setSortField('size');  // toggle 方向
    expect(setDirectorySort).toHaveBeenCalled();
  });
});

describe('fileBrowser store — searchQuery 进目录清空', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
  });

  it('setSearchQuery 写入 searchQuery', () => {
    const store = useFileBrowserStore();
    store.setSearchQuery('abc');
    expect(store.searchQuery).toBe('abc');
  });

  it('navigate 清空 searchQuery', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setSearchQuery('abc');
    expect(store.searchQuery).toBe('abc');
    await store.navigate('sub');
    expect(store.searchQuery).toBe('');
  });

  it('setRoot 清空 searchQuery', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setSearchQuery('abc');
    await store.setRoot('C:/y');
    expect(store.searchQuery).toBe('');
  });
});

// ─── v0.1.0-module3.0.4-virtuallist Phase 1: toggleSelection in-place + triggerRef ───
// Ctrl+Click 取消大选中累积从 O(n²) → O(n). 1000 entries Ctrl+Click 取消 100 次:
// 之前 ~250ms (累积拷贝), 之后 < 50ms (in-place + triggerRef).
// 关键: selectedPaths 引用保持不变 (in-place), 但 triggerRef 强制响应式通知依赖者
// (selectedCount, selectedEntries, selectionSizeBytes computed).
describe('fileBrowser store — toggleSelection in-place', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('toggleSelection 不拷贝 Set, 引用不变', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => makeEntry(`f${i}.txt`)),
    )
    const fb = useFileBrowserStore()
    await fb.setRoot('C:/x')
    fb.replaceSelection('f0.txt')
    const refBefore = fb.selectedPaths
    fb.toggleSelection('f0.txt')
    // in-place 模式下 selectedPaths 引用保持不变 (新实现);
    // 旧实现 `selectedPaths.value = new Set(...)` 会换引用, 这里会 FAIL.
    expect(fb.selectedPaths).toBe(refBefore)
    expect(fb.selectedPaths.has('f0.txt')).toBe(false)
  })

  it('toggleSelection 响应式通知: triggerRef 强制 watcher 重算', async () => {
    const { watch } = await import('vue')
    mockedList.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeEntry(`f${i}.txt`)),
    )
    const fb = useFileBrowserStore()
    await fb.setRoot('C:/x')
    let computeCount = 0
    // 订阅 selectedCount (computed → ref selectedPaths): toggle 后必须重算.
    // flush: 'sync' 让 watcher 回调在 trigger 后立即执行, 避免 post-flush 时序导致断言在 flush 之前跑完.
    const stop = watch(
      () => fb.selectedCount,
      () => { computeCount++ },
      { flush: 'sync' },
    )
    fb.replaceSelection('f0.txt')
    computeCount = 0  // 重置 baseline (初始化选中也触发 watcher)
    fb.toggleSelection('f0.txt')
    expect(computeCount).toBeGreaterThan(0)
    stop()
  })

  it('Ctrl+Click 连续取消大集合: O(n) per call, 总 O(n) 不是 O(n²)', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => makeEntry(`f${i}.txt`)),
    )
    const fb = useFileBrowserStore()
    await fb.setRoot('C:/x')
    // 选前 1000 个: replaceSelection(1) + 999 个 toggle add (累积增长 1→2→...→1000)
    const allPaths = Array.from({ length: 1000 }, (_, i) => `f${i}.txt`)
    fb.replaceSelection(allPaths[0])
    for (let i = 1; i < 1000; i++) fb.toggleSelection(allPaths[i])
    expect(fb.selectedPaths.size).toBe(1000)
    // 连续 Ctrl+Click 取消 100 个 (旧实现每次 new Set 拷贝 ~10μs, 累积 O(n²); 新实现 in-place + triggerRef)
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) fb.toggleSelection(allPaths[i])
    const t1 = performance.now()
    expect(t1 - t0).toBeLessThan(50)  // 100 次 in-place 操作应 < 50ms
    expect(fb.selectedPaths.size).toBe(900)
  })
});

// ─── v0.1.0-module3.0.4-virtuallist Phase 1: selectRange pathIndex O(1) ───
// 14949 entries 目录的 Shift+Click 范围选择从 O(n) indexOf × 2 → O(1) Map 查找.
describe('fileBrowser store — selectRange pathIndex O(1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('shift+click 大范围选择用 pathIndex 选中正确子集', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => makeEntry(`f${i}.txt`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    fb.selectRange('f10.txt', 'f20.txt');
    expect(fb.selectedPaths.size).toBe(11);
    expect(fb.selectedPaths.has('f15.txt')).toBe(true);
  });

  it('selectRange 反向范围 (to < from) 也正确', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => makeEntry(`f${i}.txt`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    fb.selectRange('f80.txt', 'f20.txt');
    expect(fb.selectedPaths.size).toBe(61);
    expect(fb.selectedPaths.has('f50.txt')).toBe(true);
  });

  it('selectRange 路径不存在 → no-op (保留先前 selection)', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeEntry(`f${i}.txt`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    fb.replaceSelection('f0.txt');
    expect(fb.selectedPaths.size).toBe(1);
    fb.selectRange('f0.txt', 'nonexistent.txt');
    expect(fb.selectedPaths.size).toBe(1);
  });

  it('pathIndex 与 sortedEntries 同步 (entries 无序 → sort 后按 sorted 顺序)', async () => {
    mockedList.mockResolvedValue([
      makeEntry('c.txt'),
      makeEntry('a.txt'),
      makeEntry('b.txt'),
    ]);
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    // entries 顺序 [c, a, b], sortedEntries 顺序 [a, b, c]
    fb.selectRange('a.txt', 'c.txt');
    expect(fb.selectedPaths.size).toBe(3);
    expect(fb.selectedPaths.has('a.txt')).toBe(true);
    expect(fb.selectedPaths.has('b.txt')).toBe(true);
    expect(fb.selectedPaths.has('c.txt')).toBe(true);
  });
});

// ─── v0.1.0-module3.0.4-virtuallist Phase 3: store pathIndex 暴露 + scrollToPath action + setScrollToIndexCallback ───
// FileList 组件实例方法 scrollToPath 通过模块级 callback 注册机制反向传给 store.
// FileBrowser 在 onMounted 调 setScrollToIndexCallback(fileListRef.scrollToPath).
describe('fileBrowser store — pathIndex 暴露 + scrollToPath action + setScrollToIndexCallback', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    // callback 是模块级 state, 测试间必须手动清零避免污染
    setScrollToIndexCallback(null);
  });

  it('pathIndex 已 export, 可通过 fb.pathIndex 访问', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeEntry(`f${i}`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    expect(fb.pathIndex).toBeInstanceOf(Map);
    expect(fb.pathIndex.get('f5')).toBe(5);
  });

  it('scrollToPath 没注册 callback → no-op', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeEntry(`f${i}`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    // 没注册 callback, 不应抛错
    expect(() => fb.scrollToPath('f5')).not.toThrow();
  });

  it('setScrollToIndexCallback + scrollToPath 联动: callback 被调用', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => makeEntry(`f${i}`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    const cb = vi.fn();
    setScrollToIndexCallback(cb);
    fb.scrollToPath('f50');
    expect(cb).toHaveBeenCalledWith(50, undefined);
  });

  it('scrollToPath 透传 opts (align=center)', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeEntry(`f${i}`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    const cb = vi.fn();
    setScrollToIndexCallback(cb);
    fb.scrollToPath('f5', { align: 'center' });
    expect(cb).toHaveBeenCalledWith(5, { align: 'center' });
  });

  it('scrollToPath 路径不存在 callback 不调', async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeEntry(`f${i}`)),
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/x');
    const cb = vi.fn();
    setScrollToIndexCallback(cb);
    fb.scrollToPath('nonexistent');
    expect(cb).not.toHaveBeenCalled();
  });
});
