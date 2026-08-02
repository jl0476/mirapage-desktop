/**
 * fileBrowser store 单测 — 模块 #1
 * v0.1.0-module1.22: 升维度 — sortField / viewMode / selectedPaths / hideFinished
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFileBrowserStore } from './fileBrowser';
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

  it('setViewMode 写入 settings', async () => {
    mockedList.mockResolvedValue([]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setViewMode('grid');
    expect(store.viewMode).toBe('grid');
    expect(mockedSet).toHaveBeenCalledWith('fb_view_mode', 'grid');
  });

  it('setHideFinished 写入 settings', async () => {
    mockedList.mockResolvedValue([]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setHideFinished(true);
    expect(store.hideFinished).toBe(true);
    expect(mockedSet).toHaveBeenCalledWith('fb_hide_finished', '1');
  });

  it('loadLayout 读 settings 恢复状态', async () => {
    mockedGet.mockImplementation(async (key) => {
      if (key === 'fb_sort_field') return 'size';
      if (key === 'fb_sort_ascending') return '0';
      if (key === 'fb_view_mode') return 'grid';
      if (key === 'fb_hide_finished') return '1';
      return null;
    });
    const store = useFileBrowserStore();
    await store.loadLayout();
    expect(store.sortField).toBe('size');
    expect(store.sortAscending).toBe(false);
    expect(store.viewMode).toBe('grid');
    expect(store.hideFinished).toBe(true);
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
