/**
 * readStatus store — 目录级"阅读中 / 已读完"染色数据源。
 *
 * v0.1.0-module1.21: 参考 perfect-viewer `FileBrowserViewModel.computeMarks`
 * 的三态离散模型。
 *
 * v0.1.0-module3.0: 数据源从 history 改为 library（library 表存所有 books，
 * 包括 temp-imported，isFavorite=0 的 books 也参与 readStatus 计算）。
 *   - useLibraryStore.items (library 表) — 含所有 create_book 的书（含 temp）
 *   - listProgressFinished() (progress.finished 列) — {book_id: bool}
 *
 * 派生规则:
 *   - library 命中 → READING（默认）或 FINISHED（progress.finished=true）
 *   - library 未命中 → NONE（不显示）
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listProgressFinished, type BookItem } from '@/lib/tauri';
import { useLibraryStore } from './library';

export type ReadStatus = 'none' | 'reading' | 'finished';
export type ReadStatusMap = Record<string, ReadStatus>;

/**
 * 从 library item 提取 (rootPath, absolutePath) 复合 key.
 */
export function libraryEntryKey(b: BookItem): string {
  const sd = b.sourceDescriptor as unknown;
  if (typeof sd === 'string') {
    try {
      const d = JSON.parse(sd);
      if (d?.type === 'local') return `${d.rootPath}|${b.absolutePath}`;
      return `${d?.type ?? 'unknown'}:${b.absolutePath}`;
    } catch {
      return `${sd}|${b.absolutePath}`;
    }
  }
  if (sd && typeof sd === 'object' && 'type' in sd) {
    const d = sd as { type: string; rootPath?: string };
    if (d.type === 'local' && d.rootPath) return `${d.rootPath}|${b.absolutePath}`;
    return `${d.type}:${b.absolutePath}`;
  }
  return `unknown:${b.absolutePath}`;
}

export const useReadStatusStore = defineStore('readStatus', () => {
  /** key = libraryEntryKey(b) → ReadStatus */
  const marks = ref<ReadStatusMap>({});

  async function refresh(): Promise<void> {
    const library = useLibraryStore();
    if (library.items.length === 0) {
      await library.refresh();
    }
    const finishedMap = await listProgressFinished();

    const m: ReadStatusMap = {};
    for (const b of library.items) {
      const key = libraryEntryKey(b);
      const realBid = b.id.toString();
      const isFinished = finishedMap[realBid] === true;
      m[key] = isFinished ? 'finished' : 'reading';
    }
    marks.value = m;
  }

  function clear(): void {
    marks.value = {};
  }

  return { marks, refresh, clear };
});