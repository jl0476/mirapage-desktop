/**
 * history store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listHistory: vi.fn(async () => [
    { bookId: 1, sourceDescriptor: '{}', lastPage: 9, lastReadAt: 200 },
    { bookId: 2, sourceDescriptor: '{}', lastPage: 4, lastReadAt: 100 },
  ]),
  recordHistory: vi.fn(async () => undefined),
}));

import { useHistoryStore } from './history';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('history store', () => {
  it('refresh populates items sorted by lastReadAt DESC', async () => {
    const store = useHistoryStore();
    await store.refresh();
    expect(store.sorted.map((it) => it.bookId)).toEqual([1, 2]);
  });

  it('record calls backend then refreshes', async () => {
    const { recordHistory } = await import('@/lib/tauri');
    const store = useHistoryStore();
    await store.record(99, 7, { type: 'local', rootPath: '/x' } as any);
    expect(recordHistory).toHaveBeenCalled();
  });

  it('lastPageOf returns lastPage for bookId', async () => {
    const store = useHistoryStore();
    await store.refresh();
    expect(store.lastPageOf(1)).toBe(9);
    expect(store.lastPageOf(99)).toBeUndefined();
  });
});