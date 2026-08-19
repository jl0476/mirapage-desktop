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
  readerMode: 'single' as 'single' | 'double' | 'webtoon',
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
  useSettingsStore: () => ({ get readerDefaultMode() { return mocks.readerMode; } }),
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
  mocks.readerMode = 'single';
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
    // media:// 统一 URL（spec §2 决策：Local 同走 media://，单段 encode 绝对路径）
    expect(snapshot.pageUrls).toEqual([
      `asset://local/${encodeURIComponent('C:\\comics\\vol1\\page2.jpg')}`,
      `asset://local/${encodeURIComponent('C:\\comics\\vol1\\page10.jpg')}`,
    ]);
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

  it('webdav descriptor 不再抛「非本地资源」且 pageUrls 走 media://', async () => {
    const webdavDesc = { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' } as SourceDescriptor;
    mocks.getBook.mockResolvedValue({
      ...book, sourceDescriptor: webdavDesc, absolutePath: 'comics/v1',
    });
    const snapshot = await useReaderBookLoader().loadBookById(7);
    expect(mocks.listDirectory).toHaveBeenCalledWith(webdavDesc, 'comics/v1');
    expect(snapshot.pageUrls[0]).toBe(`asset://webdav/7/${encodeURIComponent('comics/v1/page2.jpg')}`);
  });

  it('archive(local) descriptor：pageUrls 走 archive/local 形态', async () => {
    const archiveDesc = {
      type: 'archive', archivePath: 'D:/a.cbz', entryPrefix: '', format: 'cbz', origin: null,
    } as unknown as SourceDescriptor;
    mocks.getBook.mockResolvedValue({
      ...book, sourceDescriptor: archiveDesc, absolutePath: '',
    });
    const snapshot = await useReaderBookLoader().loadBookById(7);
    expect(mocks.listDirectory).toHaveBeenCalledWith(archiveDesc, '');
    expect(snapshot.pageUrls[0]).toBe(`asset://archive/local/${encodeURIComponent('D:/a.cbz')}/${encodeURIComponent('page2.jpg')}`);
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

  it('恢复快照暴露图索引：imageName 命中、finished 回到首图、page 越界钳位', async () => {
    mocks.getProgress.mockResolvedValue(progress({ page: 1, imageName: 'page10.jpg' }));
    const byName = await useReaderBookLoader().loadBookById(7);
    expect(byName.restoreImageIndex).toBe(1);

    mocks.getProgress.mockResolvedValue(progress({ page: 1, imageName: 'page10.jpg', finished: true }));
    const finished = await useReaderBookLoader().loadBookById(7);
    expect(finished.restoreImageIndex).toBe(0);

    mocks.getProgress.mockResolvedValue(progress({ page: 999, imageName: null }));
    const byPage = await useReaderBookLoader().loadBookById(7);
    expect(byPage.restoreImageIndex).toBe(1);
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

  it('bookmarkPage image kind: canonical 图片索引直取（single 模式 1:1）', async () => {
    const snapshot = await useReaderBookLoader().loadBookById(7, { bookmarkPage: 1, bookmarkPositionKind: 'image' });
    expect(snapshot.initialSpreadIndex).toBe(1);
    expect(snapshot.restoreImageIndex).toBe(1);
    expect(mocks.getProgress).not.toHaveBeenCalled();
  });

  it('bookmarkPage spread kind（double 模式）: legacy spread 索引折算为首图索引', async () => {
    mocks.readerMode = 'double';
    // 6 张图 + coverStandalone → spreads [{0..1},{1..3},{3..5},{5..6}]
    // legacy spread 索引 2 → 首图索引 3（spreads[2].start），落在 spread 2
    mocks.listDirectory.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.jpg`, path: `p${i}.jpg`, isDirectory: false, isArchive: false, size: 1 })),
    );
    const snapshot = await useReaderBookLoader().loadBookById(7, { bookmarkPage: 2, bookmarkPositionKind: 'spread' });
    expect(snapshot.restoreImageIndex).toBe(3);
    expect(snapshot.initialSpreadIndex).toBe(2);
  });

  it('bookmarkPage 越界: webtoon 恢复钳位末图, paged 链 spreadIndexForPage 无匹配回首页', async () => {
    const snapshot = await useReaderBookLoader().loadBookById(7, { bookmarkPage: 999, bookmarkPositionKind: 'image' });
    const last = snapshot.imageNames.length - 1;
    expect(snapshot.restoreImageIndex).toBe(last);
    expect(snapshot.initialSpreadIndex).toBe(0); // spreadIndexForPage 越界 fallback 0（与 progress.page 链一致）
  });

  it('explicitImageName 优先于 bookmarkPage', async () => {
    mocks.getProgress.mockResolvedValue(progress({ page: 0, imageName: 'page10.jpg' }));
    const snapshot = await useReaderBookLoader().loadBookById(7, {
      explicitImageName: 'page2.jpg',
      bookmarkPage: 1,
      bookmarkPositionKind: 'image',
    });
    expect(snapshot.restoreImageIndex).toBe(0); // page2.jpg 在排序后 index 0
    expect(snapshot.initialSpreadIndex).toBe(0);
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
