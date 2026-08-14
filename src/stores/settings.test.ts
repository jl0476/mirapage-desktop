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
    return null;
  }),
  setSetting: vi.fn(async () => undefined),
  updateThumbnailRuntimeConfig: vi.fn(async () => undefined),
  updateThumbnailCacheLimit: vi.fn(async () => undefined),
  getThumbnailCacheInfo: vi.fn(async () => ({ bytes: 0, count: 0 })),
  clearThumbnailCache: vi.fn(async () => undefined),
  notifyThumbnailEpoch: vi.fn(async () => undefined),
  notifyThumbnailFastScrolling: vi.fn(async () => undefined),
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
});

describe('settings store: 缩略图缓存', () => {
  it('九个 key 默认值', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.thumbnailResourceMode).toBe('balanced');
    expect(store.thumbnailWorkerLimit).toBe(2);
    expect(store.thumbnailDecodeMemoryMb).toBe(128);
    expect(store.thumbnailQuality).toBe('high');
    expect(store.thumbnailPrefetchScreens).toBe(1.5);
    expect(store.thumbnailIdleGeneration).toBe(true);
    expect(store.thumbnailIdlePrefetchScreens).toBe(1);
    expect(store.thumbnailCacheRoot).toBe('');
    expect(store.thumbnailCacheLimitMb).toBe(512);
  });

  it('选预设一次性覆盖资源参数并推送 runtime', async () => {
    const { updateThumbnailRuntimeConfig } = await import('@/lib/tauri');
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailResourceMode('performance');
    expect(store.thumbnailResourceMode).toBe('performance');
    expect(store.thumbnailWorkerLimit).toBe(3);
    expect(store.thumbnailDecodeMemoryMb).toBe(256);
    expect(store.thumbnailPrefetchScreens).toBe(2.5);
    expect(store.thumbnailIdlePrefetchScreens).toBe(2);
    expect(updateThumbnailRuntimeConfig).toHaveBeenCalledWith(3, 256, 'high');
  });

  it('手改 worker -> 模式切 custom', async () => {
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailResourceMode('balanced');
    await store.setThumbnailWorkerLimit(4);
    expect(store.thumbnailResourceMode).toBe('custom');
    expect(store.thumbnailWorkerLimit).toBe(4);
  });

  it('手改 worker 越界归一化（17 -> 16）', async () => {
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailWorkerLimit(17);
    expect(store.thumbnailWorkerLimit).toBe(16);
  });

  it('改清晰度不改资源模式，但推送 runtime', async () => {
    const { updateThumbnailRuntimeConfig } = await import('@/lib/tauri');
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailQuality('ultra');
    expect(store.thumbnailResourceMode).toBe('balanced');
    expect(store.thumbnailQuality).toBe('ultra');
    expect(updateThumbnailRuntimeConfig).toHaveBeenCalledWith(2, 128, 'ultra');
  });

  it('改缓存上限不改资源模式', async () => {
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailCacheLimitMb(1024);
    expect(store.thumbnailResourceMode).toBe('balanced');
    expect(store.thumbnailCacheLimitMb).toBe(1024);
  });

  it('P1-4: 改缓存上限即时推送 runtime（无需重启）', async () => {
    const { updateThumbnailCacheLimit } = await import('@/lib/tauri');
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailCacheLimitMb(2048);
    expect(updateThumbnailCacheLimit).toHaveBeenCalledWith(2048);
  });

  it('P1-4: 节能预设预读范围 = 0.5 屏 / 空闲关闭', async () => {
    const store = useSettingsStore();
    await store.load();
    await store.setThumbnailResourceMode('powerSaver');
    expect(store.thumbnailPrefetchScreens).toBe(0.5);
    expect(store.thumbnailIdleGeneration).toBe(false);
    expect(store.thumbnailIdlePrefetchScreens).toBe(0);
  });
});

describe('settings store: masonry 浏览位置（v0.1.0-module3.0.8 任务 11）', () => {
  it('默认 recordBrowsePosition=true（DB 无值）', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.recordBrowsePosition).toBe(true);
  });

  it('默认 restoreBrowsePositionOnEnter=true（DB 无值）', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.restoreBrowsePositionOnEnter).toBe(true);
  });

  it('setRecordBrowsePosition(false) 持久化到 DB', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    await store.setRecordBrowsePosition(false);
    expect(store.recordBrowsePosition).toBe(false);
    expect(setSetting).toHaveBeenCalledWith('fb_record_browse_position', 'false');
  });

  it('load 从 DB 读 fb_record_browse_position="false" → ref=false', async () => {
    const { getSetting } = await import('@/lib/tauri');
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'fb_record_browse_position') return 'false';
      if (key === 'fb_restore_browse_position_on_enter') return 'false';
      return null;
    });
    const store = useSettingsStore();
    await store.load();
    expect(store.recordBrowsePosition).toBe(false);
    expect(store.restoreBrowsePositionOnEnter).toBe(false);
  });

  // module3.0.11：角标点击弹详情开关
  it('thumbnailDetailPopover 读写：load 加载 + setter 持久化（true/false 字符串）', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    // 默认 true
    expect(store.thumbnailDetailPopover).toBe(true);
    await store.setThumbnailDetailPopover(false);
    expect(store.thumbnailDetailPopover).toBe(false);
    expect(setSetting).toHaveBeenCalledWith('fb_thumbnail_detail_popover', 'false');
  });

  it('load 从 DB 读 fb_thumbnail_detail_popover="false" → ref=false', async () => {
    const { getSetting } = await import('@/lib/tauri');
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'fb_thumbnail_detail_popover') return 'false';
      return null;
    });
    const store = useSettingsStore();
    await store.load();
    expect(store.thumbnailDetailPopover).toBe(false);
  });
});
