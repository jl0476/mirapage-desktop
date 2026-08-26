/**
 * fileBrowser store 单测 — 模块 #1
 * v0.1.0-module1.22: 升维度 — sortField / viewMode / selectedPaths / hideFinished
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFileBrowserStore, setScrollToIndexCallback } from './fileBrowser';
import {
  listDirectory, getSetting, setSetting, listAccounts,
  beginArchiveSession, prepareArchive, unlockArchive, commitArchiveOpen, cancelArchivePrepare,
} from '@/lib/tauri';
import type { ArchivePrepareResult, ArchiveRequestId } from '@/lib/tauri';
import { useShortcutsStore } from '@/stores/shortcuts';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';

// 终审二批 P2-2：捕获 archive://progress 回调（startArchiveProgressListener 区域用）
// 任务 12：载荷升级——requestId（候选关联 id；进入后的后台事件固定 null）+
// progressKey（Ready 保存的 opaque key，后台分支唯一匹配源）。
type ArchiveProgressEvent = {
  requestId: ArchiveRequestId | null;
  progressKey: string;
  relPath: string;
  downloaded: number;
  totalBytes: number;
  phase: string;
};
type ArchiveProgressCb = (event: { payload: ArchiveProgressEvent }) => void;
let capturedArchiveProgressCb: ArchiveProgressCb | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_ev: string, cb: ArchiveProgressCb) => {
    capturedArchiveProgressCb = cb;
    return () => { capturedArchiveProgressCb = null; };
  }),
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listDirectory: vi.fn(),
    // module3.5.0 后续: setCurrentDirAsRoot 查账户 share 用
    listAccounts: vi.fn(async () => []),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined),
    recordHistory: vi.fn(async () => undefined),
    getDirectorySort: vi.fn(async () => null),
    setDirectorySort: vi.fn(async () => undefined),
    // 任务 12（简报步骤 1 逐字）：事务式 archive IPC 五命令 mock
    beginArchiveSession: vi.fn((_sessionId: string, bootMs: number) => Promise.resolve(bootMs)), // 数字返回契约：正常安装返回自身 boot
    prepareArchive: vi.fn(async () => ({ status: 'ready', accessMode: 'local' as const, progressKey: null })),
    unlockArchive: vi.fn(async () => ({ status: 'ready', accessMode: 'local' as const, progressKey: null })),
    commitArchiveOpen: vi.fn(async () => undefined),
    cancelArchivePrepare: vi.fn(async () => undefined),
  };
});
const mockedList = vi.mocked(listDirectory);
const mockedAccounts = vi.mocked(listAccounts);
const mockedGet = vi.mocked(getSetting);
const mockedSet = vi.mocked(setSetting);

function makeEntries(...names: string[]): MediaEntry[] {
  return names.map((n) => ({
    name: n,
    path: n,
    isDirectory: !n.includes('.'),
    isArchive: /\.(cbz|zip|cbr|rar|7z)$/i.test(n),
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

/** 任务 12：手动控制 resolve 时机的 deferred（事务时序测试用） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 任务 12：远程源测试固定 webdav descriptor */
function webdavRoot(): SourceDescriptor {
  return { type: 'webdav', accountId: 7, baseUrl: 'https://dav.example', path: '' };
}

/** 任务 12：发一条 archive://progress 事件（监听未挂时惰性挂载——mock 的 listen
 *  回调捕获在调用同步段完成，无需 flush） */
