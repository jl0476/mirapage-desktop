<script setup lang="ts">
/**
 * LikesView.vue — 喜欢列表(收藏的书)
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
  library.refresh();
});
</script>

<template>
  <main class="likes-view">
    <header>
      <h2>{{ t('likes.title') }}</h2>
      <RouterLink to="/library">← {{ t('common.back') }}</RouterLink>
    </header>

    <p v-if="liked().length === 0" class="hint">
      {{ t('likes.empty') }}
    </p>

    <ul v-else data-test="list" class="likes-list">
      <li v-for="book in liked()" :key="book.id" data-test="row">
        <span class="title">{{ book.title }}</span>
        <RouterLink :to="{ path: '/reader', query: { bookId: book.id } }">
          {{ t('common.open') }}
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.likes-view { padding: 24px; height: 100%; overflow-y: auto; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
h2 { margin: 0; }
.likes-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.likes-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
}
.likes-list .title { font-weight: 600; }
.hint { color: #888; text-align: center; margin-top: 24px; }
</style>
