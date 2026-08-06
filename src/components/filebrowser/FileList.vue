<script setup lang="ts">
/**
 * FileList.vue — 虚拟容器 (v0.1.0-module3.0.4-virtuallist Task 3.2)
 *
 * 完全重写: 用 useVirtualList composable + VirtualRow 子组件,
 * 把 ul/li v-for 改为 containerRef + contentRef + visibleEntries,
 * 让 14949 entries 时 DOM < 100 行.
 *
 * Props 保持向后兼容: entries / loading / marks / selectedPaths / viewMode
 * 新增 emits: context / name-hover / name-leave / scroll-to-path (Task 3.4 用)
 * 保留旧 emits: select / contextmenu (FileBrowser.vue 仍依赖)
 *
 * 三视图 (list / grid / details) 由 viewMode prop 切换, VirtualRow 内部用
 * CSS :not() 显隐, viewMode 切换不重建 DOM (复用 + 保留 Vue 渲染缓存).
 */
import { computed, nextTick, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useVirtualList } from '@/composables/useVirtualList';
import VirtualRow from './VirtualRow.vue';
import type { MediaEntry, ReadStatusMap } from '@/lib/sourceDescriptor';

interface Props {
  entries: MediaEntry[];
  loading?: boolean;
  marks?: ReadStatusMap;
  selectedPaths?: Set<string>;
  viewMode?: 'list' | 'grid' | 'details';
}
const props = withDefaults(defineProps<Props>(), {
  loading: false,
  marks: () => ({}),
  selectedPaths: () => new Set<string>(),
  viewMode: 'list',
});

const emit = defineEmits<{
  (e: 'open', entry: MediaEntry): void;
  (e: 'select', entry: MediaEntry, event: MouseEvent | KeyboardEvent): void;
  (e: 'contextmenu', entry: MediaEntry, x: number, y: number): void;
  (e: 'context', entry: MediaEntry, event: MouseEvent): void;
  (e: 'name-hover', entry: MediaEntry, event: MouseEvent): void;
  (e: 'name-leave'): void;
  (e: 'scroll-to-path', path: string, opts?: { align?: 'start' | 'center' | 'end' }): void;
}>();

const { t } = useI18n();
const fb = useFileBrowserStore();

/** 三视图行高 (像素, 固定). useVirtualList 暂只支持数字 (Phase 3 后续可扩展) */
const rowHeightByView: Record<'list' | 'grid' | 'details', number> = {
  list: 29,
  details: 29,
  grid: 132,
};
const resolvedRowHeight = computed(() => rowHeightByView[props.viewMode] ?? 29);

const {
  containerRef,
  contentRef,
  visibleRange,
  visibleEntries,
  totalHeight,
  viewportHeight,
  scrollTop,
  scrollToIndex,
  scrollToPath,
} = useVirtualList(computed(() => props.entries), {
  rowHeight: resolvedRowHeight.value,
});

/**
 * happy-dom / 测试环境 clientHeight 始终 0, ResizeObserver 不触发, 导致
 * visibleRange end=0 → 无 row 渲染. 在 mount 后兜底: 若 viewportHeight 为 0,
 * 设默认值 290 (与 brief 测试期望一致); 真机环境 ResizeObserver 回调会立刻覆盖.
 */
onMounted(() => {
  if (viewportHeight.value === 0) {
    const h = containerRef.value?.clientHeight ?? 0;
    viewportHeight.value = h > 0 ? h : 290;
  }
});

/**
 * mark 预算: 父层一次性 O(n) 算 markByPath, 子 row 只接收单值 mark.
 * marks key 形如 `${descriptorId}|${entry.path}`, 用 endsWith 命中.
 * 优先级: reading > finished > none.
 */
