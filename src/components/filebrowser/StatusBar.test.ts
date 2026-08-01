/**
 * StatusBar.test.ts — 3 段渲染
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
});
