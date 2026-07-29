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

// ─── History (Phase 4) ──────────────────────────────────────────────────
export interface HistoryItem {
  bookId: number;
  sourceDescriptor: SourceDescriptor;
  lastPage: number;
  lastReadAt: number;
}
export async function listHistory(): Promise<HistoryItem[]> {
  return invoke<HistoryItem[]>('list_history');
}
export async function recordHistory(
  sourceDescriptor: SourceDescriptor,
  bookId: number,
  lastPage: number,
): Promise<void> {
  await invoke<void>('record_history', { sourceDescriptor, bookId, lastPage });
}

// ─── Library / Book (Phase 4) ───────────────────────────────────────────
export interface BookItem {
  id: number;
  title: string;
  sourceDescriptor: SourceDescriptor;
  lastReadAt: number | null;
  isFavorite: boolean;
}
export async function listLibrary(): Promise<BookItem[]> {
  return invoke<BookItem[]>('list_library');
}
export async function setFavorite(bookId: number, favorite: boolean): Promise<void> {
  await invoke<void>('set_favorite', { bookId, favorite });
}

// ─── Progress (Phase 4) ─────────────────────────────────────────────────
export interface ProgressItem {
  bookId: number;
  page: number;
  readerMode: 'single' | 'double';
  updatedAt: number;
}
export async function saveProgress(
  bookId: number,
  page: number,
  readerMode: 'single' | 'double',
): Promise<void> {
  await invoke<void>('save_progress', { bookId, page, readerMode });
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