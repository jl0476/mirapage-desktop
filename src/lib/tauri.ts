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

import { invoke } from '@tauri-apps/api/core';
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
}
export async function listHistory(): Promise<BrowseHistoryEntry[]> {
  return invoke<BrowseHistoryEntry[]>('list_history');
}
/**
 * FileBrowser.fetch 成功后调 — upsert 到 browse_history（folder-level）
 * Tauri 2: 单个结构体参数 invoke 时前端传 { args: { ... } }
 */
export async function recordHistory(
  sourceDescriptor: SourceDescriptor,
  relPath: string,
  displayName: string,
): Promise<void> {
  await invoke<void>('record_history', { args: { sourceDescriptor, relPath, displayName } });
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

// ─── Progress (Phase 4) ─────────────────────────────────────────────────
export interface ProgressItem {
  bookId: number;
  page: number;
  readerMode: 'single' | 'double';
  updatedAt: number;
}
/**
 * 保存阅读进度。
 * finished 语义：
 * - true: 翻到末页（永久 true，翻回不清零）
 * - false: 主动重置（清 browse_history）
 * - undefined: 普通翻页，保留已有 finished 值
 */
export async function saveProgress(
  bookId: number,
  page: number,
  readerMode: 'single' | 'double',
  finished?: boolean,
): Promise<void> {
  await invoke<void>('save_progress', {
    bookId,
    page,
    readerMode,
    finished: finished ?? null,
  });
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

// ─── Search (Phase 4) ───────────────────────────────────────────────────
export interface SearchHit {
  source: 'library' | 'bookmark' | 'history' | 'tag';
  bookId: number;
  title: string;
  snippet?: string;
}
export async function search(query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search', { query });
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
export async function findNextVolume(
  descriptor: SourceDescriptor,
  currentPath: string,
  direction: 'next' | 'prev',
): Promise<string | null> {
  return invoke<string | null>('find_next_volume', { descriptor, currentPath, direction });
}

// ─── Shortcuts (模块 #1) ───────────────────────────────────────────────
export interface ShortcutItem {
  id: number;
  rootPath: string;
  label: string | null;
  createdAt: number;
}
export async function listShortcuts(): Promise<ShortcutItem[]> {
  return invoke<ShortcutItem[]>('list_shortcuts');
}
export async function createShortcut(
  rootPath: string,
  label: string | null,
): Promise<number> {
  return invoke<number>('create_shortcut', { rootPath, label });
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