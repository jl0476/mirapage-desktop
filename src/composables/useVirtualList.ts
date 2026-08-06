/**
 * useVirtualList.ts — v0.1.0-module3.0.4-virtuallist
 *
 * Task 2.1: 骨架 + visibleRange / visibleEntries / totalHeight
 * Task 2.2: scrollToIndex / scrollToPath (align: start | center | end, clamp, DOM 同步)
 * Task 2.3: ResizeObserver + rAF scroll 节流
 *
 * 设计:
 * - 接收 entries (Ref<readonly MediaEntry[]>) + rowHeight options
 * - 返回 containerRef/contentRef + viewportHeight/scrollTop (响应式) +
 *   visibleRange/visibleEntries/totalHeight (computed) + scrollToIndex/scrollToPath
 * - bufferSize 默认 5, 上下都加 buffer 避免快速滚动空白
 * - onMounted 装 ResizeObserver (容器尺寸 → viewportHeight) + scroll 事件 rAF 节流
 * - onUnmounted 拆 ResizeObserver + removeEventListener + cancel pending rAF
 * - ResizeObserver 用 feature detect, 不可用时降级为 window resize
 *
 * Phase 3 集成到 FileList 时再加绝对定位 + transform 渲染逻辑.
 */
import { ref, computed, isRef, onMounted, onUnmounted, nextTick, watch, type Ref, type ComputedRef } from 'vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

export interface VirtualListOptions {
  /** 固定行高 (像素). 支持 number / Ref<number> / (entry) => number */
  rowHeight: number | Ref<number> | ((entry: MediaEntry) => number);
  /** visibleRange 上下额外渲染的行数, 默认 5 */
  bufferSize?: number;
  /**
   * 可选 O(1) path→index 查表 (Ref<Map<string, number>>).
   * 提供后 scrollToPath 走 O(1) 反查; 不提供则降级 entries.findIndex O(n).
   * 性能敏感场景 (大目录 10000+ entries) 应在 fileBrowser store 维护此 Map 后传入.
   */
  pathIndex?: Ref<Map<string, number>>;
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

  // Task 2.1: 支持 number / Ref<number> / (entry) => number 三种 rowHeight 形式.
  // Ref<number> 形式让 viewMode 变化能响应式驱动 totalHeight / visibleRange 重算.
  const resolvedRowHeight = computed<number>(() => {
    const rh = options.rowHeight;
    if (typeof rh === 'number') return rh > 0 ? rh : 0;
    if (typeof rh === 'function') {
      return Math.max(0, rh({
        name: '_default',
        path: '_default',
        isDirectory: false,
        isArchive: false,
        size: 0,
        modifiedAt: 0,
      }));
    }
    if (isRef(rh)) return rh.value > 0 ? rh.value : 0;
    return 0;
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

  // Task 2.2: scrollToIndex / scrollToPath
  // - scrollToIndex(i, opts?): 滚到 i * rowHeight, opts.align: start (默认) / center / end.
  //   clamp [0, totalHeight - viewportHeight]; 同步设 scrollTop.value (响应式) +
  //   containerRef.value.scrollTop (DOM 触发实际滚动).
  // - scrollToPath(path, opts?): 若传了 pathIndex 则 O(1) Map.get; 否则降级
  //   entries.findIndex O(n). 14949 entries 时 findIndex ~30ms, Map.get < 0.01ms.
  //   找不到 no-op.
  const scrollToIndex = (
    i: number,
    opts?: { align?: 'start' | 'center' | 'end' },
  ): void => {
    const rh = resolvedRowHeight.value;
    const vh = viewportHeight.value;
    let target = i * rh;
    if (opts?.align === 'center') target = i * rh - (vh - rh) / 2;
    if (opts?.align === 'end') target = i * rh - (vh - rh);
    target = Math.max(0, Math.min(target, totalHeight.value - vh));
    scrollTop.value = target;
    if (containerRef.value) {
      containerRef.value.scrollTop = target;
    }
  };

  const scrollToPath = (
    path: string,
    opts?: { align?: 'start' | 'center' | 'end' },
  ): void => {
    let idx: number;
    if (options.pathIndex) {
      idx = options.pathIndex.value.get(path) ?? -1;
    } else {
      idx = entries.value.findIndex((e) => e.path === path);
    }
    if (idx >= 0) scrollToIndex(idx, opts);
  };

  // Task 2.3: ResizeObserver + rAF scroll.
  // - ResizeObserver: container 尺寸变化 → viewportHeight (驱动 visibleRange 重算)
  // - scroll: passive listener + rAF 节流 → scrollTop (避免每像素触发 Vue computed)
  // - 卸载: disconnect + removeEventListener + 取消未执行的 rAF
  // - ResizeObserver 不可用时降级为 window.resize (兜底)
  // - onUnmounted 必须在 setup 顶层调用 (Vue 警告), 不能塞在 onMounted 内
  let ro: ResizeObserver | null = null;
  let onScroll: (() => void) | null = null;
  let rafId: number | null = null;
  let resizeFallback: (() => void) | null = null;

  onMounted(() => {
    const el = containerRef.value;
    if (!el) return;

    // ResizeObserver → viewportHeight
    const ResizeObserverCtor = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null;
    if (ResizeObserverCtor) {
      ro = new ResizeObserverCtor(() => {
        if (containerRef.value) {
          viewportHeight.value = containerRef.value.clientHeight;
        }
      });
      ro.observe(el);
    } else {
      // 兜底: window resize
      resizeFallback = () => {
        if (containerRef.value) {
          viewportHeight.value = containerRef.value.clientHeight;
        }
      };
      window.addEventListener('resize', resizeFallback);
    }

    // scroll → rAF 节流 → scrollTop
    onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        if (containerRef.value) {
          scrollTop.value = containerRef.value.scrollTop;
        }
        rafId = null;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
  });

  // Task 2.4: entries 引用变化 → scrollTop clamp 到合法范围.
  // - 场景: 搜索过滤 / 新目录加载 / 排序变化后 totalHeight 变小,
  //   旧 scrollTop 超出 max → 看到空白. 自动 clamp 避免.
  // - flush: 'post' 让 watcher 在 DOM 更新后跑 (确保 viewportHeight 已更新).
  // - nextTick 双重保险 (happy-dom flush 时序不稳).
  // - max 先 Math.max(0, ...) 兜底 (entries 空时 totalHeight=0, vh 可能 > 0).
  // - 同步 ref + DOM (避免 ref 与 containerRef.value.scrollTop 不一致).
  // - watcher 顶层调用 (Vue 警告: onWatcher 必须在 setup 顶层, 不能塞 onMounted).
  watch(entries, () => {
    nextTick(() => {
      const max = Math.max(0, totalHeight.value - viewportHeight.value);
      const target = Math.min(scrollTop.value, max);
      if (containerRef.value && containerRef.value.scrollTop !== target) {
        containerRef.value.scrollTop = target;
      }
      scrollTop.value = target;
    });
  }, { flush: 'post' });

  onUnmounted(() => {
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    if (resizeFallback) {
      window.removeEventListener('resize', resizeFallback);
      resizeFallback = null;
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (onScroll) {
      containerRef.value?.removeEventListener('scroll', onScroll);
      onScroll = null;
    }
  });

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
