<script setup lang="ts">
/**
 * Likes.vue — 喜欢列表 (收藏的书)
 *
 * v0.1.0-module3.0.X-polish:
 *  - scoped CSS hardcoded hex → Tailwind utility class (对齐 Bookmarks.vue)
 *  - 行布局: heart icon (实心) + 标题 + 打开按钮
 */
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';

const { t } = useI18n();
const library = useLibraryStore();
const { items } = storeToRefs(library);
const liked = () => items.value.filter((b) => b.isFavorite);

onMounted(() => {
  void library.refresh();
});

const ICON_HEART_FILLED = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
const ICON_OPEN = 'M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5';
const ICON_HEART_BIG = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('likes.title') }}
      </h2>
      <RouterLink
        to="/library"
        class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors"
        data-test="back-link"
      >
        ← {{ t('common.back') }}
      </RouterLink>
    </header>

    <!-- 列表 -->
    <ul
      v-if="liked().length > 0"
      class="list-none p-0 m-0 flex flex-col gap-2"
      data-test="list"
    >
      <li
        v-for="book in liked()"
        :key="book.id"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
        data-test="row"
      >
        <svg
          width="18" height="18" viewBox="0 0 24 24"
          fill="#f472b6" stroke="#f472b6" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true" class="shrink-0"
        >
          <path :d="ICON_HEART_FILLED" />
        </svg>
        <span class="flex-1 font-semibold text-sm text-text-primary truncate">
          {{ book.title }}
        </span>
        <RouterLink
          :to="{ path: '/reader', query: { bookId: book.id } }"
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
          width="32" height="32" viewBox="0 0 24 24"
          fill="none" stroke="#f472b6" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="ICON_HEART_BIG" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">
        {{ t('likes.empty') }}
      </p>
      <RouterLink
        to="/library"
        class="text-accent no-underline text-sm hover:text-accent-hover hover:underline transition-colors"
        data-test="link-to-filebrowser"
      >
        {{ t('library.title') }} →
      </RouterLink>
    </div>
  </main>
</template>