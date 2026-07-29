/**
 * slideshow store 测试
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
});

describe('slideshow store', () => {
  it('updateIntervalMs clamps to [1000, 30000]', async () => {
    const store = useSlideshowStore();
    await store.updateIntervalMs(500);
    expect(store.intervalMs).toBe(1000);
    await store.updateIntervalMs(50000);
    expect(store.intervalMs).toBe(30000);
    await store.updateIntervalMs(5000);
    expect(store.intervalMs).toBe(5000);
  });

  it('toggle flips isPlaying', () => {
    const store = useSlideshowStore();
    expect(store.isPlaying).toBe(false);
    store.toggle();
    expect(store.isPlaying).toBe(true);
    store.toggle();
    expect(store.isPlaying).toBe(false);
  });

  it('updateLoop persists true → 1', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSlideshowStore();
    await store.updateLoop(true);
    expect(setSetting).toHaveBeenCalledWith('slideshow_loop', '1');
    expect(store.loop).toBe(true);
  });

  it('updateDirection persists', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSlideshowStore();
    await store.updateDirection('backward');
    expect(setSetting).toHaveBeenCalledWith('slideshow_direction', 'backward');
    expect(store.direction).toBe('backward');
  });
});