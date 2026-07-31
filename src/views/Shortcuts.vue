<script setup lang="ts">
/**
 * Shortcuts.vue — 模块 #1
 * 列出所有快捷方式，提供打开（跳 / 并切换到该根）+ 删除
 */
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useFileBrowserStore } from '@/stores/fileBrowser';

const { t } = useI18n();
const router = useRouter();
const shortcuts = useShortcutsStore();
const fb = useFileBrowserStore();

onMounted(async () => {
  await shortcuts.refresh();
});

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function displayLabel(item: { label: string | null; rootPath: string }): string {
  return item.label || basename(item.rootPath);
}

async function onOpen(id: number) {
  const sc = shortcuts.items.find((s) => s.id === id);
  if (!sc) return;
  // 先激活 shortcut, 再设文件浏览器根目录, 最后路由跳转
  shortcuts.setActive(id);
  await fb.setRoot(sc.rootPath);
  await router.push('/');
}

async function onDelete(id: number) {
  if (window.confirm(t('shortcuts.confirmDelete'))) {
    await shortcuts.remove(id);
  }
}
</script>

<template>
  <main class="shortcuts-view">
    <header>
      <h2>{{ t('shortcuts.title') }}</h2>
      <RouterLink to="/" class="back">← {{ t('common.back') }}</RouterLink>
    </header>

    <p
      v-if="shortcuts.items.length === 0"
      data-test="empty-hint"
      class="empty-hint"
    >
      {{ t('shortcuts.empty') }}
    </p>

    <ul v-else data-test="list" class="shortcuts-list">
      <li
        v-for="item in shortcuts.items"
        :key="item.id"
        data-test="row"
      >
        <span class="name">{{ displayLabel(item) }}</span>
        <span class="path">{{ item.rootPath }}</span>
        <button data-test="btn-open" @click="onOpen(item.id)">
          {{ t('shortcuts.open') }}
        </button>
        <button data-test="btn-delete" @click="onDelete(item.id)">
          {{ t('shortcuts.delete') }}
        </button>
      </li>
    </ul>

    <RouterLink
      v-if="shortcuts.items.length === 0"
      to="/"
      data-test="link-to-filebrowser"
      class="add-link"
    >
      {{ t('fileBrowser.pickRoot') }} →
    </RouterLink>
  </main>
</template>

<style scoped>
.shortcuts-view {
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
h2 { margin: 0; font-size: 20px; }
.back {
  color: var(--color-primary, #4a9eff);
  text-decoration: none;
  font-size: 13px;
}
.empty-hint {
  color: #888;
  text-align: center;
  margin-top: 24px;
  font-size: 14px;
}
.shortcuts-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.shortcuts-list li {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
  flex-wrap: wrap;
}
.name {
  font-weight: 600;
  min-width: 160px;
}
.path {
  opacity: 0.7;
  flex: 1;
  font-size: 12px;
  font-family: monospace;
}
button {
  padding: 4px 10px;
  border: 1px solid #555;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
.add-link {
  display: block;
  text-align: center;
  margin-top: 24px;
  color: var(--color-primary, #4a9eff);
  text-decoration: none;
  font-size: 13px;
}
</style>
