import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import MasonrySettingsPopup from './MasonrySettingsPopup.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: { 'zh-CN': zhCN },
});

describe('MasonrySettingsPopup', () => {
  it('渲染 3 个 slider（列数/列间距/行间距）', () => {
    const wrapper = mount(MasonrySettingsPopup, {
      props: { colCount: 4, hGap: 8, vGap: 8 },
      global: { plugins: [i18n] },
    });
    const sliders = wrapper.findAll('input[type="range"]');
    expect(sliders).toHaveLength(3);
  });

  it('改列数 slider → emit change 带 colCount', async () => {
    const wrapper = mount(MasonrySettingsPopup, {
      props: { colCount: 4, hGap: 8, vGap: 8 },
      global: { plugins: [i18n] },
    });
    const colSlider = wrapper.findAll('input[type="range"]')[0];
    await colSlider.setValue(6);
    expect(wrapper.emitted('change')?.[0]?.[0]).toMatchObject({ colCount: 6 });
  });

  it('改列间距 slider → emit change 带 hGap', async () => {
    const wrapper = mount(MasonrySettingsPopup, {
      props: { colCount: 4, hGap: 8, vGap: 8 },
      global: { plugins: [i18n] },
    });
    const hGapSlider = wrapper.findAll('input[type="range"]')[1];
    await hGapSlider.setValue(12);
    expect(wrapper.emitted('change')?.[0]?.[0]).toMatchObject({ hGap: 12 });
  });

  it('click-outside 关闭 → emit close', async () => {
    const wrapper = mount(MasonrySettingsPopup, {
      props: { colCount: 4, hGap: 8, vGap: 8 },
      attachTo: document.body,
      global: { plugins: [i18n] },
    });
    // 模拟点击面板外部
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });
});
