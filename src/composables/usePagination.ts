/**
 * usePagination — 列表分页 composable（2026-08-18，四列表页共用）
 *
 * 翻页模式：不无限滚动。pageSize 固定由调用方传（四页统一 50）。
 * total 变化（搜索过滤/删除）时自动 clamp 当前页到有效范围；
 * 删除当页唯一一条后自动回退到前一页（clamp 语义天然覆盖）。
 */
import { computed, ref, watch, type Ref } from 'vue';

export interface Pagination<T> {
  /** 当前页（1-based） */
  page: Ref<number>;
  /** 总页数（total=0 时为 1，避免 0 页怪态） */
  pages: Ref<number>;
  /** 当前页切片 */
  pagedItems: Ref<T[]>;
  /** 上一页（已在首页时 no-op） */
  prev: () => void;
  /** 下一页（已在末页时 no-op） */
  next: () => void;
  /** 回到第一页（搜索词变化时调用） */
  reset: () => void;
}

/** pageSize 可传静态数值或响应式 getter（settings 驱动，运行时可调） */
export function usePagination<T>(
  items: Ref<T[]> | (() => T[]),
  pageSize: number | (() => number),
): Pagination<T> {
  const source = typeof items === 'function' ? computed(items) : items;
  const size = typeof pageSize === 'function' ? computed(pageSize) : ref(pageSize);
  const page = ref(1);
  const pages = computed(() => Math.max(1, Math.ceil(source.value.length / Math.max(1, size.value))));
  const pagedItems = computed(() => {
    const start = (page.value - 1) * size.value;
    return source.value.slice(start, start + size.value);
  });

  // total 收缩时把越界页拉回最后一页（搜索过滤/删除行后）
  watch(pages, (p) => {
    if (page.value > p) page.value = p;
  });

  function prev(): void {
    if (page.value > 1) page.value -= 1;
  }
  function next(): void {
    if (page.value < pages.value) page.value += 1;
  }
  function reset(): void {
    page.value = 1;
  }

  return { page, pages, pagedItems, prev, next, reset };
}
