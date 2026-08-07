<script setup lang="ts">
/**
 * Shortcuts.vue — 快捷方式管理视图
 *
 * v0.1.0-module3.0.X-shortcuts-polish:
 *  - 改用 Tailwind utility class (对齐 Bookmarks.vue 风格)
 *  - 删除确认改 in-app dialog (废弃 window.confirm)
 *  - empty state 加 accent icon 容器 (对齐 §1.8)
 */
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import type { ShortcutItem } from '@/lib/tauri';
import type { SourceDescriptor, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

const { t } = useI18n();
const router = useRouter();
const shortcuts = useShortcutsStore();
const fb = useFileBrowserStore();

onMounted(async () => {
  await shortcuts.refresh();
});

/** 解码 shortcut 的 sourceDescriptorJson (失败或非 Local 返回 null) */
function decodeDescriptor(sc: ShortcutItem): SourceDescriptorLocal | null {
  try {
    const d = JSON.parse(sc.sourceDescriptorJson) as SourceDescriptor;
    if (d.type === 'local') return d;
    return null; // Phase 7-8 前 SMB/WebDAV 不可打开
  } catch {
    return null;
  }
}

/** shortcut 完整路径 (rootPath + relPath 拼接) */
function fullPath(sc: ShortcutItem): string {
  const d = decodeDescriptor(sc);
  if (!d) return sc.sourceDescriptorJson;
  return d.rootPath + (sc.relPath ? '/' + sc.relPath : '');
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function displayLabel(sc: ShortcutItem): string {
  return sc.alias || basename(fullPath(sc));
}

async function onOpen(id: number) {
  const sc = shortcuts.items.find((s) => s.id === id);
  if (!sc) return;
  const d = decodeDescriptor(sc);
  if (!d) return; // 非 Local 暂不支持
  shortcuts.setActive(id);
  // v0.1.0-module3.0.5: 两步打开 (复用 History.vue openEntry 模式), 支持子目录 relPath
  await fb.setRoot(d.rootPath);
  if (sc.relPath) {
    await fb.navigate(sc.relPath);
  }
  await router.push('/');
}

// 删除确认 dialog state
const pendingDelete = ref<{ id: number; label: string } | null>(null);
function onDeleteAsk(id: number) {
  const sc = shortcuts.items.find((s) => s.id === id);
  if (!sc) return;
  pendingDelete.value = { id, label: displayLabel(sc) };
}
function onDeleteCancel() {
  pendingDelete.value = null;
}
async function onDeleteConfirm() {
  const p = pendingDelete.value;
  pendingDelete.value = null;
  if (!p) return;
  await shortcuts.remove(p.id);
}

// 内嵌 SVG path (与 ShortcutDropdown / FileList 一致)
const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ICON_OPEN = 'M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5';
const ICON_TRASH = 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6';
const ICON_FOLDER_OPEN_BIG = 'M6 14l1.5-7.5A2 2 0 0 1 9.45 4.8h5.1a2 2 0 0 1 1.95 1.7L18 14M6 14h12M6 14l-2 5h16l-2-5';
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('shortcuts.title') }}
      </h2>
      <RouterLink
        to="/"
        class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors"
        data-test="back-link"
      >
        ← {{ t('common.back') }}
      </RouterLink>
    </header>

    <!-- 空状态 -->
    <div
      v-if="shortcuts.items.length === 0"
      class="flex flex-col items-center justify-center gap-4 mt-12"
      data-test="empty-state"
    >
      <div
        class="w-16 h-16 rounded-2xl bg-surface-1 xp-bd flex items-center justify-center backdrop-blur-md"
      >
        <svg
          width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="ICON_FOLDER_OPEN_BIG" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">
        {{ t('shortcuts.empty') }}
      </p>
      <RouterLink
        to="/"
        class="text-accent no-underline text-sm hover:text-accent-hover hover:underline transition-colors"
        data-test="link-to-filebrowser"
      >
        {{ t('fileBrowser.pickRoot') }} →
      </RouterLink>
    </div>

    <!-- 列表 -->
    <ul
      v-else
      class="list-none p-0 m-0 flex flex-col gap-2"
      data-test="list"
    >
      <li
        v-for="item in shortcuts.items"
        :key="item.id"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
        data-test="row"
      >
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="#6366f1" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true" class="shrink-0"
        >
          <path :d="ICON_FOLDER" />
        </svg>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span class="font-semibold text-sm text-text-primary truncate">
            {{ displayLabel(item) }}
          </span>
          <span class="font-mono text-xs text-text-tertiary truncate" :title="fullPath(item)">
            {{ fullPath(item) }}
          </span>
        </div>
        <button
          data-test="btn-open"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
          @click="onOpen(item.id)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_OPEN" />
          </svg>
          {{ t('shortcuts.open') }}
        </button>
        <button
          data-test="btn-delete"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-error hover:border-error transition-colors"
          @click="onDeleteAsk(item.id)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_TRASH" />
          </svg>
          {{ t('shortcuts.delete') }}
        </button>
      </li>
    </ul>

    <!-- 删除确认 dialog (v0.1.0-module3.0.X: 替代 window.confirm, 适配 dark/light 主题) -->
    <div
      v-if="pendingDelete"
      class="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-[1000]"
      data-test="confirm-dialog"
      @click.self="onDeleteCancel"
    >
      <div
        class="bg-surface-4 xp-bd rounded-lg p-6 flex flex-col gap-4 min-w-[360px] shadow-lg"
      >
        <h3 class="m-0 text-base font-semibold text-text-primary flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="#f87171" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_TRASH" />
          </svg>
          {{ t('shortcuts.confirmDelete') }}
        </h3>
        <p class="m-0 text-sm text-text-secondary">
          {{ pendingDelete.label }}
        </p>
        <div class="flex justify-end gap-2 mt-2">
          <button
            data-test="confirm-cancel"
            class="px-4 py-2 xp-bd bg-transparent text-text-secondary rounded transition-[background,color] duration-100 hover:bg-surface-2 hover:text-text-primary"
            @click="onDeleteCancel"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            data-test="confirm-confirm"
            class="flex items-center gap-1.5 px-4 py-2 border border-error text-error rounded cursor-pointer font-semibold shadow-[0_0_10px_rgba(248,113,113,0.3)] transition-[background,transform] duration-100 hover:bg-error hover:text-white active:translate-y-px"
            @click="onDeleteConfirm"
          >
            {{ t('shortcuts.delete') }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>