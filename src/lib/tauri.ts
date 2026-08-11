// Tauri IPC 桥
// 集中封装所有 invoke 调用,前端代码不直接用 @tauri-apps/api
//
// 命名约定:
//   list<X>(...) → readonly list
//   get<X>(id) → 单条
//   add<X>(...) → insert,返回新行
//   remove<X>(id) → delete
//   set<X>(id, ...) → update / toggle
//   record<X>(...) → upsert(用于 history 等)

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { SourceDescriptor, MediaEntry } from './sourceDescriptor';

// ─── Settings ───────────────────────────────────────────────────────────
export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke<void>('set_setting', { key, value });
}

// ─── Files (Phase 2) ─────────────────────────────────────────────────────
export async function listDirectory(
  descriptor: SourceDescriptor,
  path: string,
): Promise<MediaEntry[]> {
  return invoke<MediaEntry[]>('list_directory', { descriptor, path });
}

export async function readFile(
  descriptor: SourceDescriptor,
  path: string,
  range?: { offset: number; length: number },
): Promise<Uint8Array> {
  const offset = range?.offset ?? null;
  const length = range?.length ?? null;
  const bytes = await invoke<number[]>('read_file', { descriptor, path, offset, length });
  return new Uint8Array(bytes);
}

// ─── Bookmarks (Phase 4) ────────────────────────────────────────────────
export interface BookmarkItem {
  id: number;
  bookId: number;
  page: number;
  label: string | null;
  createdAt: number;
}
export async function listBookmarks(bookId: number): Promise<BookmarkItem[]> {
  return invoke<BookmarkItem[]>('list_bookmarks', { bookId });
}
export async function addBookmark(
  bookId: number,
  page: number,
  label: string | null,
): Promise<BookmarkItem> {
  return invoke<BookmarkItem>('add_bookmark', { bookId, page, label });
}
export async function removeBookmark(id: number): Promise<void> {
  await invoke<void>('remove_bookmark', { id });
}

// ─── Likes (Phase 4) ────────────────────────────────────────────────────
export interface LikeItem {
  bookId: number;
  likedAt: number;
}
export async function listLikes(): Promise<LikeItem[]> {
  return invoke<LikeItem[]>('list_likes');
}
export async function toggleLike(bookId: number): Promise<boolean> {
  return invoke<boolean>('toggle_like', { bookId });
}

// ─── History (v0.1.0-module3.0: folder-level, Android BrowseHistory 对齐) ──
export interface BrowseHistoryEntry {
  sourceDescriptor: SourceDescriptor;
  relPath: string;
  displayName: string;
  lastVisitedAt: number;
  /** v0.1.0-module3.0.1: 关联 library.id（reader 真正打开时记录） */
  bookId: number | null;
}
export async function listHistory(): Promise<BrowseHistoryEntry[]> {
  return invoke<BrowseHistoryEntry[]>('list_history');
}
/**
 * FileBrowser.fetch 成功后调 — upsert 到 browse_history（folder-level）
 * Tauri 2: 单个结构体参数 invoke 时前端传 { args: { ... } }
 *
 * v0.1.0-module3.0.1: bookId optional, reader 真正打开时传（仅"实际阅读"才入 history）
 */
export async function recordHistory(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
  displayName: string,
  bookId?: number,
): Promise<void> {
  await invoke<void>('record_history', {
    args: { sourceDescriptor, relPath, displayName, bookId: bookId ?? null },
  });
}
export async function deleteHistory(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
): Promise<void> {
  await invoke<void>('delete_history', { sourceDescriptor, relPath });
}

// ─── Library / Book (v0.1.0-module3.0: 11 列对齐 Android LibraryEntity) ───
export interface BookItem {
  id: number;
  title: string;
  sourceDescriptor: SourceDescriptor;
  sourceType: string;
  absolutePath: string;
  coverEntryPath: string | null;
  coverEntryName: string | null;
  pageCount: number;
  lastReadAt: number | null;
  addedAt: number;
  isFavorite: boolean;
}
export async function listLibrary(): Promise<BookItem[]> {
  return invoke<BookItem[]>('list_library');
}
export async function getBook(bookId: number): Promise<BookItem | null> {
  return invoke<BookItem | null>('get_book', { bookId });
}

/**
 * v0.1.0-module3.0 createBook 入参扩展：
 * - favorite: true=加入书库（Library 可见），false=临时（Library 不可见，供 progress 持久化）
 * - absolutePath / sourceType / 封面：与 Android LibraryEntity 11 列对齐
 * - Tauri 2: 嵌套结构体 args 必须用 camelCase
 */
