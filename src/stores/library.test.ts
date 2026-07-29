/**
 * library store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listLibrary: vi.fn(async () => [
    {
      id: 1,
      title: 'A',
      sourceDescriptor: '{}',
      lastReadAt: 100,
      isFavorite: true,
    },
    {
      id: 2,
      title: 'B',
      sourceDescriptor: '{}',
      lastReadAt: 200,
      isFavorite: false,
    },
    {
      id: 3,
      title: 'C',
      sourceDescriptor: '{}',
      lastReadAt: null,
      isFavorite: false,
    },
  ]),
  setFavorite: vi.fn(async () => undefined),
}));

import { useLibraryStore } from './library';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('library store', () => {
  it('refresh populates items', async () => {
    const store = useLibraryStore();
    await store.refresh();
    expect(store.items).toHaveLength(3);
  });

  it('favorites only contains isFavorite=true items', async () => {
    const store = useLibraryStore();
    await store.refresh();
    expect(store.favorites.map((b) => b.id)).toEqual([1]);
  });

  it('sorted places favorites first then by lastReadAt DESC', async () => {
    const store = useLibraryStore();
    await store.refresh();
    expect(store.sorted.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it('toggleFavorite flips local state', async () => {
    const store = useLibraryStore();
    await store.refresh();
    expect(store.items[1].isFavorite).toBe(false);
    await store.toggleFavorite(2);
    expect(store.items[1].isFavorite).toBe(true);
  });
});