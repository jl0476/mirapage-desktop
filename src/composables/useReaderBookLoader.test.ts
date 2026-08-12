import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useReaderBookLoader } from './useReaderBookLoader';
import type { BookItem, ProgressItem } from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';

const mocks = vi.hoisted(() => ({
  getBook: vi.fn(),
  listDirectory: vi.fn(),
  getProgress: vi.fn(),
  createBook: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  resolveSort: vi.fn(),
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, getBook: mocks.getBook, listDirectory: mocks.listDirectory, getProgress: mocks.getProgress, createBook: mocks.createBook };
});
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convertFileSrc }));
vi.mock('@/stores/directorySort', () => ({
  useDirectorySortStore: () => ({ resolve: mocks.resolveSort }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ readerDefaultMode: 'single' }),
}));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const descriptor: SourceDescriptor = { type: 'local', rootPath: 'C:\\comics' };
const book: BookItem = {
  id: 7, title: 'Vol 1', sourceDescriptor: descriptor, sourceType: 'Local', absolutePath: 'vol1',
  coverEntryPath: null, coverEntryName: null, pageCount: 0, lastReadAt: null, addedAt: 0, isFavorite: false,
};
const entries: MediaEntry[] = [
  { name: 'page10.jpg', path: 'vol1\\page10.jpg', isDirectory: false, isArchive: false, size: 10 },
  { name: 'page2.jpg', path: 'vol1\\page2.jpg', isDirectory: false, isArchive: false, size: 20 },
  { name: 'folder', path: 'vol1\\folder', isDirectory: true, isArchive: false, size: 0 },
  { name: 'book.cbz', path: 'vol1\\book.cbz', isDirectory: false, isArchive: true, size: 30 },
  { name: 'note.txt', path: 'vol1\\note.txt', isDirectory: false, isArchive: false, size: 2 },
];

function progress(overrides: Partial<ProgressItem> = {}): ProgressItem {
  return { bookId: 7, page: 0, imageName: null, readerMode: 'single', updatedAt: 0, finished: false, ...overrides };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.getBook.mockResolvedValue(book);
  mocks.listDirectory.mockResolvedValue(entries);
  mocks.getProgress.mockResolvedValue(null);
  mocks.resolveSort.mockResolvedValue(null);
});