function emitArchiveProgress(payload: ArchiveProgressEvent): void {
  if (!capturedArchiveProgressCb) {
    useFileBrowserStore().startArchiveProgressListener();
  }
  capturedArchiveProgressCb!({ payload });
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

  it('非 Local descriptor 在无本地 root 时仍有活动数据源', async () => {
    const descriptor: SourceDescriptor = {
      type: 'webdav', accountId: 7, baseUrl: 'https://dav.example', path: '',
    };
    mockedList.mockResolvedValue(makeEntries('page1.jpg'));
    const store = useFileBrowserStore();
    await store.openDescriptorAt(descriptor, '');
    expect(store.rootPath).toBeNull();
    expect(store.hasActiveSource).toBe(true);
    expect(mockedList).toHaveBeenCalledWith(descriptor, '');
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

  // ─── 路径身份修复 (2026-08-12): navigate/fetch 拒绝越界路径 ───
  // 绝对路径只允许出现在 rootPath; navigate 接收的 path 必须相对 root.
  // 校验失败不改 currentPath、不发 IPC。

  it('navigate 拒绝盘符绝对路径, currentPath 不变, 不发 IPC', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    vi.clearAllMocks(); // 清掉 setRoot 的 IPC
    await store.navigate('F:/WallPaper');
    expect(store.currentPath).toBe(''); // 未被改成 'F:/WallPaper'
    expect(mockedList).not.toHaveBeenCalled();
    expect(store.error?.kind).toBe('io');
  });

  it('navigate 拒绝反斜杠绝对路径', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    vi.clearAllMocks();
    await store.navigate('F:\\WallPaper');
    expect(store.currentPath).toBe('');
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('navigate 拒绝 .. 遍历', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    await store.navigate('sub');
    vi.clearAllMocks();
    await store.navigate('../etc');
    // currentPath 应停在之前的 'sub' (校验失败不改 state)
    expect(store.currentPath).toBe('sub');
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('navigate 接受根目录空串', async () => {
    mockedList.mockResolvedValue(makeEntries('root_item'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    vi.clearAllMocks();
    mockedList.mockResolvedValue(makeEntries('root_item'));
    await store.navigate('');
    expect(store.currentPath).toBe('');
    expect(mockedList).toHaveBeenCalledWith({ type: 'local', rootPath: 'C:/comics' }, '');
  });

  it('up() 在被污染的绝对 currentPath 下防御性拒绝, 留在原处', async () => {
    // 模拟 currentPath 被历史污染成绝对路径（不应发生，但防御）
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    // 直接操纵 currentPath 模拟污染
    store.currentPath = 'F:/WallPaper';
    vi.clearAllMocks();
    await store.up();
    // up 计算 parent = 'F:' (盘符), 校验拒绝 → 不 fetch
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('restoreNavigationContext: 恢复被污染的绝对 currentPath → 停在根目录', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    await store.navigate('sub');
    // 注入被污染的上下文（模拟旧版本写入的绝对路径）
    store.saveNavigationContext();
    // 直接改 store 内部状态模拟污染（restoreNavigationContext 读 savedNavigationContext）
    // 通过 navigate 到一个合法路径后 save, 再模拟污染
    store.currentPath = 'F:/WallPaper'; // 污染
    store.saveNavigationContext();
    store.currentPath = ''; // 重置
    vi.clearAllMocks();
    mockedList.mockResolvedValue(makeEntries('root'));
    const ok = await store.restoreNavigationContext();
    expect(ok).toBe(true);
    // currentPath 非法 → 停在根目录 ''
    expect(store.currentPath).toBe('');
  });

  // ─── 路径身份修复 (2026-08-12): 异步导航身份防护 (spec §6.5) ───
  // 跨 root/跨目录并发请求乱序返回时, 仅最新请求可回写 entries/lastFetchedPath.

  it('fetch 乱序: 旧请求晚返回不覆盖最新 entries', async () => {
    // 模拟: navigate('slow') 发出慢请求, navigate('fast') 发出快请求并先返回,
    //       然后 slow 才返回 — slow 的回写必须被丢弃。
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    // 用 deferred 手动控制两个请求的 resolve 顺序。
    let resolveSlow!: (v: MediaEntry[]) => void;
    let resolveFast!: (v: MediaEntry[]) => void;
    const slowPromise = new Promise<MediaEntry[]>((r) => { resolveSlow = r; });
    const fastPromise = new Promise<MediaEntry[]>((r) => { resolveFast = r; });

    // 第一次调用返 slowPromise, 第二次返 fastPromise
    let callCount = 0;
    mockedList.mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? slowPromise : fastPromise;
    });

    const slowP = store.navigate('slow');
    const fastP = store.navigate('fast');

    // fast 先 resolve（最新请求）, slow 后 resolve（过期）
    resolveFast(makeEntries('fast_item'));
    await fastP;
    resolveSlow(makeEntries('slow_item'));
    await slowP;

    // entries 必须是 fast 的, 不能被 slow 覆盖
    expect(store.entries.map((e) => e.name)).toEqual(['fast_item']);
    expect(store.lastFetchedPath).toBe('fast');
    expect(store.currentPath).toBe('fast');
  });

  it('setRoot(null) 使在途 fetch 失效, 旧请求回写被丢弃', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    let resolveFetch!: (v: MediaEntry[]) => void;
    const fetchPromise = new Promise<MediaEntry[]>((r) => { resolveFetch = r; });
    mockedList.mockImplementation(() => fetchPromise);

    const navP = store.navigate('sub');
    // 在 fetch 完成前 setRoot(null) — 应失效在途请求
    const setRootP = store.setRoot(null);
    resolveFetch(makeEntries('should_not_appear'));
    await Promise.all([navP, setRootP]);

    // setRoot(null) 已清空 entries; 旧请求的回写不能让 entries 复活
    expect(store.entries).toEqual([]);
    expect(store.rootPath).toBeNull();
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

describe('fileBrowser store — pendingOpenLocation（likes 浏览跳转意图）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('requestOpenLocation 写入 → consume 返回并清空（一次性，descriptor 形态）', () => {
    const store = useFileBrowserStore();
    const desc = { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' } as const;
    store.requestOpenLocation(desc, 'VOL.11');
    expect(store.consumePendingOpenLocation()).toEqual({ descriptor: desc, relPath: 'VOL.11' });
    expect(store.consumePendingOpenLocation()).toBeNull();
  });

  it('无意图时 consume 返回 null', () => {
    const store = useFileBrowserStore();
    expect(store.consumePendingOpenLocation()).toBeNull();
  });

  it('requestOpenLocation 清空 savedNavigationContext（新意图取代残留上下文）', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/old');
    store.saveNavigationContext();
    store.requestOpenLocation({ type: 'local', rootPath: 'C:/comics' }, '');
    expect(await store.restoreNavigationContext()).toBe(false);
  });

  it('requestOpenLocation 清空 shortcuts.activeId（防重挂载重放旧快捷方式）', () => {
    const store = useFileBrowserStore();
    const shortcuts = useShortcutsStore();
    shortcuts.setActive(3);
    store.requestOpenLocation({ type: 'local', rootPath: 'C:/comics' }, '');
    expect(shortcuts.activeId).toBeNull();
  });

  // ─── module3.2.0: openDescriptorAt（四类源打开指定目录）───

  it('openDescriptorAt(Local)：转 setRoot + navigate（rootPath 语义不变）', async () => {
    mockedList.mockResolvedValue(makeEntries('a.jpg'));
    const store = useFileBrowserStore();
    await store.openDescriptorAt({ type: 'local', rootPath: 'C:/comics' }, 'VOL.11');
    expect(mockedList).toHaveBeenLastCalledWith(
      { type: 'local', rootPath: 'C:/comics' }, 'VOL.11');
    expect(store.rootPath).toBe('C:/comics');
    expect(store.currentPath).toBe('VOL.11');
  });

  it('openDescriptorAt(webdav)：currentDescriptor 置入 + 该源取数', async () => {
    mockedList.mockResolvedValue(makeEntries('a.jpg'));
    const store = useFileBrowserStore();
    const desc = { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' } as const;
    await store.openDescriptorAt(desc, 'comics/v1');
    expect(mockedList).toHaveBeenLastCalledWith(desc, 'comics/v1');
    expect(store.currentPath).toBe('comics/v1');
    expect(store.currentDescriptor).toEqual(desc);
  });

  it('openDescriptorAt 后 navigate 仍走 currentDescriptor（非 Local 持续生效）', async () => {
    mockedList.mockClear();
    mockedList.mockResolvedValue(makeEntries('b.jpg'));
    const store = useFileBrowserStore();
    const desc = { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' } as const;
    await store.openDescriptorAt(desc, '');
    mockedList.mockClear();
    await store.navigate('sub');
    expect(mockedList).toHaveBeenLastCalledWith(desc, 'sub');
  });

  it('setRoot 重置 currentDescriptor（回 Local 语义）', async () => {
    mockedList.mockResolvedValue(makeEntries('a.jpg'));
    const store = useFileBrowserStore();
    await store.openDescriptorAt({ type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' }, '');
    await store.setRoot('C:/comics');
    expect(store.currentDescriptor).toBeNull();
    expect(mockedList).toHaveBeenLastCalledWith({ type: 'local', rootPath: 'C:/comics' }, '');
  });

  // ─── module3.2.0（spec §3.3）: ZIP 进入/退出 ───

  it('openArchive：构造 Archive descriptor（绝对路径）并保存返回上下文', async () => {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const store = useFileBrowserStore();
    await store.setRoot('F:/comics');
    await store.navigate('sub');
    const entry = makeEntry('book.cbz', { isArchive: true });
    await store.openArchive(entry);
    // M3 任务 7：archiveParent 形态升级 { descriptor, relPath }（原 { rootPath, path }）
    expect(store.archiveParent).toEqual({
      descriptor: { type: 'local', rootPath: 'F:/comics' },
      relPath: 'sub',
    });
    expect(store.currentDescriptor?.type).toBe('archive');
    expect((store.currentDescriptor as { archivePath: string }).archivePath).toBe('F:/comics/sub/book.cbz'); // 绝对路径（rev2 §3.3）
    expect(mockedList).toHaveBeenLastCalledWith(store.currentDescriptor, '');
  });

  it('exitArchive：恢复进入前目录', async () => {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const store = useFileBrowserStore();
    await store.setRoot('F:/comics');
    await store.navigate('sub');
    await store.openArchive(makeEntry('book.cbz', { isArchive: true }));
    await store.exitArchive();
    expect(store.archiveParent).toBeNull();
    expect(store.currentDescriptor).toBeNull();
    expect(store.rootPath).toBe('F:/comics');
    expect(store.currentPath).toBe('sub');
    expect(mockedList).toHaveBeenLastCalledWith({ type: 'local', rootPath: 'F:/comics' }, 'sub');
  });

  it('ZIP 内 navigate 到顶层再 up() 触发 exitArchive', async () => {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const store = useFileBrowserStore();
    await store.setRoot('F:/comics');
    await store.openArchive(makeEntry('book.cbz', { isArchive: true }));
    expect(store.currentPath).toBe('');
    await store.up();
    expect(store.archiveParent).toBeNull(); // 已退出
    expect(mockedList).toHaveBeenLastCalledWith({ type: 'local', rootPath: 'F:/comics' }, '');
  });

  // ─── M3 任务 7: openArchive 泛化（远程源虚拟路径 + origin descriptor）───

  it('openArchive 远程源：构造 origin descriptor + 虚拟 archivePath + descriptor 形态 parent', async () => {
    mockedList.mockResolvedValue(makeEntries('book.cbz', 'p1.jpg'));
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(
      { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' }, 'comics');
    const entry = makeEntry('book.cbz', { isArchive: true });
    await fb.openArchive(entry);
    expect(fb.archiveParent).toEqual({
      descriptor: { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' },
      relPath: 'comics',
    });
    const d = fb.currentDescriptor;
    expect(d?.type).toBe('archive');
    if (d?.type !== 'archive') return;
    expect(d.origin?.type).toBe('webdav');
    expect(d.archiveRelPath).toBe('comics/book.cbz');
    expect(d.originEntryPath).toBe('comics/book.cbz');
    expect(d.archivePath).toBe('https://d/x/comics/book.cbz'); // 虚拟 URL 形态
    expect(mockedList).toHaveBeenLastCalledWith(d, '');
  });

  it('openArchive SMB 源：虚拟 archivePath 契约 smb://{accountId}/{initialPath}/{rel}', async () => {
    mockedList.mockResolvedValue(makeEntries('book.cbz', 'p1.jpg'));
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(
      { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 }, '');
    const entry = makeEntry('book.cbz', { isArchive: true });
    await fb.openArchive(entry);
    const d = fb.currentDescriptor;
    expect(d?.type).toBe('archive');
    if (d?.type !== 'archive') return;
    expect(d.archivePath).toBe('smb://3/share/comics/book.cbz'); // rev3 契约（非 UNC，无 smbHostOf）
    expect(d.archiveRelPath).toBe('book.cbz');
    expect(d.origin?.type).toBe('smb');
  });

  it('exitArchive 恢复远程源目录（openDescriptorAt 复用）', async () => {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const fb = useFileBrowserStore();
    const desc: SourceDescriptor = { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' };
    await fb.openDescriptorAt(desc, 'comics');
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    await fb.exitArchive();
    expect(fb.archiveParent).toBeNull();
    expect(fb.currentDescriptor).toEqual(desc); // activeDescriptor 回 webdav
    expect(fb.currentPath).toBe('comics');
    expect(mockedList).toHaveBeenLastCalledWith(desc, 'comics');
  });

  it('本地源 openArchive 行为不变（零回归）', async () => {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const store = useFileBrowserStore();
    await store.setRoot('F:/comics');
    await store.navigate('sub');
    await store.openArchive(makeEntry('book.cbz', { isArchive: true }));
    // descriptor 形态 parent（Local descriptor + relPath）
    expect(store.archiveParent).toEqual({
      descriptor: { type: 'local', rootPath: 'F:/comics' },
      relPath: 'sub',
    });
    const d = store.currentDescriptor;
    expect(d?.type).toBe('archive');
    if (d?.type !== 'archive') return;
    // archivePath 仍是绝对路径（module3.2.0 语义不变）；本地源无 origin 字段
    expect(d.archivePath).toBe('F:/comics/sub/book.cbz');
    expect(d.origin).toBeUndefined();
    expect(d.archiveRelPath).toBeUndefined();
    expect(d.format).toBe('cbz');
    expect(mockedList).toHaveBeenLastCalledWith(d, '');
  });
});

// ─── 任务 12: archive://progress 双分支匹配（候选 requestId / 后台 progressKey）───
// 旧 relPath 匹配已被契约废除：候选事件只认 pending 的 requestId（两字段相等），
// 进入后的后台物化事件固定 requestId=null、只认 Ready 保存的 opaque progressKey。
describe('fileBrowser store — archive://progress 过滤', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    capturedArchiveProgressCb = null;
  });

  /** 进入远程压缩包（webdav comics/book.cbz，streaming + opaque key）并挂监听 */
  async function setupStreamingArchive(progressKey: string) {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(
      { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' }, 'comics');
    vi.mocked(prepareArchive).mockResolvedValueOnce({
      status: 'ready', accessMode: 'streaming', progressKey,
    });
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    fb.startArchiveProgressListener();
    expect(capturedArchiveProgressCb).toBeTruthy();
    return fb;
  }

  const emitBg = (progressKey: string, downloaded: number, totalBytes: number, phase = 'downloading') =>
    emitArchiveProgress({ requestId: null, progressKey, relPath: 'comics/book.cbz', downloaded, totalBytes, phase });

  it('另一 key 的后台事件（预载其他 CBZ）不写入 archiveProgress', async () => {
    const fb = await setupStreamingArchive('opaque-key');
    emitBg('other-key', 50, 100);
    expect(fb.archiveProgress).toBeNull();
    // 匹配的 key 正常写入
    emitBg('opaque-key', 30, 100);
    expect(fb.archiveProgress).toEqual({ downloaded: 30, total: 100 });
    // 再来一个不匹配的也不覆盖已有进度
    emitBg('other-key', 99, 100);
    expect(fb.archiveProgress).toEqual({ downloaded: 30, total: 100 });
  });

  it('匹配 key 的 ready 事件清空 archiveProgress（防陈旧数字残留）', async () => {
    const fb = await setupStreamingArchive('opaque-key');
    emitBg('opaque-key', 30, 100);
    expect(fb.archiveProgress).toEqual({ downloaded: 30, total: 100 });
    emitBg('opaque-key', 100, 100, 'ready');
    expect(fb.archiveProgress).toBeNull();
  });

  it('本地 ZIP（progressKey null）与无 pending 时的 requestId 事件均不消费', async () => {
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    fb.startArchiveProgressListener();
    expect(fb.currentDescriptor?.type).toBe('archive');
    // 后台分支：无 progressKey（local 直开 Ready 无 key）→ 拒绝
    emitArchiveProgress({ requestId: null, progressKey: 'any-key', relPath: 'book.cbz', downloaded: 50, totalBytes: 100, phase: 'downloading' });
    // 候选分支：无 pending（open 已完成）→ 拒绝
    emitArchiveProgress({ requestId: { sessionId: 'sid', sequence: 1 }, progressKey: 'any-key', relPath: 'book.cbz', downloaded: 50, totalBytes: 100, phase: 'downloading' });
    expect(fb.archiveProgress).toBeNull();
  });
});

// ─── 任务 12: 事务式 openArchive（prepare → Ready → 原子提交导航 → commit 握手）───
describe('fileBrowser store — 事务式 archive 打开', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    capturedArchiveProgressCb = null;
    mockedList.mockResolvedValue(makeEntries('p1.jpg'));
    // 防御：clearAllMocks 不清 implementation，上一用例的永久 mock
    // （mockRejectedValue / mockReturnValue(new Promise(...))）不能泄漏进本用例。
    vi.mocked(beginArchiveSession).mockImplementation((_s: string, bootMs: number) => Promise.resolve(bootMs));
    vi.mocked(prepareArchive).mockImplementation(async () => ({ status: 'ready', accessMode: 'local' as const, progressKey: null }));
    vi.mocked(unlockArchive).mockImplementation(async () => ({ status: 'ready', accessMode: 'local' as const, progressKey: null }));
    vi.mocked(commitArchiveOpen).mockImplementation(async () => undefined);
    vi.mocked(cancelArchivePrepare).mockImplementation(async () => undefined);
  });

  it('prepare ready 后才原子提交 archive 导航', async () => {
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');
    await fb.navigate('sub');
    const pending = deferred<ArchivePrepareResult>();
    vi.mocked(prepareArchive).mockReturnValueOnce(pending.promise);
    const opening = fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
    expect(fb.currentPath).toBe('sub');
    expect(fb.currentDescriptor).toBeNull();
    pending.resolve({ status: 'ready', accessMode: 'local', progressKey: null });
    await opening;
    expect(fb.currentPath).toBe('');
    expect(fb.currentDescriptor).toMatchObject({ type: 'archive', format: 'cbr' });
    expect(commitArchiveOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String), sequence: 1 }));
  });

  it('password-required 不污染原导航', async () => {
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');
    await fb.navigate('sub');
    vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
    await fb.openArchive(makeEntry('book.7z', { isArchive: true }));
    expect(fb.pendingArchivePassword?.descriptor.format).toBe('7z');
    expect(fb.currentPath).toBe('sub');
    expect(fb.currentDescriptor).toBeNull();
    fb.cancelArchivePassword();
    expect(fb.pendingArchivePassword).toBeNull();
    expect(fb.currentPath).toBe('sub');
  });

  it.each([
    'multiVolumeUnsupported',
    'resourceLimitExceeded',
    'network',
    'corruptArchive',
  ] as const)('prepare %s 进入结构化错误状态且不污染原导航', async (kind) => {
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');
    await fb.navigate('sub');
    vi.mocked(prepareArchive).mockRejectedValueOnce({ kind });
    await fb.openArchive(makeEntry('book.7z', { isArchive: true }));
    expect(fb.archiveOpenError).toMatchObject({ kind });
    expect(fb.currentPath).toBe('sub');
    expect(fb.currentDescriptor).toBeNull();
    expect(fb.archiveOpening).toBe(false);
  });

  it('错误密码保留请求，正确密码提交候选导航', async () => {
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');
    vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    vi.mocked(unlockArchive).mockRejectedValueOnce({ kind: 'wrongPassword' });
    await expect(fb.submitArchivePassword('bad')).rejects.toMatchObject({ kind: 'wrongPassword' });
    expect(fb.pendingArchivePassword).not.toBeNull();
    vi.mocked(unlockArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
    await fb.submitArchivePassword('secret');
    expect(fb.pendingArchivePassword).toBeNull();
    expect(fb.currentDescriptor?.type).toBe('archive');
  });

  it('候选未提交时消费物化进度，取消后丢弃迟到回包与事件', async () => {
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(webdavRoot(), 'comics');
    const pending = deferred<ArchivePrepareResult>();
    vi.mocked(prepareArchive).mockReturnValueOnce(pending.promise);
    const opening = fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
    expect(fb.archiveOpening).toBe(true);
    await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
    const oldRequestId = fb.pendingArchiveOpen!.requestId;
    emitArchiveProgress({ requestId: oldRequestId, progressKey: 'candidate-key', relPath: 'comics/book.cbr', downloaded: 4, totalBytes: 10, phase: 'downloading' });
    expect(fb.archiveProgress).toEqual({ downloaded: 4, total: 10 });
    fb.cancelArchiveOpen();
    expect(cancelArchivePrepare).toHaveBeenCalledWith(oldRequestId);
    pending.resolve({ status: 'ready', accessMode: 'materialized', progressKey: 'opaque-old-key' });
    await opening;
    emitArchiveProgress({ requestId: oldRequestId, progressKey: 'opaque-old-key', relPath: 'comics/book.cbr', downloaded: 10, totalBytes: 10, phase: 'ready' });
    expect(fb.currentDescriptor).toMatchObject({ type: 'webdav' });
    expect(fb.archiveProgress).toBeNull();
    expect(fb.archiveOpening).toBe(false);
    expect(commitArchiveOpen).not.toHaveBeenCalled();
  });

  it('候选期间 navigate 推进 epoch：迟到 ready 不提交导航（spec §6.1）', async () => {
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(webdavRoot(), 'comics');
    const pending = deferred<ArchivePrepareResult>();
    vi.mocked(prepareArchive).mockReturnValueOnce(pending.promise);
    const opening = fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
    await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
    const oldRequestId = fb.pendingArchiveOpen!.requestId;
    // 候选物化期间（远程 RAR/7z 下载，秒到分钟级）用户页内导航 → 视为离开：
    // 原子摘走 pending/password/commit-pending id 并 best-effort 后端取消
    await fb.navigate('elsewhere');
    expect(cancelArchivePrepare).toHaveBeenCalledWith(oldRequestId);
    expect(fb.pendingArchiveOpen).toBeNull();
    expect(fb.currentPath).toBe('elsewhere');
    pending.resolve({ status: 'ready', accessMode: 'materialized', progressKey: 'opaque-key' });
    await opening;
    // 迟到 ready 不提交导航：currentDescriptor/currentPath 不被 archive 覆写（导航劫持）
    expect(fb.currentDescriptor).toMatchObject({ type: 'webdav' });
    expect(fb.currentPath).toBe('elsewhere');
    expect(commitArchiveOpen).not.toHaveBeenCalled();
    expect(fb.archiveOpening).toBe(false);
  });

  it('替换取消窗口内导航使新请求整体失效（deferred-cancel，复审 P1-3）', async () => {
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(webdavRoot(), 'comics');
    // 第一次打开挂起（制造 pending）；第二次打开 supersede 且 cancel IPC 挂起——
    // 清空三 ref 与注册新请求之间存在 await 窗口，守卫不得因 ref 全空而空过
    vi.mocked(prepareArchive).mockReturnValue(new Promise(() => {}));
    void fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
    await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
    const cancelGate = deferred<void>();
    vi.mocked(cancelArchivePrepare).mockReturnValueOnce(cancelGate.promise);
    const second = fb.openArchive(makeEntry('book2.cbr', { isArchive: true }));
    await vi.waitFor(() => expect(fb.pendingArchiveOpen).toBeNull());
    // 窗口内导航：epoch 被推进，第二次 open 的取消返回后整体失效
    await fb.navigate('elsewhere');
    expect(fb.currentPath).toBe('elsewhere');
    cancelGate.resolve();
    await second;
    // 两次请求都未发出 prepare：第一次在 ensure 恢复时 epoch 已失配丢弃，
    // 第二次在取消返回后整体失效（不注册不提交）
    expect(prepareArchive).not.toHaveBeenCalled();
    expect(fb.currentDescriptor).toMatchObject({ type: 'webdav' });
    expect(fb.currentPath).toBe('elsewhere');
    expect(commitArchiveOpen).not.toHaveBeenCalled();
    expect(fb.archiveOpening).toBe(false);
  });

  it('取消后立即重开同一路径时只接受新 requestId 的进度', async () => {
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(webdavRoot(), 'comics');
    vi.mocked(prepareArchive).mockReturnValue(new Promise(() => {}));
    void fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
    await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
    const oldId = fb.pendingArchiveOpen!.requestId;
    fb.cancelArchiveOpen();
    void fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
    await vi.waitFor(() => expect(fb.pendingArchiveOpen?.requestId).not.toBe(oldId));
    const newId = fb.pendingArchiveOpen!.requestId;
    expect(newId).not.toBe(oldId);
    emitArchiveProgress({ requestId: oldId, progressKey: 'old-key', relPath: 'comics/book.cbr', downloaded: 8, totalBytes: 10, phase: 'downloading' });
    expect(fb.archiveProgress).toBeNull();
    emitArchiveProgress({ requestId: newId, progressKey: 'new-key', relPath: 'comics/book.cbr', downloaded: 2, totalBytes: 10, phase: 'downloading' });
    expect(fb.archiveProgress).toEqual({ downloaded: 2, total: 10 });
  });

  it('新 open 取消 commit-pending 的旧 Prepared，再注册唯一的新 request', async () => {
    const fb = useFileBrowserStore();
    const firstCommit = deferred<void>();
    vi.mocked(prepareArchive)
      .mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null })
      .mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
    vi.mocked(commitArchiveOpen).mockReturnValueOnce(firstCommit.promise);
    const openingOld = fb.openArchive(makeEntry('old.cbz', { isArchive: true }));
    // 旧请求已 Ready：本地导航已提交、commit IPC 挂起 → Prepared/commit-pending 确实存在
    await vi.waitFor(() => expect(fb.archiveCommitPendingId).not.toBeNull());
    const oldId = fb.archiveCommitPendingId!;
    const openingNew = fb.openArchive(makeEntry('new.cbz', { isArchive: true }));
    await vi.waitFor(() => expect(vi.mocked(prepareArchive).mock.calls.length).toBe(2));
    // 新 open 先 cancel 该 commit-pending id，cancel 完成后才注册第二个 prepare
    expect(cancelArchivePrepare).toHaveBeenCalledWith(oldId);
    expect(vi.mocked(cancelArchivePrepare).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(prepareArchive).mock.invocationCallOrder[1]);
    firstCommit.resolve(); // 迟到的旧 commit 回包不得污染新导航
    await Promise.all([openingOld, openingNew]);
    expect(fb.currentDescriptor).toMatchObject({ archivePath: expect.stringContaining('new.cbz') });
    expect(fb.archiveCommitPendingId).toBeNull(); // 新请求自己的 commit 已成功清位
  });

  it('commit 暂时失败时用同一 id 重试且只启动一次预载', async () => {
    const fb = useFileBrowserStore();
    vi.mocked(commitArchiveOpen)
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValueOnce(undefined);
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    expect(commitArchiveOpen).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commitArchiveOpen).mock.calls[0][0])
      .toEqual(vi.mocked(commitArchiveOpen).mock.calls[1][0]);
    expect(cancelArchivePrepare).not.toHaveBeenCalled();
  });

  it('commit 永久失败时保留导航、取消 Prepared 并回收后台 key', async () => {
    const fb = useFileBrowserStore();
    vi.mocked(prepareArchive).mockResolvedValueOnce({
      status: 'ready', accessMode: 'streaming', progressKey: 'server-key-42',
    });
    vi.mocked(commitArchiveOpen).mockRejectedValue(new Error('ipc unavailable'));
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    expect(fb.currentDescriptor).toMatchObject({ type: 'archive' });
    expect(commitArchiveOpen).toHaveBeenCalledTimes(3);
    expect(cancelArchivePrepare).toHaveBeenCalledWith(
      vi.mocked(commitArchiveOpen).mock.calls[2][0],
    );
    // 后台物化已被取消：key 回收，UI 不进入"后台缓存中"，任何 key 的迟到事件都不再更新进度
    expect(fb.archiveProgressKey).toBeNull();
    for (const key of ['client-derived-wrong', 'server-key-42']) {
      emitArchiveProgress({ requestId: null, progressKey: key, relPath: 'book.cbz', downloaded: 8, totalBytes: 10, phase: 'downloading' });
      expect(fb.archiveProgress).toBeNull();
    }
  });

  it('session 初始化失败写入 archiveOpenError 且下一次 open 重试', async () => {
    const fb = useFileBrowserStore();
    vi.mocked(beginArchiveSession).mockRejectedValueOnce(new Error('ipc unavailable'));
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true })); // openArchive 自身不得 reject
    expect(fb.archiveOpenError).toMatchObject({ kind: 'io' }); // 未结构化的 IPC 错误收敛为 io
    expect(prepareArchive).not.toHaveBeenCalled();
    expect(fb.archiveOpening).toBe(false);
    expect(fb.pendingArchiveOpen).toBeNull();
    vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    expect(fb.archiveOpenError).toBeNull();
    expect(fb.currentDescriptor?.type).toBe('archive');
  });

  it('时钟回拨恢复后 prepare 携带换代后的 sessionId', async () => {
    const fb = useFileBrowserStore();
    const resumedUuid = '0e2f9a55-1234-4c56-9abc-def012345678';
    const randomSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(resumedUuid);
    const futureBoot = Date.now() + 60_000;
    vi.mocked(beginArchiveSession)
      .mockResolvedValueOnce(futureBoot)      // 第一次 begin 返回更大生效代次 → 本页过期
      .mockResolvedValueOnce(futureBoot + 1); // 换代 begin 成功
    vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
    await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    expect(beginArchiveSession).toHaveBeenNthCalledWith(2, resumedUuid, futureBoot + 1);
    // requestId 必须取换代后的最终 session id，而不是模块加载时的旧 UUID
    expect(vi.mocked(prepareArchive).mock.calls[0][1].sessionId).toBe(resumedUuid);
    expect(fb.currentDescriptor?.type).toBe('archive'); // 最终成功，不是静默 Cancelled
    randomSpy.mockRestore();
  });

  it('commit 退避等待中被取消后不再发送陈旧 commit', async () => {
    vi.useFakeTimers();
    try {
      const fb = useFileBrowserStore();
      vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
      vi.mocked(commitArchiveOpen).mockRejectedValueOnce(new Error('ipc unavailable'));
      const opening = fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
      await vi.advanceTimersByTimeAsync(0); // 第一次 commit 已失败，任务进入 25ms 退避
      expect(commitArchiveOpen).toHaveBeenCalledTimes(1);
      const pendingId = fb.archiveCommitPendingId!;
      fb.cancelArchiveOpen(); // 退避窗口内用户取消：epoch 前进、cancel 已发出
      await vi.advanceTimersByTimeAsync(25); // 旧任务苏醒：epoch 已失效 → 不再发 commit，转入 cancel 清理
      expect(commitArchiveOpen).toHaveBeenCalledTimes(1);
      expect(cancelArchivePrepare).toHaveBeenCalledWith(pendingId);
      await opening;
      expect(fb.archiveCommitPendingId).toBeNull();
      expect(fb.archiveOpenError).toBeNull(); // 取消不显示错误
    } finally {
      vi.useRealTimers();
    }
  });

  // 简报步骤 5：五格式扩展各断言一次 format
  it.each(['cbz', 'cbr', 'zip', 'rar', '7z'] as const)('openArchive(book.%s) 构造对应 format', async (fmt) => {
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');
    await fb.openArchive(makeEntry(`book.${fmt}`, { isArchive: true }));
    const d = fb.currentDescriptor;
    expect(d?.type).toBe('archive');
    if (d?.type !== 'archive') return;
    expect(d.format).toBe(fmt);
  });
});

