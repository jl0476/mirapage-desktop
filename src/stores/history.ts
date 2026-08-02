/**
 * History Pinia store — v0.1.0-module3.0
 * 与 Rust commands::history 对接（folder-level, Android BrowseHistory 对齐）:
 *   - listHistory() → BrowseHistoryEntry[]  (按 lastVisitedAt DESC)
 *   - recordHistory(source, relPath, displayName)  (FileBrowser 导航成功后调)
 *   - deleteHistory(source, relPath)
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  listHistory,
  recordHistory,
  deleteHistory,
  type BrowseHistoryEntry,
} from '@/lib/tauri';

export const useHistoryStore = defineStore('history', () => {
  const items = ref<BrowseHistoryEntry[]>([]);

  async function refresh(): Promise<void> {
    items.value = await listHistory();
  }

  /** FileBrowser.fetch 成功后调 — 容错，失败不抛 */
  async function record(
    sourceDescriptor: BrowseHistoryEntry['sourceDescriptor'],
    relPath: string,
    displayName: string,
  ): Promise<void> {
    try {
      await recordHistory(sourceDescriptor, relPath, displayName);
    } catch (e) {
      // 容错：历史记录失败不应影响 FileBrowser 列表展示
      console.warn('[history] record failed', e);
    }
  }

  async function deleteEntry(entry: BrowseHistoryEntry): Promise<void> {
    await deleteHistory(entry.sourceDescriptor, entry.relPath);
    await refresh();
  }

  return { items, refresh, record, deleteEntry };
});