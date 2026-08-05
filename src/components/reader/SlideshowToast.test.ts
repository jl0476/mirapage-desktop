/**
 * SlideshowToast.vue 测试
 * v0.1.0-module3.0.3: 空格切换幻灯片时弹出胶囊提示
 *
 * 触发源：watch slideshow.isPlaying flip
 * 持续时长：1500ms
 * 文案：slideshow.statusStarted / slideshow.statusPaused
 * 图标：Play / Pause SVG inline 11px
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import SlideshowToast from './SlideshowToast.vue';
import { useSlideshowStore } from '@/stores/slideshow';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
});

function makeWrapper() {
  return mount(SlideshowToast, {
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
}

function getToast() {
  return document.body.querySelector('[data-test="slideshow-toast"]') as HTMLElement | null;
}

describe('SlideshowToast.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('初始不显示胶囊', () => {
    makeWrapper();
    expect(getToast()).toBeNull();
  });

  it('isPlaying 从 false → true 显示"已开始播放" + 播放中图标（双 rect / Pause 图形）', async () => {
    makeWrapper();
    const slideshow = useSlideshowStore();
    slideshow.isPlaying = true;
    await flushPromises();
    const toast = getToast();
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('已开始播放');
    // 状态指示约定: isPlaying=true (播放中) → Pause 图形 (双 rect), 与 macOS/YouTube 媒体控件一致
    expect(toast!.querySelectorAll('rect').length).toBe(2);
  });

  it('isPlaying 从 true → false 显示"已暂停" + 暂停图标（Play 图形三角）', async () => {
    makeWrapper();
    const slideshow = useSlideshowStore();
    slideshow.isPlaying = true;
    await flushPromises();
    slideshow.isPlaying = false;
    await flushPromises();
    const toast = getToast();
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('已暂停');
    // 状态指示约定: isPlaying=false (暂停) → Play 图形 (单 path 三角)
    expect(toast!.querySelectorAll('rect').length).toBe(0);
    expect(toast!.querySelector('path')?.getAttribute('d')).toBe('M7 5v14l12-7z');
  });

  it('1500ms 后自动隐藏', async () => {
    makeWrapper();
    const slideshow = useSlideshowStore();
    slideshow.isPlaying = true;
    await flushPromises();
    expect(getToast()).not.toBeNull();
    vi.advanceTimersByTime(1500);
    await flushPromises();
    expect(getToast()).toBeNull();
  });

  it('快速翻转两次时计时器重置（仅最后一个 1500ms 后隐藏）', async () => {
    makeWrapper();
    const slideshow = useSlideshowStore();
    slideshow.isPlaying = true;
    await flushPromises();
    vi.advanceTimersByTime(1000);
    slideshow.isPlaying = false;
    await flushPromises();
    // 此时 toast 还应显示（未到 1500ms）
    expect(getToast()).not.toBeNull();
    // 再过 1000ms (累计 2000ms 但中间重置) — 实际只过了 1000ms < 1500ms
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(getToast()).not.toBeNull();
    // 再过 500ms 才到第二个 1500ms
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(getToast()).toBeNull();
  });

  it('使用 i18n 英文文案 (en-US)', async () => {
    i18n.global.locale.value = 'en-US';
    makeWrapper();
    const slideshow = useSlideshowStore();
    slideshow.isPlaying = true;
    await flushPromises();
    expect(getToast()!.textContent).toContain('Slideshow started');
    slideshow.isPlaying = false;
    await flushPromises();
    expect(getToast()!.textContent).toContain('Slideshow paused');
  });
});
