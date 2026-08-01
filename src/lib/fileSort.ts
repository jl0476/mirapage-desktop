/**
 * fileSort.ts — 文件排序纯函数
 *
 * v0.1.0-module1.22: 从 FileList.vue 组件内 computed 提到 lib,
 * 供 fileBrowser store 的 sortedEntries computed 复用.
 *
 * 规则:
 *   - dir-first: 文件夹永远在前面 (Xplorer 风格, Perfect-Viewer 一致)
 *   - name: 复用 naturalSort (已有 src/lib/naturalSort.ts)
 *   - modifiedAt / size: 数字比较; 缺失值 (undefined) 排到末尾
 *   - ascending=false: 整体反转
 */
import type { MediaEntry } from '@/lib/sourceDescriptor';
import { naturalSort } from '@/lib/naturalSort';

export type SortField = 'name' | 'modifiedAt' | 'size';

export function sortEntries(
  entries: MediaEntry[],
  field: SortField,
  ascending: boolean,
): MediaEntry[] {
  if (entries.length === 0) return entries;

  // Step 1: dir-first
  const dirs = entries.filter((e) => e.isDirectory);
  const files = entries.filter((e) => !e.isDirectory);

  // Step 2: dirs 与 files 各自按字段排
  const sortedDirs = sortByField(dirs, field);
  const sortedFiles = sortByField(files, field);

  // Step 3: asc=false 则整体反转 (但 dirs 永远在前面, 所以翻完后 dirs 仍在前)
  if (!ascending) {
    sortedDirs.reverse();
    sortedFiles.reverse();
  }

  return [...sortedDirs, ...sortedFiles];
}

function sortByField(entries: MediaEntry[], field: SortField): MediaEntry[] {
  if (field === 'name') {
    const sorted = naturalSort(entries, (e) => e.name);
    return sorted;
  }
  if (field === 'modifiedAt') {
    // 缺失值放末尾: 排序时把 undefined 映射为 -Infinity / +Infinity
    return [...entries].sort((a, b) => {
      const av = a.modifiedAt;
      const bv = b.modifiedAt;
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1; // a 排后
      if (bv === undefined) return -1; // b 排后
      return av - bv;
    });
  }
  if (field === 'size') {
    return [...entries].sort((a, b) => a.size - b.size);
  }
  return entries;
}
