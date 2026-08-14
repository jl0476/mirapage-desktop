/**
 * MasonryThumbnail.vue 测试（计划任务8）
 * 覆盖 6 种状态 DOM + 失败按钮 stopPropagation 只 emit retry + load 淡入 + error emit。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import MasonryThumbnail from './MasonryThumbnail.vue';
import type { ThumbnailState } from '@/lib/thumbnail';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
});

function mountThumb(state?: ThumbnailState, extraProps: Record<string, unknown> = {}) {
  return mount(MasonryThumbnail, {
    props: { state, alt: 'x.jpg', ...extraProps },
    global: { plugins: [i18n] },
  });
}

describe('MasonryThumbnail.vue', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('placeholder（无 state）：无 img 有 spinner（加载中反馈，避免白屏）无 failed', () => {
    const w = mountThumb(undefined);
    expect(w.find('img').exists()).toBe(false);
    // 无 state 视为加载中（尚未进入窗口/请求未返回/header 失败待兜底），显示 spinner 而非白屏
    expect(w.find('.thumb-spinner').exists()).toBe(true);
    expect(w.find('.thumb-failed').exists()).toBe(false);
  });

  it('queued：单个 CSS spinner + aria-label', () => {
    const w = mountThumb({ kind: 'queued', cacheKey: 'k' });
    expect(w.find('.thumb-spinner').exists()).toBe(true);
    expect(w.find('.thumb-spinner').attributes('role')).toBe('status');
    expect(w.find('img').exists()).toBe(false);
  });

  it('generating：显示 spinner', () => {
    const w = mountThumb({ kind: 'generating', cacheKey: 'k', phase: 'queued', startedAt: Date.now(), timings: {} });
    expect(w.find('.thumb-spinner').exists()).toBe(true);
  });

  it('cached：渲染 img，load 后加 is-ready 淡入 class', async () => {
    const w = mountThumb({ kind: 'cached', cacheKey: 'k', path: 'asset://c.webp', width: 512, height: 400 });
    const img = w.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('asset://c.webp');
    expect(img.classes()).not.toContain('is-ready');
    // load 前仍有 spinner
    expect(w.find('.thumb-spinner').exists()).toBe(true);
    // 触发 load
    img.trigger('load');
    await flushPromises();
    expect(w.find('img').classes()).toContain('is-ready');
    expect(w.find('.thumb-spinner').exists()).toBe(false);
  });

  it('original：渲染原图 img', () => {
    const w = mountThumb({ kind: 'original', url: 'orig://a.jpg' });
    const img = w.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('orig://a.jpg');
  });

  it('failed：渲染重试按钮，click 只 emit retry 且 stopPropagation', async () => {
    const w = mountThumb({ kind: 'failed', cacheKey: 'k', retryable: true, message: 'boom' });
    const btn = w.find('.retry-btn');
    expect(btn.exists()).toBe(true);
    // 监听 click 冒泡到根元素
    const rootClick = vi.fn();
    w.element.addEventListener('click', rootClick);
    // stopPropagation 应阻止冒泡到根
    await btn.trigger('click');
    expect(w.emitted('retry')).toBeTruthy();
    expect(rootClick).not.toHaveBeenCalled();
  });

  it('img error -> emit load-error', async () => {
    const w = mountThumb({ kind: 'original', url: 'orig://bad.jpg' });
    await w.find('img').trigger('error');
    expect(w.emitted('load-error')).toBeTruthy();
  });

  it('img 带 loading=lazy + decoding=async', () => {
    const w = mountThumb({ kind: 'original', url: 'orig://a.jpg' });
    const img = w.find('img');
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
  });
});

// ─── module3.0.11：阶段角标（round-1/2/3 修订全覆盖）──────────────────────
describe('MasonryThumbnail phase badge (module3.0.11)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('generating(queued) 显角标，点击 emit show-progress 携带角标元素', async () => {
    const w = mountThumb({ kind: 'generating', cacheKey: 'k', phase: 'queued', startedAt: Date.now(), timings: {} });
    const badge = w.find('.phase-badge');
    expect(badge.exists()).toBe(true);
    expect(w.find('.thumb-spinner').exists()).toBe(true);
    await badge.trigger('click');
    const emitted = w.emitted('show-progress');
    expect(emitted).toBeTruthy();
    // round-1 P2：payload 是角标 DOM 元素（MasonryView 用它定位，不走 querySelector）
    expect(emitted![0]![0]).toBeInstanceOf(HTMLElement);
  });

  it('generating(decoding) 角标存在 + click 不冒泡到根', async () => {
    const w = mountThumb({ kind: 'generating', cacheKey: 'k', phase: 'decoding', startedAt: Date.now(), timings: {} });
    const badge = w.find('.phase-badge');
    expect(badge.exists()).toBe(true);
    const rootClick = vi.fn();
    w.element.addEventListener('click', rootClick);
    await badge.trigger('click');
    expect(w.emitted('show-progress')).toBeTruthy();
    expect(rootClick).not.toHaveBeenCalled(); // stopPropagation
  });

  it('cached / original / undefined 均无角标', () => {
    for (const st of [
      undefined,
      { kind: 'cached', cacheKey: 'k', path: 'asset://c.webp', width: 100, height: 100 },
      { kind: 'original', url: 'orig://a.jpg' },
    ] as const) {
      const w = mountThumb(st as never);
      expect(w.find('.phase-badge').exists()).toBe(false);
    }
  });

  // round-2 必修：failed 态保留错误角标——否则未在失败前打开 popover 的用户，
  // 失败时间线与 popover 内重试按钮永不可达（spec §5.2/§6.3 决策 14）。
  it('failed 显错误角标（error 色 + 感叹号图标），点击 emit show-progress 携带元素', async () => {
    const w = mountThumb({ kind: 'failed', cacheKey: 'k', retryable: true, message: 'x' });
    const badge = w.find('.phase-badge');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain('fail');
    await badge.trigger('click');
    const emitted = w.emitted('show-progress');
    expect(emitted).toBeTruthy();
    expect(emitted![0]![0]).toBeInstanceOf(HTMLElement);
  });

  // round-3：开关关时角标纯指示——disabled + 不 emit（spec §7.2 实现契约）
  it('badgeInteractive=false → 角标 disabled、点击不 emit（纯指示）', async () => {
    const w = mountThumb(
      { kind: 'generating', cacheKey: 'k', phase: 'queued', startedAt: Date.now(), timings: {} },
      { badgeInteractive: false },
    );
    const badge = w.find('.phase-badge');
    expect(badge.attributes('disabled')).toBeDefined();
    await badge.trigger('click'); // dispatchEvent 会绕过 disabled，靠 handler 守卫兜底
    expect(w.emitted('show-progress')).toBeUndefined();
  });
});
