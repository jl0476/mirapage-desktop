// Pinia settings store
// 读 / 写 settings 表（通过 Tauri IPC 桥接到 SQLite）

import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { getSetting, setSetting } from '@/lib/tauri';
import {
  TOUCH_ZONES, TOUCH_ZONE_KEY, DEFAULT_TOUCH_SCHEME,
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
  type ScaleMode, type ReadDirection,
  type TouchZone, type TouchAction,
} from '@/lib/readerSettings';

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
  const keepScreenOn = ref(true);

  // v0.1.0-module3.0: 新增字段
  const defaultScaleMode = ref<ScaleMode>(DEFAULT_SCALE_MODE);
  const defaultReadDirection = ref<ReadDirection>(DEFAULT_READ_DIRECTION);
  const touchScheme = reactive<Record<TouchZone, TouchAction>>({ ...DEFAULT_TOUCH_SCHEME });

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
      ['keep_screen_on', (v) => (keepScreenOn.value = v === '1')],
      ['default_scale_mode', (v) => (defaultScaleMode.value = v as ScaleMode)],
      ['default_read_direction', (v) => (defaultReadDirection.value = v as ReadDirection)],
      ...TOUCH_ZONES.map((z) =>
        [`touch_${TOUCH_ZONE_KEY[z]}`, (v) => (touchScheme[z] = v as TouchAction)] as [string, (v: string) => void],
      ),
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

  /** 设置单个触控分区动作 */
  async function setTouchAction(zone: TouchZone, action: TouchAction): Promise<void> {
    touchScheme[zone] = action;
    await update(`touch_${TOUCH_ZONE_KEY[zone]}`, action);
  }

  /** 恢复 PV 经典 9 区布局 */
  async function resetTouchScheme(): Promise<void> {
    for (const z of TOUCH_ZONES) {
      touchScheme[z] = DEFAULT_TOUCH_SCHEME[z];
      await update(`touch_${TOUCH_ZONE_KEY[z]}`, DEFAULT_TOUCH_SCHEME[z]);
    }
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
    keepScreenOn,
    defaultScaleMode,
    defaultReadDirection,
    touchScheme,
    initialized,
    // 方法
    load,
    update,
    setTouchAction,
    resetTouchScheme,
  };
});
