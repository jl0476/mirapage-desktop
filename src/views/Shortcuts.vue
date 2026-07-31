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
  padding: var(--space-6);
  height: 100%;
  overflow-y: auto;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-6);
}
h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
}
.back {
  color: var(--text-secondary);
  text-decoration: none;
  font-size: var(--text-base);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
.back:hover { background: var(--surface-2); color: var(--text-primary); }

.empty-hint {
  color: var(--text-tertiary);
  text-align: center;
  margin-top: var(--space-8);
  font-size: var(--text-md);
}

.shortcuts-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.shortcuts-list li {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-1);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  flex-wrap: wrap;
  transition: border-color var(--dur-fast) var(--ease-out),
              box-shadow var(--dur-fast) var(--ease-out);
}
.shortcuts-list li:hover {
  border-color: var(--accent);
  box-shadow: var(--glow-accent);
}

.name {
  font-weight: var(--weight-semibold);
  min-width: 160px;
  color: var(--text-primary);
  font-size: var(--text-md);
}
.path {
  opacity: 0.6;
  flex: 1;
  min-width: 200px;
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
button {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--text-base);
  transition: background var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
button:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
  color: var(--text-primary);
}
button[data-test="btn-delete"]:hover {
  border-color: var(--error);
  color: var(--error);
}

.add-link {
  display: block;
  text-align: center;
  margin-top: var(--space-6);
  color: var(--accent);
  text-decoration: none;
  font-size: var(--text-base);
  transition: color var(--dur-fast) var(--ease-out);
}
.add-link:hover { color: var(--accent-hover); text-decoration: underline; }
</style>
