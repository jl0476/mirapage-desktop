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
import { toRootRelativePath } from '@/composables/useMasonryLayout';
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

  /**
   * 重建 marks。`bookIds` 可选——传入则只查这批（当前目录收敛，spec §7）；
   * 省略则从 history.items 派生（仍比全表 progress 收敛：progress 可能有不在 history 的书）。
   *
   * v0.1.0-database-retention-and-cleanup 审查修复 #6：不再无条件全表查 progress。
   */
  async function refresh(bookIds?: number[]): Promise<void> {
    const history = useHistoryStore();
    if (history.items.length === 0) {
      await history.refresh();
    }
    const ids =
      bookIds ??
      Array.from(
        new Set(
          history.items
            .map((h) => h.bookId)
            .filter((b): b is number => b != null),
        ),
      );
    const finishedMap = ids.length === 0 ? {} : await listProgressFinished(ids);

    const m: ReadStatusMap = {};
    // 2026-08-14 hotfix: 同 key 重复 history 行（descriptor 双序列化格式遗留）取
    // lastVisitedAt 最新的行 — 旧实现按迭代顺序后者覆盖，旧行的过期状态会盖掉新行。
    // 语义与「无重复（正确 upsert）」世界一致：最新行即 upsert 后的唯一行。
    const seenAt = new Map<string, number>();
    for (const h of history.items) {
      // v0.1.0-module3.0.1: 没 book_id 的 history 行（旧 migration 005 前或 bookId 未传）跳过
      if (h.bookId == null) continue;
      const bid = h.bookId.toString();
      const key = historyEntryKey(h);
      const ts = h.lastVisitedAt ?? 0;
      if (seenAt.has(key) && ts <= (seenAt.get(key) ?? 0)) continue;
      seenAt.set(key, ts);
      // history 命中 + progress 表里有 row 才 mark（最新行无 progress → 无 mark，不回退旧行）
      if (bid in finishedMap) {
        m[key] = finishedMap[bid] === true ? 'finished' : 'reading';
      } else {
        delete m[key];
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
   *
   * 2026-08-14 hotfix: marks key 的 relPath 段是「相对根」的（如 raw/vol1），
   * 而 entry.path 相对当前目录（如 vol1）。浏览子目录时传 currentRelPath
   * （= fb.lastFetchedPath）拼前缀匹配；省略 = 根目录语义（现有调用兼容）。
   */
  function isFinished(
    entry: { path: string; isDirectory: boolean; isArchive: boolean },
    currentRelPath = '',
  ): boolean {
    if (!entry.isDirectory && !entry.isArchive) return false;
    return finishedSet.value.has(toRootRelativePath(currentRelPath, entry.path));
  }

  return { marks, finishedSet, refresh, clear, rebuildFinishedSet, isFinished };
});
