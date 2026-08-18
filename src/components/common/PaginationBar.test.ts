import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import PaginationBar from './PaginationBar.vue';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function mountBar(page: number, pages: number, total = 0) {
  return mount(PaginationBar, { props: { page, pages, total }, global: { plugins: [i18n] } });
}

describe('PaginationBar', () => {
  it('单页时整栏隐藏', () => {
    const w = mountBar(1, 1, 5);
    expect(w.find('[data-test="pagination-bar"]').exists()).toBe(false);
  });

  it('首页侧 prev/first disabled，末页侧 next/last disabled', () => {
    const first = mountBar(1, 3, 100);
    expect(first.get('[data-test="pagination-prev"]').attributes('disabled')).toBeDefined();
    expect(first.get('[data-test="pagination-first"]').attributes('disabled')).toBeDefined();
    expect(first.get('[data-test="pagination-next"]').attributes('disabled')).toBeUndefined();

    const last = mountBar(3, 3, 100);
    expect(last.get('[data-test="pagination-prev"]').attributes('disabled')).toBeUndefined();
    expect(last.get('[data-test="pagination-next"]').attributes('disabled')).toBeDefined();
    expect(last.get('[data-test="pagination-last"]').attributes('disabled')).toBeDefined();
  });

  it('点击 prev/next/first/last emit update:page', async () => {
    const w = mountBar(2, 5, 100);
    await w.get('[data-test="pagination-prev"]').trigger('click');
    expect(w.emitted('update:page')?.[0]).toEqual([1]);
    await w.get('[data-test="pagination-next"]').trigger('click');
    expect(w.emitted('update:page')?.[1]).toEqual([3]);
    await w.get('[data-test="pagination-first"]').trigger('click');
    expect(w.emitted('update:page')?.[2]).toEqual([1]);
    await w.get('[data-test="pagination-last"]').trigger('click');
    expect(w.emitted('update:page')?.[3]).toEqual([5]);
  });

  it('显示总页数与总条数', () => {
    const w = mountBar(2, 7, 321);
    expect(w.get('[data-test="pagination-total"]').text()).toContain('共 321 条');
    expect(w.text()).toContain('/ 7 页');
  });

  it('跳页输入：Enter 提交 emit，越界 clamp 到有效范围', async () => {
    const w = mountBar(2, 5, 100);
    const input = w.get('[data-test="pagination-jump"]');
    await input.setValue('4');
    await input.trigger('keydown.enter');
    expect(w.emitted('update:page')?.[0]).toEqual([4]);

    await input.setValue('999'); // 越界 → clamp 到末页
    await input.trigger('blur');
    expect(w.emitted('update:page')?.[1]).toEqual([5]);
    expect((input.element as HTMLInputElement).value).toBe('5');
  });

  it('跳页输入非法（NaN）不 emit，回落当前页', async () => {
    const w = mountBar(2, 5, 100);
    const input = w.get('[data-test="pagination-jump"]');
    await input.setValue('');
    await input.trigger('blur');
    expect(w.emitted('update:page')).toBeUndefined();
    expect((input.element as HTMLInputElement).value).toBe('2');
  });

  it('page 变化时跳页输入框同步显示', async () => {
    const w = mountBar(2, 5, 100);
    await w.setProps({ page: 4 });
    const input = w.get('[data-test="pagination-jump"]');
    expect((input.element as HTMLInputElement).value).toBe('4');
  });
});
