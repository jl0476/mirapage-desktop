/**
 * settings store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (key === 'locale') return 'zh-CN';
    if (key === 'theme_mode') return 'dark';
    if (key === 'slideshow_interval_ms') return '5000';
    if (key === 'slideshow_loop') return '1';
    if (key === 'default_scale_mode') return 'fit-width';
    if (key === 'default_read_direction') return 'rtl';
    if (key === 'touch_top_left') return 'jump-first';
    return null;
  }),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from './settings';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('settings store', () => {
  it('load populates known keys', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.locale).toBe('zh-CN');
    expect(store.themeMode).toBe('dark');
    expect(store.slideshowIntervalMs).toBe(5000);
    expect(store.slideshowLoop).toBe(true);
    expect(store.initialized).toBe(true);
  });

  it('update persists boolean as 1/0', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    await store.update('slideshow_loop', false);
    expect(setSetting).toHaveBeenCalledWith('slideshow_loop', '0');
  });

  it('update persists number as string', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.update('slideshow_interval_ms', 2500);
    expect(setSetting).toHaveBeenCalledWith('slideshow_interval_ms', '2500');
  });

  it('load populates new default_scale_mode and default_read_direction', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.defaultScaleMode).toBe('fit-width');
    expect(store.defaultReadDirection).toBe('rtl');
  });

  it('load populates touch_top_left to override default', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.touchScheme.tl).toBe('jump-first');
    // 其他 8 区未在 mock 命中, 应保持 PV DEFAULT
    expect(store.touchScheme.tm).toBe('open-file-browser');
    expect(store.touchScheme.br).toBe('folder-next');
  });

  it('setTouchAction updates reactive state and persists to DB', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    await store.setTouchAction('tl', 'jump-last');
    expect(store.touchScheme.tl).toBe('jump-last');
    expect(setSetting).toHaveBeenCalledWith('touch_top_left', 'jump-last');
  });

  it('resetTouchScheme writes all 9 zones to PV DEFAULT', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    void store.touchScheme;  // ensure reactive obj init
    await store.resetTouchScheme();
    expect(store.touchScheme).toEqual({
      tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
      ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
      bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
    });
    expect(setSetting).toHaveBeenCalledWith('touch_top_left', 'fit-width');
    expect(setSetting).toHaveBeenCalledWith('touch_bot_right', 'folder-next');
    expect(setSetting).toHaveBeenCalledTimes(9);
  });
});
