<script setup lang="ts">
/**
 * HistoryView.vue — 阅览记录 (v0.1.0-module3.0, folder-level, Android BrowseHistory 对齐)
 * 列文件夹 + 时间；点击 → 跳回 FileBrowser 对应 root + path；右侧 × 删除
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useHistoryStore } from '@/stores/history';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { formatDate } from '@/locales/helpers';
import type { BrowseHistoryEntry } from '@/lib/tauri';

const { t } = useI18n();
const router = useRouter();
const store = useHistoryStore();
const { items } = storeToRefs(store);
const fb = useFileBrowserStore();

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
</script>

<template>
  <main class="history-view">
    <header class="history-header">
      <h2>{{ t('history.title') }}</h2>
      <RouterLink to="/">← {{ t('common.back') }}</RouterLink>
    </header>

    <p v-if="items.length === 0" class="hint">{{ t('history.empty') }}</p>

    <ul v-else data-test="list" class="history-list">
      <li
        v-for="item in items"
        :key="`${JSON.stringify(item.sourceDescriptor)}::${item.relPath}`"
        data-test="row"
        class="history-row"
      >
        <span class="icon">📁</span>
        <button class="name" @click="openEntry(item)">{{ item.displayName }}</button>
        <span class="time">{{ formatDate(item.lastVisitedAt, 'system') }}</span>
        <button
          class="delete"
          :aria-label="t('common.delete')"
          @click="removeEntry(item)"
        >×</button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.history-view { padding: 24px; height: 100%; overflow-y: auto; }
.history-header {
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
.history-row {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--color-border, #444);
  border-radius: 8px;
}
.icon { font-size: 18px; }
.name {
  flex: 1;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
  padding: 0;
}
.name:hover { text-decoration: underline; }
.time { opacity: 0.7; font-size: 12px; }
.delete {
  background: none;
  border: 1px solid var(--color-border, #444);
  color: var(--color-text-muted, #888);
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}
.delete:hover {
  color: var(--color-error, #f87171);
  border-color: var(--color-error, #f87171);
}
.hint {
  color: var(--color-text-muted, #888);
  text-align: center;
  margin-top: 24px;
}
</style>