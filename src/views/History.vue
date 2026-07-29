<script setup lang="ts">
/**
 * HistoryView.vue — 阅览记录(按 lastReadAt DESC)
 */
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useHistoryStore } from '@/stores/history';
import { formatDate } from '@/locales/helpers';

const { t } = useI18n();
const store = useHistoryStore();
const { sorted } = storeToRefs(store);

onMounted(() => {
  store.refresh();
});
</script>

<template>
  <main class="history-view">
    <header>
      <h2>{{ t('history.title') }}</h2>
      <RouterLink to="/library">← {{ t('common.back') }}</RouterLink>
    </header>

    <p v-if="sorted.length === 0" class="hint">
      {{ t('history.empty') }}
    </p>

    <ul v-else data-test="list" class="history-list">
      <li v-for="item in sorted" :key="item.bookId" data-test="row">
        <span class="page">{{ t('reader.pageIndicator', { current: item.lastPage + 1, total: '?' }) }}</span>
        <span class="time">{{ formatDate(item.lastReadAt, 'system') }}</span>
        <RouterLink :to="{ path: '/reader', query: { bookId: item.bookId, page: item.lastPage } }">
          {{ t('common.open') }}
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.history-view { padding: 24px; height: 100%; overflow-y: auto; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
h2 { margin: 0; }
.history-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.history-list li {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
}
.history-list .page { font-weight: 600; min-width: 80px; }
.history-list .time { opacity: 0.7; flex: 1; }
.hint { color: #888; text-align: center; margin-top: 24px; }
</style>
