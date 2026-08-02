/**
 * useReaderActions.ts — v0.1.0-module3.0
 * - readNow(entry): 临时 import (favorite=false)，Library 不可见，progress 仍能持久化
 * - addToLibrary(entry): 手动加入书库 (favorite=true)，Library 可见
 *
 * 不再调 recordHistory（browse_history 已重写为 folder-level，由 FileBrowser.fetch 自动 upsert）
 *
 * **不做** (plan §6 决策):
 * - ❌ 下载全部按钮 (本地文件无下载需求)
 * - ❌ 编辑类 (新建/重命名/删除/拖放)
 */
import { useRouter } from 'vue-router';
import { createBook, listDirectory, type CreateBookArgs } from '@/lib/tauri';
import { isImage } from '@/lib/mime';
import { naturalCompare } from '@/lib/naturalSort';
import { log } from '@/lib/logger';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { Router } from 'vue-router';

export interface ReaderActionsOptions {
  /** 当前列表的 rootPath (FileBrowser 顶层 root) */
  resolveRootPath: () => string;
  /** sourceDescriptor — 桌面端单 source 模式 = { type: 'local', rootPath } */
  buildSourceDescriptor: (rootPath: string) => SourceDescriptor;
  /** 可选 router, 测试时手动传入; 缺省时尝试 useRouter() */
  router?: Router;
  /** 数据变化后回调 (UI 刷新 Reading/Finished 标记 / book 列表) */
  onLibraryChanged?: () => void | Promise<void>;
}

export function useReaderActions(opts: ReaderActionsOptions) {
  let router: Router | null;
  try {
    router = useRouter() ?? null;
  } catch {
    router = null;
  }
  if (!router && opts.router) router = opts.router;

  /**
   * 枚举 entry 下的图片页（供 create_book 写入封面 + 页数）
   * 失败时返 fallback（封面 null / 页数 0），不影响主流程。
   */
  async function enumerateCover(
    descriptor: SourceDescriptor,
    absPath: string,
  ): Promise<{ coverEntryPath: string | null; coverEntryName: string | null; pageCount: number }> {
    try {
      const entries = await listDirectory(descriptor, absPath);
      const images = entries
        .filter((e) => !e.isDirectory && isImage(e.name))
        .sort((a, b) => naturalCompare(a.name, b.name));
      if (images.length === 0) {
        return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
      }
      const first = images[0]!;
      return {
        coverEntryPath: first.path,
        coverEntryName: first.name,
        pageCount: images.length,
      };
    } catch (e) {
      log('[useReaderActions] enumerateCover failed', e);
      return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
    }
  }

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * 复用 / 创建 bookId (Android LibraryRepository.importFromSource 行为)
   * favorite=true → is_favorite=1（Library 可见）；false → is_favorite=0（Library 不可见）
   */
  async function ensureBookId(entry: MediaEntry, favorite: boolean): Promise<number | null> {
    if (!entry.isDirectory) {
      log('[useReaderActions] ensureBookId: entry is not a directory', entry.name);
      return null;
    }
    const rootPath = opts.resolveRootPath();
    const absPath = entry.path;
    const descriptor = opts.buildSourceDescriptor(rootPath);
    const sourceType = descriptor.type === 'local' ? 'Local' : capitalize(descriptor.type);

    const cover = await enumerateCover(descriptor, absPath);

    try {
      const args: CreateBookArgs = {
        title: entry.name,
        sourceDescriptor: descriptor,
        absolutePath: absPath,
        sourceType,
        favorite,
        ...cover,
      };
      const bookId = await createBook(args);
      log('[useReaderActions] createBook', favorite ? 'favorite=true' : 'favorite=false', '→ bookId', bookId);
      return bookId;
    } catch (e) {
      log('[useReaderActions] createBook failed', e);
      return null;
    }
  }

  async function readNow(entry: MediaEntry): Promise<void> {
    log('[useReaderActions] readNow called', entry.name, 'isDirectory=', entry.isDirectory);
    const bookId = await ensureBookId(entry, /*favorite=*/false);
    if (bookId === null) {
      log('[useReaderActions] readNow: bookId is null, abort');
      return;
    }
    if (opts.onLibraryChanged) {
      try {
        await opts.onLibraryChanged();
      } catch (e) {
        log('[useReaderActions] onLibraryChanged failed', e);
      }
    }
    if (router) {
      log('[useReaderActions] readNow: router.push /reader/' + bookId);
      await router.push(`/reader/${bookId}`);
      log('[useReaderActions] readNow: pushed');
    } else {
      log('[useReaderActions] router unavailable, cannot navigate');
    }
  }

  async function addToLibrary(entry: MediaEntry): Promise<number | null> {
    log('[useReaderActions] addToLibrary called', entry.name);
    const bookId = await ensureBookId(entry, /*favorite=*/true);
    if (bookId !== null && opts.onLibraryChanged) {
      try {
        await opts.onLibraryChanged();
      } catch (e) {
        log('[useReaderActions] onLibraryChanged failed', e);
      }
    }
    return bookId;
  }

  return { readNow, addToLibrary };
}