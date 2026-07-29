/**
 * search store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  search: vi.fn(async (q: string) => {
    if (q.includes('xxx')) return [];
    return [
      { source: 'library', bookId: 1, title: `Matched ${q}`, snippet: null },
    ];
  }),
}));

import { useSearchStore } from './search';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('search store', () => {
  it('run with empty query returns empty hits', async () => {
    const store = useSearchStore();
    const hits = await store.run('   ');
    expect(hits).toEqual([]);
  });

  it('run with non-empty query delegates to backend', async () => {
    const store = useSearchStore();
    const hits = await store.run('something');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('something');
  });

  it('clear resets state', async () => {
    const store = useSearchStore();
    await store.run('abc');
    expect(store.hits.length).toBeGreaterThan(0);
    store.clear();
    expect(store.query).toBe('');
    expect(store.hits).toEqual([]);
  });
});