<script setup lang="ts">
/**
 * SearchInput.vue — FileBrowser toolbar 常驻搜索输入框.
 *
 * v0.1.0-module3.0.3: 文件浏览器内 Windows 风格搜索.
 * 输入即时 fb.setSearchQuery (150ms 防抖); X 清空; ESC 清空+失焦.
 * 直接读写 fileBrowser store, 无 props (toolbar 常驻, 单实例).
 */
import { ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore } from '@/stores/fileBrowser';

const { t } = useI18n();
const fb = useFileBrowserStore();

const inputRef = ref<HTMLInputElement | null>(null);
const localValue = ref(fb.searchQuery);

// 外部清空 (进目录等) 同步到输入框显示
watch(
  () => fb.searchQuery,
  (v) => {
    if (v !== localValue.value) localValue.value = v;
  },
);

let timerId: ReturnType<typeof setTimeout> | null = null;
function onInput(e: Event) {
  localValue.value = (e.target as HTMLInputElement).value;
  if (timerId) clearTimeout(timerId);
  timerId = setTimeout(() => {
    fb.setSearchQuery(localValue.value);
    timerId = null;
  }, 150);
}

function clear() {
  localValue.value = '';
  fb.setSearchQuery('');
  inputRef.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    clear();
    inputRef.value?.blur();
  }
}

onUnmounted(() => {
  if (timerId) clearTimeout(timerId);
});

const ICON_SEARCH = 'M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z';
const ICON_X = 'M18 6L6 18M6 6l12 12';
</script>

<template>
  <div class="relative flex items-center" data-test="search-input-wrap">
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
      v-model="localValue"
      type="text"
      :placeholder="t('fileBrowser.searchPlaceholder')"
      class="w-48 pl-7 pr-6 py-1 text-xs xp-bd bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:text-accent"
      data-test="search-input"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      v-if="localValue"
      class="absolute right-1 flex items-center justify-center w-5 h-5 text-text-muted hover:text-text-primary"
      data-test="search-clear"
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
