// Pinia settings store
// 读 / 写 settings 表（通过 Tauri IPC 桥接到 SQLite）

import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { getSetting, setSetting, updateThumbnailRuntimeConfig, updateThumbnailCacheLimit } from '@/lib/tauri';
import { log } from '@/lib/logger';
import {
  TOUCH_ZONES, TOUCH_ZONE_KEY, DEFAULT_TOUCH_SCHEME,
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION, normalizeScaleMode,
  type ScaleMode, type ReadDirection,
  type TouchZone, type TouchAction,
} from '@/lib/readerSettings';
import {
  resolveThumbnailPreset, normalizeWorkerLimit, normalizeDecodeMemoryMb, normalizeCacheLimitMb,
  type ThumbnailResourceMode, type ThumbnailQuality,
} from '@/lib/thumbnail';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ColorTheme = 'blue' | 'purple' | 'amber' | 'neutral';
export type Locale = 'system' | 'zh-CN' | 'en-US';
export type ContinueMode = 'off' | 'auto' | 'manual';
export type ReaderMode = 'single' | 'double';

export const useSettingsStore = defineStore('settings', () => {
  const themeMode = ref<ThemeMode>('system');
  const colorTheme = ref<ColorTheme>('blue');
  const locale = ref<Locale>('system');
  const readerDefaultMode = ref<ReaderMode>('single');
  const continueToNextVolume = ref<ContinueMode>('manual');
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

  // v0.1.0-module3.0.6: masonry 瀑布流全局默认（per-folder override 在 useMasonrySettings）
  const masonryDefaultCols = ref(4);
  const masonryDefaultHGap = ref(8);
  const masonryDefaultVGap = ref(8);

  // v0.1.0-module3.0.7: 缩略图缓存资源 / 清晰度 / 容量（§14 九个 key）
  const thumbnailResourceMode = ref<ThumbnailResourceMode>('balanced');
  const thumbnailWorkerLimit = ref(2);
  const thumbnailDecodeMemoryMb = ref(128);
  const thumbnailQuality = ref<ThumbnailQuality>('high');
  const thumbnailPrefetchScreens = ref(1.5);
  const thumbnailIdleGeneration = ref(true);
  const thumbnailIdlePrefetchScreens = ref(1);
  const thumbnailCacheRoot = ref('');   // 空值 = 系统默认 cache dir（迁移在任务12）
  const thumbnailCacheLimitMb = ref(512);

  // v0.1.0-module3.0.8 (任务 11): masonry 浏览位置记录 / 进目录恢复开关
  //  - DB 用 'true'/'false' 字符串（spec §5.1），区别于其他 bool key 的 '1'/'0'
  const recordBrowsePosition = ref(true);
  const restoreBrowsePositionOnEnter = ref(true);

  // v0.1.0-module3.0.11: 点击角标是否弹生成详情浮层（默认开，spec §7）
  const thumbnailDetailPopover = ref(true);

  const initialized = ref(false);

  /** 加载所有 settings（启动时调用） */
  async function load(): Promise<void> {
    const keys: Array<[string, (v: string) => void]> = [
      ['theme_mode', (v) => (themeMode.value = v as ThemeMode)],
      ['color_theme', (v) => (colorTheme.value = v as ColorTheme)],
      ['locale', (v) => (locale.value = v as Locale)],
      ['reader_default_mode', (v) => (readerDefaultMode.value = v as ReaderMode)],
      ['continue_to_next_volume', (v) => (continueToNextVolume.value = v as ContinueMode)],
      ['slideshow_interval_ms', (v) => (slideshowIntervalMs.value = Number(v))],
      ['slideshow_loop', (v) => (slideshowLoop.value = v === '1')],
      ['slideshow_direction', (v) => (slideshowDirection.value = v as 'forward' | 'backward')],
      ['keep_screen_on', (v) => (keepScreenOn.value = v === '1')],
      ['default_scale_mode', (v) => (defaultScaleMode.value = normalizeScaleMode(v as ScaleMode))],
      ['scale_mode', (v) => (currentScaleMode.value = normalizeScaleMode(v as ScaleMode))],
      ['default_read_direction', (v) => (defaultReadDirection.value = v as ReadDirection)],
      ['touch_zones_enabled', (v) => (touchZonesEnabled.value = v === '1')],
      ['fb_masonry_default_cols', (v) => (masonryDefaultCols.value = Number(v))],
      ['fb_masonry_default_h_gap', (v) => (masonryDefaultHGap.value = Number(v))],
      ['fb_masonry_default_v_gap', (v) => (masonryDefaultVGap.value = Number(v))],
      // 缩略图缓存（带值域归一化兜底越界/脏值）
      ['fb_thumbnail_resource_mode', (v) => (thumbnailResourceMode.value = v as ThumbnailResourceMode)],
      ['fb_thumbnail_worker_limit', (v) => (thumbnailWorkerLimit.value = normalizeWorkerLimit(Number(v)))],
      ['fb_thumbnail_decode_memory_mb', (v) => (thumbnailDecodeMemoryMb.value = normalizeDecodeMemoryMb(Number(v)))],
      ['fb_thumbnail_quality', (v) => (thumbnailQuality.value = v as ThumbnailQuality)],
      ['fb_thumbnail_prefetch_screens', (v) => (thumbnailPrefetchScreens.value = Number(v))],
      ['fb_thumbnail_idle_generation', (v) => (thumbnailIdleGeneration.value = v === '1')],
      ['fb_thumbnail_idle_prefetch_screens', (v) => (thumbnailIdlePrefetchScreens.value = Number(v))],
      ['fb_thumbnail_cache_root', (v) => (thumbnailCacheRoot.value = v)],
      ['fb_thumbnail_cache_limit_mb', (v) => (thumbnailCacheLimitMb.value = normalizeCacheLimitMb(Number(v)))],
      // v0.1.0-module3.0.8 (任务 11): masonry 浏览位置 2 开关（'true'/'false' 字符串语义）
      ['fb_record_browse_position', (v) => (recordBrowsePosition.value = v !== 'false')],
      ['fb_restore_browse_position_on_enter', (v) => (restoreBrowsePositionOnEnter.value = v !== 'false')],
      ['fb_thumbnail_detail_popover', (v) => (thumbnailDetailPopover.value = v !== 'false')],
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
   * v0.1.0-module3.0.6: 设置 masonry 全局默认列数（先设 ref 再 update，update 只写 DB）。
   */
  async function setMasonryDefaultCols(v: number): Promise<void> {
    masonryDefaultCols.value = v;
    await update('fb_masonry_default_cols', v);
  }

  /** v0.1.0-module3.0.6: 设置 masonry 全局默认列间距 */
  async function setMasonryDefaultHGap(v: number): Promise<void> {
    masonryDefaultHGap.value = v;
    await update('fb_masonry_default_h_gap', v);
  }

  /** v0.1.0-module3.0.6: 设置 masonry 全局默认行间距 */
  async function setMasonryDefaultVGap(v: number): Promise<void> {
    masonryDefaultVGap.value = v;
    await update('fb_masonry_default_v_gap', v);
  }

  // ─── 缩略图缓存资源 / 清晰度 / 容量（v0.1.0-module3.0.7）──────────────
  /** 推送 worker/内存/清晰度运行时配置到 Rust 调度器。 */
  async function pushThumbnailRuntime(): Promise<void> {
    try {
      await updateThumbnailRuntimeConfig(
        thumbnailWorkerLimit.value,
        thumbnailDecodeMemoryMb.value,
        thumbnailQuality.value,
      );
    } catch (e) {
      log('[settings] pushThumbnailRuntime failed', e);
    }
  }

  /** 手改任一高级资源参数后模式自动切 custom。 */
  async function markThumbnailCustom(): Promise<void> {
    if (thumbnailResourceMode.value !== 'custom') {
      thumbnailResourceMode.value = 'custom';
      await update('fb_thumbnail_resource_mode', 'custom');
    }
  }

  /** 选择资源预设：一次性覆盖 worker/内存/预读/idle 并推送一次 runtime。 */
  async function setThumbnailResourceMode(mode: ThumbnailResourceMode): Promise<void> {
    thumbnailResourceMode.value = mode;
    await update('fb_thumbnail_resource_mode', mode);
    const preset = resolveThumbnailPreset(mode);
    if (preset) {
      thumbnailWorkerLimit.value = preset.workerLimit;
      thumbnailDecodeMemoryMb.value = preset.decodeMemoryMb;
      thumbnailPrefetchScreens.value = preset.prefetchScreens;
      thumbnailIdleGeneration.value = preset.idleGeneration;
      thumbnailIdlePrefetchScreens.value = preset.idlePrefetchScreens;
      await Promise.all([
        update('fb_thumbnail_worker_limit', preset.workerLimit),
        update('fb_thumbnail_decode_memory_mb', preset.decodeMemoryMb),
        update('fb_thumbnail_prefetch_screens', preset.prefetchScreens),
        update('fb_thumbnail_idle_generation', preset.idleGeneration ? '1' : '0'),
        update('fb_thumbnail_idle_prefetch_screens', preset.idlePrefetchScreens),
      ]);
      await pushThumbnailRuntime();
    }
  }

  async function setThumbnailWorkerLimit(v: number): Promise<void> {
    thumbnailWorkerLimit.value = normalizeWorkerLimit(v);
    await update('fb_thumbnail_worker_limit', thumbnailWorkerLimit.value);
    await markThumbnailCustom();
    await pushThumbnailRuntime();
  }

  async function setThumbnailDecodeMemoryMb(v: number): Promise<void> {
    thumbnailDecodeMemoryMb.value = normalizeDecodeMemoryMb(v);
    await update('fb_thumbnail_decode_memory_mb', thumbnailDecodeMemoryMb.value);
    await markThumbnailCustom();
    await pushThumbnailRuntime();
  }

  async function setThumbnailQuality(v: ThumbnailQuality): Promise<void> {
    thumbnailQuality.value = v;
    await update('fb_thumbnail_quality', v);
    await pushThumbnailRuntime();
  }

  async function setThumbnailPrefetchScreens(v: number): Promise<void> {
    thumbnailPrefetchScreens.value = v;
    await update('fb_thumbnail_prefetch_screens', v);
    await markThumbnailCustom();
  }

  async function setThumbnailIdleGeneration(v: boolean): Promise<void> {
    thumbnailIdleGeneration.value = v;
    await update('fb_thumbnail_idle_generation', v ? '1' : '0');
    await markThumbnailCustom();
  }

  async function setThumbnailIdlePrefetchScreens(v: number): Promise<void> {
    thumbnailIdlePrefetchScreens.value = v;
    await update('fb_thumbnail_idle_prefetch_screens', v);
    await markThumbnailCustom();
  }

  async function setThumbnailCacheLimitMb(v: number): Promise<void> {
    thumbnailCacheLimitMb.value = normalizeCacheLimitMb(v);
    await update('fb_thumbnail_cache_limit_mb', thumbnailCacheLimitMb.value);
    // P1-4: 运行时即时生效，无需重启
    try {
      await updateThumbnailCacheLimit(thumbnailCacheLimitMb.value);
    } catch (e) {
      log('[settings] updateThumbnailCacheLimit failed', e);
    }
  }

  // ─── v0.1.0-module3.0.8 (任务 11): masonry 浏览位置 2 开关 setter ────
  /** 'true'/'false' 字符串语义（区别于 update() 的 '1'/'0'，spec §5.1 一致）。 */
  async function setRecordBrowsePosition(v: boolean): Promise<void> {
    recordBrowsePosition.value = v;
    await setSetting('fb_record_browse_position', v ? 'true' : 'false');
  }
  async function setRestoreBrowsePositionOnEnter(v: boolean): Promise<void> {
    restoreBrowsePositionOnEnter.value = v;
    await setSetting('fb_restore_browse_position_on_enter', v ? 'true' : 'false');
  }

  /** v0.1.0-module3.0.11: 角标点击弹详情开关（'true'/'false' 字符串语义）。 */
  async function setThumbnailDetailPopover(v: boolean): Promise<void> {
    thumbnailDetailPopover.value = v;
    await setSetting('fb_thumbnail_detail_popover', v ? 'true' : 'false');
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
    slideshowIntervalMs,
    slideshowLoop,
    slideshowDirection,
    keepScreenOn,
    defaultScaleMode,
    defaultReadDirection,
    currentScaleMode,
    touchZonesEnabled,
    touchScheme,
    masonryDefaultCols,
    masonryDefaultHGap,
    masonryDefaultVGap,
    thumbnailResourceMode,
    thumbnailWorkerLimit,
    thumbnailDecodeMemoryMb,
    thumbnailQuality,
    thumbnailPrefetchScreens,
    thumbnailIdleGeneration,
    thumbnailIdlePrefetchScreens,
    thumbnailCacheRoot,
    thumbnailCacheLimitMb,
    // v0.1.0-module3.0.8 (任务 11): masonry 浏览位置 2 开关
    recordBrowsePosition,
    restoreBrowsePositionOnEnter,
    // v0.1.0-module3.0.11: 角标点击弹详情开关
    thumbnailDetailPopover,
    setThumbnailDetailPopover,
    initialized,
    // 方法
    load,
    update,
    setScaleMode,
    setMasonryDefaultCols,
    setMasonryDefaultHGap,
    setMasonryDefaultVGap,
    setThumbnailResourceMode,
    setThumbnailWorkerLimit,
    setThumbnailDecodeMemoryMb,
    setThumbnailQuality,
    setThumbnailPrefetchScreens,
    setThumbnailIdleGeneration,
    setThumbnailIdlePrefetchScreens,
    setThumbnailCacheLimitMb,
    setRecordBrowsePosition,
    setRestoreBrowsePositionOnEnter,
    cycleReaderMode,
    cycleReadDirection,
    setTouchAction,
    resetTouchScheme,
  };
});
