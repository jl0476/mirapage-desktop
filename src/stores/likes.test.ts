/**
 * likes store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listLikes: vi.fn(async () => [
    { bookId: 1, likedAt: 100 },
    { bookId: 2, likedAt: 200 },
  ]),
  toggleLike: vi.fn(),
}));

import { useLikesStore } from './likes';
import * as tauri from '@/lib/tauri';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('likes store', () => {
  it('refresh populates items', async () => {
    const store = useLikesStore();
    await store.refresh();
    expect(store.items).toHaveLength(2);
  });

  it('isLiked returns true when bookId in items', async () => {
    const store = useLikesStore();
    await store.refresh();
    expect(store.isLiked(1)).toBe(true);
    expect(store.isLiked(99)).toBe(false);
  });

  it('toggle inserts when backend returns true', async () => {
    vi.mocked(tauri.toggleLike).mockResolvedValueOnce(true);
    const store = useLikesStore();
    await store.toggle(42);
    expect(store.isLiked(42)).toBe(true);
  });

  it('toggle does not insert when backend returns false', async () => {
    vi.mocked(tauri.toggleLike).mockResolvedValueOnce(false);
    const store = useLikesStore();
    await store.toggle(42);
    expect(store.isLiked(42)).toBe(false);
  });
});