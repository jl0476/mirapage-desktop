<script setup lang="ts">
/**
 * BookmarksView.vue — 单本书的书签列表 + 添加书签
 *
 * 进入时通过 query.bookId 加载该书的 bookmarks
 * 添加书签 emit 给 reader store(openBook 后跳页并 add)
 *
 * v0.1.0-module3.0-settings: 改用 Tailwind utility class 替代硬编码 hex CSS,
 * 适配 light/dark 双主题 (CLAUDE.md §1.1)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useBookmarksStore } from '@/stores/bookmarks';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useBookmarksStore();
const { sorted } = storeToRefs(store);

const bookId = computed(() => Number(route.query.bookId ?? 0));
const newLabel = ref('');
const newPage = ref<number>(1);

onMounted(() => {
  if (bookId.value > 0) {
    store.list(bookId.value);
  }
});

watch(bookId, (id) => {
  if (id > 0) store.list(id);
});

async function addBookmark() {
  if (bookId.value <= 0) return;
  await store.add(bookId.value, newPage.value, newLabel.value || null);
  newLabel.value = '';
  newPage.value = 1;
}

async function remove(id: number) {
  await store.remove(id);
}

function jumpTo(bookId: number, page: number) {
  router.push({ path: '/reader', query: { bookId, page } });
}
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold">{{ t('bookmarks.title') }}</h2>
      <RouterLink to="/library" class="text-xs text-text-secondary hover:text-accent">
        ← {{ t('common.back') }}
      </RouterLink>
    </header>

    <section class="add-form flex gap-3 items-center p-3 xp-bd rounded-lg mb-4" data-test="add-form">
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
        :disabled="bookId === 0"
        @click="addBookmark"
      >
        {{ t('bookmarks.add') }}
      </button>
    </section>

    <p v-if="bookId === 0" class="text-text-tertiary text-center text-sm mt-6">
      {{ t('bookmarks.openBookFirst') }}
    </p>

    <ul v-else data-test="list" class="list-none p-0 m-0 flex flex-col gap-2">
      <li
        v-for="bm in sorted"
        :key="bm.id"
        data-test="row"
        class="flex gap-4 items-center p-3 xp-bd rounded-lg bg-surface-1"
      >
        <span class="font-semibold min-w-[80px] text-sm">
          {{ t('bookmarks.page') }} {{ bm.page }}
        </span>
        <span class="flex-1 text-text-secondary text-sm">
          {{ bm.label ?? '—' }}
        </span>
        <button
          data-test="jump"
          class="px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
          @click="jumpTo(bm.bookId, bm.page)"
        >
          {{ t('common.open') }}
        </button>
        <button
          data-test="remove"
          class="px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-error transition-colors"
          @click="remove(bm.id)"
        >
          {{ t('common.delete') }}
        </button>
      </li>
    </ul>
  </main>
</template>