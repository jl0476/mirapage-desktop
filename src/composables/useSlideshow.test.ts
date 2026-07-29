/**
 * useSlideshow composable 测试
 * - setInterval 每 intervalMs 触发一次 advance(dir)
 * - direction=forward → advance(+1),backward → advance(-1)
 * - 末页处理:loop=true 回到首页,loop=false 暂停
 * - 0 页时 noop
 * - 切换 isPlaying 时启/停 timer
 * - 间隔变更时重启 timer
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useSlideshow } from './useSlideshow';
import { useSlideshowStore } from '@/stores/slideshow';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSlideshow', () => {
  // setActivePinia(createPinia()) beforeEach 已重置 store,无需 $reset

  it('starts a setInterval when isPlaying=true', () => {
    const store = useSlideshowStore();
    store.isPlaying = true;
    store.intervalMs = 1000;
    store.direction = 'forward';
    store.loop = true;

    const currentPage = ref(0);
    const pageCount = ref(5);
    const advance = vi.fn((next: number) => {
      currentPage.value = next;
    });
    useSlideshow(currentPage, pageCount, advance);

    vi.advanceTimersByTime(1000);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(1);

    vi.advanceTimersByTime(1000);
    expect(advance).toHaveBeenCalledTimes(2);
    expect(advance).toHaveBeenNthCalledWith(2, 2);
  });

  it('does nothing when isPlaying=false', () => {
    const store = useSlideshowStore();
    store.isPlaying = false;
    const advance = vi.fn();
    useSlideshow(ref(0), ref(5), advance);
    vi.advanceTimersByTime(5000);
    expect(advance).not.toHaveBeenCalled();
  });

  it('direction=backward advances prev', () => {
    const store = useSlideshowStore();
    store.isPlaying = true;
    store.intervalMs = 100;
    store.direction = 'backward';
    store.loop = true;

    const currentPage = ref(3);
    const pageCount = ref(5);
    const advance = vi.fn((next: number) => {
      currentPage.value = next;
    });
    useSlideshow(currentPage, pageCount, advance);
    vi.advanceTimersByTime(100);
    expect(advance).toHaveBeenCalledWith(2);
  });

  it('at last page with loop=true wraps to first', () => {
    const store = useSlideshowStore();
    store.isPlaying = true;
    store.intervalMs = 100;
    store.direction = 'forward';
    store.loop = true;

    const currentPage = ref(4);
    const advance = vi.fn();
    useSlideshow(currentPage, ref(5), advance);
    vi.advanceTimersByTime(100);
    expect(advance).toHaveBeenCalledWith(0);
  });

  it('at last page with loop=false pauses and skips', () => {
    const store = useSlideshowStore();
    store.isPlaying = true;
    store.intervalMs = 100;
    store.direction = 'forward';
    store.loop = false;

    const currentPage = ref(4);
    const advance = vi.fn();
    useSlideshow(currentPage, ref(5), advance);
    vi.advanceTimersByTime(100);
    expect(advance).not.toHaveBeenCalled();
    expect(store.isPlaying).toBe(false);
  });

  it('does not tick when pageCount=0', () => {
    const store = useSlideshowStore();
    store.isPlaying = true;
    store.intervalMs = 100;
    const advance = vi.fn();
    useSlideshow(ref(0), ref(0), advance);
    vi.advanceTimersByTime(1000);
    expect(advance).not.toHaveBeenCalled();
  });

  it('intervalMs change restarts the timer', async () => {
    const store = useSlideshowStore();
    store.isPlaying = true;
    store.intervalMs = 1000;
    store.direction = 'forward';
    store.loop = true;

    const currentPage = ref(0);
    const advance = vi.fn((next: number) => {
      currentPage.value = next;
    });
    useSlideshow(currentPage, ref(5), advance);

    await vi.advanceTimersByTimeAsync(500);
    expect(advance).not.toHaveBeenCalled();

    // 缩短间隔
    store.intervalMs = 100;
    await Promise.resolve(); // 让 watch microtask 跑
    await vi.advanceTimersByTimeAsync(100);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});