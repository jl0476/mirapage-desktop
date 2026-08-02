/**
 * directorySort store 测试 — v0.1.0-module3.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useDirectorySortStore } from './directorySort';
import { getDirectorySort, setDirectorySort } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    getDirectorySort: vi.fn(),
    setDirectorySort: vi.fn(async () => undefined),
  };
});

import type { SourceDescriptor } from '@/lib/sourceDescriptor';

const sd: SourceDescriptor = { type: 'local', rootPath: 'C:/comics' };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('useDirectorySortStore', () => {
  it('resolve 未命中 → 返回 null', async () => {
    vi.mocked(getDirectorySort).mockResolvedValueOnce(null);
    const store = useDirectorySortStore();
    expect(await store.resolve(sd, 'Vol.01')).toBeNull();
  });

  it('resolve 命中 → 缓存 + 返回', async () => {
    vi.mocked(getDirectorySort).mockResolvedValueOnce({
      locationKey: 'x',
      sortField: 'name',
      ascending: false,
    });
    const store = useDirectorySortStore();
    const first = await store.resolve(sd, 'Vol.01');
    expect(first).toEqual({ sortField: 'name', ascending: false });
    // 第二次命中缓存
    expect(await store.resolve(sd, 'Vol.01')).toEqual({ sortField: 'name', ascending: false });
    expect(getDirectorySort).toHaveBeenCalledTimes(1);
  });

  it('set → 写 cache + 调 setDirectorySort', async () => {
    const store = useDirectorySortStore();
    await store.set(sd, 'Vol.01', { sortField: 'modifiedAt', ascending: true });
    expect(setDirectorySort).toHaveBeenCalledWith(sd, 'Vol.01', 'modifiedAt', true);
    // 后续 resolve 命中缓存，不再调 getDirectorySort
    expect(await store.resolve(sd, 'Vol.01')).toEqual({ sortField: 'modifiedAt', ascending: true });
    expect(getDirectorySort).not.toHaveBeenCalled();
  });

  it('resolve IPC 失败 → 返回 null（不抛）', async () => {
    vi.mocked(getDirectorySort).mockRejectedValueOnce(new Error('boom'));
    const store = useDirectorySortStore();
    expect(await store.resolve(sd, 'Vol.02')).toBeNull();
  });

  it('set IPC 失败 → 静默（容错，cache 已更新）', async () => {
    vi.mocked(setDirectorySort).mockRejectedValueOnce(new Error('boom'));
    const store = useDirectorySortStore();
    await expect(
      store.set(sd, 'Vol.03', { sortField: 'size', ascending: false }),
    ).resolves.toBeUndefined();
    // cache 仍写入
    expect(await store.resolve(sd, 'Vol.03')).toEqual({ sortField: 'size', ascending: false });
  });
});