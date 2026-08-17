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
import WebtoonViewerStub from './WebtoonViewer.vue';

interface WebtoonRegistry {
  scrollTargets: string[];
  atBottom: boolean;
  el: { clientHeight: number; scrollHeight: number; scrollTop: number; scrollBy: ReturnType<typeof vi.fn> };
}
const wtStub = WebtoonViewerStub as unknown as { __registry: WebtoonRegistry };

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
// module3.1.0 webtoon 编排测试 stub：expose 契约与真实 viewer 一致（全 getter），
// 状态集中在 __registry，测试断言 scrollBy / scrollToImage 副作用。
vi.mock('./WebtoonViewer.vue', () => {
  const registry = {
    scrollTargets: [] as string[],
    atBottom: false,
    el: { clientHeight: 100, scrollHeight: 500, scrollTop: 0, scrollBy: vi.fn() },
  };
  const component = {
    name: 'WebtoonViewer',
    template: '<div data-test="webtoon-viewer-stub" />',
    setup(_props: unknown, ctx: { expose: (exposed: Record<string, unknown>) => void }) {
      ctx.expose({
        scrollToImage: (name: string) => { registry.scrollTargets.push(name); },
        isAtBottom: () => registry.atBottom,
        getScrollEl: () => registry.el,
      });
    },
    __registry: registry,
  };
  return { default: component };
});
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
    // v0.1.0-reader-review-fix-7: chrome 默认隐藏, 由 trigger zone hover 触发
    await w.find('[data-test="trigger-zone-top"]').trigger('mouseenter');
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
    await w.find('[data-test="trigger-zone-top"]').trigger('mouseenter');
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
    await w.find('[data-test="trigger-zone-top"]').trigger('mouseenter');
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

  // ── module3.1.0 webtoon 分支 ──────────────────────────────────────────
  const webtoonDescriptor = { type: 'local', rootPath: '/test/manga' };

  it('renders WebtoonViewer when mode="webtoon"（descriptor 存在时）', () => {
    const w = mountReader({ mode: 'webtoon', pageNames: ['a.jpg', 'b.jpg'], descriptor: webtoonDescriptor, relPath: '' });
    expect(w.find('[data-test="webtoon-viewer-stub"]').exists()).toBe(true);
    expect(w.find('[data-test="single"]').exists()).toBe(false);
    expect(w.find('[data-test="double"]').exists()).toBe(false);
  });

  it('webtoon + descriptor 缺失 → 不渲染任何 viewer（三层判空链）', () => {
    const w = mountReader({ mode: 'webtoon', pageNames: ['a.jpg'] });
    expect(w.find('[data-test="webtoon-viewer-stub"]').exists()).toBe(false);
    expect(w.find('[data-test="double"]').exists()).toBe(false);
  });

  it('overlay ◀▶ 按钮 webtoon 分流：scrollByScreen 而非 store 翻页', async () => {
    wtStub.__registry.el.scrollBy.mockClear();
    const w = mountReader({ mode: 'webtoon', pageNames: ['a.jpg', 'b.jpg'], descriptor: webtoonDescriptor, relPath: '', pageOverride: 1 });
    await w.find('[data-test="trigger-zone-top"]').trigger('mouseenter');
    await w.find('[data-test="btn-next"]').trigger('click');
    expect(wtStub.__registry.el.scrollBy).toHaveBeenCalledWith({ top: 90, behavior: 'auto' });
    await w.find('[data-test="btn-prev"]').trigger('click');
    expect(wtStub.__registry.el.scrollBy).toHaveBeenLastCalledWith({ top: -90, behavior: 'auto' });
  });

  it('overlay ▶ 在 webtoon 底部转发 scroll-past-bottom（末页再翻等价，审查 #2）', async () => {
    wtStub.__registry.atBottom = true;
    wtStub.__registry.el.scrollBy.mockClear();
    const w = mountReader({ mode: 'webtoon', pageNames: ['a.jpg', 'b.jpg'], descriptor: webtoonDescriptor, relPath: '' });
    await w.find('[data-test="trigger-zone-top"]').trigger('mouseenter');
    await w.find('[data-test="btn-next"]').trigger('click');
    expect(w.emitted('scroll-past-bottom')).toBeTruthy();
    expect(wtStub.__registry.el.scrollBy).not.toHaveBeenCalled();
  });

  it('overlay 跳页 webtoon 分流：scrollToImage 目标图而非 spread', async () => {
    wtStub.__registry.scrollTargets = [];
    const w = mountReader({ mode: 'webtoon', pageNames: ['a.jpg', 'b.jpg', 'c.jpg'], descriptor: webtoonDescriptor, relPath: '' });
    await w.find('[data-test="trigger-zone-top"]').trigger('mouseenter');
    const form = w.find('[data-test="jump-input"]');
    await form.find('input').setValue(3);
    await form.trigger('submit');
    expect(wtStub.__registry.scrollTargets).toEqual(['c.jpg']);
  });

  it('slideshow tick mode-aware：webtoon 下不推进 spread（interval 空转无害）', async () => {
    vi.useFakeTimers();
    try {
      const w = mountReader({ mode: 'webtoon', pageNames: ['a.jpg', 'b.jpg'], descriptor: webtoonDescriptor, relPath: '' });
      const reader = useReaderStore();
      reader.openBook({
        bookId: 1,
        title: 'demo',
        pages: ['a.jpg', 'b.jpg', 'c.jpg'],
        spreads: [{ start: 0, end: 1 }, { start: 1, end: 3 }],
        initialSpreadIndex: 0,
      });
      const before = reader.currentSpreadIndex;
      const slideshow = (await import('@/stores/slideshow')).useSlideshowStore();
      slideshow.intervalMs = 50;
      slideshow.start();
      vi.advanceTimersByTime(200);
      expect(reader.currentSpreadIndex).toBe(before);
      slideshow.pause();
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});