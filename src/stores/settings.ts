// Pinia settings store
// 读 / 写 settings 表（通过 Tauri IPC 桥接到 SQLite）

import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { getSetting, setSetting } from '@/lib/tauri';
import { log } from '@/lib/logger';
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
  // v0.1.0-module3.0.2-reader-polish (Cluster C):
  // currentScaleMode = 阅读中当前生效的缩放 (runtime, 随用户切换变化, 持久化为 scale_mode)
  // defaultScaleMode = 新书打开时的初始化缩放 (持久化为 default_scale_mode, 已存在)
  const currentScaleMode = ref<ScaleMode>(DEFAULT_SCALE_MODE);
  const touchZonesEnabled = ref<boolean>(true);  // master toggle for 9-zone
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
      ['scale_mode', (v) => (currentScaleMode.value = v as ScaleMode)],
      ['default_read_direction', (v) => (defaultReadDirection.value = v as ReadDirection)],
      ['touch_zones_enabled', (v) => (touchZonesEnabled.value = v === '1')],
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

  /**
   * Cluster C: 设置当前缩放模式 (runtime + 持久化).
   *  - 改 currentScaleMode (OSD useReaderScale watch 触发 applyScale)
   *  - 持久化到 scale_mode DB key
   */
  async function setScaleMode(mode: ScaleMode): Promise<void> {
    currentScaleMode.value = mode;
    await update('scale_mode', mode);
  }

  /**
   * v0.1.0-reader-review-fix-9: 切换 reader_default_mode (in-memory + 持久化).
   *  - 修复 settings.update() 只持久化不更新 in-memory 的 bug
   *  - 用 store.$patch 强制触发 Pinia 响应 (替代直接 ref.value = X,
   *    后者在 setup store 中某些边缘情况不传播到 proxy getter)
   *  - 调用方: ReaderMainMenu / ReaderContextMenu 的 cycle-mode handler
   */
  async function cycleReaderMode(): Promise<void> {
    const next: ReaderMode = readerDefaultMode.value === 'single' ? 'double' : 'single';
    log('[settings] cycleReaderMode →', next, '(was', readerDefaultMode.value, ')');
    // 用 $patch 强制 Pinia 触发响应 + 同步 DB
    const store = useSettingsStore();
    store.$patch({ readerDefaultMode: next });
    await update('reader_default_mode', next);
    log('[settings] cycleReaderMode done, current=', readerDefaultMode.value);
  }

  /**
   * v0.1.0-reader-review-fix-9: 切换 default_read_direction (in-memory + 持久化).
   *  - 同上用 $patch 强制 Pinia 响应
   *  - 调用方: ReaderMainMenu / ReaderContextMenu 的 cycle-direction handler
   */
  async function cycleReadDirection(): Promise<void> {
    const next: ReadDirection = defaultReadDirection.value === 'ltr' ? 'rtl' : 'ltr';
    log('[settings] cycleReadDirection →', next, '(was', defaultReadDirection.value, ')');
    const store = useSettingsStore();
    store.$patch({ defaultReadDirection: next });
    await update('default_read_direction', next);
    log('[settings] cycleReadDirection done, current=', defaultReadDirection.value);
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
    currentScaleMode,
    touchZonesEnabled,
    touchScheme,
    initialized,
    // 方法
    load,
    update,
    setScaleMode,
    cycleReaderMode,
    cycleReadDirection,
    setTouchAction,
    resetTouchScheme,
  };
});
