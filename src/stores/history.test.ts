/**
 * history store 测试 — v0.1.0-module3.0 BrowseHistoryEntry shape
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listHistory: vi.fn(async () => [
    {
      sourceDescriptor: { type: 'local', rootPath: '/manga' } as never,
      relPath: '',
      displayName: 'root',
      lastVisitedAt: 200,
      bookId: null,
    },
    {
      sourceDescriptor: { type: 'local', rootPath: '/manga' } as never,
      relPath: 'VOL.01',
      displayName: 'VOL.01',
      lastVisitedAt: 100,
      bookId: null,
    },
  ]),
  recordHistory: vi.fn(async () => undefined),
  deleteHistory: vi.fn(async () => undefined),
}));

import { useHistoryStore } from './history';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('history store', () => {
  it('refresh populates items from listHistory', async () => {
    const store = useHistoryStore();
    await store.refresh();
    expect(store.items.length).toBe(2);
    expect(store.items[0]!.relPath).toBe('');
    expect(store.items[1]!.relPath).toBe('VOL.01');
  });

  it('record calls recordHistory (容错)', async () => {
    const { recordHistory } = await import('@/lib/tauri');
    const store = useHistoryStore();
    await store.record({ type: 'local', rootPath: '/x' } as never, 'VOL.02', 'VOL.02');
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/x' },
      'VOL.02',
      'VOL.02',
    );
  });

  it('record 容错: recordHistory 抛错不传播', async () => {
    const { recordHistory } = await import('@/lib/tauri');
    vi.mocked(recordHistory).mockRejectedValueOnce(new Error('boom'));
    const store = useHistoryStore();
    await expect(
      store.record({ type: 'local', rootPath: '/x' } as never, 'a', 'a'),
    ).resolves.toBeUndefined();
  });

  it('deleteEntry 调 deleteHistory + refresh', async () => {
    const { deleteHistory, listHistory } = await import('@/lib/tauri');
    vi.mocked(listHistory).mockResolvedValueOnce([
      {
        sourceDescriptor: { type: 'local', rootPath: '/manga' } as never,
        relPath: 'Vol.01',
        displayName: 'Vol.01',
        lastVisitedAt: 100,
        bookId: 42,
      },
    ]);
    const store = useHistoryStore();
    await store.refresh();
    await store.deleteEntry(store.items[0]!);
    expect(deleteHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/manga' },
      'Vol.01',
    );
  });
});