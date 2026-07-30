/**
 * fileBrowser store 单测 — 模块 #1
 * 覆盖：rootPath 状态、setRoot / navigate / refresh / up、错误状态
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFileBrowserStore } from './fileBrowser';
import { listDirectory } from '@/lib/tauri';
import type { MediaEntry } from '@/lib/sourceDescriptor';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listDirectory: vi.fn() };
});
const mockedList = vi.mocked(listDirectory);

const localRoot = (p: string) => ({ type: 'local' as const, rootPath: p });

function makeEntries(...names: string[]): MediaEntry[] {
  return names.map((n) => ({
    name: n,
    path: n,
    isDirectory: !n.includes('.'),
    isArchive: n.endsWith('.cbz') || n.endsWith('.zip'),
    size: 100,
  }));
}

describe('fileBrowser store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('初始状态：rootPath=null, currentPath="", entries=[], error=null', () => {
    const store = useFileBrowserStore();
    expect(store.rootPath).toBeNull();
    expect(store.currentPath).toBe('');
    expect(store.entries).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it('setRoot(root) 更新 rootPath + currentPath="" + 拉根目录条目', async () => {
    mockedList.mockResolvedValue(makeEntries('comic1.cbz', 'chapter1'));
    const store = useFileBrowserStore();

    await store.setRoot('C:/comics');

    expect(store.rootPath).toBe('C:/comics');
    expect(store.currentPath).toBe('');
    expect(store.entries.length).toBe(2);
    expect(mockedList).toHaveBeenCalledWith(localRoot('C:/comics'), '');
  });

  it('setRoot(null) 清空状态，不调 listDirectory', async () => {
    mockedList.mockResolvedValue([]);
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    mockedList.mockClear();

    await store.setRoot(null);

    expect(store.rootPath).toBeNull();
    expect(store.currentPath).toBe('');
    expect(store.entries).toEqual([]);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('navigate(p) 更新 currentPath + 拉新条目', async () => {
    mockedList.mockResolvedValue(makeEntries('chapter1'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    mockedList.mockResolvedValue(makeEntries('chapter1/page1.jpg', 'chapter1/page2.jpg'));
    await store.navigate('chapter1');

    expect(store.currentPath).toBe('chapter1');
    expect(mockedList).toHaveBeenLastCalledWith(localRoot('C:/comics'), 'chapter1');
    expect(store.entries.length).toBe(2);
  });

  it('refresh() 重新拉当前 path', async () => {
    mockedList.mockResolvedValue(makeEntries('chapter1'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    mockedList.mockClear();
    mockedList.mockResolvedValue(makeEntries('chapter1', 'chapter2'));
    await store.refresh();

    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenCalledWith(localRoot('C:/comics'), '');
  });

  it('up() 跳到父目录', async () => {
    mockedList.mockResolvedValue(makeEntries('rootA', 'rootB'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    mockedList.mockResolvedValue(makeEntries('chapter1', 'chapter2'));
    await store.navigate('chapter1');

    mockedList.mockResolvedValue(makeEntries('rootA', 'rootB'));
    await store.up();

    expect(store.currentPath).toBe('');
  });

  it('up() 支持多级嵌套目录回退 (chapter/sub → chapter)', async () => {
    mockedList.mockResolvedValue(makeEntries('chapter'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    mockedList.mockResolvedValue(makeEntries('sub'));
    await store.navigate('chapter');

    mockedList.mockResolvedValue(makeEntries('page1'));
    await store.navigate('chapter/sub');

    mockedList.mockClear();
    mockedList.mockResolvedValue(makeEntries('sub'));
    await store.up();

    expect(store.currentPath).toBe('chapter');
    expect(mockedList).toHaveBeenCalledWith(localRoot('C:/comics'), 'chapter');
  });

  it('up() 在根目录不报错，currentPath 仍为 ""，不调 listDirectory', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    mockedList.mockClear();
    await store.up();

    expect(store.currentPath).toBe('');
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('listDirectory 抛错 → error 状态', async () => {
    mockedList.mockRejectedValueOnce(new Error('not found'));
    const store = useFileBrowserStore();

    await store.setRoot('C:/missing');

    expect(store.error).not.toBeNull();
    expect(store.error?.kind).toBe('io');
    expect(store.error?.message).toBe('not found');
  });

  it('navigate 抛错也设 error 状态', async () => {
    mockedList.mockResolvedValueOnce(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');

    mockedList.mockRejectedValueOnce(new Error('permission denied'));
    await store.navigate('forbidden');

    expect(store.error?.kind).toBe('io');
    expect(store.error?.message).toBe('permission denied');
  });

  it('下次成功 fetch 清空前次 error', async () => {
    mockedList.mockRejectedValueOnce(new Error('first failure'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/comics');
    expect(store.error).not.toBeNull();

    mockedList.mockResolvedValueOnce(makeEntries('recovered'));
    await store.navigate('');

    expect(store.error).toBeNull();
    expect(store.entries.length).toBe(1);
  });
});
