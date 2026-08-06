<script setup lang="ts">
/**
 * History.vue — 阅览记录 (v0.1.0-module3.0, folder-level, Android BrowseHistory 对齐)
 * 列文件夹 + 时间；点击 → 跳回 FileBrowser 对应 root + path；右侧 × 删除
 *
 * v0.1.0-module3.0.X-polish:
 *  - emoji 📁 → lucide folder SVG (dark/light 双主题可控)
 *  - × 字符 → lucide X SVG
 *  - scoped CSS hardcoded hex → Tailwind utility class (对齐 Bookmarks.vue)
 *  - 保留 button.name / button.delete class 选择器 (History.test.ts 依赖)
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useHistoryStore } from '@/stores/history';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { formatDateTime } from '@/locales/helpers';
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

const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ICON_FOLDER_OPEN_BIG = 'M6 14l1.5-7.5A2 2 0 0 1 9.45 4.8h5.1a2 2 0 0 1 1.95 1.7L18 14M6 14h12M6 14l-2 5h16l-2-5';
const ICON_X = 'M18 6 6 18M6 6l12 12';
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('history.title') }}
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
      v-if="items.length > 0"
      class="list-none p-0 m-0 flex flex-col gap-2"
      data-test="list"
    >
      <li
        v-for="item in items"
        :key="`${JSON.stringify(item.sourceDescriptor)}::${item.relPath}`"
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
        <button
          class="name flex-1 bg-transparent border-0 text-left p-0 font-semibold text-sm text-text-primary cursor-pointer truncate hover:text-accent hover:underline transition-colors"
          @click="openEntry(item)"
        >
          {{ item.displayName }}
        </button>
        <span class="text-xs text-text-tertiary font-mono whitespace-nowrap" data-test="time">
          {{ formatDateTime(item.lastVisitedAt, 'system') }}
        </span>
        <button
          data-test="btn-delete"
          class="delete flex items-center justify-center w-7 h-7 rounded xp-bd bg-transparent text-text-tertiary hover:text-error hover:border-error transition-colors"
          :aria-label="t('common.delete')"
          @click="removeEntry(item)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_X" />
          </svg>
        </button>
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
          stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="ICON_FOLDER_OPEN_BIG" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">
        {{ t('history.empty') }}
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