export interface CreateBookArgs {
  title: string;
  sourceDescriptor: SourceDescriptor;
  absolutePath: string;
  sourceType: string;
  favorite: boolean;
  coverEntryPath: string | null;
  coverEntryName: string | null;
  pageCount: number;
}
export async function createBook(args: CreateBookArgs): Promise<number> {
  return invoke<number>('create_book', {
    args: {
      title: args.title,
      sourceDescriptor: args.sourceDescriptor,
      absolutePath: args.absolutePath,
      sourceType: args.sourceType,
      favorite: args.favorite,
      coverEntryPath: args.coverEntryPath,
      coverEntryName: args.coverEntryName,
      pageCount: args.pageCount,
    },
  });
}
export async function setFavorite(bookId: number, favorite: boolean): Promise<void> {
  await invoke<void>('set_favorite', { bookId, favorite });
}

// ─── Directory Sort (v0.1.0-module3.0, Android DirectorySortEntity 对齐) ──
export type DirectorySortField = 'name' | 'modifiedAt' | 'size';
export interface DirectorySort {
  locationKey: string;
  sortField: DirectorySortField;
  ascending: boolean;
}
export async function getDirectorySort(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
): Promise<DirectorySort | null> {
  return invoke<DirectorySort | null>('get_directory_sort', { sourceDescriptor, relPath });
}
export async function setDirectorySort(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
  sortField: DirectorySortField,
  ascending: boolean,
): Promise<void> {
  await invoke<void>('set_directory_sort', {
    args: { sourceDescriptor, relPath, sortField, ascending },
  });
}

// ─── Image Dimensions (v0.1.0-module3.0.6 masonry) ─────────────────────
export interface ImageDim {
  path: string;
  width: number;
  height: number;
}

/** 批量读图片尺寸（仅 masonry viewMode 触发）。paths 是预读窗口子集。 */
export async function listImageDimensions(
  descriptor: SourceDescriptor,
  paths: string[],
): Promise<ImageDim[]> {
  return invoke<ImageDim[]>('list_image_dimensions', { descriptor, paths });
}

// ─── Directory Masonry (v0.1.0-module3.0.6 per-folder 布局参数) ──────────
export interface DirectoryMasonry {
  colCount: number | null;
  hGap: number | null;
  vGap: number | null;
}

export async function getDirectoryMasonry(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
): Promise<DirectoryMasonry | null> {
  return invoke<DirectoryMasonry | null>('get_directory_masonry', { sourceDescriptor, relPath });
}

export async function setDirectoryMasonry(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
  colCount: number | null,
  hGap: number | null,
  vGap: number | null,
): Promise<void> {
  await invoke<void>('set_directory_masonry', {
    args: { sourceDescriptor, relPath, colCount, hGap, vGap },
  });
}

// ─── 缩略图缓存 (v0.1.0-module3.0.7) ─────────────────────────────────────
// 图片字节不进前端；Rust 返回缓存绝对路径，前端 convertFileSrc 转 asset URL。
import type {
  ThumbnailRequestItem,
  ThumbnailRequestResult,
  ThumbnailQuality,
} from './thumbnail';

export interface ThumbnailStateEvent {
  epoch: number;
  cacheKey: string;
  path: string;
  state: 'cached' | 'failed' | 'stale';
  cachePath: string | null;
  outputWidth: number | null;
  outputHeight: number | null;
  message: string | null;
}

/** 批量请求缩略图状态（命中直返 cached/original，未命中 queued 后由事件通知）。 */
export async function requestThumbnails(
  descriptor: SourceDescriptor,
  items: ThumbnailRequestItem[],
  epoch: number,
  visibleCacheKeys: string[],
): Promise<ThumbnailRequestResult[]> {
  return invoke<ThumbnailRequestResult[]>('request_thumbnails', {
    descriptor,
    items,
    epoch,
    visibleCacheKeys,
  });
}

export async function retryThumbnail(
  descriptor: SourceDescriptor,
  item: ThumbnailRequestItem,
  epoch: number,
): Promise<ThumbnailRequestResult> {
  return invoke<ThumbnailRequestResult>('retry_thumbnail', { descriptor, item, epoch });
}

export async function regenerateThumbnail(
  descriptor: SourceDescriptor,
  item: ThumbnailRequestItem,
  epoch: number,
): Promise<ThumbnailRequestResult> {
  return invoke<ThumbnailRequestResult>('regenerate_thumbnail', { descriptor, item, epoch });
}

export async function updateThumbnailRuntimeConfig(
  workerLimit: number,
  memoryBudgetMb: number,
  quality: ThumbnailQuality,
): Promise<void> {
  await invoke<void>('update_thumbnail_runtime_config', {
    workerLimit,
    memoryBudgetMb,
    quality,
  });
}

