/**
 * Likes Pinia store
 * 与 Rust commands::likes 对接(DESIGn §5 Phase 4):
 *   - list_likes() → LikeItem[]
 *   - toggle_like(book_id) → boolean(返回是否当前 liked)
 *
 * 当前书 ID 单独存,便于视图展示。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listLikes, toggleLike, type LikeItem } from '@/lib/tauri';

export const useLikesStore = defineStore('likes', () => {
  const items = ref<LikeItem[]>([]);

  function isLiked(bookId: number): boolean {
    return items.value.some((it) => it.bookId === bookId);
  }

  async function refresh(): Promise<void> {
    items.value = await listLikes();
  }

  async function toggle(bookId: number): Promise<boolean> {
    const liked = await toggleLike(bookId);
    if (liked) {
      items.value = [...items.value, { bookId, likedAt: Date.now() }];
    } else {
      items.value = items.value.filter((it) => it.bookId !== bookId);
    }
    return liked;
  }

  return { items, isLiked, refresh, toggle };
});