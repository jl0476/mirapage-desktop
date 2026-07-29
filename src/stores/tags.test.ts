/**
 * tags store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listTags: vi.fn(async () => [
    { id: 1, name: 'comedy', color: null, createdAt: 100 },
    { id: 2, name: 'horror', color: '#000', createdAt: 200 },
  ]),
  createTag: vi.fn(async (name: string, color: string | null) => ({
    id: 99,
    name,
    color,
    createdAt: 999,
  })),
  deleteTag: vi.fn(async () => undefined),
  addBookTag: vi.fn(async () => undefined),
  removeBookTag: vi.fn(async () => undefined),
}));

import { useTagsStore } from './tags';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('tags store', () => {
  it('refresh populates tags', async () => {
    const store = useTagsStore();
    await store.refresh();
    expect(store.tags).toHaveLength(2);
    expect(store.tagsById[1].name).toBe('comedy');
  });

  it('create appends new tag to list', async () => {
    const store = useTagsStore();
    await store.create('action', null);
    expect(store.tags.find((t) => t.name === 'action')).toBeDefined();
  });

  it('remove drops tag', async () => {
    const store = useTagsStore();
    await store.refresh();
    await store.remove(1);
    expect(store.tags.find((t) => t.id === 1)).toBeUndefined();
  });

  it('tagBook adds tagId to bookTags', async () => {
    const store = useTagsStore();
    await store.tagBook(10, 1);
    expect(store.bookTagsByBookId[10]).toEqual([1]);
  });
});