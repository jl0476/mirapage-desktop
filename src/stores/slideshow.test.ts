/**
 * slideshow store v0.1.0-module2.0 升级测试
 * - tick: 翻页回调 + 末页暂停 + 跨卷 flag
 * - reset: 重置 timer 不暂停
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { useSlideshowStore } from './slideshow';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

describe('slideshow — tick 翻页回调', () => {
  it('非末页 → 调 onAdvance (forward)', () => {
    const store = useSlideshowStore();
    store.direction = 'forward';
    const onAdvance = vi.fn();
    const onPrev = vi.fn();
    const atLast = vi.fn(() => false);
    store.tick(onAdvance, onPrev, atLast);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('非末页 + direction=backward → 调 onPrev', () => {
    const store = useSlideshowStore();
    store.direction = 'backward';
    const onAdvance = vi.fn();
    const onPrev = vi.fn();
    const atLast = vi.fn(() => false);
    store.tick(onAdvance, onPrev, atLast);
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('末页 → 调 pause() + 设置 pendingNextVolume = true', () => {
    const store = useSlideshowStore();
    store.isPlaying = true; // 模拟 start 后
    const onAdvance = vi.fn();
    const onPrev = vi.fn();
    const atLast = vi.fn(() => true);
    store.tick(onAdvance, onPrev, atLast);
    expect(store.isPlaying).toBe(false); // pause
    expect(store.pendingNextVolume).toBe(true);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('consumePendingNextVolume → 重置 flag', () => {
    const store = useSlideshowStore();
    store.pendingNextVolume = true;
    expect(store.consumePendingNextVolume()).toBe(true);
    expect(store.pendingNextVolume).toBe(false);
    expect(store.consumePendingNextVolume()).toBe(false);
  });
});

describe('slideshow — reset 重置 timer', () => {
  it('isPlaying=false → reset 是 no-op', () => {
    const store = useSlideshowStore();
    expect(store.isPlaying).toBe(false);
    // 不应抛错
    expect(() => store.reset()).not.toThrow();
  });

  it('isPlaying=true → reset 重启 timer', () => {
    vi.useRealTimers(); // setInterval/clearInterval 用真实 timer
    const store = useSlideshowStore();
    store.intervalMs = 1000;
    store.start();
    expect(store.isPlaying).toBe(true);
    store.reset(); // 重启 timer, 不暂停
    expect(store.isPlaying).toBe(true);
    store.pause();
    vi.useFakeTimers();
  });
});

describe('slideshow — start/pause/toggle', () => {
  it('start → isPlaying=true + 设 timer', () => {
    vi.useRealTimers();
    const store = useSlideshowStore();
    store.intervalMs = 1000;
    store.start();
    expect(store.isPlaying).toBe(true);
    store.pause();
    expect(store.isPlaying).toBe(false);
    vi.useFakeTimers();
  });

  it('start 重复调幂等', () => {
    vi.useRealTimers();
    const store = useSlideshowStore();
    store.intervalMs = 1000;
    store.start();
    const t1 = store.isPlaying;
    store.start(); // 重复
    expect(store.isPlaying).toBe(t1);
    store.pause();
    vi.useFakeTimers();
  });

  it('toggle flip', () => {
    vi.useRealTimers();
    const store = useSlideshowStore();
    store.intervalMs = 1000;
    expect(store.isPlaying).toBe(false);
    store.toggle();
    expect(store.isPlaying).toBe(true);
    store.toggle();
    expect(store.isPlaying).toBe(false);
    vi.useFakeTimers();
  });
});

// v0.1.0-module3.0.2 (H2): start() 启动的 timer 第一次 fire 必须能跑通.
// 老实现 schedule() = setInterval(tick, ms), 但 tick 期望 3 个回调, 0 传入 → 抛 TypeError.
describe('slideshow — start timer 真实链路', () => {
  it('start 后等 intervalMs, 调 setAdvance / setPrev / getIsAtLast (不抛错)', () => {
    vi.useRealTimers();
    const store = useSlideshowStore();
    store.intervalMs = 500;
    const onAdvance = vi.fn();
    const onPrev = vi.fn();
    const atLast = vi.fn(() => false);
    store.setAdvance(onAdvance);
    store.setPrev(onPrev);
    store.setIsAtLast(atLast);
    store.start();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onAdvance).toHaveBeenCalled();
        store.pause();
        resolve();
      }, 700);
    });
  });
});
