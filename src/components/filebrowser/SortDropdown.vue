<script setup lang="ts">
/**
 * SortDropdown.vue — Xplorer OperationBar 风格的排序下拉
 *
 * v0.1.0-module1.22: 替换 FileBrowser 现有 tb-select 原生 <select>.
 *  - trigger: text-xs text-text-muted hover:bg-surface-light + ChevronDown 12px
 *  - popover: absolute left-0 top-full z-50 mt-1 bg-surface-4 backdrop-blur-xl shadow-xl
 *  - 当前项右侧 ArrowUp/ArrowDown 11px
 *  - click-outside ref + document mousedown listener
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore } from '@/stores/fileBrowser';

const { t } = useI18n();
const fb = useFileBrowserStore();
const open = ref(false);
const dropdownRef = ref<HTMLDivElement | null>(null);

interface Option {
  field: 'name' | 'modifiedAt' | 'size';
  labelKey: string;
}
const options: Option[] = [
  { field: 'name', labelKey: 'fileBrowser.sortField.name' },
  { field: 'modifiedAt', labelKey: 'fileBrowser.sortField.date' },
  { field: 'size', labelKey: 'fileBrowser.sortField.size' },
];

const currentLabel = () => {
  const opt = options.find((o) => o.field === fb.sortField);
  return opt ? t(opt.labelKey) : '';
};

function onSelect(field: 'name' | 'modifiedAt' | 'size') {
  fb.setSortField(field);
  open.value = false;
}

function onMouseDown(e: MouseEvent) {
  if (!dropdownRef.value?.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener('mousedown', onMouseDown));
onUnmounted(() => document.removeEventListener('mousedown', onMouseDown));

// lucide icons (inline SVG path)
const ICON_CHEVRON_DOWN = 'M6 9l6 6 6-6';
const ICON_ARROW_UP = 'M5 12l7-7 7 7M12 19V5';
const ICON_ARROW_DOWN = 'M5 12l7 7 7-7M12 5v14';
</script>

<template>
  <div ref="dropdownRef" class="relative">
    <button
      type="button"
      class="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-light hover:text-text-primary transition-colors"
      data-test="btn-sort"
      :aria-label="t('fileBrowser.sortBy')"
      @click="open = !open"
    >
      <span class="whitespace-nowrap">{{ currentLabel() }}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" class="opacity-60" aria-hidden="true">
        <path :d="ICON_CHEVRON_DOWN" />
      </svg>
    </button>
    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1 min-w-[170px] bg-surface-4 border border-white/10 rounded-lg py-1 shadow-xl backdrop-blur-xl"
      role="menu"
      data-test="sort-dropdown"
    >
      <button
        v-for="opt in options"
        :key="opt.field"
        type="button"
        class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light transition-colors"
        :class="opt.field === fb.sortField ? 'text-accent' : ''"
        role="menuitem"
        :data-test="`sort-opt-${opt.field}`"
        @click="onSelect(opt.field)"
      >
        <span>{{ t(opt.labelKey) }}</span>
        <svg
          v-if="opt.field === fb.sortField"
          width="11" height="11" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="fb.sortAscending ? ICON_ARROW_UP : ICON_ARROW_DOWN" />
        </svg>
      </button>
    </div>
  </div>
</template>
