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
  };
});

vi.mock('vue-router', () => ({
  useRouter: () => null,
}));

import { createBook, listDirectory, recordHistory } from '@/lib/tauri';
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
});