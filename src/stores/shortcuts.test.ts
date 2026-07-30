/**
 * shortcuts store 单测 — 模块 #1
 * 覆盖 7 行为：refresh / add / remove / 移除当前 active 清空 activeId / setActive / active computed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useShortcutsStore } from './shortcuts';
import { listShortcuts, createShortcut, deleteShortcut } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listShortcuts: vi.fn(),
    createShortcut: vi.fn(),
    deleteShortcut: vi.fn(),
  };
});

const mockedList = vi.mocked(listShortcuts);
const mockedCreate = vi.mocked(createShortcut);
const mockedDelete = vi.mocked(deleteShortcut);

describe('shortcuts store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('refresh() 拉取并填充 items', async () => {
    mockedList.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
      { id: 2, rootPath: 'C:/b', label: null, createdAt: 200 },
    ]);
    const store = useShortcutsStore();
    await store.refresh();

    expect(store.items).toHaveLength(2);
    expect(store.items[0].id).toBe(1);
    expect(store.items[1].label).toBeNull();
    expect(store.loading).toBe(false);
  });

  it('refresh() 中 loading=true，期间为 true', async () => {
    let resolveFn!: (v: unknown) => void;
    mockedList.mockImplementation(
      () => new Promise((resolve) => { resolveFn = resolve; }) as any,
    );
    const store = useShortcutsStore();
    const p = store.refresh();
    expect(store.loading).toBe(true);
    resolveFn([]);
    await p;
    expect(store.loading).toBe(false);
  });

  it('add() 调 createShortcut + refresh；返回 id', async () => {
    mockedCreate.mockResolvedValue(42);
    mockedList.mockResolvedValue([
      { id: 42, rootPath: 'C:/new', label: 'New', createdAt: 999 },
    ]);
    const store = useShortcutsStore();
    const id = await store.add('C:/new', 'New');

    expect(id).toBe(42);
    expect(mockedCreate).toHaveBeenCalledWith('C:/new', 'New');
    expect(store.items).toHaveLength(1);
  });

  it('add() label 可选 (null)', async () => {
    mockedCreate.mockResolvedValue(1);
    mockedList.mockResolvedValue([]);
    const store = useShortcutsStore();
    await store.add('C:/new', null);

    expect(mockedCreate).toHaveBeenCalledWith('C:/new', null);
  });

  it('remove() 调 deleteShortcut + refresh', async () => {
    mockedDelete.mockResolvedValue(undefined);
    mockedList
      .mockResolvedValueOnce([{ id: 1, rootPath: 'C:/a', label: null, createdAt: 100 }])
      .mockResolvedValueOnce([]); // remove 后空列表
    const store = useShortcutsStore();
    await store.refresh();
    await store.remove(1);

    expect(mockedDelete).toHaveBeenCalledWith(1);
    expect(store.items).toHaveLength(0);
  });

  it('remove() 当前 active 时清空 activeId', async () => {
    mockedDelete.mockResolvedValue(undefined);
    mockedList.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: null, createdAt: 100 },
    ]);
    const store = useShortcutsStore();
    await store.refresh();
    store.setActive(1);
    expect(store.activeId).toBe(1);

    mockedList.mockResolvedValue([]);
    await store.remove(1);

    expect(store.activeId).toBeNull();
  });

  it('setActive(id) 设置 activeId', () => {
    const store = useShortcutsStore();
    store.setActive(42);
    expect(store.activeId).toBe(42);
  });

  it('active computed 返回 items 中 activeId 对应项', async () => {
    mockedList.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
      { id: 2, rootPath: 'C:/b', label: 'B', createdAt: 200 },
    ]);
    const store = useShortcutsStore();
    await store.refresh();
    store.setActive(2);
    expect(store.active?.id).toBe(2);
    expect(store.active?.rootPath).toBe('C:/b');
  });
});
