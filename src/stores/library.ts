/**
 * Library Pinia store
 * 与 Rust commands::library 对接(DESIGn §5 Phase 4):
 *   - list_library() → BookItem[]
 *   - set_favorite(book_id, fav)
 *
 * 收藏的书(isFavorite=true)先显示,再按 lastReadAt DESC 排。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { listLibrary, setFavorite, type BookItem } from '@/lib/tauri';

export const useLibraryStore = defineStore('library', () => {
  const items = ref<BookItem[]>([]);

  const favorites = computed<BookItem[]>(() => items.value.filter((b) => b.isFavorite));

  const sorted = computed<BookItem[]>(() =>
    [...items.value].sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      const ta = a.lastReadAt ?? 0;
      const tb = b.lastReadAt ?? 0;
      return tb - ta;
    }),
  );

  async function refresh(): Promise<void> {
    items.value = await listLibrary();
  }

  async function toggleFavorite(bookId: number): Promise<void> {
    const target = items.value.find((b) => b.id === bookId);
    if (!target) return;
    const nextFav = !target.isFavorite;
    await setFavorite(bookId, nextFav);
    items.value = items.value.map((b) =>
      b.id === bookId ? { ...b, isFavorite: nextFav } : b,
    );
  }

  return { items, sorted, favorites, refresh, toggleFavorite };
});