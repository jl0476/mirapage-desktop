<script setup lang="ts">
/**
 * ListSearchInput.vue — 列表页受控搜索输入框（v0.1.0 2026-08-18）
 *
 * 与 FileBrowser SearchInput 同 UI（X 清空 / ESC 清空+失焦），但受控：
 * v-model:modelValue + placeholder prop。Shortcuts/Likes/Bookmarks/History 四页共用。
 * 过滤逻辑在各页 computed（配 lib/searchFilter.matchesAnyField）。
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  placeholder?: string;
}>();

const value = defineModel<string>({ default: '' });

const { t } = useI18n();
const inputRef = ref<HTMLInputElement | null>(null);

function clear() {
  value.value = '';
  inputRef.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    clear();
    inputRef.value?.blur();
  }
}

const ICON_SEARCH = 'M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z';
const ICON_X = 'M18 6L6 18M6 6l12 12';
</script>

<template>
  <div class="relative flex items-center" data-test="list-search-wrap">
    <svg
      class="absolute left-2 pointer-events-none text-text-muted"
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    >
      <path :d="ICON_SEARCH" />
    </svg>
    <input
      ref="inputRef"
      v-model="value"
      type="text"
      :placeholder="props.placeholder ?? t('common.searchPlaceholder')"
      class="w-48 pl-7 pr-6 py-1 text-xs xp-bd bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:text-accent"
      data-test="list-search-input"
      @keydown="onKeydown"
    />
    <button
      v-if="value"
      class="absolute right-1 flex items-center justify-center w-5 h-5 text-text-muted hover:text-text-primary"
      data-test="list-search-clear"
      :title="t('common.cancel')"
      @click="clear"
      type="button"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_X" />
      </svg>
    </button>
  </div>
</template>
