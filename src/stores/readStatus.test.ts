/**
 * readStatus store 测试 — finishedSet O(1) 查询（v0.1.0-module3.0.4-virtuallist Task 1.3）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  listProgressFinished: vi.fn(async () => ({})),
}));

vi.mock('./history', () => ({
  useHistoryStore: () => ({
    items: [] as never[],
    refresh: vi.fn(async () => undefined),
  }),
}));

import { useReadStatusStore } from './readStatus';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
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
});
