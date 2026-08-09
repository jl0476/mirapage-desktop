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

function mountThumb(state?: ThumbnailState) {
  return mount(MasonryThumbnail, {
    props: { state, alt: 'x.jpg' },
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
    const w = mountThumb({ kind: 'generating', cacheKey: 'k' });
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
