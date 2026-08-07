// useMasonrySettings.test.ts — v0.1.0-module3.0.6 阶段 B
// per-folder 瀑布流参数 resolve/set 行为

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from '@/stores/settings';

vi.mock('@/lib/tauri', () => ({
  getDirectoryMasonry: vi.fn(),
  setDirectoryMasonry: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

import { useMasonrySettings } from './useMasonrySettings';
import { getDirectoryMasonry, setDirectoryMasonry } from '@/lib/tauri';
import type { SourceDescriptorLocal } from '@/lib/sourceDescriptor';

const desc: SourceDescriptorLocal = { type: 'local', rootPath: 'C:/comics' };

describe('useMasonrySettings', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('per-folder 命中 → 返回 override', async () => {
    (getDirectoryMasonry as any).mockResolvedValue({ colCount: 6, hGap: 12, vGap: null });
    const { resolve } = useMasonrySettings(useSettingsStore());
    const r = await resolve(desc, 'sub');
    expect(r.colCount).toBe(6);
    expect(r.hGap).toBe(12);
  });

  it('per-folder 未命中 → fallback 全局默认', async () => {
    (getDirectoryMasonry as any).mockResolvedValue(null);
    const settings = useSettingsStore();
    settings.masonryDefaultCols = 4;
    settings.masonryDefaultHGap = 8;
    settings.masonryDefaultVGap = 8;
    const { resolve } = useMasonrySettings(settings);
    const r = await resolve(desc, 'sub');
    expect(r.colCount).toBe(4);
    expect(r.hGap).toBe(8);
    expect(r.vGap).toBe(8);
  });

  it('部分 override：只改 colCount，其他维度用全局', async () => {
    (getDirectoryMasonry as any).mockResolvedValue({ colCount: 6, hGap: null, vGap: null });
    const settings = useSettingsStore();
    settings.masonryDefaultHGap = 10;
    const { resolve } = useMasonrySettings(settings);
    const r = await resolve(desc, 'sub');
    expect(r.colCount).toBe(6); // override
    expect(r.hGap).toBe(10);    // 全局 fallback
  });

  it('set 只改传入的维度，写 IPC 用部分值', async () => {
    const { set } = useMasonrySettings(useSettingsStore());
    await set(desc, 'sub', { colCount: 5 });
    expect(setDirectoryMasonry).toHaveBeenCalledWith(desc, 'sub', 5, null, null);
  });
});