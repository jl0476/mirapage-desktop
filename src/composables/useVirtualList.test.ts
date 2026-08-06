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
