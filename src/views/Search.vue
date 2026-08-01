<script setup lang="ts">
/**
 * Search.vue — 全局搜索视图
 *
 * v0.1.0-module1.22: 简单 search 输入 + fuzzy/substring toggle + flat 结果列表.
 * 复用 useSearchStore (已就绪) + Rust `search` command.
 * 暂不做 4 维度 filter (type/date/size/ext) / recent history / highlight match.
 */
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSearchStore } from '@/stores/search';
import { useSettingsStore } from '@/stores/settings';

const { t } = useI18n();
const search = useSearchStore();
const settings = useSettingsStore();

const query = ref(search.query);

let timer: ReturnType<typeof setTimeout> | null = null;
function onQueryChange() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    search.run(query.value);
  }, 200);
}

watch(query, () => {
  search.setMode(settings.searchMode);
  onQueryChange();
});

function onModeChange() {
  void settings.update('search_mode', search.mode);
  if (query.value) search.run(query.value);
}

const sourceColor = (src: string): string => {
  switch (src) {
    case 'library': return 'text-accent';
    case 'bookmark': return 'text-warning';
    case 'history': return 'text-text-secondary';
    case 'tag': return 'text-success';
    default: return 'text-text-secondary';
  }
};
</script>

<template>
  <main class="flex flex-col h-full p-4 gap-3" data-test="search-view">
    <header class="flex items-center gap-2">
      <input
        v-model="query"
        type="text"
        :placeholder="t('search.placeholder')"
        class="flex-1 px-3 py-2 bg-surface-1 border border-white/10 rounded text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] outline-none transition-all"
        data-test="search-input"
        @keydown.enter="search.run(query)"
      />
      <select
        v-model="search.mode"
        class="px-2 py-2 text-xs rounded border border-white/10 bg-surface-1 text-text-secondary hover:bg-surface-light cursor-pointer"
        data-test="search-mode"
        @change="onModeChange"
      >
        <option value="fuzzy">{{ t('search.modeFuzzy') }}</option>
        <option value="substring">{{ t('search.modeSubstring') }}</option>
      </select>
    </header>

    <p v-if="search.loading" class="text-text-tertiary text-xs">{{ t('common.loading') }}</p>
    <p v-else-if="query && search.hits.length === 0" class="text-text-tertiary text-xs" data-test="search-no-results">
      {{ t('search.noResults') }}
    </p>
    <p v-else-if="search.hits.length > 0" class="text-text-tertiary text-xs" data-test="search-results-count">
      {{ t('search.resultsCount', { count: search.hits.length }) }}
    </p>
    <ul
      v-if="search.hits.length > 0"
      class="flex-1 overflow-y-auto list-none m-0 p-0 flex flex-col gap-0.5"
      data-test="search-results"
    >
      <li
        v-for="hit in search.hits"
        :key="`${hit.source}-${hit.bookId}`"
        class="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-light cursor-pointer"
        data-test="search-hit"
        :data-source="hit.source"
      >
        <span
          class="text-[10px] uppercase font-semibold px-1.5 py-0.5 bg-surface-1 rounded shrink-0"
          :class="sourceColor(hit.source)"
        >
          {{ hit.source }}
        </span>
        <span class="text-sm text-text-primary truncate flex-1">{{ hit.title }}</span>
      </li>
    </ul>
  </main>
</template>
