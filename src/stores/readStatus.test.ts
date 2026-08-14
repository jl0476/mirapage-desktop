/**
 * readStatus store 测试 — finishedSet O(1) 查询（v0.1.0-module3.0.4-virtuallist Task 1.3）
 * + 子目录 mark 匹配 / refresh 同 key 取最新（2026-08-14 hotfix）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// mock 可注入：refresh 测试需要设置 history items / progress finished 返回值
const historyState = vi.hoisted(() => ({
  items: [] as Array<{
    bookId: number | null;
    relPath: string;
    displayName: string;
    lastVisitedAt: number;
    sourceDescriptor: unknown;
  }>,
}));
const finishedMapState = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));

vi.mock('@/lib/tauri', () => ({
  listProgressFinished: vi.fn(async () => finishedMapState.value),
}));

vi.mock('./history', () => ({
  useHistoryStore: () => ({
    items: historyState.items,
    refresh: vi.fn(async () => undefined),
  }),
}));

import { useReadStatusStore } from './readStatus';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  historyState.items = [];
  finishedMapState.value = {};
});

describe('readStatus', () => {
  describe('finishedSet', () => {
    it('refresh 后 finishedSet 包含所有 finished entry 的 path', async () => {
      const rs = useReadStatusStore();
      await rs.refresh();
      rs.marks = {
        'local|Q:\\test|foo': 'finished',
        'local|Q:\\test|bar': 'reading',
        'local|Q:\\test|baz': 'finished',
      };
      rs.rebuildFinishedSet();
      expect(rs.finishedSet.has('foo')).toBe(true);
      expect(rs.finishedSet.has('bar')).toBe(false);
      expect(rs.finishedSet.has('baz')).toBe(true);
    });

    it('isFinished 走 finishedSet O(1)', () => {
      const rs = useReadStatusStore();
      rs.marks = Object.fromEntries(
        Array.from({ length: 10000 }, (_, i) => [`local|Q:\\test|entry${i}`, 'finished']),
      );
      rs.rebuildFinishedSet();
      const entry = {
        name: 'entry5000',
        path: 'entry5000',
        isDirectory: true,
        isArchive: false,
        size: 0,
        modifiedAt: 0,
      };
      const t0 = performance.now();
      const result = rs.isFinished(entry);
      const t1 = performance.now();
      expect(result).toBe(true);
      expect(t1 - t0).toBeLessThan(1);
    });

    it('isFinished 对非目录/非压缩包直接 false (不变)', () => {
      const rs = useReadStatusStore();
      rs.marks = { 'local|Q:\\test|foo': 'finished' };
      rs.rebuildFinishedSet();
      const entry = {
        name: 'foo',
        path: 'foo',
        isDirectory: false,
        isArchive: false,
        size: 0,
        modifiedAt: 0,
      };
      expect(rs.isFinished(entry)).toBe(false);
    });

    it('key 格式无 | 时也能处理 (边界)', () => {
      const rs = useReadStatusStore();
      rs.marks = {
        foo: 'finished',
        'local|bar': 'finished',
      };
      rs.rebuildFinishedSet();
      expect(rs.finishedSet.has('foo')).toBe(true);
      expect(rs.finishedSet.has('bar')).toBe(true);
    });

    it('marks 替换后显式 rebuildFinishedSet 重建 finishedSet', async () => {
      // 注: watch(marks) 默认 flush: 'pre' 异步, 测试场景需显式 rebuild 同步触发
      const rs = useReadStatusStore();
      rs.marks = { 'local|Q:\\test|foo': 'finished' };
      rs.rebuildFinishedSet();
      expect(rs.finishedSet.has('foo')).toBe(true);
      rs.marks = { 'local|Q:\\test|bar': 'finished' };
      rs.rebuildFinishedSet();
      expect(rs.finishedSet.has('foo')).toBe(false);
      expect(rs.finishedSet.has('bar')).toBe(true);
    });
  });

  // ─── 2026-08-14 hotfix: 子目录 mark 匹配 ───
  // marks key 的 relPath 段是「相对根」（如 raw/vol1），而 entry.path 相对当前目录
  // （如 vol1）。浏览子目录时必须拼上 currentRelPath 前缀才能命中。
  describe('isFinished 子目录匹配', () => {
    const dirEntry = (path: string) => ({
      name: path,
      path,
      isDirectory: true,
      isArchive: false,
      size: 0,
      modifiedAt: 0,
    });

    it('currentRelPath 非空时用拼接后的根相对路径匹配', () => {
      const rs = useReadStatusStore();
      rs.marks = { 'C:/comics|raw/vol1': 'finished' };
      rs.rebuildFinishedSet();
      expect(rs.isFinished(dirEntry('vol1'), 'raw')).toBe(true);
      // 尾部分隔符归一（toRootRelativePath 语义）
      expect(rs.isFinished(dirEntry('vol1'), 'raw/')).toBe(true);
    });

    it('不传 currentRelPath = 根目录语义（现有调用兼容）', () => {
      const rs = useReadStatusStore();
      rs.marks = { 'C:/comics|raw/vol1': 'finished' };
      rs.rebuildFinishedSet();
      // 根目录下 vol1 ≠ raw/vol1 → 不命中
      expect(rs.isFinished(dirEntry('vol1'))).toBe(false);
      expect(rs.isFinished(dirEntry('vol1'), '')).toBe(false);
    });

    it('根目录场景（marks key 无前缀）不受影响', () => {
      const rs = useReadStatusStore();
      rs.marks = { 'C:/comics|vol1': 'finished' };
      rs.rebuildFinishedSet();
      expect(rs.isFinished(dirEntry('vol1'), '')).toBe(true);
    });
  });

  // ─── 2026-08-14 hotfix: refresh 同 key 重复 history 行取最新 ───
  // descriptor 双序列化格式（raw Value 字母序 vs typed tag-first）导致 browse_history
  // 同 (解析后 descriptor, relPath) 出现两行。marks 应取 lastVisitedAt 最新的行，
  // 与数组顺序无关（旧实现按迭代顺序后者覆盖，旧行的过期状态盖掉新行）。
  describe('refresh 同 key 重复行取最新', () => {
    const h = (bookId: number, lastVisitedAt: number) => ({
      bookId,
      relPath: 'normal',
      displayName: 'normal',
      lastVisitedAt,
      sourceDescriptor: { type: 'local', rootPath: 'D:/Wallpaper' },
    });

    it('新行在前（list_history DESC 实际顺序）→ 旧行不覆盖新行', async () => {
      historyState.items = [h(3, 200), h(1, 100)];
      finishedMapState.value = { '3': true, '1': false };
      const rs = useReadStatusStore();
      await rs.refresh();
      expect(rs.marks['D:/Wallpaper|normal']).toBe('finished');
    });

    it('旧行在前 → 新行覆盖旧行', async () => {
      historyState.items = [h(1, 100), h(3, 200)];
      finishedMapState.value = { '3': true, '1': false };
      const rs = useReadStatusStore();
      await rs.refresh();
      expect(rs.marks['D:/Wallpaper|normal']).toBe('finished');
    });

    it('无重复行行为不变（单行 finished → finished）', async () => {
      historyState.items = [h(3, 200)];
      finishedMapState.value = { '3': true };
      const rs = useReadStatusStore();
      await rs.refresh();
      expect(rs.marks['D:/Wallpaper|normal']).toBe('finished');
    });

    it('最新行无 progress 行 → 无 mark（不回退到旧行状态）', async () => {
      historyState.items = [h(3, 200), h(1, 100)];
      // 只有旧行 bookId=1 有 progress
      finishedMapState.value = { '1': false };
      const rs = useReadStatusStore();
      await rs.refresh();
      expect(rs.marks['D:/Wallpaper|normal']).toBeUndefined();
    });
  });
});
