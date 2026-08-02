/**
 * readStatus store — 目录级"阅读中 / 已读完"染色数据源。
 *
 * v0.1.0-module3.0.1: 数据源从 library 改为 history (Android FileBrowserViewModel.computeMarks
 * 语义)。规则：
 *   - history 不命中 → NONE（不显示）
 *   - history 命中 + progress.finished=true → FINISHED
 *   - history 命中 + progress 有行 → READING
 *
 * 关键不变量：readStatus **不**依赖 library——加入书库 ≠ 阅读中。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listProgressFinished } from '@/lib/tauri';
import { useHistoryStore } from './history';

export type ReadStatus = 'none' | 'reading' | 'finished';
export type ReadStatusMap = Record<string, ReadStatus>;

/**
 * 从 history item 提取 marks key: `${rootPath}|${relPath}`
 * 与 FileList.markFor() 末尾 `|${entry.path}` 匹配
 */
export function historyEntryKey(h: { sourceDescriptor: unknown; relPath: string }): string {
  const sd = h.sourceDescriptor as unknown;
  if (typeof sd === 'string') {
    try {
      const d = JSON.parse(sd);
      return `${d?.rootPath ?? sd}|${h.relPath}`;
    } catch {
      return `${sd}|${h.relPath}`;
    }
  }
  if (sd && typeof sd === 'object' && 'rootPath' in sd) {
    const d = sd as { rootPath?: string };
    return `${d.rootPath ?? ''}|${h.relPath}`;
  }
  return `unknown|${h.relPath}`;
}

export const useReadStatusStore = defineStore('readStatus', () => {
  /** key = historyEntryKey(h) → ReadStatus */
  const marks = ref<ReadStatusMap>({});

  async function refresh(): Promise<void> {
    const history = useHistoryStore();
    if (history.items.length === 0) {
      await history.refresh();
    }
    const finishedMap = await listProgressFinished();

    const m: ReadStatusMap = {};
    for (const h of history.items) {
      // v0.1.0-module3.0.1: 没 book_id 的 history 行（旧 migration 005 前或 bookId 未传）跳过
      if (h.bookId == null) continue;
      const bid = h.bookId.toString();
      // history 命中 + progress 表里有 row 才 mark
      if (bid in finishedMap) {
        m[historyEntryKey(h)] = finishedMap[bid] === true ? 'finished' : 'reading';
      }
    }
    marks.value = m;
  }

  function clear(): void {
    marks.value = {};
  }

  return { marks, refresh, clear };
});