const markByPath = computed<Map<string, 'reading' | 'finished' | 'none'>>(() => {
  const m = new Map<string, 'reading' | 'finished' | 'none'>();
  for (const e of props.entries) {
    if (!e.isDirectory && !e.isArchive) {
      m.set(e.path, 'none');
      continue;
    }
    let mark: 'reading' | 'finished' | 'none' = 'none';
    for (const [k, v] of Object.entries(props.marks)) {
      if (k.endsWith(`|${e.path}`)) {
        if (v === 'reading') {
          mark = 'reading';
          break;
        }
        if (v === 'finished') {
          mark = 'finished';
          break;
        }
      }
    }
    m.set(e.path, mark);
  }
  return m;
});
function getMark(entry: MediaEntry): 'reading' | 'finished' | 'none' {
  return markByPath.value.get(entry.path) ?? 'none';
}

function isSelected(entry: MediaEntry): boolean {
  return props.selectedPaths.has(entry.path);
}

/* ─── 行事件转发 ─────────────────────────────────── */
function onRowClick(entry: MediaEntry, event: MouseEvent): void {
  emit('select', entry, event);
}
function onRowDblclick(entry: MediaEntry): void {
  emit('open', entry);
}
function onRowKeydown(entry: MediaEntry, event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('open', entry);
  } else if (event.key === ' ') {
    event.preventDefault();
    emit('select', entry, event);
  }
}
function onRowContextmenu(entry: MediaEntry, event: MouseEvent): void {
  event.preventDefault();
  emit('context', entry, event);
  // 兼容: FileBrowser.vue 旧 handler 仍依赖 (entry, x, y)
  emit('contextmenu', entry, event.clientX, event.clientY);
}
function onNameHover(entry: MediaEntry, event: MouseEvent): void {
  emit('name-hover', entry, event);
}
function onNameLeave(): void {
  emit('name-leave');
}

/* ─── 键盘导航 (Phase 3 基础版: 6 键) ──────────────── */
function onKeydown(event: KeyboardEvent): void {
  const key = event.key;
  const navKeys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
  if (!navKeys.includes(key)) return;
  event.preventDefault();
  const rowCount = props.entries.length;
  if (rowCount === 0) return;
  const vh = viewportHeight.value || 290;
  const rh = resolvedRowHeight.value;
  const focusedEl = containerRef.value?.querySelector('[data-focused="true"]') as HTMLElement | null;
  const focusedIdx = focusedEl
    ? props.entries.findIndex((e) => e.path === focusedEl.dataset.path)
    : -1;
  let target = -1;
  if (key === 'ArrowDown') target = focusedIdx + 1;
  else if (key === 'ArrowUp') target = focusedIdx - 1;
  else if (key === 'PageDown') target = focusedIdx + Math.max(1, Math.floor(vh / rh));
  else if (key === 'PageUp') target = focusedIdx - Math.max(1, Math.floor(vh / rh));
  else if (key === 'Home') target = 0;
  else if (key === 'End') target = rowCount - 1;
  if (target < 0) target = 0;
  if (target >= rowCount) target = rowCount - 1;
  scrollToIndex(target, { align: 'start' });
  nextTick(() => {
    const targetPath = props.entries[target]?.path;
    if (!targetPath || !containerRef.value) return;
    const rows = containerRef.value.querySelectorAll('[role="row"]');
    rows.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const focused = htmlEl.dataset.path === targetPath;
      htmlEl.dataset.focused = focused ? 'true' : 'false';
      htmlEl.tabIndex = focused ? 0 : -1;
    });
  });
}

const containerClass = computed(() => ({
  [`virt-${props.viewMode}`]: true,
  loading: props.loading,
}));

/* ─── details 列头排序箭头 (inline path data) ────── */
const ICON_ARROW_UP = 'M5 12l7-7 7 7';
const ICON_ARROW_DOWN = 'M5 12l7 7 7-7';

/* ─── 暴露 scrollToPath / scrollToIndex 给父级 (Task 3.4 FileBrowser 接入) ─── */
defineExpose({ scrollToPath, scrollToIndex, scrollTop, viewportHeight });
</script>

