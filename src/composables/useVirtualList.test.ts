/**
 * useVirtualList.test.ts — v0.1.0-module3.0.4-virtuallist
 *
 * Task 2.1: 骨架 + visibleRange/visibleEntries/totalHeight
 * scrollToIndex/scrollToPath/ResizeObserver/clamp 是 stub (后续 task 补)
 */
import { describe, it, expect } from 'vitest';
import { ref, type Ref } from 'vue';
import { useVirtualList } from './useVirtualList';
import type { MediaEntry } from '@/lib/sourceDescriptor';

const mockEntry = (path: string): MediaEntry => ({
  name: path,
  path,
  isDirectory: false,
  isArchive: false,
  size: 0,
  modifiedAt: 0,
});

describe('useVirtualList visibleRange', () => {
  it('空 entries: visibleRange = { start: 0, end: 0 }', () => {
    const entries: Ref<MediaEntry[]> = ref([]);
    const { visibleRange } = useVirtualList(entries, { rowHeight: 29 });
    expect(visibleRange.value).toEqual({ start: 0, end: 0 });
  });

  it('viewportHeight 未设时 (0) visibleRange = { start: 0, end: 0 }', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { visibleRange } = useVirtualList(entries, { rowHeight: 29 });
    // 不设 viewportHeight, 默认 0
    expect(visibleRange.value).toEqual({ start: 0, end: 0 });
  });

  it('visibleEntries 是 entries.slice(start, end)', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { visibleEntries, viewportHeight, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;  // 10 行 viewport
    scrollTop.value = 0;  // 顶部
    expect(visibleEntries.value.length).toBeLessThanOrEqual(100);
    expect(visibleEntries.value[0]?.name).toBe('f0');
  });

  it('totalHeight = entries.length × rowHeight', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { totalHeight } = useVirtualList(entries, { rowHeight: 29 });
    expect(totalHeight.value).toBe(2900);  // 100 * 29
  });

  it('entries 变化触发 totalHeight + visibleRange 重算', () => {
    const entries = ref<MediaEntry[]>([]);
    const { totalHeight, visibleRange } = useVirtualList(entries, { rowHeight: 29 });
    expect(totalHeight.value).toBe(0);
    entries.value = Array.from({ length: 50 }, (_, i) => mockEntry(`f${i}`));
    expect(totalHeight.value).toBe(1450);  // 50 * 29
    expect(visibleRange.value).toEqual({ start: 0, end: 0 });  // viewportHeight 仍 0
  });
});

describe('useVirtualList scrollToIndex', () => {
  it('scrollToIndex(i) 滚到 i * rowHeight', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollToIndex(10);
    expect(scrollTop.value).toBe(290);  // 10 * 29
  });

  it('scrollToIndex 越界 [0, totalHeight - viewportHeight] clamp', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToIndex(1000);  // 超出范围
    expect(scrollTop.value).toBeLessThanOrEqual(100 * 29 - 290);
    expect(scrollTop.value).toBeGreaterThanOrEqual(0);
  });

  it('scrollToIndex 负数 clamp 到 0', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollToIndex(-10);
    expect(scrollTop.value).toBe(0);
  });

  it('align=center 让目标 row 在视口中央', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToIndex(50, { align: 'center' });
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29) / 2);
  });

  it('align=end 让目标 row 在视口底部', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToIndex(50, { align: 'end' });
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29));
  });

  it('scrollToIndex 同时设 containerRef.scrollTop (DOM 同步)', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, containerRef } = useVirtualList(entries, { rowHeight: 29 });
    const div = document.createElement('div');
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
    containerRef.value = div;
    scrollToIndex(10);
    expect(div.scrollTop).toBe(290);
  });
});

describe('useVirtualList scrollToPath', () => {
  it('scrollToPath(path) 找到 index 后调 scrollToIndex', () => {
    const entries = ref([mockEntry('a'), mockEntry('b'), mockEntry('c')]);
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollToPath('b');
    expect(scrollTop.value).toBe(29);
  });

  it('scrollToPath 找不到 no-op (scrollTop 不变)', () => {
    const entries = ref([mockEntry('a'), mockEntry('b')]);
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollTop.value = 100;  // 预设值
    scrollToPath('nonexistent');
    expect(scrollTop.value).toBe(100);  // 不变
  });

  it('scrollToPath 透传 opts 到 scrollToIndex (align=center)', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToPath, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToPath('f50', { align: 'center' });
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29) / 2);
  });
});
