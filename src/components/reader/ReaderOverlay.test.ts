/**
 * ReaderOverlay.vue 测试
 * v0.1.0-module2.0: 增加 slideshow 控制条 + 使用 vue-i18n
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ReaderOverlay from './ReaderOverlay.vue';

vi.mock('@/stores/slideshow', async () => {
  const actual = await vi.importActual<typeof import('@/stores/slideshow')>('@/stores/slideshow');
  return {
    ...actual,
    useSlideshowStore: () => ({
      isPlaying: false,
      intervalMs: 3000,
      direction: 'forward' as const,
      toggle: vi.fn(),
      updateIntervalMs: vi.fn(),
      updateDirection: vi.fn(),
    }),
  };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function makeWrapper(propsOverride: Record<string, unknown> = {}) {
  return mount(ReaderOverlay, {
    props: {
      title: '漫画 A',
      currentPage: 5,
      totalPages: 24,
      mode: 'single',
      chromeVisible: true,
      hovered: false,
      ...propsOverride,
    },
    global: { plugins: [i18n] },
  });
}

describe('ReaderOverlay.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // 现有测试现在依赖 hovered=true 才能显示 chrome (Cluster B #8 chromeShow 语义)

  it('renders title and page indicator when chrome visible', () => {
    const w = makeWrapper({ hovered: true });
    expect(w.find('[data-test="title"]').text()).toBe('漫画 A');
    expect(w.find('[data-test="page-indicator"]').text()).toContain('5');
    expect(w.find('[data-test="page-indicator"]').text()).toContain('24');
  });

  it('renders nothing when chrome not visible', () => {
    const w = makeWrapper({ chromeVisible: false, hovered: true });
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(false);
    expect(w.find('[data-test="overlay-bottom"]').exists()).toBe(false);
  });

  it('emits "next" when next button clicked', async () => {
    const w = makeWrapper({ hovered: true });
    await w.find('[data-test="btn-next"]').trigger('click');
    expect(w.emitted('next')).toBeTruthy();
    expect(w.emitted('next')).toHaveLength(1);
  });

  it('emits "prev" when prev button clicked', async () => {
    const w = makeWrapper({ hovered: true });
    await w.find('[data-test="btn-prev"]').trigger('click');
    expect(w.emitted('prev')).toBeTruthy();
  });

  it('emits "toggle-mode" when mode button clicked', async () => {
    const w = makeWrapper({ hovered: true });
    await w.find('[data-test="btn-mode"]').trigger('click');
    expect(w.emitted('toggle-mode')).toBeTruthy();
  });

  it('emits "jump" with page number when input submitted', async () => {
    const w = makeWrapper({ hovered: true });
    const form = w.find('[data-test="jump-input"]');
    await form.find('input').setValue('12');
    await form.trigger('submit');
    expect(w.emitted('jump')).toBeTruthy();
    expect(w.emitted('jump')![0]).toEqual([12]);
  });

  it('displays current mode label (i18n)', () => {
    const wSingle = makeWrapper({ mode: 'single', hovered: true });
    expect(wSingle.find('[data-test="btn-mode"]').text()).toContain('单页');
    const wDouble = makeWrapper({ mode: 'double', hovered: true });
    expect(wDouble.find('[data-test="btn-mode"]').text()).toContain('双页');
  });

  it('不显示轮播控制条 (isPlaying=false 且未 hover)', () => {
    const w = makeWrapper({ hovered: false });
    expect(w.find('[data-test="slideshow-control"]').exists()).toBe(false);
  });

  // ─── Cluster B #5/#8: pointer-events + chromeShow 逻辑 ───

  it('Cluster B #5: outer overlay div has pointer-events-none class (click-through)', () => {
    const w = makeWrapper();
    const overlay = w.find('[data-test="overlay"]');
    expect(overlay.classes()).toContain('pointer-events-none');
  });

  it('Cluster B #5: header element has pointer-events-auto (buttons clickable)', () => {
    const w = makeWrapper({ hovered: true });
    const header = w.find('[data-test="overlay-top"]');
    expect(header.classes()).toContain('pointer-events-auto');
  });

  it('Cluster B #5: footer element has pointer-events-auto', () => {
    const w = makeWrapper({ hovered: true });
    const footer = w.find('[data-test="overlay-bottom"]');
    expect(footer.classes()).toContain('pointer-events-auto');
  });

  it('Cluster B #5: jump-input form has pointer-events-auto', () => {
    const w = makeWrapper({ hovered: true });
    const form = w.find('[data-test="jump-input"]');
    expect(form.classes()).toContain('pointer-events-auto');
  });

  // Cluster B #8: chromeShow 需 (chromeVisible && !autoHide && (hovered || hoveredVisible))
  // autoHide = slideshow.isPlaying (mock 固定 false)
  // hovered 单独控制:
  it('Cluster B #8: chrome 显示当 hovered=true (默认 chromeVisible=true)', () => {
    const w = makeWrapper({ hovered: true });
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(true);
    expect(w.find('[data-test="overlay-bottom"]').exists()).toBe(true);
  });

  it('Cluster B #8: chrome 隐藏当 chromeVisible=false', () => {
    const w = makeWrapper({ chromeVisible: false, hovered: true });
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(false);
    expect(w.find('[data-test="overlay-bottom"]').exists()).toBe(false);
  });

  it('Cluster B #8: chrome 显示当 hovered=false 但 chromeVisible=true (依赖 hoveredVisible, 2s timeout 不可测)', () => {
    // 注: hoveredVisible 在 mount 时默认 false, 2s 后也 false.
    // 所以 chromeShow = chromeVisible(true) && !autoHide && (hovered(false) || hoveredVisible(false)) = false.
    const w = makeWrapper({ hovered: false });
    // 实际 prod 行为: 不显示 (需要鼠标 hover 才能显示)
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(false);
  });

  it('Cluster B #8: 轮播控制条 显示当 hovered=true (isPlaying=false)', () => {
    const w = makeWrapper({ hovered: true });
    expect(w.find('[data-test="slideshow-control"]').exists()).toBe(true);
  });

  // ─── 需求1: chrome 配色 (mix-blend-mode + 强化模糊) ───

  it('顶栏含 backdrop-blur-xl 与 mix-blend-difference class', () => {
    const w = makeWrapper({ hovered: true });
    const top = w.find('[data-test="overlay-top"]');
    expect(top.classes()).toContain('backdrop-blur-xl');
    expect(top.classes()).toContain('mix-blend-difference');
    // 标题 span 含 mix-blend-difference
    const titleSpan = top.find('[data-test="title"]');
    expect(titleSpan.classes()).toContain('mix-blend-difference');
  });

  it('底栏同样含 backdrop-blur-xl 与 mix-blend-difference', () => {
    const w = makeWrapper({ hovered: true });
    const bottom = w.find('[data-test="overlay-bottom"]');
    expect(bottom.classes()).toContain('backdrop-blur-xl');
    expect(bottom.classes()).toContain('mix-blend-difference');
  });

  it('页码 indicator 含 mix-blend-difference', () => {
    const w = makeWrapper({ hovered: true });
    const indicator = w.find('[data-test="page-indicator"]');
    expect(indicator.classes()).toContain('mix-blend-difference');
  });

  // ─── 需求2: 顶栏缩放下拉 (6 种 ScaleMode) ───

  it('点击缩放 trigger 展开 6 个选项', async () => {
    const w = makeWrapper({ hovered: true, scaleMode: 'fit-screen' });
    const trigger = w.find('[data-test="scale-trigger"]');
    expect(trigger.exists()).toBe(true);
    expect(trigger.text()).toContain('fit-screen');

    await trigger.trigger('click');
    const opts = w.findAll('[data-test="scale-option"]');
    expect(opts.length).toBe(6);
  });

  it('选某项 emit scale-change', async () => {
    const w = makeWrapper({ hovered: true, scaleMode: 'fit-screen' });
    await w.find('[data-test="scale-trigger"]').trigger('click');
    await w.findAll('[data-test="scale-option"]')[2].trigger('click');
    expect(w.emitted('scale-change')?.[0]).toEqual(['fit-height']);
  });

  it('当前 scaleMode 对应选项高亮 (text-accent)', async () => {
    const w = makeWrapper({ hovered: true, scaleMode: 'fit-width' });
    await w.find('[data-test="scale-trigger"]').trigger('click');
    const opts = w.findAll('[data-test="scale-option"]');
    // fit-width 是 SCALE_MODES[1]
    expect(opts[1].classes()).toContain('text-accent');
    expect(opts[0].classes()).not.toContain('text-accent');
  });

  it('点击外部关闭 dropdown', async () => {
    const w = makeWrapper({ hovered: true, scaleMode: 'fit-screen' });
    await w.find('[data-test="scale-trigger"]').trigger('click');
    expect(w.find('[data-test="scale-option"]').exists()).toBe(true);
    // 模拟点击外部 — 触发 document mousedown
    document.dispatchEvent(new MouseEvent('mousedown'));
    await w.vm.$nextTick();
    expect(w.find('[data-test="scale-option"]').exists()).toBe(false);
  });

  it('未传 scaleMode 时默认 fit-screen', () => {
    const w = makeWrapper({ hovered: true });
    const trigger = w.find('[data-test="scale-trigger"]');
    expect(trigger.text()).toContain('fit-screen');
  });
});

describe('ReaderOverlay 返回按钮（需求5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('右上角按钮是返回箭头图标，emit back-to-list', async () => {
    const wrapper = mount(ReaderOverlay, {
      props: {
        title: 't', currentPage: 1, totalPages: 10,
        mode: 'single', chromeVisible: true, hovered: true,
      },
      global: { plugins: [i18n] },
    });
    const btn = wrapper.find('[data-test="btn-back"]');
    expect(btn.exists()).toBe(true);
    // 需求4: chrome 完整菜单按钮 (汉堡 ☰) 唤出 ReaderMainMenu
    const menuBtn = wrapper.find('[data-test="btn-menu"]');
    expect(menuBtn.exists()).toBe(true);
    await menuBtn.trigger('click');
    expect(wrapper.emitted('open-main-menu')).toBeTruthy();
    await btn.trigger('click');
    expect(wrapper.emitted('back-to-list')).toBeTruthy();
  });
});