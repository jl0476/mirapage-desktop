/**
 * readStatus store — 目录级"阅读中 / 已读完"染色数据源。
 *
 * v0.1.0-module1.21: 参考 perfect-viewer `FileBrowserViewModel.computeMarks`
 * (app/src/main/java/top/racyan/ui/filebrowser/FileBrowserViewModel.kt:759-771)
 * 的三态离散模型。
 *
 * 数据源:
 *   - useHistoryStore.items (browse_history 表) — bookId 是 library.create_book 主键
 *   - listProgressFinished() (progress.finished 列) — {book_id: bool}
 *
 * 派生规则 (与 Perfect-Viewer 一致):
 *   - history 命中 → READING (默认) 或 FINISHED (progress.finished=true)
 *   - history 未命中 → NONE (不显示)
 *
 * 当前实现简化:
 *   - 只支持 local 源 (fileBrowser store 也只支持 local)
 *   - marks key = `${rootPath}|${relPath}` (descriptor+path 拼接)
 *   - FileBrowser.vue 用 entry.path 在 marks 里查
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listProgressFinished, type HistoryItem } from '@/lib/tauri';
import { useHistoryStore } from './history';

export type ReadStatus = 'none' | 'reading' | 'finished';
export type ReadStatusMap = Record<string, ReadStatus>;

/**
 * 从 history item 提取 (rootPath, relPath) 复合 key.
 * 当前 fileBrowser 只支持 local 源, sourceDescriptor 在 Rust 端是 JSON 字符串,
 * 但 Tauri IPC deserialize 时可能保留为 string 或解析为对象. 两种情况都兼容:
 */
export function historyEntryKey(h: HistoryItem): string {
  const sd = h.sourceDescriptor as unknown;
  const tryLocal = (rootPath: string) => `${rootPath}|${h.bookId}`;
  if (typeof sd === 'string') {
    try {
      const d = JSON.parse(sd);
      if (d?.type === 'local') return tryLocal(d.rootPath);
      return `${d?.type ?? 'unknown'}:${h.bookId}`;
    } catch {
      return tryLocal(sd);
    }
  }
  if (sd && typeof sd === 'object' && 'type' in sd) {
    const d = sd as { type: string; rootPath?: string };
    if (d.type === 'local' && d.rootPath) return tryLocal(d.rootPath);
    return `${d.type}:${h.bookId}`;
  }
  return `unknown:${h.bookId}`;
}

export const useReadStatusStore = defineStore('readStatus', () => {
  /** key = historyEntryKey(h) → ReadStatus */
  const marks = ref<ReadStatusMap>({});

  /**
   * 拉 history + progress, 计算 marks。
   * - history 命中即隐含"含过图" (单纯 FB 浏览不写历史)
   * - finished=true → 'finished', 否则 'reading'
   */
  async function refresh(): Promise<void> {
    const history = useHistoryStore();
    if (history.items.length === 0) {
      await history.refresh();
    }
    const finishedMap = await listProgressFinished();

    const m: ReadStatusMap = {};
    for (const h of history.items) {
      const key = historyEntryKey(h);
      const realBid = h.bookId.toString();
      const isFinished = finishedMap[realBid] === true;
      m[key] = isFinished ? 'finished' : 'reading';
    }
    marks.value = m;
  }

  /** 单点重置 (右键菜单 markFinished 后调用) */
  function clear(): void {
    marks.value = {};
  }

  return { marks, refresh, clear };
});