// ─── module3.5.0 后续: 远程会话「将当前目录设为根目录」───
describe('fileBrowser store — setCurrentDirAsRoot / canSetRootHere', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedList.mockResolvedValue(makeEntries('vol1'));
    mockedAccounts.mockResolvedValue([]);
  });

  it('canSetRootHere: 无源 / 本地 / 远程根 / 远程子目录 四态', async () => {
    const store = useFileBrowserStore();
    expect(store.canSetRootHere).toBe(false); // 无源
    await store.setRoot('C:/comics');
    expect(store.canSetRootHere).toBe(false); // 本地源不参与提升
    await store.openDescriptorAt({ type: 'webdav', accountId: 3, baseUrl: 'https://dav.example', path: '' }, '');
    expect(store.canSetRootHere).toBe(false); // 远程但停在根
    await store.navigate('comics');
    expect(store.canSetRootHere).toBe(true); // 远程子目录
  });

  it('SMB 空 initialPath（share 根）提升需查账户表补 share 首段', async () => {
    mockedAccounts.mockResolvedValue([
      { id: 7, name: 'NAS', type: 'smb', host: '192.168.50.168', port: 445, share: 'Other1' },
    ]);
    const store = useFileBrowserStore();
    await store.openDescriptorAt({ type: 'smb', accountId: 7, initialPath: '', path: '', port: 445 }, '');
    await store.navigate('wall');
    const ok = await store.setCurrentDirAsRoot();
    expect(ok).toBe(true);
    expect(store.currentDescriptor).toEqual({
      type: 'smb', accountId: 7, initialPath: 'Other1/wall', path: '', port: 445,
    });
    expect(store.currentPath).toBe('');
    expect(mockedList).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'smb', initialPath: 'Other1/wall' }), '',
    );
  });

  it('SMB 非空 initialPath 直接拼接（首段保持 = share，不再查账户表）', async () => {
    const store = useFileBrowserStore();
    await store.openDescriptorAt({ type: 'smb', accountId: 7, initialPath: 'Other1', path: '', port: 445 }, '');
    await store.navigate('wall/vol1');
    const ok = await store.setCurrentDirAsRoot();
    expect(ok).toBe(true);
    expect(store.currentDescriptor).toMatchObject({ type: 'smb', initialPath: 'Other1/wall/vol1' });
    expect(mockedAccounts).not.toHaveBeenCalled();
  });

  it('SMB share 根提升但账户已删 → false 且状态不变', async () => {
    mockedAccounts.mockResolvedValue([]);
    const store = useFileBrowserStore();
    await store.openDescriptorAt({ type: 'smb', accountId: 9, initialPath: '', path: '', port: 445 }, '');
    await store.navigate('wall');
    const ok = await store.setCurrentDirAsRoot();
    expect(ok).toBe(false);
    expect(store.currentDescriptor).toMatchObject({ type: 'smb', initialPath: '' });
    expect(store.currentPath).toBe('wall');
  });

  it('WebDAV 提升拼 path 段', async () => {
    const store = useFileBrowserStore();
    await store.openDescriptorAt({ type: 'webdav', accountId: 3, baseUrl: 'https://dav.example', path: '' }, '');
    await store.navigate('comics/manga');
    const ok = await store.setCurrentDirAsRoot();
    expect(ok).toBe(true);
    expect(store.currentDescriptor).toEqual({
      type: 'webdav', accountId: 3, baseUrl: 'https://dav.example', path: 'comics/manga',
    });
    expect(store.currentPath).toBe('');
  });

  it('远程 openDescriptorAt 清空旧选区（对齐 setRoot 语义）', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    store.replaceSelection('a');
    expect(store.selectedPaths.size).toBe(1);
    await store.openDescriptorAt({ type: 'webdav', accountId: 3, baseUrl: 'https://dav.example', path: '' }, '');
    expect(store.selectedPaths.size).toBe(0);
  });

  it('saveNavigationContext: 远程会话跳过保存（rootPath 是陈旧本地值不可作恢复身份）', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics'); // rootPath 留存陈旧本地值
    await store.openDescriptorAt({ type: 'smb', accountId: 7, initialPath: '', path: '', port: 445 }, '');
    await store.navigate('wall');
    store.saveNavigationContext();
    // 未保存 → restore 返回 false（ref 未导出，用行为断言）
    expect(await store.restoreNavigationContext()).toBe(false);
  });
});
