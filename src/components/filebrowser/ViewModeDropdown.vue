<script setup lang="ts">
/**
 * ViewModeDropdown.vue — list / grid / details 切换按钮组
 *
 * v0.1.0-module1.22: 比 SortDropdown 简单 — 不用 chevron,
 * 直接 2 个按钮横向 (类似 Xplorer OperationBar ViewMode 段).
 *
 * v0.1.0-module1.23: 加 details (Windows 资源管理器多列布局) 按钮.
 *
 * v0.1.0-module3.0.5-masonry (阶段 B / B4): list/grid 按钮临时删除 — ViewMode union 收窄后
 * setViewMode('list'/'grid') 类型报错, 本任务让组件编译通过即可. UI 整体删除留 E3.
 * 仅保留 details 按钮 (占位), masonry 按钮留 E3 加.
 */
import { useFileBrowserStore } from '@/stores/fileBrowser';

const fb = useFileBrowserStore();

// lucide icons (inline SVG path) — 仅保留 details, 其他 E3 加回 masonry 按钮时再补
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
