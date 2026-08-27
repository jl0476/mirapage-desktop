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
import { useSettingsStore } from '@/stores/settings';
import { setSetting } from '@/lib/tauri';

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

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return { ...actual, setSetting: vi.fn(async () => {}) };
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

  it('webtoon 模式显示三态文案并禁用缩放、间隔和方向控件', async () => {
    const w = makeWrapper({ mode: 'webtoon', hovered: true });
    expect(w.find('[data-test="btn-mode"]').text()).toContain('竖条漫');
    expect(w.find('[data-test="scale-trigger"]').attributes('disabled')).toBeDefined();
    // module3.5.4: 间隔控件在 webtoon 下替换为滚动速度（不再禁用）；方向按钮隐藏（垂直滚动无意义）
    expect(w.find('[data-test="slideshow-interval"]').exists()).toBe(false);
    expect(w.find('[data-test="webtoon-speed"]').attributes('disabled')).toBeUndefined();
    expect(w.find('[data-test="slideshow-direction"]').exists()).toBe(false);
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

  it('Cluster B #8: chrome 默认隐藏 (hovered=false 时), 只有 hover 才显示', () => {
    // v0.1.0-reader-review-fix-5: chromeShow = chromeVisible && (hovered || hoveredVisible)
    // 默认 (hovered=false, hoveredVisible=false) → 不显示
    const w = makeWrapper({ hovered: false });
    expect(w.find('[data-test="overlay-top"]').exists()).toBe(false);
    expect(w.find('[data-test="overlay-bottom"]').exists()).toBe(false);
  });

  it('Cluster B #8: 轮播控制条 显示当 hovered=true (isPlaying=false)', () => {
    const w = makeWrapper({ hovered: true });
    expect(w.find('[data-test="slideshow-control"]').exists()).toBe(true);
  });

  // ─── 需求1: chrome 配色 (mix-blend-mode + 强化模糊) ───

  // v0.1.0-reader-review-fix-4: chrome 改实色 bg-surface/90 (dark theme 下深蓝紫半透,
  // text-text-primary 白字始终可读). 不再用 mix-blend-difference (在各种底图色
  // 表现都不稳). 去掉 xp-bd (避免白边框), 字号 text-sm (14px 更清晰).
  it('顶栏含 backdrop-blur-xl + bg-surface/90 (实色 bg, text-sm 字号)', () => {
    const w = makeWrapper({ hovered: true });
    const top = w.find('[data-test="overlay-top"]');
    expect(top.classes()).toContain('backdrop-blur-xl');
    expect(top.classes()).toContain('bg-surface/90');
    expect(top.classes()).toContain('text-sm');
    // 不再用 xp-bd (fix-4: 避免白边框)
    expect(top.classes()).not.toContain('xp-bd');
    // 标题 span 实色 text-text-primary
    const titleSpan = top.find('[data-test="title"]');
    expect(titleSpan.classes()).not.toContain('mix-blend-difference');
  });

  it('顶栏 icon (btn-back / btn-menu) 实色 + hover 高亮', () => {
    const w = makeWrapper({ hovered: true });
    const top = w.find('[data-test="overlay-top"]');
    expect(top.find('[data-test="btn-back"]').classes()).not.toContain('mix-blend-difference');
    expect(top.find('[data-test="btn-menu"]').classes()).not.toContain('mix-blend-difference');
  });

  it('底栏同样含 backdrop-blur-xl + bg-surface/90 (无 xp-bd)', () => {
    const w = makeWrapper({ hovered: true });
    const bottom = w.find('[data-test="overlay-bottom"]');
    expect(bottom.classes()).toContain('backdrop-blur-xl');
    expect(bottom.classes()).toContain('bg-surface/90');
    expect(bottom.classes()).not.toContain('xp-bd');
  });

  it('页码 indicator 实色 text-text-secondary (无 mix-blend)', () => {
    const w = makeWrapper({ hovered: true });
    const indicator = w.find('[data-test="page-indicator"]');
    expect(indicator.classes()).not.toContain('mix-blend-difference');
  });

  // ─── 需求2: 顶栏缩放下拉 (5 种 ScaleMode, stretch 已移除) ───
  // v0.1.0-reader-review (Minor #4): scale trigger 文案走 t('reader.scale.*')
  // 不再显示 raw enum "fit-screen".

  it('点击缩放 trigger 展开 5 个选项 (trigger 文案 i18n: 适应屏幕)', async () => {
    const w = makeWrapper({ hovered: true, scaleMode: 'fit-screen' });
    const trigger = w.find('[data-test="scale-trigger"]');
    expect(trigger.exists()).toBe(true);
    expect(trigger.text()).toContain('适应屏幕');
    expect(trigger.text()).not.toContain('fit-screen');

    await trigger.trigger('click');
    const opts = w.findAll('[data-test="scale-option"]');
    expect(opts.length).toBe(5);
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
    // 模拟点击外部 — 触发 window pointerdown (OSD Pointer Events 下 mousedown 被抑制)
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await w.vm.$nextTick();
    expect(w.find('[data-test="scale-option"]').exists()).toBe(false);
  });

  it('未传 scaleMode 时默认 fit-screen (trigger 文案 i18n: 适应屏幕)', () => {
    const w = makeWrapper({ hovered: true });
    const trigger = w.find('[data-test="scale-trigger"]');
    expect(trigger.text()).toContain('适应屏幕');
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
// ─── module3.5.4: 间隔直接输入 + webtoon 滚动速度替换禁用 ───
describe('module3.5.4 间隔/速度控件', () => {
  type SlideshowMock = { updateIntervalMs: ReturnType<typeof vi.fn> };
  function getSlideshow(w: { vm: unknown }): SlideshowMock {
    return (w.vm as unknown as { slideshow: SlideshowMock }).slideshow;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(setSetting).mockClear();
  });

  it('分页模式：输入框提交有效秒数 → updateIntervalMs(秒×1000)', async () => {
    const w = makeWrapper({ hovered: true });
    const input = w.find('[data-test="slideshow-interval-input"]');
    expect(input.exists()).toBe(true);
    await input.setValue('8');
    expect(getSlideshow(w).updateIntervalMs).toHaveBeenCalledWith(8000);
  });

  it('分页模式：越界输入钳位 1-30（99 → 30000ms）', async () => {
    const w = makeWrapper({ hovered: true });
    await w.find('[data-test="slideshow-interval-input"]').setValue('99');
    expect(getSlideshow(w).updateIntervalMs).toHaveBeenCalledWith(30000);
  });

  it('分页模式：非法输入回退当前值且不发起写入', async () => {
    const w = makeWrapper({ hovered: true });
    const input = w.find('[data-test="slideshow-interval-input"]');
    await input.setValue('');
    expect(getSlideshow(w).updateIntervalMs).not.toHaveBeenCalled();
    expect((input.element as HTMLInputElement).value).toBe('3');
  });

  it('webtoon 模式：间隔控件隐藏，显示滚动速度滑条+输入且可用，方向隐藏', async () => {
    const w = makeWrapper({ mode: 'webtoon', hovered: true });
    expect(w.find('[data-test="slideshow-interval"]').exists()).toBe(false);
    expect(w.find('[data-test="slideshow-interval-input"]').exists()).toBe(false);
    expect(w.find('[data-test="slideshow-direction"]').exists()).toBe(false);
    const slider = w.find('[data-test="webtoon-speed"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('disabled')).toBeUndefined();
    expect(w.find('[data-test="webtoon-speed-input"]').exists()).toBe(true);
  });

  it('webtoon 模式：速度输入提交 150 → 持久化 webtoon_scroll_speed', async () => {
    const w = makeWrapper({ mode: 'webtoon', hovered: true });
    await w.find('[data-test="webtoon-speed-input"]').setValue('150');
    const settings = useSettingsStore();
    expect(settings.webtoonScrollSpeed).toBe(150);
    expect(setSetting).toHaveBeenCalledWith('webtoon_scroll_speed', '150');
  });

  it('webtoon 模式：速度越界钳位 10-300（999 → 300）', async () => {
    const w = makeWrapper({ mode: 'webtoon', hovered: true });
    await w.find('[data-test="webtoon-speed-input"]').setValue('999');
    expect(useSettingsStore().webtoonScrollSpeed).toBe(300);
  });
});
