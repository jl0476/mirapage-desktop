import { convertFileSrc } from '@tauri-apps/api/core';
import {
  createBook,
  getBook,
  getProgress,
  listDirectory,
  type BookItem,
  type CreateBookArgs,
} from '@/lib/tauri';
import { sortEntries, type SortField } from '@/lib/fileSort';
import { isImage } from '@/lib/mime';
import { SpreadPlanner, type PageRange } from '@/lib/spreadPlanner';
import { validateSourceRelativePath } from '@/lib/relativePath';
import { useDirectorySortStore } from '@/stores/directorySort';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useSettingsStore } from '@/stores/settings';
import { log } from '@/lib/logger';
import type { MediaEntry, SourceDescriptor, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

export interface BookIdentity {
  descriptor: SourceDescriptorLocal;
  relPath: string;
  bookId: number;
}

export interface NextVolumeTarget {
  descriptor: SourceDescriptorLocal;
  relPath: string;
  title: string;
}

export interface LoadBookOptions {
  explicitImageName?: string;
}

export interface ReaderBookSnapshot {
  book: BookItem;
  descriptor: SourceDescriptorLocal;
  relPath: string;
  imageNames: string[];
  pageUrls: string[];
  spreads: PageRange[];
  initialSpreadIndex: number;
  /** webtoon 恢复使用图索引，不能复用 spread 索引。 */
  restoreImageIndex: number;
}

export function sameBookIdentity(a: BookIdentity | null, b: BookIdentity | null): boolean {
  return a !== null && b !== null
    && a.bookId === b.bookId
    && a.relPath === b.relPath
    && a.descriptor.rootPath === b.descriptor.rootPath;
}

function parseSourceDescriptor(raw: unknown): SourceDescriptor | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && 'rootPath' in parsed
        ? parsed as SourceDescriptor : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && 'rootPath' in raw
    && typeof (raw as { rootPath: unknown }).rootPath === 'string') {
    return raw as SourceDescriptor;
  }
  return null;
}

function joinPath(...parts: string[]): string {
  return parts.filter((s) => s.length > 0).map((s) => s.replace(/[\\/]+$/, '')).join('\\');
}

function resolveInitialSpreadIndex(
  progress: Awaited<ReturnType<typeof getProgress>>,
  explicitImageName: string | undefined,
  imageNames: string[],
  spreads: PageRange[],
): number {
  if (explicitImageName && imageNames.includes(explicitImageName)) {
    return Math.max(0, Math.min(
      SpreadPlanner.spreadIndexForPage(imageNames.indexOf(explicitImageName), spreads),
      Math.max(0, spreads.length - 1),
    ));
  }
  if (!progress || progress.finished || spreads.length === 0) return 0;
  if (progress.imageName) {
    const idx = imageNames.indexOf(progress.imageName);
    if (idx >= 0) {
      const target = SpreadPlanner.spreadIndexForPage(idx, spreads);
      const last = spreads.length - 1;
      const clamped = Math.max(0, Math.min(target, last));
      return clamped >= last ? Math.max(0, last - 1) : clamped;
    }
  }
  const target = SpreadPlanner.spreadIndexForPage(progress.page, spreads);
  const last = spreads.length - 1;
  const clamped = Math.max(0, Math.min(target, last));
  return clamped >= last ? Math.max(0, last - 1) : clamped;
}

