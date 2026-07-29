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
    return null;
  }),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from './settings';

beforeEach(() => {
  setActivePinia(createPinia());
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
});