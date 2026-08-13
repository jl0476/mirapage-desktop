/**
 * StatusBar.test.ts — 3 段渲染 + 三段等宽布局
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import StatusBar from './StatusBar.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
});

describe('StatusBar.vue', () => {
  it('renders items count', () => {
    const w = mount(StatusBar, {
      props: { total: 10, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'C:/x' },
      global: { plugins: [i18n, createPinia()] },
    });
    expect(w.find('[data-test="statusbar-items"]').text()).toContain('10');
  });

  it('选中 0 → 不显示 selected span', () => {
    const w = mount(StatusBar, {
      props: { total: 5, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'C:/x' },
      global: { plugins: [i18n, createPinia()] },
    });
    expect(w.find('[data-test="statusbar-selected"]').exists()).toBe(false);
  });

  it('选中 > 0 → 显示 selected + size', () => {
    const w = mount(StatusBar, {
      props: { total: 5, selectedCount: 2, selectionSizeBytes: 2048, currentPath: 'C:/x' },
      global: { plugins: [i18n, createPinia()] },
    });
    const html = w.find('[data-test="statusbar-selected"]').html();
    expect(html).toContain('2');
    expect(html).toContain('2.00 KB');
  });

  it('current path 显示在中间', () => {
    const w = mount(StatusBar, {
      props: { total: 0, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'C:/comics/chapter1' },
      global: { plugins: [i18n, createPinia()] },
    });
    expect(w.find('[data-test="statusbar-path"]').text()).toBe('C:/comics/chapter1');
  });

  it('三段等宽: 左/中/右各 flex-1, 中段 justify-center', () => {
    const wrapper = mount(StatusBar, {
      props: { total: 12, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'D:/path' },
      global: { plugins: [i18n] },
    });
    const footer = wrapper.find('[data-test="statusbar"]');
    const children = footer.element.children;
    // 三段
    expect(children.length).toBe(3);
    // 每段含 flex-1 class
    for (const child of children) {
      expect((child as HTMLElement).className).toContain('flex-1');
    }
    // 中段 justify-center
    const center = children[1] as HTMLElement;
    expect(center.className).toContain('justify-center');
  });

  it('无 nextVolumeTitle 时右段渲染空 div 保持对称', () => {
    const wrapper = mount(StatusBar, {
      props: { total: 12, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'D:/path' },
      global: { plugins: [i18n] },
    });
    const footer = wrapper.find('[data-test="statusbar"]');
    const right = footer.element.children[2] as HTMLElement;
    // 右段存在(flex-1)但无下一卷内容
    expect(right.className).toContain('flex-1');
    expect(right.querySelector('[data-test="statusbar-next-volume"]')).toBeNull();
  });
});

describe('StatusBar 下一卷右段', () => {
  const base = { total: 12, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'D:/p' };

  it('nextVolumeTitle 有值: 显示「下一卷: title」, 点击 emit next-volume', async () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: 'vol02' },
      global: { plugins: [i18n] },
    });
    const btn = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(btn.text()).toContain('vol02');
    await btn.trigger('click');
    expect(wrapper.emitted('next-volume')).toHaveLength(1);
  });

  it('nextVolumeTitle=null: 显示「已是最后一卷」灰 disabled', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: null },
      global: { plugins: [i18n] },
    });
    const el = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(el.attributes('disabled')).toBeDefined();
    expect(el.text()).toContain('最后一卷');
  });

  it('nextVolumeLoading=true: 显示「…」', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeLoading: true },
      global: { plugins: [i18n] },
    });
    const el = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(el.text()).toContain('…');
  });

  it('nextVolumeTitle=undefined: 右段无 next-volume 元素(兼容)', () => {
    const wrapper = mount(StatusBar, { props: base, global: { plugins: [i18n] } });
    expect(wrapper.find('[data-test="statusbar-next-volume"]').exists()).toBe(false);
  });

  it('nextVolumeDisabled=true: 有 title 但 disabled', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: 'vol02', nextVolumeDisabled: true },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="statusbar-next-volume"]').attributes('disabled')).toBeDefined();
  });
});
