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
import { useDirectorySortStore } from '@/stores/directorySort';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useSettingsStore } from '@/stores/settings';
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
  progress: (Awaited<ReturnType<typeof getProgress>> & { finished?: boolean }) | null,
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
  if (!progress || progress.finished === true || spreads.length === 0) return 0;
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
    const relPath = b.absolutePath ?? '';
    const isAlreadyAbs = Boolean(b.absolutePath && /^[A-Za-z]:[\\/]/.test(b.absolutePath));
    const absDir = b.absolutePath && b.absolutePath.length > 0
      ? (isAlreadyAbs ? b.absolutePath : joinPath(rootPath, b.absolutePath)) : rootPath;
    const targetEntries: MediaEntry[] = await listDirectory(descriptor, absDir);
    const imageEntries = targetEntries.filter((e) => !e.isDirectory && !e.isArchive && isImage(e.name));
    let sortField: SortField = fb.sortField;
    let ascending = fb.sortAscending;
    try {
      const override = await dsStore.resolve(descriptor, relPath);
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
    let initialSpreadIndex: number;
    if (explicitHit) {
      const last = Math.max(0, spreads.length - 1);
      initialSpreadIndex = Math.max(0, Math.min(
        SpreadPlanner.spreadIndexForPage(imageNames.indexOf(opts.explicitImageName!), spreads), last));
    } else {
      const progress = await getProgress(bookId);
      initialSpreadIndex = resolveInitialSpreadIndex(progress, undefined, imageNames, spreads);
    }
    return { book: b, descriptor, relPath, imageNames, pageUrls, spreads, initialSpreadIndex };
  }

  async function ensureBookId(target: NextVolumeTarget): Promise<number> {
    const args: CreateBookArgs = {
      title: target.title, sourceDescriptor: target.descriptor, absolutePath: target.relPath,
      sourceType: 'Local', favorite: false, coverEntryPath: null, coverEntryName: null, pageCount: 0,
    };
    return createBook(args);
  }

  return { loadBookById, ensureBookId };
}
