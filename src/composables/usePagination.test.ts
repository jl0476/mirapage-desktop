import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePagination } from './usePagination';

function setup(size: number) {
  const items = ref(Array.from({ length: size }, (_, i) => i));
  return { items, ...usePagination(items, 50) };
}

describe('usePagination', () => {
  it('total=0 时 pages=1，切片为空', () => {
    const p = setup(0);
    expect(p.pages.value).toBe(1);
    expect(p.pagedItems.value).toEqual([]);
  });

  it('50 条一页：49 条 1 页，50 条 1 页，51 条 2 页', () => {
    expect(setup(49).pages.value).toBe(1);
    expect(setup(50).pages.value).toBe(1);
    expect(setup(51).pages.value).toBe(2);
  });

  it('next/prev 翻页，首末页 no-op', () => {
    const p = setup(120); // 3 页
    expect(p.page.value).toBe(1);
    p.prev();
    expect(p.page.value).toBe(1); // 首页 no-op
    p.next(); p.next();
    expect(p.page.value).toBe(3);
    p.next();
    expect(p.page.value).toBe(3); // 末页 no-op
    expect(p.pagedItems.value.length).toBe(20); // 120-100
    p.prev();
    expect(p.pagedItems.value.length).toBe(50);
  });

  it('total 收缩时当前页 clamp 到最后一页（删除/过滤场景）', async () => {
    const { items, page, pages } = setup(120);
    page.value = 3;
    items.value = items.value.slice(0, 60); // 剩 2 页
    expect(pages.value).toBe(2);
    await nextTick(); // watch(pre) 异步 flush
    expect(page.value).toBe(2);
  });

  it('reset 回第 1 页（搜索词变化）', () => {
    const p = setup(120);
    p.next();
    expect(p.page.value).toBe(2);
    p.reset();
    expect(p.page.value).toBe(1);
  });

  it('pageSize 传 getter 时响应式生效（settings 驱动运行时调整）', () => {
    const items = ref(Array.from({ length: 100 }, (_, i) => i));
    const size = ref(50);
    const p = usePagination(items, () => size.value);
    expect(p.pages.value).toBe(2);
    p.next();
    expect(p.page.value).toBe(2);
    expect(p.pagedItems.value.length).toBe(50);
    size.value = 20; // 调小 → 5 页，当前页 2 仍有效
    expect(p.pages.value).toBe(5);
    expect(p.pagedItems.value.length).toBe(20);
    size.value = 200; // 调大 → 1 页，越界页 clamp
    expect(p.pages.value).toBe(1);
  });
});
