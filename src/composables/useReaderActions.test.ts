/**
 * useReaderActions.test.ts — v0.1.0-module3.0
 *
 * 验证:
 * - readNow: enumerate cover + createBook(favorite=false) → router.push
 * - addToLibrary: enumerate cover + createBook(favorite=true) → 不 router.push
 * - readFromImage (Cluster A): 双击图片 → 走父目录 ensureBookId + ?at=imageName
 * - 非目录: 返回 null 不调 IPC
 * - createBook 失败: 不 router.push
 * - onLibraryChanged: 调 readNow / addToLibrary 完成后触发
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    createBook: vi.fn(),
    listDirectory: vi.fn(),
    recordHistory: vi.fn(),
    getProgress: vi.fn(),
  };
});

vi.mock('vue-router', () => ({
  useRouter: () => null,
}));

import { createBook, listDirectory, recordHistory, getProgress, type ProgressItem } from '@/lib/tauri';
import { useReaderActions } from './useReaderActions';
import type { MediaEntry } from '@/lib/sourceDescriptor';

const fakeRouter = { push: vi.fn() } as unknown as { push: (path: string | { path: string; query?: Record<string, string> | undefined }) => Promise<void> } & { push: { mockImplementation: (fn: (path: string | { path: string; query?: Record<string, string> }) => Promise<void>) => void } };

function makeEntry(isDirectory: boolean, name = 'VOL.01'): MediaEntry {
  return {
    name,
    path: name,
    isDirectory,
    isArchive: false,
    size: 0,
    modifiedAt: 0,
  };
}

describe('useReaderActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readNow: enumerate 封面 + createBook(favorite=false) + recordHistory(bookId) + router.push', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(42);
    const onLibraryChanged = vi.fn();
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      router: fakeRouter as never,
      onLibraryChanged,
    });
    await actions.readNow(makeEntry(true));
    expect(listDirectory).toHaveBeenCalledWith({ type: 'local', rootPath: '/manga' }, 'VOL.01');
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'VOL.01',
        sourceDescriptor: { type: 'local', rootPath: '/manga' },
        absolutePath: 'VOL.01',
        sourceType: 'Local',
        favorite: false,
        pageCount: 0,
      }),
    );
    // v0.1.0-module3.0.1: recordHistory 携带 bookId
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/manga' },
      'VOL.01',
      'VOL.01',
      42,
    );
    expect(fakeRouter.push).toHaveBeenCalledWith('/reader/42');
    expect(onLibraryChanged).toHaveBeenCalled();
  });

  it('readNow: enumerate 有图片 → coverEntryPath/pageCount 填入', async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'page2.jpg', path: 'VOL.01/page2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 } as MediaEntry,
      { name: 'page1.jpg', path: 'VOL.01/page1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 } as MediaEntry,
    ]);
    vi.mocked(createBook).mockResolvedValue(1);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      router: fakeRouter as never,
    });
    await actions.readNow(makeEntry(true));
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({
        coverEntryPath: 'VOL.01/page1.jpg', // natural-sort: page1 < page2
        coverEntryName: 'page1.jpg',
        pageCount: 2,
      }),
    );
  });

  it('addToLibrary: 不 router.push, 不 recordHistory（仅 favorite=true, 阅读状态独立）', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(99);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      router: fakeRouter as never,
    });
    const result = await actions.addToLibrary(makeEntry(true));
    expect(result).toBe(99);
    expect(fakeRouter.push).not.toHaveBeenCalled();
    expect(createBook).toHaveBeenCalledWith(expect.objectContaining({ favorite: true }));
    // v0.1.0-module3.0.1: 加书库 ≠ 进 reader，不写 history
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('非目录: 返回 null, 不调 IPC', async () => {
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      router: fakeRouter as never,
    });
    await actions.readNow(makeEntry(false));
    expect(listDirectory).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });

  it('createBook 失败: 不 router.push', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockRejectedValue(new Error('DB locked'));
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      router: fakeRouter as never,
    });
    await actions.readNow(makeEntry(true));
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });

  // ─── Cluster A: readFromImage (双击图片 / 选中图片立即阅读) ───

  it('readFromImage: 用父目录合成 entry 调 ensureBookId + recordHistory(bookId) + router.push 带 ?at=', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(77);
    const onLibraryChanged = vi.fn();
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => 'VOL.01',
      router: fakeRouter as never,
      onLibraryChanged,
    });
    const imageEntry: MediaEntry = {
      name: 'page3.jpg',
      path: 'VOL.01/page3.jpg',
      isDirectory: false,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    };
    await actions.readFromImage(imageEntry);
    // enumerateCover 仍调 listDirectory (复用 cover 枚举)
    expect(listDirectory).toHaveBeenCalledWith({ type: 'local', rootPath: '/manga' }, 'VOL.01');
    // createBook 收的是父目录 (合成 isDirectory entry), favorite=false
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'VOL.01',
        sourceDescriptor: { type: 'local', rootPath: '/manga' },
        absolutePath: 'VOL.01',
        favorite: false,
      }),
    );
    // recordHistory 携带 bookId (针对父目录)
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/manga' },
      'VOL.01',
      'VOL.01',
      77,
    );
    // router.push 带 ?at=imageName (encodeURIComponent)
    expect(fakeRouter.push).toHaveBeenCalledWith({
      path: '/reader/77',
      query: { at: 'page3.jpg' },
    });
    expect(onLibraryChanged).toHaveBeenCalled();
  });

  it('readFromImage: imageName 含特殊字符时 URL encode 后传给 ?at=', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(1);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => 'VOL.01',
      router: fakeRouter as never,
    });
    await actions.readFromImage({
      name: 'c (1).jpg',
      path: 'VOL.01/c (1).jpg',
      isDirectory: false,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });
    expect(fakeRouter.push).toHaveBeenCalledWith({
      path: '/reader/1',
      query: { at: 'c%20(1).jpg' },
    });
  });

  it('readFromImage: getLastFetchedPath 为空 → 容错, 不 router.push', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(1);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      router: fakeRouter as never,
    });
    await actions.readFromImage({
      name: 'a.jpg',
      path: 'a.jpg',
      isDirectory: false,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });
    expect(listDirectory).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });

  it('readFromImage: createBook 失败 → 不 router.push', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockRejectedValue(new Error('DB locked'));
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => 'VOL.01',
      router: fakeRouter as never,
    });
    await actions.readFromImage({
      name: 'a.jpg',
      path: 'VOL.01/a.jpg',
      isDirectory: false,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });

  // ─── 嵌套目录路径修复 (v0.1.0-module3.0.3-hotfix) ───
  // Bug 1: MediaEntry.path 是相对 currentPath 的, 但 ensureBookId 之前误用为
  // 相对 rootPath, 嵌套目录下 listDirectory / recordHistory / createBook 全错.
  // 修复: 加 getCurrentPath 选项, ensureBookId 用 PathUtils.join 拼出 absPath.

  it('readNow 嵌套目录: currentPath="output" + entry.path="260715" → absPath="output/260715"', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(7);
    const actions = useReaderActions({
      resolveRootPath: () => 'U:/H/AI',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'output',  // 嵌套目录
      router: fakeRouter as never,
    });
    const nestedEntry: MediaEntry = {
      name: '260715',
      path: '260715',  // 相对 currentPath='output', 真实绝对 = U:/H/AI/output/260715
      isDirectory: true,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    };
    await actions.readNow(nestedEntry);
    expect(listDirectory).toHaveBeenCalledWith({ type: 'local', rootPath: 'U:/H/AI' }, 'output/260715');
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '260715',
        sourceDescriptor: { type: 'local', rootPath: 'U:/H/AI' },
        absolutePath: 'output/260715',
        sourceType: 'Local',
        favorite: false,
      }),
    );
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'U:/H/AI' },
      'output/260715',
      '260715',
      7,
    );
    expect(fakeRouter.push).toHaveBeenCalledWith('/reader/7');
  });

  it('addToLibrary 嵌套目录: enumerate cover + createBook.absolutePath 拼接 currentPath', async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'p1.jpg', path: 'output/260715/p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 } as MediaEntry,
      { name: 'p2.jpg', path: 'output/260715/p2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 } as MediaEntry,
    ]);
    vi.mocked(createBook).mockResolvedValue(33);
    const actions = useReaderActions({
      resolveRootPath: () => 'U:/H/AI',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'output',
      router: fakeRouter as never,
    });
    const result = await actions.addToLibrary({
      name: '260715',
      path: '260715',
      isDirectory: true,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });
    expect(result).toBe(33);
    expect(listDirectory).toHaveBeenCalledWith({ type: 'local', rootPath: 'U:/H/AI' }, 'output/260715');
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '260715',
        absolutePath: 'output/260715',
        favorite: true,
        coverEntryPath: 'output/260715/p1.jpg',
        coverEntryName: 'p1.jpg',
        pageCount: 2,
      }),
    );
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('readFromImage 嵌套目录: parentPath="output/VOL.01" → absPath 拼到 currentPath', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(8);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => 'output/VOL.01',
      getCurrentPath: () => 'output/VOL.01',  // 双层嵌套
      router: fakeRouter as never,
    });
    await actions.readFromImage({
      name: 'page1.jpg',
      path: 'page1.jpg',  // 相对 currentPath='output/VOL.01'
      isDirectory: false,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });
    expect(listDirectory).toHaveBeenCalledWith({ type: 'local', rootPath: '/manga' }, 'output/VOL.01');
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'VOL.01',  // parentPath 最后一段
        absolutePath: 'output/VOL.01',
        favorite: false,
      }),
    );
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/manga' },
      'output/VOL.01',
      'VOL.01',
      8,
    );
    expect(fakeRouter.push).toHaveBeenCalledWith({
      path: '/reader/8',
      query: { at: 'page1.jpg' },
    });
  });

  it('readNow: 保存导航上下文 (saveNavigationContext) 在 router.push 前调', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(1);
    const saveNavigationContext = vi.fn();
    const callOrder: string[] = [];
    saveNavigationContext.mockImplementation(() => callOrder.push('saveNavigationContext'));
    fakeRouter.push.mockImplementation(async () => { callOrder.push('router.push'); });
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'output',
      saveNavigationContext,
      router: fakeRouter as never,
    });
    await actions.readNow({ name: '260715', path: '260715', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 });
    expect(saveNavigationContext).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['saveNavigationContext', 'router.push']);
  });

  // ─── v0.1.0-module3.0.3-hotfix2: race condition 回归 ───
  // 现象: 双击 260715 触发 fileBrowser.navigate, navigate 同步更新 currentPath
  //   但 entries / lastFetchedPath 要等 fetch 成功才更新. 用户在 fetch 期间点
  //   「立即阅读」时, getCurrentPath() 应反映 entries 的真实基准 (= lastFetchedPath),
  //   而不是 currentPath (用户"想去"的位置).
  // 旧 fix 用 currentPath → 在 race 期间拼出 'output/260715/260715' (double 260715).
  // 新 fix 用 lastFetchedPath → race 期间仍是 'output', 正确拼出 'output/260715'.

  it('race condition: getCurrentPath=lastFetchedPath (≠ currentPath) → absPath 仍正确', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(99);
    const actions = useReaderActions({
      resolveRootPath: () => 'U:/H/AI',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => 'output',         // race 期间: entries 仍来自 output
      getCurrentPath: () => 'output',              // 应跟 lastFetchedPath 一致
      router: fakeRouter as never,
    });
    // 模拟用户在 fetch(output/260715) 期间点立即阅读
    const entryFromOldList: MediaEntry = {
      name: '260715',
      path: '260715',  // 来自旧 output/ 列表, 相对 lastFetchedPath='output'
      isDirectory: true,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    };
    await actions.readNow(entryFromOldList);
    expect(listDirectory).toHaveBeenCalledWith({ type: 'local', rootPath: 'U:/H/AI' }, 'output/260715');
    expect(createBook).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: 'output/260715' }),
    );
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'U:/H/AI' },
      'output/260715',
      '260715',
      99,
    );
  });

  it('race condition 文档化: 旧 fix 用 currentPath 会出错 (防止回退)', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(99);
    const actions = useReaderActions({
      resolveRootPath: () => 'U:/H/AI',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => 'output',
      // ⚠️ 故意模拟旧的 buggy 映射 (currentPath 已被 navigate 改成 'output/260715',
      //   但 entries 还来自 'output'). absPath 会错位成 'output/260715/260715'.
      getCurrentPath: () => 'output/260715',
      router: fakeRouter as never,
    });
    await actions.readNow({
      name: '260715',
      path: '260715',
      isDirectory: true,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });
    // 此断言记录了 bug 行为. 修这个 bug 的关键是 FileBrowser.vue 传 lastFetchedPath,
    // 不是把 useReaderActions 内部逻辑改成用 currentPath.
    expect(listDirectory).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'U:/H/AI' },
      'output/260715/260715',  // 错位 — 这是需要避免的
    );
  });

  // ─── v0.1.0-module3.0.8: readFromCurrentPath (顶栏「立即阅读」无选中 entry 时) ───
  // 入口: FileBrowser.vue 在无选中时调 useReaderActions.readFromCurrentPath(),
  //   FileBrowser 传入 cachedProgress (从 fb store 取的 progress),
  //   缓存命中 → 直接 router.push; 缓存未命中 → 走 IPC ensureBookId + getProgress.

  it('readFromCurrentPath: cachedProgress 命中 → 走 router.push, 不调 IPC (ensureBookId/getProgress)', async () => {
    const cached: ProgressItem = {
      bookId: 42, page: 5, imageName: 'p5.jpg',
      readerMode: 'single', updatedAt: 0, finished: false,
    };
    const router = { push: vi.fn() };
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'VOL.01',
      router: router as never,
    });
    await actions.readFromCurrentPath({ cachedProgress: cached });
    // cachedProgress 命中: 不走 IPC (ensureBookId / getProgress)
    expect(getProgress).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
    expect(listDirectory).not.toHaveBeenCalled();
    // router.push 用 { name, params, query } 形态
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
      name: 'reader',
      params: { bookId: '42' },
      query: { at: 'p5.jpg' },
    }));
  });

  it('readFromCurrentPath: cachedProgress 空 → 走 ensureBookId + getProgress, 取回 imageName 后 router.push', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(77);
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 77, page: 3, imageName: 'x.jpg',
      readerMode: 'single', updatedAt: 1, finished: false,
    });
    const router = { push: vi.fn() };
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'VOL.01',
      router: router as never,
    });
    await actions.readFromCurrentPath({ cachedProgress: null });
    // 走了 ensureBookId (listDirectory + createBook)
    expect(createBook).toHaveBeenCalledWith(expect.objectContaining({
      title: 'VOL.01',
      sourceDescriptor: { type: 'local', rootPath: '/manga' },
      absolutePath: 'VOL.01',
      favorite: false,
    }));
    // 走了 getProgress(bookId)
    expect(getProgress).toHaveBeenCalledWith(77);
    // router.push 用从 IPC 取回的 imageName
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
      name: 'reader',
      params: { bookId: '77' },
      query: { at: 'x.jpg' },
    }));
  });

  it('readFromCurrentPath: cachedProgress 空 + getProgress.imageName=null → noop, 不 router.push', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(77);
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 77, page: 3, imageName: null,  // 没浏览过, imageName=null
      readerMode: 'single', updatedAt: 0, finished: false,
    });
    const router = { push: vi.fn() };
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'VOL.01',
      router: router as never,
    });
    await actions.readFromCurrentPath({ cachedProgress: null });
    // noop: router.push 不调
    expect(router.push).not.toHaveBeenCalled();
  });

  it('readFromCurrentPath: router null (useRouter 返 null + opts 未传) → 不抛', async () => {
    const cached: ProgressItem = {
      bookId: 42, page: 5, imageName: 'p5.jpg',
      readerMode: 'single', updatedAt: 0, finished: false,
    };
    // 不传 router → useRouter() mock 返 null, opts.router 也无, router 最终为 null
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => 'VOL.01',
    });
    await expect(actions.readFromCurrentPath({ cachedProgress: cached })).resolves.not.toThrow();
    // ensureBookId/getProgress 也不应被调 (cachedProgress 命中短路)
    expect(getProgress).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
  });

  it('readFromCurrentPath: 根目录 currentPath="" → 用 localRoot fallback dirName, 不 abort', async () => {
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(5);
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 5, page: 1, imageName: 'r.jpg',
      readerMode: 'single', updatedAt: 0, finished: false,
    });
    const router = { push: vi.fn() };
    const actions = useReaderActions({
      resolveRootPath: () => '/manga',  // localRoot = '/manga', fallback dirName = 'manga'
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      getLastFetchedPath: () => '',
      getCurrentPath: () => '',  // 根目录
      router: router as never,
    });
    await actions.readFromCurrentPath({ cachedProgress: null });
    // 用 fallback dirName='manga' 走 ensureBookId, 不 abort
    expect(createBook).toHaveBeenCalledWith(expect.objectContaining({
      title: 'manga',  // localRoot 最后一段
      favorite: false,
    }));
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
      name: 'reader',
      params: { bookId: '5' },
      query: { at: 'r.jpg' },
    }));
  });
});