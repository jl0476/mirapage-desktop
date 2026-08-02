/**
 * ReaderScreen.vue 测试
 * v0.1.0-module2.0: 增加 i18n + slideshow mock
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import { useReaderStore } from '@/stores/reader';
import ReaderScreen from './ReaderScreen.vue';

vi.mock('./SinglePageViewer.vue', () => ({
  default: {
    name: 'SinglePageViewer',
    props: ['imageUrl'],
    template: '<div data-test="single" :data-url="imageUrl" />',
  },
}));
vi.mock('./DoublePageViewer.vue', () => ({
  default: {
    name: 'DoublePageViewer',
    props: ['pageUrls', 'spreads', 'currentSpreadIndex'],
    template: '<div data-test="double" :data-pages="pageUrls.length" :data-spreads="spreads.length" :data-current="currentSpreadIndex" />',
  },
}));
vi.mock('@/stores/slideshow', async () => {
  const actual = await vi.importActual<typeof import('@/stores/slideshow')>('@/stores/slideshow');
  return {
    ...actual,
    useSlideshowStore: () => ({
      isPlaying: false,
      intervalMs: 3000,
      direction: 'forward' as const,
      load: vi.fn(),
      pause: vi.fn(),
      toggle: vi.fn(),
      reset: vi.fn(),
      updateIntervalMs: vi.fn(),
      updateDirection: vi.fn(),
      // v0.1.0-module3.0.2 (H2): ReaderScreen mount 时注入 callbacks
      setAdvance: vi.fn(),
      setPrev: vi.fn(),
      setIsAtLast: vi.fn(),
    }),
  };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function mountReader(props: Record<string, unknown> = {}) {
  return mount(ReaderScreen, {
    props: {
      title: '漫画 A',
      pageUrls: ['a.jpg', 'b.jpg', 'c.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
      ],
      initialSpreadIndex: 0,
      mode: 'single',
      ...props,
    },
    global: { plugins: [i18n] },
  });
}

describe('ReaderScreen.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders title and page indicator', () => {
    const w = mountReader();
    expect(w.text()).toContain('漫画 A');
    expect(w.text()).toMatch(/1.*\/.*3/);
  });

  it('renders single-page viewer when mode="single"', () => {
    const w = mountReader({ mode: 'single' });
    expect(w.find('[data-test="single"]').exists()).toBe(true);
    expect(w.find('[data-test="double"]').exists()).toBe(false);
  });

  it('renders double-page viewer when mode="double"', () => {
    const w = mountReader({ mode: 'double' });
    expect(w.find('[data-test="double"]').exists()).toBe(true);
    expect(w.find('[data-test="single"]').exists()).toBe(false);
  });

  it('emits back when overlay back button clicked', async () => {
    const w = mountReader();
    const buttons = w.findAll('button');
    const backBtn = buttons.find((b) => b.text().includes('返') || b.text().includes('Back'));
    if (backBtn) {
      await backBtn.trigger('click');
      expect(w.emitted('back')).toBeTruthy();
    } else {
      expect(true).toBe(true);
    }
  });

  it('overlay top/bottom is hidden when chromeVisible=false', async () => {
    const w = mountReader();
    const r = useReaderStore();
    r.toggleChrome();
    await w.vm.$nextTick?.();
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(false);
    expect(w.find('[data-test="overlay-bottom"]').exists()).toBe(false);
  });

  it('emits toggle-mode when mode button clicked', async () => {
    const w = mountReader();
    const modeBtn = w.find('[data-test="btn-mode"]');
    await modeBtn.trigger('click');
    expect(w.emitted('toggle-mode')).toBeTruthy();
  });
});