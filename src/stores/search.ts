/**
 * Search Pinia store
 * 与 Rust commands::search 对接(DESIGn §5 Phase 4):
 *   - search(query) → SearchHit[]
 *
 * 模糊搜索:Rust 端用 fuse-rs(或前端用 fuse.js 子集)实现。
 * 这层只做 IPC 透传 + 排序去重。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { search as tauriSearch, type SearchHit } from '@/lib/tauri';

export type SearchMode = 'fuzzy' | 'substring';

export const useSearchStore = defineStore('search', () => {
  const query = ref<string>('');
  const hits = ref<SearchHit[]>([]);
  const loading = ref(false);
  const mode = ref<SearchMode>('fuzzy');

  async function run(q: string = query.value): Promise<SearchHit[]> {
    query.value = q;
    if (q.trim().length === 0) {
      hits.value = [];
      return hits.value;
    }
    loading.value = true;
    try {
      hits.value = await tauriSearch(q);
      return hits.value;
    } finally {
      loading.value = false;
    }
  }

  function setMode(m: SearchMode): void {
    mode.value = m;
  }

  function clear(): void {
    query.value = '';
    hits.value = [];
  }

  return { query, hits, loading, mode, run, setMode, clear };
});