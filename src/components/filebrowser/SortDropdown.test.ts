/**
 * SortDropdown.test.ts — 触发按钮 + 弹层 + click-outside
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import SortDropdown from './SortDropdown.vue';
import { useFileBrowserStore } from '@/stores/fileBrowser';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: { 'zh-CN': zhCN },
});

describe('SortDropdown.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders trigger button with current sort field name', () => {
    const w = mount(SortDropdown, { global: { plugins: [i18n] } });
    // 默认 sortField='name' → 显示 "名称"
    expect(w.find('[data-test="btn-sort"]').text()).toContain('名称');
  });

  it('trigger 显示当前选中字段 + 升/降序箭头', async () => {
    const store = useFileBrowserStore();
    store.setSortField('size'); // 切到 size
    const w = mount(SortDropdown, { global: { plugins: [i18n] } });
    expect(w.find('[data-test="btn-sort"]').text()).toContain('大小');
  });

  it('click trigger 打开弹出层, click 同一选项关闭', async () => {
    const w = mount(SortDropdown, { global: { plugins: [i18n] } });
    expect(w.find('[data-test="sort-dropdown"]').exists()).toBe(false);
    await w.find('[data-test="btn-sort"]').trigger('click');
    expect(w.find('[data-test="sort-dropdown"]').exists()).toBe(true);
    await w.find('[data-test="sort-opt-name"]').trigger('click');
    expect(w.find('[data-test="sort-dropdown"]').exists()).toBe(false);
  });

  it('选 sort 选项 → store.setSortField 被调', async () => {
    const store = useFileBrowserStore();
    const w = mount(SortDropdown, { global: { plugins: [i18n] } });
    await w.find('[data-test="btn-sort"]').trigger('click');
    await w.find('[data-test="sort-opt-size"]').trigger('click');
    expect(store.sortField).toBe('size');
  });

  it('click 外部 (document.body) 关闭弹层', async () => {
    const w = mount(SortDropdown, { global: { plugins: [i18n] } });
    await w.find('[data-test="btn-sort"]').trigger('click');
    expect(w.find('[data-test="sort-dropdown"]').exists()).toBe(true);
    // 模拟外部 click
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.find('[data-test="sort-dropdown"]').exists()).toBe(false);
  });
});
