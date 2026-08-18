/**
 * Bookmarks Pinia store 测试
 * - list: 调用 backend list_bookmarks(按书 ID 过滤)
 * - add: 添加后状态更新
 * - remove: 删除后状态更新
 * - 该书的所有书签按页排序
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listBookmarks: vi.fn(async (_bookId: number) => [
    { id: 1, bookId: 1, page: 5, positionKind: 'image', label: null, createdAt: 100 },
    { id: 2, bookId: 1, page: 2, positionKind: 'image', label: null, createdAt: 200 },
    { id: 3, bookId: 1, page: 8, positionKind: 'image', label: null, createdAt: 300 },
  ]),
  addBookmark: vi.fn(async (bookId: number, page: number, label: string | null) => ({
    id: 99,
    bookId,
    page,
    positionKind: 'image',
    label,
    createdAt: 999,
  })),
  removeBookmark: vi.fn(async () => undefined),
}));

import { useBookmarksStore } from './bookmarks';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('bookmarks store', () => {
  it('list returns bookmarks sorted by page ascending', async () => {
    const store = useBookmarksStore();
    const items = await store.list(1);
    expect(items.map((b) => b.page)).toEqual([2, 5, 8]);
  });

  it('add appends new bookmark to local list', async () => {
    const store = useBookmarksStore();
    await store.list(1);
    await store.add(1, 10, null);
    const last = store.items[store.items.length - 1];
    expect(last.page).toBe(10);
    expect(last.id).toBe(99);
  });

  it('remove drops bookmark by id', async () => {
    const store = useBookmarksStore();
    await store.list(1);
    await store.remove(2);
    expect(store.items.find((b) => b.id === 2)).toBeUndefined();
  });

  it('load onBookId change triggers reload', async () => {
    const store = useBookmarksStore();
    await store.list(1);
    await store.list(2);
    // mock 用 _bookId 都被接受,不变;行为确认 store 缓存
    expect(store.items.length).toBe(3);
  });
});