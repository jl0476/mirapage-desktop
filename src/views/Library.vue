<script setup lang="ts">
/**
 * Library.vue — 书库视图
 *  - 仅显示 is_favorite=1 的手动加入书 (v0.1.0-module3.0, Android LibraryEntity 对齐)
 *  - 全部按 lastReadAt DESC 排
 *  - ★ 切换 favorite 状态 (lucide star outline/filled SVG)
 *
 * v0.1.0-module3.0.X-polish:
 *  - 移除 dead input[type=search] (搜索已迁移到 FileBrowser 工具栏)
 *  - 移除 scoped CSS hardcoded hex, 改 Tailwind utility class (对齐 Bookmarks.vue)
 *  - emoji ★ 改 lucide star SVG (dark/light 双主题可控)
 */
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';

const { t } = useI18n();
const library = useLibraryStore();

onMounted(() => {
  void library.refresh();
});

async function toggleFav(id: number) {
  await library.toggleFavorite(id);
}

const ICON_STAR_FILLED = 'M12 2l2.39 7.36H22l-6.18 4.49L18.21 22 12 17.27 5.79 4.73 2.39-8.15 4 9.36h7.61Z';
const ICON_STAR_OUTLINE = 'M12 17.27 5.79 4.73 2.39-8.15 4 9.36h7.61Z M12 2l2.39 7.36';
const ICON_OPEN = 'M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5';
const ICON_BOOK = 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5a2.5 2.5 0 0 1 2.5-2.5H20';
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('library.title') }}
      </h2>
      <RouterLink
        to="/"
        class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors"
        data-test="back-link"
      >
        ← {{ t('common.back') }}
      </RouterLink>
    </header>

    <!-- 列表 -->
    <ul
      v-if="library.items.length > 0"
      class="list-none p-0 m-0 flex flex-col gap-2"
      data-test="list"
    >
      <li
        v-for="book in library.items"
        :key="book.id"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
        data-test="row"
      >
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="#6366f1" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true" class="shrink-0"
        >
          <path :d="ICON_BOOK" />
        </svg>
        <span class="flex-1 font-semibold text-sm text-text-primary truncate">
          {{ book.title }}
        </span>
        <button
          data-test="btn-fav"
          class="p-1.5 rounded hover:bg-surface-2 transition-colors"
          :aria-label="book.isFavorite ? t('library.unfavorite') : t('library.favorite')"
          @click="toggleFav(book.id)"
        >
          <svg
            width="16" height="16" viewBox="0 0 24 24"
            :fill="book.isFavorite ? '#fbbf24' : 'none'"
            :stroke="book.isFavorite ? '#fbbf24' : 'currentColor'"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="book.isFavorite ? ICON_STAR_FILLED : ICON_STAR_OUTLINE" />
          </svg>
        </button>
        <RouterLink
          :to="{ name: 'reader', params: { bookId: book.id } }"
          data-test="btn-open"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary no-underline hover:bg-surface-2 hover:text-text-primary transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_OPEN" />
          </svg>
          {{ t('common.open') }}
        </RouterLink>
      </li>
    </ul>

    <!-- 空状态 -->
    <div
      v-else
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
          <path :d="ICON_BOOK" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">
        {{ t('library.empty') }}
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