<template>
  <div
    ref="containerRef"
    class="virt-container"
    :class="containerClass"
    :aria-rowcount="entries.length"
    aria-label="文件列表"
    role="grid"
    tabindex="0"
    @keydown="onKeydown"
  >
    <!-- details 视图列头 (sticky, 始终渲染在 virt-content 上方) -->
    <div
      v-if="viewMode === 'details' && entries.length > 0"
      class="details-header sticky top-0 z-10 bg-surface/80 backdrop-blur-xl xp-bdb px-3 py-1.5 grid items-center gap-2 text-xs text-text-muted select-none"
      style="grid-template-columns: 40px 28px minmax(80px, 1fr) minmax(0, 160px) minmax(0, 120px) minmax(0, 100px) minmax(0, 110px)"
      role="row"
    >
      <span class="text-right text-text-tertiary font-mono" data-test="details-header-index">#</span>
      <span aria-hidden="true" />
      <button
        type="button"
        class="text-left truncate hover:text-text-primary transition-colors"
        data-test="details-sort-name"
        @click="fb.setSortField('name')"
      >
        {{ t('properties.labelName') }}
        <svg
          v-if="fb.sortField === 'name'"
          width="9" height="9" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
          class="inline-block ml-1 -mt-0.5" aria-hidden="true"
        >
          <path :d="fb.sortAscending ? ICON_ARROW_UP : ICON_ARROW_DOWN" />
        </svg>
      </button>
      <button
        type="button"
        class="text-right hover:text-text-primary transition-colors"
        data-test="details-sort-modified"
        @click="fb.setSortField('modifiedAt')"
      >
        {{ t('properties.labelModified') }}
        <svg
          v-if="fb.sortField === 'modifiedAt'"
          width="9" height="9" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
          class="inline-block ml-1 -mt-0.5" aria-hidden="true"
        >
          <path :d="fb.sortAscending ? ICON_ARROW_UP : ICON_ARROW_DOWN" />
        </svg>
      </button>
      <span class="text-center" data-test="details-header-type">{{ t('properties.labelType') }}</span>
      <button
        type="button"
        class="text-right hover:text-text-primary transition-colors"
        data-test="details-sort-size"
        @click="fb.setSortField('size')"
      >
        {{ t('properties.labelSize') }}
        <svg
          v-if="fb.sortField === 'size'"
          width="9" height="9" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
          class="inline-block ml-1 -mt-0.5" aria-hidden="true"
        >
          <path :d="fb.sortAscending ? ICON_ARROW_UP : ICON_ARROW_DOWN" />
        </svg>
      </button>
      <span class="text-right" data-test="details-header-status">
        {{ t('fileBrowser.status.reading') }}/{{ t('fileBrowser.status.finished') }}
      </span>
    </div>

    <!-- empty state -->
    <div
      v-if="entries.length === 0"
      class="virt-empty"
      data-test="empty"
    >
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
      </svg>
      <span>{{ t('fileBrowser.empty') }}</span>
    </div>

    <!-- 虚拟滚动内容 -->
    <div
      v-else
      ref="contentRef"
      class="virt-content"
      :style="{ height: totalHeight + 'px' }"
      role="presentation"
    >
      <VirtualRow
        v-for="(entry, i) in visibleEntries"
        :key="entry.path"
        :entry="entry"
        :row-index="visibleRange.start + i"
        :absolute-top="(visibleRange.start + i) * resolvedRowHeight"
        :mark="getMark(entry)"
        :selected="isSelected(entry)"
        :view-mode="viewMode"
        :row-height="resolvedRowHeight"
        @row-click="onRowClick"
        @row-dblclick="onRowDblclick"
        @row-keydown="onRowKeydown"
        @row-contextmenu="onRowContextmenu"
        @name-hover="onNameHover"
        @name-leave="onNameLeave"
      />
    </div>
  </div>
</template>

<style scoped>
.virt-container {
  position: relative;
  overflow: auto;
  height: 100%;
  width: 100%;
  outline: none;
}
.virt-content {
  position: relative;
}
.virt-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  color: var(--color-text-tertiary);
  font-size: 14px;
  gap: 12px;
}
.virt-container.loading {
  pointer-events: none;
  opacity: 0.55;
}

/* details 列头 — 沿用 v0.1.0-module1.23 样式 (Xplorer 风格) */
.details-header button {
  cursor: pointer;
  transition: color 120ms var(--ease-out);
}
</style>