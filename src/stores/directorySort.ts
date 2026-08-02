/**
 * directorySort Pinia store — v0.1.0-module3.0
 * per-folder 排序覆盖（Android DirectorySortRepository 对齐）
 *
 * locationKey = JSON.stringify(sourceDescriptor) + "|" + relPath
 * 用户改排序时调 set() 写 override；下次进同文件夹 fetch() 读 override
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  getDirectorySort,
  setDirectorySort,
  type DirectorySortField,
} from '@/lib/tauri';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

export interface DirectorySortOverride {
  sortField: DirectorySortField;
  ascending: boolean;
}

export const useDirectorySortStore = defineStore('directorySort', () => {
  const overrides = ref<Map<string, DirectorySortOverride>>(new Map());

  function keyOf(sourceDescriptor: SourceDescriptor, relPath: string): string {
    return JSON.stringify(sourceDescriptor) + '|' + relPath;
  }

  /** 读 override；未命中返回 null，调用方 fallback 到 settings/fileBrowser 默认 */
  async function resolve(
    sourceDescriptor: SourceDescriptor,
    relPath: string,
  ): Promise<DirectorySortOverride | null> {
    const key = keyOf(sourceDescriptor, relPath);
    if (overrides.value.has(key)) {
      return overrides.value.get(key) ?? null;
    }
    try {
      const result = await getDirectorySort(sourceDescriptor, relPath);
      if (!result) return null;
      const ov: DirectorySortOverride = {
        sortField: result.sortField,
        ascending: result.ascending,
      };
      overrides.value.set(key, ov);
      return ov;
    } catch {
      return null;
    }
  }

  /** 写 override（用户在该文件夹改了排序时调） */
  async function set(
    sourceDescriptor: SourceDescriptor,
    relPath: string,
    sort: DirectorySortOverride,
  ): Promise<void> {
    const key = keyOf(sourceDescriptor, relPath);
    overrides.value.set(key, sort);
    try {
      await setDirectorySort(
        sourceDescriptor,
        relPath,
        sort.sortField,
        sort.ascending,
      );
    } catch (e) {
      console.warn('[directorySort] set failed', e);
    }
  }

  return { resolve, set };
});