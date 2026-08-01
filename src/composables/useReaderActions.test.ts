/**
 * useReaderActions.test.ts — v0.1.0-module2.0
 *
 * 验证:
 * - readNow: 调 listHistory → 找不到 → createBook → recordHistory → router.push
 * - readNow: listHistory 找到 → 复用 bookId (不再 createBook)
 * - addToLibrary: 同 readNow 但不 router.push
 * - 非目录: 返回 null 不调 IPC
 * - onLibraryChanged: 调 readNow / addToLibrary 完成后触发
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listHistory: vi.fn(),
    createBook: vi.fn(),
    recordHistory: vi.fn(),
  };
});

vi.mock('vue-router', () => ({
  useRouter: () => null,
}));

import { listHistory, createBook, recordHistory } from '@/lib/tauri';
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

  it('目录: listHistory 找不到 → createBook → recordHistory → router.push', async () => {
    vi.mocked(listHistory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(42);
    vi.mocked(recordHistory).mockResolvedValue(undefined);
    const onLibraryChanged = vi.fn();
    const actions = useReaderActions({
      resolveRootPath: () => '/manga/VOL.01',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      router: fakeRouter as never,
      onLibraryChanged,
    });
    await actions.readNow(makeEntry(true));
    expect(listHistory).toHaveBeenCalled();
    expect(createBook).toHaveBeenCalledWith('VOL.01', { type: 'local', rootPath: '/manga/VOL.01' });
    expect(recordHistory).toHaveBeenCalledWith({ type: 'local', rootPath: '/manga/VOL.01' }, 42, 0);
    expect(fakeRouter.push).toHaveBeenCalledWith('/reader/42');
    expect(onLibraryChanged).toHaveBeenCalled();
  });

  it('目录: listHistory 找到同 rootPath → 复用 bookId, 不调 createBook', async () => {
    vi.mocked(listHistory).mockResolvedValue([
      {
        bookId: 7,
        sourceDescriptor: { type: 'local', rootPath: '/manga/VOL.01' },
      } as never,
    ]);
    vi.mocked(recordHistory).mockResolvedValue(undefined);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga/VOL.01',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      router: fakeRouter as never,
    });
    await actions.readNow(makeEntry(true));
    expect(createBook).not.toHaveBeenCalled();
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/manga/VOL.01' },
      7,
      0,
    );
    expect(fakeRouter.push).toHaveBeenCalledWith('/reader/7');
  });

  it('addToLibrary: 不 router.push, 仅 ensureBookId', async () => {
    vi.mocked(listHistory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(99);
    vi.mocked(recordHistory).mockResolvedValue(undefined);
    const actions = useReaderActions({
      resolveRootPath: () => '/manga/VOL.02',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      router: fakeRouter as never,
    });
    const result = await actions.addToLibrary(makeEntry(true));
    expect(result).toBe(99);
    expect(fakeRouter.push).not.toHaveBeenCalled();
    expect(createBook).toHaveBeenCalled();
  });

  it('非目录: 返回 null, 不调 IPC', async () => {
    const actions = useReaderActions({
      resolveRootPath: () => '/manga/VOL.01/file.jpg',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      router: fakeRouter as never,
    });
    const result = await actions.readNow(makeEntry(false));
    expect(result).toBeUndefined();
    expect(listHistory).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });

  it('createBook 失败: 返回 null, 不 router.push', async () => {
    vi.mocked(listHistory).mockResolvedValue([]);
    vi.mocked(createBook).mockRejectedValue(new Error('DB locked'));
    const actions = useReaderActions({
      resolveRootPath: () => '/manga/VOL.99',
      buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath } as never),
      router: fakeRouter as never,
    });
    await actions.readNow(makeEntry(true));
    expect(fakeRouter.push).not.toHaveBeenCalled();
  });
});