export function useReaderBookLoader() {
  const fb = useFileBrowserStore();
  const dsStore = useDirectorySortStore();
  const settings = useSettingsStore();

  async function loadBookById(bookId: number, opts: LoadBookOptions = {}): Promise<ReaderBookSnapshot> {
    const b = await getBook(bookId);
    if (!b) throw new Error(`找不到 bookId ${bookId}`);
    const descriptor = parseSourceDescriptor(b.sourceDescriptor);
    if (!descriptor || descriptor.type !== 'local' || !descriptor.rootPath) {
      throw new Error('source descriptor 解析失败或非本地资源');
    }
    const rootPath = descriptor.rootPath.replace(/[\\/]+$/, '');
    // 路径身份修复 (2026-08-12): 移除 isAlreadyAbs 兼容分支（为污染数据开的逃生通道）。
    // library.absolute_path 必须 source-relative; 绝对值属污染数据, 校验失败显式报错
    // 而非静默走绝对路径掩盖问题（spec §4.3 兼容掩盖风险）。
    const relPath = b.absolutePath ?? '';
    const relCheck = validateSourceRelativePath(relPath);
    if (!relCheck.ok) {
      log('[useReaderBookLoader] absolute_path 越出数据源根, 拒绝加载', { bookId, absolutePath: relPath, reason: relCheck.reason });
      throw new Error(`书库记录路径异常（absolute_path="${relPath}"），请重新从正确根目录打开`);
    }
    const normalizedRel = relCheck.normalized;
    // listDirectory 的 path 参数必须 source-relative (Rust resolve_path = root.join(path),
    // 传绝对路径会触发 PathEscape 校验)。convertFileSrc 才需要完整绝对路径。
    const absDir = normalizedRel.length > 0 ? joinPath(rootPath, normalizedRel) : rootPath;
    const targetEntries: MediaEntry[] = await listDirectory(descriptor, normalizedRel);
    const imageEntries = targetEntries.filter((e) => !e.isDirectory && !e.isArchive && isImage(e.name));
    let sortField: SortField = fb.sortField;
    let ascending = fb.sortAscending;
    try {
      const override = await dsStore.resolve(descriptor, normalizedRel);
      if (override) {
        sortField = override.sortField as SortField;
        ascending = override.ascending;
      }
    } catch { /* fallback */ }
    const sorted = sortEntries(imageEntries, sortField, ascending);
    const imageNames = sorted.map((e) => e.name);
    if (imageNames.length === 0) throw new Error(`${absDir} 下找不到图片`);
    const pageUrls = imageNames.map((name) => convertFileSrc(joinPath(absDir, name)));
    const spreads = SpreadPlanner.plan(pageUrls.length, true, settings.readerDefaultMode === 'single');
    const explicitHit = opts.explicitImageName ? imageNames.includes(opts.explicitImageName) : false;
    let progress: Awaited<ReturnType<typeof getProgress>> = null;
    let initialSpreadIndex: number;
    if (explicitHit) {
      const last = Math.max(0, spreads.length - 1);
      initialSpreadIndex = Math.max(0, Math.min(
        SpreadPlanner.spreadIndexForPage(imageNames.indexOf(opts.explicitImageName!), spreads), last));
    } else {
      progress = await getProgress(bookId);
      initialSpreadIndex = resolveInitialSpreadIndex(progress, undefined, imageNames, spreads);
    }
    const restoreImageIndex = explicitHit
      ? imageNames.indexOf(opts.explicitImageName!)
      : (!progress || progress.finished) ? 0
      : (progress.imageName && imageNames.includes(progress.imageName))
        ? imageNames.indexOf(progress.imageName)
        : Math.max(0, Math.min(Math.max(0, progress.page), imageNames.length - 1));
    return { book: b, descriptor, relPath: normalizedRel, imageNames, pageUrls, spreads, initialSpreadIndex, restoreImageIndex };
  }

  async function ensureBookId(target: NextVolumeTarget): Promise<number> {
    // 路径身份修复: 跨卷 target.relPath 校验（来自 find_next_volume IPC，防御性）。
    const relCheck = validateSourceRelativePath(target.relPath);
    if (!relCheck.ok) {
      log('[useReaderBookLoader/ensureBookId] 跨卷 relPath 越界, 拒绝 createBook', { relPath: target.relPath, reason: relCheck.reason });
      throw new Error(`跨卷目标路径异常（relPath="${target.relPath}"）`);
    }
    const args: CreateBookArgs = {
      title: target.title, sourceDescriptor: target.descriptor, absolutePath: relCheck.normalized,
      sourceType: 'Local', favorite: false, coverEntryPath: null, coverEntryName: null, pageCount: 0,
    };
    return createBook(args);
  }

  return { loadBookById, ensureBookId };
}
