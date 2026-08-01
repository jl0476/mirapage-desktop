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

  it('renders title and page indicator when chrome visible', () => {
    const w = makeWrapper();
    expect(w.find('[data-test="title"]').text()).toBe('漫画 A');
    expect(w.find('[data-test="page-indicator"]').text()).toContain('5');
    expect(w.find('[data-test="page-indicator"]').text()).toContain('24');
  });

  it('renders nothing when chrome not visible', () => {
    const w = makeWrapper({ chromeVisible: false });
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(false);
    expect(w.find('[data-test="overlay-bottom"]').exists()).toBe(false);
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

  it('displays current mode label (i18n)', () => {
    const wSingle = makeWrapper({ mode: 'single' });
    expect(wSingle.find('[data-test="btn-mode"]').text()).toContain('单页');
    const wDouble = makeWrapper({ mode: 'double' });
    expect(wDouble.find('[data-test="btn-mode"]').text()).toContain('双页');
  });

  it('不显示轮播控制条 (isPlaying=false 且未 hover)', () => {
    const w = makeWrapper({ hovered: false });
    expect(w.find('[data-test="slideshow-control"]').exists()).toBe(false);
  });
});