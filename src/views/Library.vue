<script setup lang="ts">
/**
 * LibraryView.vue — 书架视图
 * - 收藏的书(isFavorite=true)优先显示
 * - 全部按 lastReadAt DESC 排
 * - 双击 favorite 切换
 */
import { onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';
import { useSearchStore } from '@/stores/search';

const { t } = useI18n();
const library = useLibraryStore();
const { items } = storeToRefs(library);
const search = useSearchStore();
const { hits, query } = storeToRefs(search);

const showSearch = ref(false);

onMounted(() => {
  library.refresh();
});

async function toggleFav(id: number) {
  await library.toggleFavorite(id);
}
</script>

<template>
  <main class="library-view">
    <header>
      <h2>{{ t('library.title') }}</h2>
      <div class="actions">
        <button data-test="search-toggle" @click="showSearch = !showSearch">
          {{ showSearch ? '×' : t('fileBrowser.search') }}
        </button>
        <RouterLink to="/">← {{ t('common.back') }}</RouterLink>
      </div>
    </header>

    <input
      v-if="showSearch"
      v-model="query"
      data-test="search-input"
      type="search"
      :placeholder="t('fileBrowser.search')"
      @keyup.enter="search.run()"
    />

    <ul v-if="!query || hits.length === 0" data-test="list" class="library-list">
      <li v-for="book in items" :key="book.id" data-test="row">
        <span class="title">{{ book.title }}</span>
        <span class="fav" :class="{ on: book.isFavorite }" @click="toggleFav(book.id)">
          {{ book.isFavorite ? '★' : '☆' }}
        </span>
        <RouterLink :to="{ path: '/reader', query: { bookId: book.id } }">
          {{ t('common.open') }}
        </RouterLink>
      </li>
    </ul>

    <ul v-else data-test="search-results" class="library-list">
      <li v-for="hit in hits" :key="`${hit.source}-${hit.bookId}`">
        <span class="title">{{ hit.title }}</span>
        <span class="source">{{ t('library.source.' + hit.source) }}</span>
        <RouterLink :to="{ path: '/reader', query: { bookId: hit.bookId } }">
          {{ t('common.open') }}
        </RouterLink>
      </li>
    </ul>

    <p v-if="items.length === 0" class="hint">
      {{ t('library.empty') }}
    </p>
  </main>
</template>

<style scoped>
.library-view { padding: 24px; height: 100%; overflow-y: auto; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.actions { display: flex; gap: 12px; align-items: center; }
h2 { margin: 0; }
input[type=search] {
  width: 100%;
  padding: 8px;
  margin-bottom: 16px;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 4px;
  color: inherit;
}
.library-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.library-list li {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
}
.library-list .title { font-weight: 600; flex: 1; }
.library-list .fav {
  cursor: pointer;
  font-size: 18px;
  width: 24px;
  text-align: center;
}
.library-list .fav.on { color: gold; }
button {
  padding: 4px 10px;
  border: 1px solid #555;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.hint { color: #888; text-align: center; margin-top: 24px; }
</style>
