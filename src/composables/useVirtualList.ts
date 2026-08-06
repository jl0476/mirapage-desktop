/**
 * useVirtualList.ts — v0.1.0-module3.0.4-virtuallist
 *
 * Task 2.1 骨架: 虚拟列表核心算法 (visibleRange / visibleEntries / totalHeight)
 *
 * 设计:
 * - 接收 entries (Ref<readonly MediaEntry[]>) + rowHeight options
 * - 返回 containerRef/contentRef + viewportHeight/scrollTop (响应式) +
 *   visibleRange/visibleEntries/totalHeight (computed)
 * - bufferSize 默认 5, 上下都加 buffer 避免快速滚动空白
 * - scrollToIndex/scrollToPath 是 stub (Task 2.2/2.3/2.4 补)
 * - ResizeObserver/clamp 也是 stub (Task 2.3/2.4 补)
 *
 * Phase 3 集成到 FileList 时再加绝对定位 + transform 渲染逻辑.
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

export interface VirtualListOptions {
  /** 固定行高 (像素). 动态行高留给 grid 后续任务 */
  rowHeight: number | ((entry: MediaEntry) => number);
  /** visibleRange 上下额外渲染的行数, 默认 5 */
  bufferSize?: number;
}

export interface VisibleRange {
  start: number;
  end: number;
}

export interface UseVirtualListReturn {
  containerRef: Ref<HTMLElement | null>;
  contentRef: Ref<HTMLElement | null>;
  visibleRange: ComputedRef<VisibleRange>;
  visibleEntries: ComputedRef<readonly MediaEntry[]>;
  totalHeight: ComputedRef<number>;
  viewportHeight: Ref<number>;
  scrollTop: Ref<number>;
  scrollToIndex: (i: number, opts?: { align?: 'start' | 'center' | 'end' }) => void;
  scrollToPath: (path: string, opts?: { align?: 'start' | 'center' | 'end' }) => void;
}

export function useVirtualList(
  entries: Ref<readonly MediaEntry[]>,
  options: VirtualListOptions,
): UseVirtualListReturn {
  const containerRef = ref<HTMLElement | null>(null);
  const contentRef = ref<HTMLElement | null>(null);
  const viewportHeight = ref(0);
  const scrollTop = ref(0);
  const bufferSize = options.bufferSize ?? 5;

  // Task 2.1: 只支持固定 rowHeight (动态 rowHeight 函数留待 grid 任务处理,
  // 因为 visibleRange 算法依赖固定 rowHeight 才能用除法定位 start index).
  const resolvedRowHeight = computed<number>(() => {
    const rh = options.rowHeight;
    return typeof rh === 'number' ? rh : 0;
  });

  const totalHeight = computed<number>(
    () => entries.value.length * resolvedRowHeight.value,
  );

  const visibleRange = computed<VisibleRange>(() => {
    const n = entries.value.length;
    const rh = resolvedRowHeight.value;
    if (n === 0 || viewportHeight.value === 0 || rh === 0) {
      return { start: 0, end: 0 };
    }
    const rawStart = Math.floor(scrollTop.value / rh) - bufferSize;
    const rawEnd = Math.ceil((scrollTop.value + viewportHeight.value) / rh) + bufferSize;
    return {
      start: Math.max(0, rawStart),
      end: Math.min(n, rawEnd),
    };
  });

  const visibleEntries = computed<readonly MediaEntry[]>(() =>
    entries.value.slice(visibleRange.value.start, visibleRange.value.end),
  );

  // scrollToIndex / scrollToPath / ResizeObserver / clamp 在后续 task 加上.
  // 当前阶段保留 stub 签名以满足 interface 契约, 实现空函数.
  const scrollToIndex = (
    _i: number,
    _opts?: { align?: 'start' | 'center' | 'end' },
  ): void => {
    /* stub — Task 2.2 实现 */
  };
  const scrollToPath = (
    _path: string,
    _opts?: { align?: 'start' | 'center' | 'end' },
  ): void => {
    /* stub — Task 2.2 实现 */
  };

  return {
    containerRef,
    contentRef,
    visibleRange,
    visibleEntries,
    totalHeight,
    viewportHeight,
    scrollTop,
    scrollToIndex,
    scrollToPath,
  };
}
