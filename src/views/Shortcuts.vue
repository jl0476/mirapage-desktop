<script setup lang="ts">
/**
 * Shortcuts.vue — 快捷方式管理视图
 *
 * v0.1.0-module3.0.X-shortcuts-polish:
 *  - 改用 Tailwind utility class (对齐 Bookmarks.vue 风格)
 *  - 删除确认改 in-app dialog (废弃 window.confirm)
 *  - empty state 加 accent icon 容器 (对齐 §1.8)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useSettingsStore } from '@/stores/settings';
import {
  decodeLocalDescriptor,
  shortcutFullPath,
  shortcutDisplayLabel,
} from '@/lib/shortcutHelpers';
import { matchesAnyField } from '@/lib/searchFilter';
import ListSearchInput from '@/components/common/ListSearchInput.vue';
import PaginationBar from '@/components/common/PaginationBar.vue';
import { usePagination } from '@/composables/usePagination';

const { t } = useI18n();
const router = useRouter();
const shortcuts = useShortcutsStore();
const { items } = storeToRefs(shortcuts);

// 客户端搜索：按别名/完整路径子串过滤（大小写不敏感）
const searchQuery = ref('');
const filteredItems = computed(() =>
  items.value.filter((s) => matchesAnyField(searchQuery.value, [shortcutDisplayLabel(s), shortcutFullPath(s)])));

// 翻页模式：不无限滚动；搜索词变化回第 1 页；每页条数全局设置（settings.listPageSize）
const settings = useSettingsStore();
const pagination = usePagination(filteredItems, () => settings.listPageSize);
const { pagedItems, page, pages } = pagination;
watch(searchQuery, () => pagination.reset());

// 翻页后列表回到顶部（滚动容器是本页 main）
const mainRef = ref<HTMLElement | null>(null);
watch(page, () => mainRef.value?.scrollTo({ top: 0 }));

onMounted(async () => {
  await shortcuts.refresh();
});

async function onOpen(id: number) {
  const sc = shortcuts.items.find((s) => s.id === id);
  if (!sc) return;
  const d = decodeLocalDescriptor(sc);
  if (!d) return; // 非 Local 暂不支持
  // 路径身份修复 (2026-08-12, spec §6.4): 本视图只 setActive + 跳首页;
  // 实际 setRoot + navigate 由 FileBrowser.vue 的 openShortcut 统一执行（唯一执行点）。
  // 收敛后避免两处重复 setRoot+navigate 导致的状态竞争。
  shortcuts.setActive(id);
  await router.push('/');
}

// 删除确认 dialog state
const pendingDelete = ref<{ id: number; label: string } | null>(null);
function onDeleteAsk(id: number) {
  const sc = shortcuts.items.find((s) => s.id === id);
  if (!sc) return;
  pendingDelete.value = { id, label: shortcutDisplayLabel(sc) };
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
  <main ref="mainRef" class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('shortcuts.title') }}
      </h2>
      <div class="flex items-center gap-3">
        <ListSearchInput v-model="searchQuery" :placeholder="t('shortcuts.searchPlaceholder')" />
        <RouterLink
          to="/"
          class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors"
          data-test="back-link"
        >
          ← {{ t('common.back') }}
        </RouterLink>
      </div>
    </header>

    <!-- 空状态：搜索无结果 vs 真的没快捷方式 -->
    <div
      v-if="items.length > 0 && filteredItems.length === 0"
      class="text-text-tertiary text-center text-sm mt-12"
      data-test="search-empty"
    >
      {{ t('common.searchNoResults') }}
    </div>
    <div
      v-else-if="shortcuts.items.length === 0"
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
        v-for="item in pagedItems"
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
            {{ shortcutDisplayLabel(item) }}
          </span>
          <span class="font-mono text-xs text-text-tertiary truncate" :title="shortcutFullPath(item)">
            {{ shortcutFullPath(item) }}
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
    <PaginationBar
      v-model:page="page"
      :pages="pages"
      :total="filteredItems.length"
    />

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