describe('useReaderBookLoader', () => {
  it('返回 Local 目录 Snapshot，图片 URL 不是文件名', async () => {
    const snapshot = await useReaderBookLoader().loadBookById(7);
    expect(snapshot.book).toEqual(book);
    expect(snapshot.descriptor).toEqual(descriptor);
    expect(snapshot.relPath).toBe('vol1');
    expect(snapshot.imageNames).toEqual(['page2.jpg', 'page10.jpg']);
    expect(snapshot.pageUrls).toEqual(['asset://C:\\comics\\vol1\\page2.jpg', 'asset://C:\\comics\\vol1\\page10.jpg']);
    expect(snapshot.spreads.length).toBeGreaterThan(0);
  });

  it('路径身份修复回归: listDirectory 收到 source-relative 路径, 不是 join 后的绝对路径', async () => {
    // bug 现场 (2026-08-12): loadBookById 曾把 joinPath(rootPath, relPath) 的绝对结果
    // 传给 listDirectory, 触发 Rust PathEscape 校验报错 "Drive: F:\..."。
    // listDirectory 的 path 参数必须 source-relative (Rust resolve_path = root.join(path))。
    await useReaderBookLoader().loadBookById(7);
    // book.absolutePath='vol1' (相对 rootPath='C:\comics'), listDirectory 应收到 'vol1'
    expect(mocks.listDirectory).toHaveBeenCalledWith(descriptor, 'vol1');
    // 绝对路径 'C:\comics\vol1' 不应被传入
    expect(mocks.listDirectory).not.toHaveBeenCalledWith(descriptor, 'C:\\comics\\vol1');
  });

  it('非 Local descriptor 抛出明确错误', async () => {
    mocks.getBook.mockResolvedValue({ ...book, sourceDescriptor: { type: 'webdav', accountId: 1, baseUrl: 'x', path: '/' } });
    await expect(useReaderBookLoader().loadBookById(7)).rejects.toThrow(/非本地/);
  });

  it('路径身份修复: absolute_path 为污染的绝对路径 → 抛错, 不走兼容分支', async () => {
    // 旧实现 isAlreadyAbs 会把绝对路径当逃生通道静默使用（spec §4.3 兼容掩盖）。
    // 修复后必须显式拒绝, 不调 listDirectory。
    mocks.getBook.mockResolvedValue({ ...book, absolutePath: 'F:/WallPaper/raw/竖版' });
    await expect(useReaderBookLoader().loadBookById(7)).rejects.toThrow(/路径异常/);
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it('路径身份修复: absolute_path 含 .. → 抛错', async () => {
    mocks.getBook.mockResolvedValue({ ...book, absolutePath: 'vol1/../../../etc' });
    await expect(useReaderBookLoader().loadBookById(7)).rejects.toThrow(/路径异常/);
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it('路径身份修复: 根目录 absolute_path="" → 正常加载 (空串合法)', async () => {
    mocks.getBook.mockResolvedValue({ ...book, absolutePath: '' });
    const snapshot = await useReaderBookLoader().loadBookById(7);
    expect(snapshot.relPath).toBe('');
    // absDir 走 rootPath fallback (空串), listDirectory 仍被调用
    expect(mocks.listDirectory).toHaveBeenCalled();
  });

  it('过滤目录、压缩包和非图片文件', async () => {
    const snapshot = await useReaderBookLoader().loadBookById(7);
    expect(snapshot.imageNames).not.toContain('folder');
    expect(snapshot.imageNames).not.toContain('book.cbz');
    expect(snapshot.imageNames).not.toContain('note.txt');
  });

  it('命中目录排序覆盖，否则使用 settings fallback', async () => {
    mocks.resolveSort.mockResolvedValue({ sortField: 'size', ascending: true });
    const snapshot = await useReaderBookLoader().loadBookById(7);
    expect(mocks.resolveSort).toHaveBeenCalledWith(descriptor, 'vol1');
    expect(snapshot.imageNames).toEqual(['page10.jpg', 'page2.jpg']);
  });

  it.each([
    ['explicit image', { opts: { explicitImageName: 'page10.jpg' }, p: progress({ page: 0, imageName: 'page2.jpg' }) }, 1],
    ['progress image', { opts: {}, p: progress({ page: 1, imageName: 'page10.jpg' }) }, 0],
    ['progress page', { opts: {}, p: progress({ page: 1 }) }, 0],
    ['finished', { opts: {}, p: progress({ page: 1, imageName: 'page10.jpg', finished: true }) }, 0],
    ['no progress', { opts: {}, p: null }, 0],
  ])('%s 恢复起始 spread', async (_name, input, expected) => {
    mocks.getProgress.mockResolvedValue(input.p);
    const snapshot = await useReaderBookLoader().loadBookById(7, input.opts);
    expect(snapshot.initialSpreadIndex).toBe(expected);
  });

  it('显式起始图不受末页钳位', async () => {
    mocks.listDirectory.mockResolvedValue([
      ...entries.filter((e) => e.name === 'page2.jpg'),
      ...Array.from({ length: 4 }, (_, i) => ({ name: `p${i}.jpg`, path: `p${i}.jpg`, isDirectory: false, isArchive: false, size: 1 })),
    ]);
    const snapshot = await useReaderBookLoader().loadBookById(7, { explicitImageName: 'p3.jpg' });
    expect(snapshot.initialSpreadIndex).toBeGreaterThan(0);
    expect(mocks.getProgress).not.toHaveBeenCalled();
  });

  it('ensureBookId 使用最小 CreateBookArgs 映射并返回 id', async () => {
    mocks.createBook.mockResolvedValue(42);
    const target = { descriptor, relPath: 'vol2', title: 'Vol 2' };
    await expect(useReaderBookLoader().ensureBookId(target)).resolves.toBe(42);
    expect(mocks.createBook).toHaveBeenCalledWith({
      title: 'Vol 2', sourceDescriptor: descriptor, absolutePath: 'vol2', sourceType: 'Local', favorite: false,
      coverEntryPath: null, coverEntryName: null, pageCount: 0,
    });
  });
});
