<script setup lang="ts">
/**
 * BookmarksView.vue — 单本书的书签列表 + 添加书签
 *
 * 进入时通过 query.bookId 加载该书的 bookmarks
 * 添加书签 emit 给 reader store(openBook 后跳页并 add)
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
  <main class="bookmarks-view">
    <header>
      <h2>{{ t('bookmarks.title') }}</h2>
      <RouterLink to="/library">← {{ t('common.back') }}</RouterLink>
    </header>

    <section class="add-form" data-test="add-form">
      <label>
        {{ t('bookmarks.page') }}:
        <input v-model.number="newPage" type="number" min="1" />
      </label>
      <label>
        {{ t('bookmarks.label') }}:
        <input v-model="newLabel" type="text" />
      </label>
      <button data-test="add" @click="addBookmark">{{ t('bookmarks.add') }}</button>
    </section>

    <p v-if="bookId === 0" class="hint">
      {{ t('bookmarks.openBookFirst') }}
    </p>

    <ul v-else data-test="list" class="bookmarks-list">
      <li v-for="bm in sorted" :key="bm.id" data-test="row">
        <span class="page">{{ t('bookmarks.page') }} {{ bm.page }}</span>
        <span class="label">{{ bm.label ?? '—' }}</span>
        <button data-test="jump" @click="jumpTo(bm.bookId, bm.page)">
          {{ t('common.open') }}
        </button>
        <button data-test="remove" @click="remove(bm.id)">
          {{ t('common.delete') }}
        </button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.bookmarks-view {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
h2 { margin: 0; }
.add-form {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
  margin-bottom: 16px;
}
.add-form input {
  padding: 4px 8px;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 4px;
  color: inherit;
}
.bookmarks-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bookmarks-list li {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
}
.bookmarks-list .page {
  font-weight: 600;
  min-width: 80px;
}
.bookmarks-list .label {
  flex: 1;
  opacity: 0.85;
}
button {
  padding: 4px 10px;
  border: 1px solid #555;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button:hover {
  background: rgba(255, 255, 255, 0.08);
}
.hint {
  text-align: center;
  color: #888;
  margin-top: 24px;
}
</style>
