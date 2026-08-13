<script setup lang="ts">
/**
 * Likes.vue — 喜欢列表 (v0.1.0-module3.0.7: Library→Likes 合并后重写)
 *
 * 数据源:useLibraryStore.favorites(= items.filter(b => b.isFavorite))
 * 行内 ❤️ toggle 调 library.toggleFavorite,取消后行消失(符合"取消喜欢 = 从列表移除")
 * 打开 reader 用 name:'reader' + params(不用 query — 路由契约 /reader/:bookId)
 *
 * 跟旧版差异:
 * - 旧 Likes.vue filter library.items(bug:不读 like 表)
 * - 新 Likes.vue 直接用 library.favorites computed(语义明确)
 * - v0.1.0-module3.0.10: ❤️ 图标 toggle → 「取消喜欢」文本按钮；新增「浏览」跳瀑布流
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import type { BookItem } from '@/lib/tauri';

const { t } = useI18n();
const library = useLibraryStore();
const { favorites } = storeToRefs(library);

const router = useRouter();
const fb = useFileBrowserStore();

// v0.1.0-module3.0.10: 「浏览」— 跳文件浏览器该书所在目录 + 瀑布流视图。
// 只写一次性意图（requestOpenLocation 内部清 savedNavigationContext + shortcut
// activeId），实际 setRoot/navigate/setViewMode 由 FileBrowser.onMounted 单点执行。
function openInBrowser(book: BookItem): void {
  const sd = book.sourceDescriptor;
  if (sd.type !== 'local') return; // 防御：非 Local 无跳转（Phase 1，当前库中不可达）
  fb.requestOpenLocation(sd.rootPath, book.absolutePath);
  void router.push('/');
}

onMounted(() => {
  void library.refresh();
});

async function toggleFav(id: number) {
  await library.toggleFavorite(id);
}

const ICON_HEART_FILLED = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
const ICON_OPEN = 'M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5';
const ICON_GRID = 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z';
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('likes.title') }}
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
      v-if="favorites.length > 0"
      class="list-none p-0 m-0 flex flex-col gap-2"
      data-test="list"
    >
      <li
        v-for="book in favorites"
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
        <button
          data-test="btn-unlike"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
          @click="toggleFav(book.id)"
        >{{ t('likes.toggleOff') }}</button>
        <button
          v-if="book.sourceDescriptor.type === 'local'"
          data-test="btn-browse"
          :title="t('likes.browseTitle')"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
          @click="openInBrowser(book)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_GRID" />
          </svg>
          {{ t('likes.browse') }}
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
          stroke="#f472b6" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="ICON_HEART_FILLED" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">
        {{ t('likes.empty') }}
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
