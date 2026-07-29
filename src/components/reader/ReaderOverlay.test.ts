/**
 * ReaderOverlay.vue 测试
 * 阅读器 UI 层：
 * - 顶栏：标题 + 页码 + 模式切换 + 主菜单
 * - 底栏：上一页 / 下一页按钮
 * - chrome 不可见时不渲染(via Esc/M/C)
 * - 点击下一页按钮 emit 'next'
 * - 点击上一页按钮 emit 'prev'
 * - 模式切换按钮 emit 'toggle-mode'
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ReaderOverlay from './ReaderOverlay.vue';

function makeWrapper(propsOverride: Record<string, unknown> = {}) {
  return mount(ReaderOverlay, {
    props: {
      title: '漫画 A',
      currentPage: 5,
      totalPages: 24,
      mode: 'single',
      chromeVisible: true,
      ...propsOverride,
    },
  });
}

describe('ReaderOverlay.vue', () => {
  it('renders title and page indicator when chrome visible', () => {
    const w = makeWrapper();
    expect(w.find('[data-test="title"]').text()).toBe('漫画 A');
    expect(w.find('[data-test="page-indicator"]').text()).toContain('5');
    expect(w.find('[data-test="page-indicator"]').text()).toContain('24');
  });

  it('renders nothing when chrome not visible', () => {
    const w = makeWrapper({ chromeVisible: false });
    expect(w.find('[data-test="overlay"]').exists()).toBe(false);
  });

  it('emits "next" when next button clicked', async () => {
    const w = makeWrapper();
    await w.find('[data-test="btn-next"]').trigger('click');
    expect(w.emitted('next')).toBeTruthy();
    expect(w.emitted('next')).toHaveLength(1);
  });

  it('emits "prev" when prev button clicked', async () => {
    const w = makeWrapper();
    await w.find('[data-test="btn-prev"]').trigger('click');
    expect(w.emitted('prev')).toBeTruthy();
  });

  it('emits "toggle-mode" when mode button clicked', async () => {
    const w = makeWrapper();
    await w.find('[data-test="btn-mode"]').trigger('click');
    expect(w.emitted('toggle-mode')).toBeTruthy();
  });

  it('emits "jump" with page number when input submitted', async () => {
    const w = makeWrapper();
    const form = w.find('[data-test="jump-input"]');
    await form.find('input').setValue('12');
    await form.trigger('submit');
    expect(w.emitted('jump')).toBeTruthy();
    expect(w.emitted('jump')![0]).toEqual([12]);
  });

  it('displays current mode label', () => {
    const wSingle = makeWrapper({ mode: 'single' });
    expect(wSingle.find('[data-test="btn-mode"]').text()).toContain('单页');
    const wDouble = makeWrapper({ mode: 'double' });
    expect(wDouble.find('[data-test="btn-mode"]').text()).toContain('双页');
  });
});
