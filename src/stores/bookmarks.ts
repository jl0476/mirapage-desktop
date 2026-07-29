/**
 * Bookmarks Pinia store
 * 与 Rust commands::bookmarks 对接 (DESIGn §5 Phase 4):
 *   - list_bookmarks(book_id)
 *   - add_bookmark(book_id, page, label)
 *   - remove_bookmark(id)
 *
 * 本 store 持有 reactive items 列表,调用 Tauri command 同步。
 * 未连 Tauri 时,fallback 到 mock(便于 UI 测试)。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { listBookmarks, addBookmark, removeBookmark } from '@/lib/tauri';

export interface BookmarkItem {
  id: number;
  bookId: number;
  page: number;
  label: string | null;
  createdAt: number;
}

export const useBookmarksStore = defineStore('bookmarks', () => {
  const items = ref<BookmarkItem[]>([]);
  const currentBookId = ref<number | null>(null);

  /** 按页升序 */
  const sorted = computed<BookmarkItem[]>(() =>
    [...items.value].sort((a, b) => a.page - b.page),
  );

  /** 列表(当前书) */
  async function list(bookId: number): Promise<BookmarkItem[]> {
    currentBookId.value = bookId;
    items.value = await listBookmarks(bookId);
    return sorted.value;
  }

  /** 新增 */
  async function add(bookId: number, page: number, label: string | null = null): Promise<BookmarkItem> {
    const bm = await addBookmark(bookId, page, label);
    items.value = [...items.value, bm];
    return bm;
  }

  /** 删除 */
  async function remove(id: number): Promise<void> {
    await removeBookmark(id);
    items.value = items.value.filter((b) => b.id !== id);
  }

  /** 清空缓存 */
  function clear(): void {
    items.value = [];
    currentBookId.value = null;
  }

  return { items, sorted, currentBookId, list, add, remove, clear };
});