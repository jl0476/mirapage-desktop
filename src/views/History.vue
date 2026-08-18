<script setup lang="ts">
/**
 * History.vue — 阅览记录 (v0.1.0-module3.0, folder-level, Android BrowseHistory 对齐)
 * 列文件夹 + 时间；点击 → 跳回 FileBrowser 对应 root + path；右侧 × 删除
 *
 * v0.1.0-module3.0.X-polish:
 *  - emoji 📁 → lucide folder SVG (dark/light 双主题可控)
 *  - × 字符 → lucide X SVG
 *  - scoped CSS hardcoded hex → Tailwind utility class (对齐 Bookmarks.vue)
 *  - 保留 button.name / button.delete class 选择器 (History.test.ts 依赖)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useHistoryStore } from '@/stores/history';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useSettingsStore } from '@/stores/settings';
import { formatDateTime } from '@/locales/helpers';
import { matchesAnyField } from '@/lib/searchFilter';
import ListSearchInput from '@/components/common/ListSearchInput.vue';
import PaginationBar from '@/components/common/PaginationBar.vue';
import { usePagination } from '@/composables/usePagination';
import type { BrowseHistoryEntry } from '@/lib/tauri';
import { useHistoryExport } from '@/composables/useHistoryExport';

const { t } = useI18n();
const router = useRouter();
const store = useHistoryStore();
const { items } = storeToRefs(store);
const fb = useFileBrowserStore();

// 阅览记录导出 JSON（module3.1.2）：状态机与 Settings maintenance 共享
const { buttonText: exportButtonText, state: exportState, trigger: triggerExport } = useHistoryExport(t);

// 客户端搜索：按显示名/相对路径子串过滤（大小写不敏感）
const searchQuery = ref('');
const filteredItems = computed<BrowseHistoryEntry[]>(() =>
  items.value.filter((e) => matchesAnyField(searchQuery.value, [e.displayName, e.relPath])));

// 翻页模式：不无限滚动；搜索词变化回第 1 页；每页条数全局设置（settings.listPageSize）
const settings = useSettingsStore();
const pagination = usePagination(filteredItems, () => settings.listPageSize);
const { pagedItems, page, pages } = pagination;
watch(searchQuery, () => pagination.reset());

// 翻页后列表回到顶部（滚动容器是本页 main）
const mainRef = ref<HTMLElement | null>(null);
watch(page, () => mainRef.value?.scrollTo({ top: 0 }));

onMounted(() => {
  void store.refresh();
});

async function openEntry(entry: BrowseHistoryEntry) {
  const sd = entry.sourceDescriptor;
  if (sd.type !== 'local') return; // Phase 1 仅支持 Local
  await fb.setRoot(sd.rootPath);
  if (entry.relPath) {
    await fb.navigate(entry.relPath);
  }
  await router.push({ name: 'home' });
}

async function removeEntry(entry: BrowseHistoryEntry) {
  await store.deleteEntry(entry);
}

/** 展示用完整路径：rootPath + relPath，分隔符统一 '\'（Windows 风格，对齐快捷方式页） */
function historyFullPath(entry: BrowseHistoryEntry): string {
  const sd = entry.sourceDescriptor;
  if (sd.type !== 'local') return entry.relPath;
  const root = sd.rootPath.replace(/[\\/]+$/, '');
  return entry.relPath ? `${root}\\${entry.relPath}` : root;
}

const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ICON_FOLDER_OPEN_BIG = 'M6 14l1.5-7.5A2 2 0 0 1 9.45 4.8h5.1a2 2 0 0 1 1.95 1.7L18 14M6 14h12M6 14l-2 5h16l-2-5';
const ICON_X = 'M18 6 6 18M6 6l12 12';
</script>

<template>
  <main ref="mainRef" class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('history.title') }}
      </h2>
      <div class="flex items-center gap-3">
        <button
          data-test="btn-export"
          class="text-xs px-2.5 py-1.5 rounded xp-bd bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50 whitespace-nowrap"
          :disabled="exportState === 'exporting'"
          @click="triggerExport"
        >
          {{ exportButtonText }}
        </button>
        <ListSearchInput v-model="searchQuery" :placeholder="t('history.searchPlaceholder')" />
        <RouterLink
          to="/"
          class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors"
          data-test="back-link"
        >
          ← {{ t('common.back') }}
        </RouterLink>
      </div>
    </header>

    <!-- 列表（快捷方式同款双行制：主显示名 + mono 副时间/路径） -->
    <ul
      v-if="filteredItems.length > 0"
      class="list-none p-0 m-0 flex flex-col gap-2"
      data-test="list"
    >
      <li
        v-for="item in pagedItems"
        :key="`${JSON.stringify(item.sourceDescriptor)}::${item.relPath}`"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
        data-test="row"
      >
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="#6366f1" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true" class="shrink-0"
        >
          <path :d="ICON_FOLDER" />
        </svg>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <button
            class="name bg-transparent border-0 text-left p-0 font-semibold text-sm text-text-primary cursor-pointer truncate hover:text-accent hover:underline transition-colors"
            @click="openEntry(item)"
          >
            {{ item.displayName }}
          </button>
          <span
            class="font-mono text-xs text-text-tertiary truncate"
            :title="historyFullPath(item)"
          >
            {{ historyFullPath(item) }}
          </span>
        </div>
        <span class="font-mono text-xs text-text-secondary whitespace-nowrap shrink-0" data-test="time">
          {{ formatDateTime(item.lastVisitedAt * 1000, 'system') }}
        </span>
        <button
          data-test="btn-delete"
          class="delete flex items-center justify-center w-7 h-7 rounded xp-bd bg-transparent text-text-tertiary hover:text-error hover:border-error transition-colors"
          :aria-label="t('common.delete')"
          @click="removeEntry(item)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_X" />
          </svg>
        </button>
      </li>
    </ul>
    <PaginationBar
      v-model:page="page"
      :pages="pages"
      :total="filteredItems.length"
    />

    <!-- 空状态：搜索无结果 vs 真的没记录（不用 v-else 链——与 ul 间夹了分页栏） -->
    <div
      v-if="filteredItems.length === 0 && searchQuery"
      class="text-text-tertiary text-center text-sm mt-12"
      data-test="search-empty"
    >
      {{ t('common.searchNoResults') }}
    </div>
    <div
      v-if="filteredItems.length === 0 && !searchQuery"
      class="flex flex-col items-center justify-center gap-4 mt-12"
      data-test="empty-state"
    >
      <div
        class="w-16 h-16 rounded-2xl bg-surface-1 xp-bd flex items-center justify-center backdrop-blur-md"
      >
        <svg
          width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="ICON_FOLDER_OPEN_BIG" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">
        {{ t('history.empty') }}
      </p>
      <RouterLink
        to="/"
        class="text-accent no-underline text-sm hover:text-accent-hover hover:underline transition-colors"
        data-test="link-to-filebrowser"
      >
        {{ t('fileBrowser.pickRoot') }} →
      </RouterLink>
    </div>
  </main>
</template>