<script setup lang="ts">
/**
 * BookmarksView.vue — 书签页（双模式）
 *
 * - 有 query.bookId（阅读器主菜单「打开书签」跳入）：单书视图 + 手动添加表单
 * - 无 query.bookId（侧栏入口）：跨书聚合，全部书签按创建时间倒序，每行带书名；
 *   表单隐藏（无书上下文）；空列表显示「还没有书签」
 *
 * v0.1.0-module3.0-settings: Tailwind utility class + xp-bd token (AGENTS §1.1)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useBookmarksStore } from '@/stores/bookmarks';
import { useSettingsStore } from '@/stores/settings';
import { matchesAnyField } from '@/lib/searchFilter';
import ListSearchInput from '@/components/common/ListSearchInput.vue';
import PaginationBar from '@/components/common/PaginationBar.vue';
import { usePagination } from '@/composables/usePagination';
import type { BookmarkRow } from '@/lib/tauri';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useBookmarksStore();
const { sorted, allItems } = storeToRefs(store);

const bookId = computed(() => Number(route.query.bookId ?? 0));
const isSingleBook = computed(() => bookId.value > 0);
const newLabel = ref('');
const newPage = ref<number>(1);

// 客户端搜索：聚合模式搜书名+标签，单书模式搜标签（大小写不敏感）
const searchQuery = ref('');
const filteredAll = computed<BookmarkRow[]>(() =>
  allItems.value.filter((bm) => matchesAnyField(searchQuery.value, [bm.bookTitle, bm.label])));
const filteredSorted = computed(() =>
  sorted.value.filter((bm) => matchesAnyField(searchQuery.value, [bm.label])));

// 翻页模式：两模式各自分页；搜索词变化回第 1 页；每页条数全局设置（settings.listPageSize）
const settings = useSettingsStore();
const allPagination = usePagination(filteredAll, () => settings.listPageSize);
const singlePagination = usePagination(filteredSorted, () => settings.listPageSize);
watch(searchQuery, () => { allPagination.reset(); singlePagination.reset(); });

// 翻页后列表回到顶部（滚动容器是本页 main）
const mainRef = ref<HTMLElement | null>(null);
watch(
  () => isSingleBook.value ? singlePagination.page.value : allPagination.page.value,
  () => mainRef.value?.scrollTo({ top: 0 }),
);

onMounted(() => {
  if (isSingleBook.value) store.list(bookId.value);
  else void store.listAll();
});

watch(bookId, (id) => {
  if (id > 0) store.list(id);
  else void store.listAll();
});

async function addBookmark() {
  if (!isSingleBook.value) return;
  // 表单是 1-based 页码（min="1"），DB 存 0-based canonical 图片索引
  await store.add(bookId.value, Math.max(1, newPage.value) - 1, newLabel.value || null);
  newLabel.value = '';
  newPage.value = 1;
}

async function remove(id: number) {
  await store.remove(id);
}

function jumpTo(bookId: number, page: number, positionKind: 'image' | 'spread') {
  router.push({ path: `/reader/${bookId}`, query: { bookmarkPage: String(page), bookmarkKind: positionKind } });
}

/** 页码列显示：image kind 1-based，legacy spread 原样（当时语义即 spread 序号） */
function displayPage(page: number, positionKind: 'image' | 'spread'): number {
  return positionKind === 'image' ? page + 1 : page;
}

const ICON_BOOKMARK = 'M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z';
</script>