/** P1-4: 缓存容量运行时生效（设置页改完即时推送）。 */
export async function updateThumbnailCacheLimit(limitMb: number): Promise<void> {
  await invoke<void>('update_thumbnail_cache_limit', { limitMb });
}

// ─── 缓存位置迁移（§11）──────────────────────────────────────────────
export interface ThumbnailMigrationState {
  version: number;
  sourceRoot: string;
  targetRoot: string;
  mode: 'move' | 'copy';
  phase: string;
  completed: string[];
  totalFiles: number;
  totalBytes: number;
  copiedBytes: number;
}

export async function validateThumbnailCacheLocation(target: string): Promise<void> {
  await invoke<void>('validate_thumbnail_cache_location', { target });
}

export async function migrateThumbnailCache(target: string, mode: 'move' | 'copy'): Promise<void> {
  await invoke<void>('migrate_thumbnail_cache', { target, mode });
}

export async function cancelThumbnailCacheMigration(): Promise<void> {
  await invoke<void>('cancel_thumbnail_cache_migration');
}

export async function resumeThumbnailCacheMigration(target: string, mode: 'move' | 'copy'): Promise<void> {
  await invoke<void>('resume_thumbnail_cache_migration', { target, mode });
}

export async function rollbackThumbnailCacheMigration(target: string): Promise<void> {
  await invoke<void>('rollback_thumbnail_cache_migration', { target });
}

export async function getThumbnailMigrationState(): Promise<ThumbnailMigrationState | null> {
  return invoke<ThumbnailMigrationState | null>('get_thumbnail_migration_state');
}

export async function getThumbnailCacheInfo(): Promise<{ bytes: number; count: number }> {
  return invoke<{ bytes: number; count: number }>('get_thumbnail_cache_info');
}

export async function clearThumbnailCache(): Promise<void> {
  await invoke<void>('clear_thumbnail_cache');
}

export async function notifyThumbnailEpoch(epoch: number): Promise<void> {
  await invoke<void>('notify_thumbnail_epoch', { epoch });
}

export async function notifyThumbnailFastScrolling(fast: boolean): Promise<void> {
  await invoke<void>('notify_thumbnail_fast_scrolling', { fast });
}

/** 缓存绝对路径转 asset URL（前端 <img> 直接加载）。 */
export function thumbnailCacheUrl(cachePath: string): string {
  return convertFileSrc(cachePath);
}

// ─── Progress (Phase 4) ─────────────────────────────────────────────────
export interface ProgressItem {
  bookId: number;
  page: number;
  /** v0.1.0-module3.0.8: 瀑布流浏览位置锚点——masonry 滚动时写入 top visible image 名。
   *  reader 翻页路径不传（保持 null），reload 时按 imageName 找 spread index 恢复。 */
  imageName: string | null;
  readerMode: 'single' | 'double';
  updatedAt: number;
  /** 2026-08-12 跨卷任务 4: 补齐 ProgressItem gap（DB 列已存在，Rust/TS 对齐）。
   *  Loader `resolveInitialSpreadIndex` 用此判定"已读完 → 第 1 页"。 */
  finished: boolean;
}
/**
 * 保存阅读进度。
 * finished 语义：
 * - true: 翻到末页（永久 true，翻回不清零）
 * - false: 主动重置（清 browse_history）
 * - undefined: 普通翻页，保留已有 finished 值
 *
 * v0.1.0-module3.0.8 imageName 语义：
 * - undefined / null: 保留旧值（reader 翻页路径不传，走 page 路径）
 * - string: 覆盖为该值（masonry 滚动时写入 top visible image 名）
 *
 * 调用约定：
 * - reader 翻页：`saveProgress(bookId, page, readerMode)`  → 4 参，imageName=undefined 保留
 * - reader 翻末页：`saveProgress(bookId, page, readerMode, true)` → finished=true, imageName 保留
 * - masonry 滚动：`saveProgress(bookId, page, 'single', undefined, imageName)` → finished 保留
 */
export async function saveProgress(
  bookId: number,
  page: number,
  readerMode: 'single' | 'double',
  finished?: boolean,
  imageName?: string,
): Promise<void> {
  await invoke<void>('save_progress', {
    bookId,
    page,
    readerMode,
    finished: finished ?? null,
    imageName: imageName ?? null,
  });
}

/**
 * v0.1.0-module3.0.2 (H5): 取单本书的最近阅读进度.
 * ReaderView 在 mount 时调用, 把 lastPage 映射成 spreadIndex 实现
 * "关书再开恢复原页" 体验. 不存在进度时返回 null.
 */
