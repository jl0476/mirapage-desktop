<script setup lang="ts">
/**
 * ViewModeDropdown.vue — list / grid / details 切换按钮组
 *
 * v0.1.0-module1.22: 比 SortDropdown 简单 — 不用 chevron,
 * 直接 2 个按钮横向 (类似 Xplorer OperationBar ViewMode 段).
 *
 * v0.1.0-module1.23: 加 details (Windows 资源管理器多列布局) 按钮.
 */
import { useFileBrowserStore } from '@/stores/fileBrowser';

const fb = useFileBrowserStore();

// lucide icons (inline SVG path)
const ICON_LIST = 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01';
const ICON_GRID = 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z';
const ICON_DETAILS = 'M3 4h18M3 9h18M3 14h18M3 19h18';
</script>

<template>
  <div
    class="flex items-center gap-0.5 xp-bd rounded p-0.5"
    data-test="view-mode-toggle"
    role="radiogroup"
    :aria-label="'view mode'"
  >
    <button
      type="button"
      class="px-1.5 py-0.5 rounded text-xs transition-colors"
      :class="fb.viewMode === 'list' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-surface-light hover:text-text-primary'"
      data-test="view-list"
      role="radio"
      :aria-checked="fb.viewMode === 'list'"
      @click="fb.setViewMode('list')"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_LIST" />
      </svg>
    </button>
    <button
      type="button"
      class="px-1.5 py-0.5 rounded text-xs transition-colors"
      :class="fb.viewMode === 'grid' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-surface-light hover:text-text-primary'"
      data-test="view-grid"
      role="radio"
      :aria-checked="fb.viewMode === 'grid'"
      @click="fb.setViewMode('grid')"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_GRID" />
      </svg>
    </button>
    <button
      type="button"
      class="px-1.5 py-0.5 rounded text-xs transition-colors"
      :class="fb.viewMode === 'details' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-surface-light hover:text-text-primary'"
      data-test="view-details"
      role="radio"
      :aria-checked="fb.viewMode === 'details'"
      @click="fb.setViewMode('details')"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_DETAILS" />
      </svg>
    </button>
  </div>
</template>
