// useMasonrySettings.ts — per-folder 瀑布流布局参数（列数 + 列间/行间间隔）
// 复用 directory_masonry 表 + locationKey 模式（与 directorySort store 对齐）。
// 优先级：per-folder override > 全局默认（settings store 的 masonryDefault*）。

import { ref } from 'vue';
import { getDirectoryMasonry, setDirectoryMasonry } from '@/lib/tauri';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
import type { useSettingsStore } from '@/stores/settings';

export interface MasonryParams {
  colCount: number;
  hGap: number;
  vGap: number;
}

export interface MasonryOverride {
  colCount?: number;
  hGap?: number;
  vGap?: number;
}

type SettingsStore = ReturnType<typeof useSettingsStore>;

function keyOf(sourceDescriptor: SourceDescriptor, relPath: string): string {
  return JSON.stringify(sourceDescriptor) + '|' + relPath;
}

export function useMasonrySettings(settings: SettingsStore) {
  const overrides = ref<Map<string, MasonryOverride>>(new Map());

  async function resolve(sourceDescriptor: SourceDescriptor, relPath: string): Promise<MasonryParams> {
    const key = keyOf(sourceDescriptor, relPath);
    let ov = overrides.value.get(key);
    if (!ov) {
      try {
        const result = await getDirectoryMasonry(sourceDescriptor, relPath);
        if (result) {
          ov = {
            colCount: result.colCount ?? undefined,
            hGap: result.hGap ?? undefined,
            vGap: result.vGap ?? undefined,
          };
          overrides.value.set(key, ov);
        }
      } catch {
        // 静默，用全局默认
      }
    }
    return {
      colCount: ov?.colCount ?? settings.masonryDefaultCols,
      hGap: ov?.hGap ?? settings.masonryDefaultHGap,
      vGap: ov?.vGap ?? settings.masonryDefaultVGap,
    };
  }

  async function set(
    sourceDescriptor: SourceDescriptor,
    relPath: string,
    partial: MasonryOverride,
  ): Promise<void> {
    const key = keyOf(sourceDescriptor, relPath);
    const existing = overrides.value.get(key) ?? {};
    const merged = { ...existing, ...partial };
    overrides.value.set(key, merged);
    try {
      await setDirectoryMasonry(
        sourceDescriptor,
        relPath,
        partial.colCount ?? null,
        partial.hGap ?? null,
        partial.vGap ?? null,
      );
    } catch {
      // 静默
    }
  }

  return { resolve, set, overrides };
}