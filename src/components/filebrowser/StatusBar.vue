<script setup lang="ts">
/**
 * StatusBar.vue — Xplorer 3 段式文件浏览器状态栏
 *
 * v0.1.0-module1.22:
 *  - 左: 总条目数 + 选中条目数 + 选中字节数
 *  - 中: 当前路径 (truncate, title 是 full path)
 *  - 右: 暂留空 (git / free-space 不在模块 #1.22 范围)
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatBytes } from '@/locales/helpers';

interface Props {
  total: number;
  selectedCount: number;
  selectionSizeBytes: number;
  currentPath: string;
  /** v0.1.0-module3.0.3: 父级可覆盖左段文案 (搜索态显示 "找到 N 项") */
  itemsText?: string;
}
const props = defineProps<Props>();

const { t } = useI18n();

const itemsLabel = computed(() =>
  props.itemsText ?? t('fileBrowser.statusBar.items', { count: props.total }),
);
const selectedLabel = computed(() =>
  t('fileBrowser.statusBar.selected', { count: props.selectedCount }),
);
const selectionSizeLabel = computed(() => formatBytes(props.selectionSizeBytes));
</script>

<template>
  <footer
    class="statusbar bg-surface xp-bdt px-3 h-6 flex items-center justify-between gap-2 text-xs text-text-secondary select-none flex-shrink-0"
    data-test="statusbar"
    role="status"
    aria-live="polite"
  >
    <!-- Left: items + selected -->
    <div class="flex items-center gap-3 min-w-0 shrink-0">
      <span data-test="statusbar-items">{{ itemsLabel }}</span>
      <span
        v-if="selectedCount > 0"
        class="text-text-primary"
        data-test="statusbar-selected"
      >
        {{ selectedLabel }}
        <span class="text-text-muted font-mono ml-1">({{ selectionSizeLabel }})</span>
      </span>
    </div>
    <!-- Center: current path -->
    <div
      class="flex-1 truncate px-4 text-center opacity-80 font-mono"
      :title="currentPath"
      data-test="statusbar-path"
    >
      {{ currentPath }}
    </div>
    <!-- Right: 暂留空 (git / free-space 后续模块) -->
    <div class="w-0" />
  </footer>
</template>