<template>
  <main ref="mainRef" class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold">{{ t('bookmarks.title') }}</h2>
      <div class="flex items-center gap-3">
        <ListSearchInput v-model="searchQuery" :placeholder="t('bookmarks.searchPlaceholder')" />
        <RouterLink to="/likes" class="text-xs text-text-secondary hover:text-accent">
          ← {{ t('common.back') }}
        </RouterLink>
      </div>
    </header>

    <section v-if="isSingleBook" class="add-form flex gap-3 items-center p-3 xp-bd rounded-lg mb-4" data-test="add-form">
      <label class="flex items-center gap-2 text-sm">
        <span class="text-text-secondary">{{ t('bookmarks.page') }}:</span>
        <input
          v-model.number="newPage"
          type="number"
          min="1"
          class="w-20 bg-surface-inset xp-bd rounded text-sm px-2 py-1 text-text-primary focus:outline-none focus:border-accent"
        />
      </label>
      <label class="flex items-center gap-2 text-sm flex-1">
        <span class="text-text-secondary">{{ t('bookmarks.label') }}:</span>
        <input
          v-model="newLabel"
          type="text"
          class="flex-1 bg-surface-inset xp-bd rounded text-sm px-2 py-1 text-text-primary focus:outline-none focus:border-accent"
        />
      </label>
      <button
        data-test="add"
        class="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        @click="addBookmark"
      >
        {{ t('bookmarks.add') }}
      </button>
    </section>

    <!-- 跨书聚合：全部书签（快捷方式同款双行制：主书名 + 副页码/标签） -->
    <ul v-if="!isSingleBook" data-test="list" class="list-none p-0 m-0 flex flex-col gap-2">
      <li v-if="filteredAll.length === 0" class="text-text-tertiary text-center text-sm mt-6">
        {{ searchQuery ? t('common.searchNoResults') : t('bookmarks.empty') }}
      </li>
      <li
        v-for="bm in allPagination.pagedItems.value"
        :key="bm.id"
        data-test="row"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="#6366f1" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true" class="shrink-0">
          <path :d="ICON_BOOKMARK" />
        </svg>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span class="font-semibold text-sm text-text-primary truncate" :title="bm.bookTitle">
            {{ bm.bookTitle || '—' }}
          </span>
          <span class="font-mono text-xs text-text-tertiary truncate" :title="bm.bookPath">
            {{ bm.bookPath || '—' }}
          </span>
        </div>
        <span class="font-mono text-xs text-text-secondary whitespace-nowrap shrink-0" data-test="meta">
          {{ t('bookmarks.page') }} {{ displayPage(bm.page, bm.positionKind) }}{{ bm.label ? ' · ' + bm.label : '' }}
        </span>
        <button
          data-test="jump"
          class="px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors shrink-0"
          @click="jumpTo(bm.bookId, bm.page, bm.positionKind)"
        >
          {{ t('common.open') }}
        </button>
        <button
          data-test="remove"
          class="px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-error transition-colors shrink-0"
          @click="remove(bm.id)"
        >
          {{ t('common.delete') }}
        </button>
      </li>
    </ul>
    <PaginationBar
      v-if="!isSingleBook"
      v-model:page="allPagination.page.value"
      :pages="allPagination.pages.value"
      :total="filteredAll.length"
    />

    <!-- 单书视图（同款双行制） -->
    <ul v-else data-test="list" class="list-none p-0 m-0 flex flex-col gap-2">
      <li v-if="filteredSorted.length === 0" class="text-text-tertiary text-center text-sm mt-6">
        {{ searchQuery ? t('common.searchNoResults') : t('bookmarks.empty') }}
      </li>
      <li
        v-for="bm in singlePagination.pagedItems.value"
        :key="bm.id"
        data-test="row"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="#6366f1" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true" class="shrink-0">
          <path :d="ICON_BOOKMARK" />
        </svg>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span class="font-semibold text-sm text-text-primary truncate">
            {{ t('bookmarks.page') }} {{ displayPage(bm.page, bm.positionKind) }}
          </span>
          <span class="font-mono text-xs text-text-tertiary truncate">
            {{ bm.label ?? '—' }}
          </span>
        </div>
        <button
          data-test="jump"
          class="px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors shrink-0"
          @click="jumpTo(bm.bookId, bm.page, bm.positionKind)"
        >
          {{ t('common.open') }}
        </button>
        <button
          data-test="remove"
          class="px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-error transition-colors shrink-0"
          @click="remove(bm.id)"
        >
          {{ t('common.delete') }}
        </button>
      </li>
    </ul>
    <PaginationBar
      v-if="isSingleBook"
      v-model:page="singlePagination.page.value"
      :pages="singlePagination.pages.value"
      :total="filteredSorted.length"
    />
  </main>
</template>