export async function getProgress(bookId: number): Promise<ProgressItem | null> {
  return invoke<ProgressItem | null>('get_progress', { bookId });
}

/**
 * 手动标记 finished (右键菜单「重置阅读进度」用)。
 * finished=false 时 Rust 端会清 browse_history。
 */
export async function markFinished(bookId: number, finished: boolean): Promise<void> {
  await invoke<void>('mark_finished', { bookId, finished });
}

/**
 * 返回所有 progress.finished 映射 { book_id: bool }。
 * key 是 i64 字符串 (与 Rust HashMap<String, bool> 一致)。
 */
export async function listProgressFinished(): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>('list_progress_finished');
}

// ─── Tags (Phase 4) ─────────────────────────────────────────────────────
export interface TagItem {
  id: number;
  name: string;
  color: string | null;
  createdAt: number;
}
export async function listTags(): Promise<TagItem[]> {
  return invoke<TagItem[]>('list_tags');
}
export async function createTag(name: string, color: string | null = null): Promise<TagItem> {
  return invoke<TagItem>('create_tag', { name, color });
}
export async function deleteTag(id: number): Promise<void> {
  await invoke<void>('delete_tag', { id });
}
export async function addBookTag(bookId: number, tagId: number): Promise<void> {
  await invoke<void>('add_book_tag', { bookId, tagId });
}
export async function removeBookTag(bookId: number, tagId: number): Promise<void> {
  await invoke<void>('remove_book_tag', { bookId, tagId });
}

// ─── Accounts (Phase 7-8) ──────────────────────────────────────────────
export interface AccountItem {
  id: number;
  name: string;
  type: 'smb' | 'webdav';
  host?: string;
  port?: number;
  share?: string;
  username?: string;
}
export async function listAccounts(): Promise<AccountItem[]> {
  return invoke<AccountItem[]>('list_accounts');
}
export async function upsertAccount(
  acct: Partial<AccountItem> & { name: string; type: 'smb' | 'webdav'; password?: string | null },
): Promise<number> {
  return invoke<number>('upsert_account', { acct });
}
export async function deleteAccount(id: number): Promise<void> {
  await invoke<void>('delete_account', { id });
}
export async function testConnection(id: number): Promise<boolean> {
  return invoke<boolean>('test_connection', { id });
}

// ─── Continue Volume (Phase 5) ──────────────────────────────────────────
// v0.1.0-module3.0.2 (H4): Rust 端 fn find_next_volume(args: FindNextVolumeArgs) 单结构体,
// 走 v0.1.0-module2.1 的 `{ args: { ... } }` 包装契约 + camelCase.
// v0.1.0-module3.0.x-cross-volume (spec §6.1): 返回类型由 string|null 升级为 NextVolumeResult|null
// (descriptor + relPath + title;无 isArchive —— 仅 Local 目录卷).filter 参数从未存在,v2 显式确认无 filter.
export interface NextVolumeResult {
  descriptor: SourceDescriptor;   // 同源 Local,rootPath 不变
  relPath: string;                // 下一卷相对 rootPath 完整路径
  title: string;                  // 目录名
  // 注:无 isArchive 字段(本版仅 Local 目录卷)
}
export async function findNextVolume(
  descriptor: SourceDescriptor,
  currentPath: string,
  direction: 'next' | 'prev',
): Promise<NextVolumeResult | null> {
  return invoke<NextVolumeResult | null>('find_next_volume', {
    args: { descriptor, currentPath, direction },
  });
}

// ─── Shortcuts (v0.1.0-module3.0.5: 跨源 + 子目录, Android ShortcutEntity 对齐) ──
export interface ShortcutItem {
  id: number;
  sourceDescriptorJson: string;
  relPath: string;
  alias: string | null;
  iconHint: string;
  createdAt: number;
}
export async function listShortcuts(): Promise<ShortcutItem[]> {
  return invoke<ShortcutItem[]>('list_shortcuts');
}
export async function createShortcut(
  sourceDescriptorJson: string,
  relPath: string,
  alias: string | null,
): Promise<number> {
  return invoke<number>('create_shortcut', { sourceDescriptorJson, relPath, alias });
}
export async function deleteShortcut(id: number): Promise<void> {
  await invoke<void>('delete_shortcut', { id });
}

// ─── Reader keep-screen-on (v0.1.0-module2.0) ──────────────────────────
/**
 * 阅读器阻止屏幕休眠 / 自动锁屏.
 * Windows 调 SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED).
 * macOS / Linux 暂 stub (Phase 9 跨平台分发时补).
 */
export async function keepScreenOn(enable: boolean): Promise<void> {
  await invoke<void>('keep_screen_on', { enable });
}