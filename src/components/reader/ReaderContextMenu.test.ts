import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ReaderContextMenu from './ReaderContextMenu.vue';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function mountMenu(propsOverride: Record<string, unknown> = {}) {
  return mount(ReaderContextMenu, {
    props: {
      x: 100,
      y: 100,
      scaleMode: 'fit-screen',
      mode: 'single',
      direction: 'ltr',
      isSlideshowPlaying: false,
      ...propsOverride,
    },
    global: { plugins: [i18n] },
  });
}

describe('ReaderContextMenu', () => {
  it('渲染 6 个菜单项', () => {
    const wrapper = mountMenu();
    const items = wrapper.findAll('[data-test="ctx-item"]');
    expect(items.length).toBe(6);
  });

  it('点缩放子菜单展开 6 个 ScaleMode', async () => {
    const wrapper = mountMenu();
    await wrapper.find('[data-test="ctx-scale"]').trigger('click');
    const opts = wrapper.findAll('[data-test="ctx-scale-option"]');
    expect(opts.length).toBe(6);
  });

  it('选缩放模式 emit scale-change', async () => {
    const wrapper = mountMenu();
    await wrapper.find('[data-test="ctx-scale"]').trigger('click');
    await wrapper.findAll('[data-test="ctx-scale-option"]')[1].trigger('click');
    expect(wrapper.emitted('scale-change')?.[0]).toEqual(['fit-width']);
  });

  it('点返回 emit back', async () => {
    const wrapper = mountMenu();
    await wrapper.findAll('[data-test="ctx-item"]')[5].trigger('click');
    expect(wrapper.emitted('back')).toBeTruthy();
  });
});
