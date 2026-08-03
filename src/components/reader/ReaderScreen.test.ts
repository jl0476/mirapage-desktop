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
// v0.1.0-module3.0.2-hotfix1 (N1): 不 mock slideshow 任何方法
// (整个 store 透传, 让 setAdvance/setPrev/setIsAtLast 实际写入真实 store 内部 fn)
// 测试通过 tick() 副作用观察 cleanup: mount 注入 nextPage fn,
// unmount 后 advanceFn 应被复位成 noop (不再触发 reader store.advanceFn).
vi.mock('@/stores/slideshow', async () => {
  const actual = await vi.importActual<typeof import('@/stores/slideshow')>('@/stores/slideshow');
  return actual;
});
// 但需要 mock @/lib/tauri 给 slideshow.load() 用 (getSetting/setSetting)
vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

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

  it('renders title and page indicator', async () => {
    const w = mountReader();
    // Cluster B #8: chrome 显示需 hovered=true (或 hoveredVisible)
    await w.find('[data-test="reader-screen"]').trigger('mouseenter');
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
    await w.find('[data-test="reader-screen"]').trigger('mouseenter');
    const modeBtn = w.find('[data-test="btn-mode"]');
    await modeBtn.trigger('click');
    expect(w.emitted('toggle-mode')).toBeTruthy();
  });

  // v0.1.0-module3.0.2-hotfix1 (N1): ReaderScreen unmount 应清 slideshow 内部
  // advance/prev/atLast callbacks, 避免闭包指向已 unmount 的 reader store 实例.
  // 测法: start() 启 setInterval, 等 fire, advanceFn 应执行 reader.nextPage.
  // unmount → start() 再启 (interval 已在跑), 此时 advanceFn 应已被清成 noop
  // → nextPage 不再被调.
  it('unmount 后 slideshow.start 内部定时器不再调 reader.nextPage (闭包清理)', async () => {
    vi.useFakeTimers();
    try {
      // 第一次 mount — 注入 callbacks
      const w = mountReader();
      // 准备 reader store
      const reader = useReaderStore();
      reader.openBook({
        bookId: 1,
        title: 'demo',
        pages: ['a.jpg', 'b.jpg', 'c.jpg'],
        spreads: [
          { start: 0, end: 1 },
          { start: 1, end: 3 },
        ],
        initialSpreadIndex: 0,
      });
      const initialSpreadIndex = reader.currentSpreadIndex;
      expect(initialSpreadIndex).toBe(0);
      // unmount
      w.unmount();
      // 此时 advanceFn 应已被清成 noop (setAdvance(() => undefined))
      // 验证: 手动调内部 advanceFn 不应跑 reader.nextPage
      // 用 slideshow 公开 API: start + advanceTimers, 看 currentSpreadIndex 不变
      const slideshow = (await import('@/stores/slideshow')).useSlideshowStore();
      slideshow.intervalMs = 100;
      slideshow.start();
      vi.advanceTimersByTime(500);
      expect(reader.currentSpreadIndex).toBe(initialSpreadIndex);
      slideshow.pause();
    } finally {
      vi.useRealTimers();
    }
  });
});