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
import { ref, watch } from 'vue';
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

  /**
   * v0.1.0-module3.0.4-virtuallist Task 1.3: finished path 集合 O(1) 查询.
   * isFinished(entry) 改为 finishedSet.has(entry.path) — 替换原 for...in + endsWith O(m).
   * 同步触发点: refresh 末尾 / clear / marks watch (覆盖外部直接赋值).
   */
  const finishedSet = ref<Set<string>>(new Set());

  function rebuildFinishedSet(): void {
    const s = new Set<string>();
    for (const [k, v] of Object.entries(marks.value)) {
      if (v === 'finished') {
        // 取 key 最后一段 `|` 之后作为 path — 与原 endsWith(|${entry.path}) 语义对齐
        // (历史 key 形如 `${rootPath}|${relPath}`, rootPath 含 `|` 也安全)
        const idx = k.lastIndexOf('|');
        s.add(idx >= 0 ? k.slice(idx + 1) : k);
      }
    }
    finishedSet.value = s;
  }

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
    rebuildFinishedSet();
  }

  function clear(): void {
    marks.value = {};
    rebuildFinishedSet();
  }

  // 外部直接赋值 rs.marks = {...} 时, 自动重建
  watch(marks, () => rebuildFinishedSet());

  /**
   * v0.1.0-module3.0.3-hotfix: 判断 entry 在当前 marks 下是否为 'finished'.
   * v0.1.0-module3.0.4-virtuallist Task 1.3: 改走 finishedSet.has O(1) 替换原 endsWith 扫表.
   * 判定与 FileList.markFor 一致 (key 以 `|${entry.path}` 结尾).
   * 供 FileBrowser.displayedEntries 过滤用 — 在 store 内部访问 marks.value,
   * 避免消费侧 ref-unwrap 行为差异 (Pinia setup store return 的 ref 在 computed
   * 内直接读可能拿到 ref 对象而非 unwrap 值).
   */
  function isFinished(entry: { path: string; isDirectory: boolean; isArchive: boolean }): boolean {
    if (!entry.isDirectory && !entry.isArchive) return false;
    return finishedSet.value.has(entry.path);
  }

  return { marks, finishedSet, refresh, clear, rebuildFinishedSet, isFinished };
});
