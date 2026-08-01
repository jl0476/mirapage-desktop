/**
 * useReaderActions.ts — v0.1.0-module2.0 触发阅读 / 加入书库
 *
 * readNow(entry): 仅对目录
 *  1. listHistory 找同 rootPath 的 entry, 复用 bookId
 *  2. 没有则 createBook → 拿 bookId
 *  3. recordHistory (UPSERT)
 *  4. router.push('/reader/' + bookId)
 *
 * addToLibrary(entry): 等同 readNow 但不导航 — 写入后保留在文件浏览器
 *  (避免无意义跳页, 用户可能想批量加书)
 *
 * **不做** (plan §6 决策):
 * - ❌ 下载全部按钮 (本地文件无下载需求)
 * - ❌ 编辑类 (新建/重命名/删除/拖放)
 *
 * **跨卷 loader** 仍留 TODO: 不在本 composable 范围.
 */
import { useRouter } from 'vue-router';
import { listHistory, recordHistory, createBook } from '@/lib/tauri';
import { log } from '@/lib/logger';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { Router } from 'vue-router';

export interface ReaderActionsOptions {
  /** 路径拼接: 当前列表基础路径 + entry.path */
  resolveRootPath: (entry: MediaEntry) => string;
  /** sourceDescriptor — 桌面端单 source 模式 = { type: 'local', rootPath } */
  buildSourceDescriptor: (rootPath: string) => SourceDescriptor;
  /** 可选 router, 测试时手动传入; 缺省时尝试 useRouter() */
  router?: Router;
  /** 数据变化后回调 (UI 刷新 Reading/Finished 标记 / book 列表) */
  onLibraryChanged?: () => void | Promise<void>;
}

export function useReaderActions(opts: ReaderActionsOptions) {
  const fallbackRouter = opts.router ?? null;
  let liveRouter: Router | null = null;
  try {
    // 实组件内有效 (setup 调用 useRouter); 测试环境 fallbackRouter 即可
    liveRouter = useRouter() ?? null;
  } catch {
    liveRouter = null;
  }
  const router: Router | null = liveRouter ?? fallbackRouter;

  /**
   * 复用 / 创建 bookId (同 sourceDescriptor 复用, 新书创建)
   * 返回 bookId; 抛错时返回 null
   */
  async function ensureBookId(entry: MediaEntry): Promise<number | null> {
    if (!entry.isDirectory) {
      log('[useReaderActions] ensureBookId: entry is not a directory', entry.name);
      return null;
    }
    const rootPath = opts.resolveRootPath(entry);
    const descriptor = opts.buildSourceDescriptor(rootPath);
    try {
      const history = await listHistory();
      const existing = history.find((h) => {
        const sd = h.sourceDescriptor as unknown;
        if (sd && typeof sd === 'object' && 'rootPath' in sd) {
          return (sd as { rootPath: string }).rootPath === rootPath;
        }
        return false;
      });
      if (existing) {
        log('[useReaderActions] reuse bookId', existing.bookId, 'for', rootPath);
        await recordHistory(descriptor, existing.bookId, 0);
        return existing.bookId;
      }
    } catch (e) {
      log('[useReaderActions] listHistory failed, fallback to createBook', e);
    }
    try {
      const bookId = await createBook(entry.name, descriptor);
      await recordHistory(descriptor, bookId, 0);
      log('[useReaderActions] created bookId', bookId, 'for', rootPath);
      return bookId;
    } catch (e) {
      log('[useReaderActions] createBook failed', e);
      return null;
    }
  }

  async function readNow(entry: MediaEntry): Promise<void> {
    const bookId = await ensureBookId(entry);
    if (bookId === null) return;
    if (opts.onLibraryChanged) await opts.onLibraryChanged();
    if (router) {
      await router.push(`/reader/${bookId}`);
    } else {
      log('[useReaderActions] router unavailable, cannot navigate');
    }
  }

  async function addToLibrary(entry: MediaEntry): Promise<number | null> {
    const bookId = await ensureBookId(entry);
    if (bookId !== null && opts.onLibraryChanged) {
      await opts.onLibraryChanged();
    }
    return bookId;
  }

  return { readNow, addToLibrary };
}