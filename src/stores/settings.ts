// Pinia settings store
// 读 / 写 settings 表（通过 Tauri IPC 桥接到 SQLite）

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getSetting, setSetting } from '@/lib/tauri';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ColorTheme = 'blue' | 'purple' | 'amber' | 'neutral';
export type Locale = 'system' | 'zh-CN' | 'en-US';
export type ContinueMode = 'off' | 'auto' | 'manual';
export type ReaderMode = 'single' | 'double';
export type SearchMode = 'fuzzy' | 'substring';

export const useSettingsStore = defineStore('settings', () => {
  const themeMode = ref<ThemeMode>('system');
  const colorTheme = ref<ColorTheme>('blue');
  const locale = ref<Locale>('system');
  const readerDefaultMode = ref<ReaderMode>('single');
  const continueToNextVolume = ref<ContinueMode>('manual');
  const searchMode = ref<SearchMode>('fuzzy');
  const slideshowIntervalMs = ref(3000);
  const slideshowLoop = ref(true);
  const slideshowDirection = ref<'forward' | 'backward'>('forward');

  const initialized = ref(false);

  /** 加载所有 settings（启动时调用） */
  async function load(): Promise<void> {
    const keys: Array<[string, (v: string) => void]> = [
      ['theme_mode', (v) => (themeMode.value = v as ThemeMode)],
      ['color_theme', (v) => (colorTheme.value = v as ColorTheme)],
      ['locale', (v) => (locale.value = v as Locale)],
      ['reader_default_mode', (v) => (readerDefaultMode.value = v as ReaderMode)],
      ['continue_to_next_volume', (v) => (continueToNextVolume.value = v as ContinueMode)],
      ['search_mode', (v) => (searchMode.value = v as SearchMode)],
      ['slideshow_interval_ms', (v) => (slideshowIntervalMs.value = Number(v))],
      ['slideshow_loop', (v) => (slideshowLoop.value = v === '1')],
      ['slideshow_direction', (v) => (slideshowDirection.value = v as 'forward' | 'backward')],
    ];

    for (const [key, apply] of keys) {
      const v = await getSetting(key);
      if (v !== null) apply(v);
    }

    initialized.value = true;
  }

  /** 更新并持久化单个设置 */
  async function update<T extends string | number | boolean>(key: string, value: T): Promise<void> {
    const strValue = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    await setSetting(key, strValue);
  }

  return {
    // 状态
    themeMode,
    colorTheme,
    locale,
    readerDefaultMode,
    continueToNextVolume,
    searchMode,
    slideshowIntervalMs,
    slideshowLoop,
    slideshowDirection,
    initialized,
    // 方法
    load,
    update,
  };
});