/**
 * History Pinia store
 * 与 Rust commands::history 对接(DESIGn §5 Phase 4):
 *   - list_history() → HistoryItem[]（按 lastReadAt DESC）
 *   - record_history(source, book_id, last_page)
 *
 * 进入 reader 时调用 record_history 写入,history 视图展示按时间倒序。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { listHistory, recordHistory, type HistoryItem } from '@/lib/tauri';

export const useHistoryStore = defineStore('history', () => {
  const items = ref<HistoryItem[]>([]);

  const sorted = computed<HistoryItem[]>(() =>
    [...items.value].sort((a, b) => b.lastReadAt - a.lastReadAt),
  );

  async function refresh(): Promise<void> {
    items.value = await listHistory();
  }

  async function record(
    bookId: number,
    lastPage: number,
    sourceDescriptor: HistoryItem['sourceDescriptor'],
  ): Promise<void> {
    await recordHistory(sourceDescriptor, bookId, lastPage);
    await refresh();
  }

  function lastPageOf(bookId: number): number | undefined {
    return items.value.find((it) => it.bookId === bookId)?.lastPage;
  }

  return { items, sorted, refresh, record, lastPageOf };
});