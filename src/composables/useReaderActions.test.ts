/**
 * useReaderActions.test.ts — v0.1.0-module3.0
 *
 * 验证:
 * - readNow: enumerate cover + createBook(favorite=false) → router.push
 * - addToLibrary: enumerate cover + createBook(favorite=true) → 不 router.push
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

const fakeRouter = { push: vi.fn() } as unknown as { push: (path: string) => Promise<void> };

function makeEntry(isDirectory: boolean): MediaEntry {
  return {
    name: 'VOL.01',
    path: 'VOL.01',
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
      router: fakeRouter as never,
    });
    await actions.readNow(makeEntry(true));
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });
});