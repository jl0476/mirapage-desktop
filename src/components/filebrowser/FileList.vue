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
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore, type ViewMode } from '@/stores/fileBrowser';
import { useReadStatusStore } from '@/stores/readStatus';
import { useVirtualList } from '@/composables/useVirtualList';
import VirtualRow from './VirtualRow.vue';
import MasonryView from './MasonryView.vue';
import type { ProgressItem } from '@/lib/tauri';
import type { MediaEntry, ReadStatusMap, SourceDescriptor } from '@/lib/sourceDescriptor';

interface Props {
  entries: MediaEntry[];
  loading?: boolean;
  marks?: ReadStatusMap;
  selectedPaths?: Set<string>;
  // v0.1.0-module3.0.5-masonry (阶段 E2): 收窄为 details | masonry,
  // 老 list/grid 仅用于持久化兼容 (fileBrowser.loadLayout fallback → details).
  viewMode?: ViewMode;
  // MasonryView 所需参数 (阶段 E2 接入瀑布流视图)
  descriptor?: SourceDescriptor;
  rootPath?: string | null;
  currentPath?: string;
  colCount?: number;
  hGap?: number;
  vGap?: number;
  // v0.1.0-module3.0.8 (任务 10): 全序列图片名 — FileBrowser 派生
  // (fb.sortedEntries 过滤图片), 透传给 MasonryView (任务 8 已接 prop).
  // UI 过滤 (搜索/隐藏已读) 不影响此 prop, 保证 useMasonryBrowsePosition
  // 计算的 page 索引稳定.
  canonicalImageNames?: string[];
}
const props = withDefaults(defineProps<Props>(), {
  loading: false,
  marks: () => ({}),
  selectedPaths: () => new Set<string>(),
  viewMode: 'details',
  rootPath: null,
  currentPath: '',
  colCount: 4,
  hGap: 8,
  vGap: 8,
  canonicalImageNames: () => [] as string[],
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
const readStatus = useReadStatusStore();

/* ─── name-wrap tooltip 状态 ─── */
const hoveredName = ref<string | null>(null);
const hoverPos = ref<{ top: number; left: number } | null>(null);

/** 行高映射 (像素, 固定). v0.1.0-module3.0.5-masonry (阶段 E2) 收窄为 details,
 *  masonry 由 MasonryView 自己管理布局 (变高卡片, 无固定 rowHeight),
 *  使用 Partial 避免强制列出 union 全部 key. */
const rowHeightByView: Partial<Record<ViewMode, number>> = {
  details: 29,
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
  rowHeight: resolvedRowHeight,
});

/* ─── viewMode 切换保留滚动位置 (Task 4.1) ─────────────
 * 切 viewMode 时 useVirtualList 会响应 rowHeight 变化重算 totalHeight, 但 scrollTop
 * 数值保留不变 — 若用户在 grid 大行高滚到 50%, 切回 list 小行高后同样的 scrollTop 数值
 * 指向的 row index 已经偏到别的位置. 这里在切换前记下 focused row path, 切换后用
 * scrollToPath 把它滚到新行高的正确位置.
 *
 * watch props.viewMode 而非 props.entries — entries 变化已由 useVirtualList 内部
 * watcher 处理 (Task 2.4 clamp), 两者职责不重叠.
 */
const selectedPathBeforeSwitch = ref<string | null>(null);
watch(() => props.viewMode, async () => {
  const focusedEl = containerRef.value?.querySelector('[data-focused="true"]') as HTMLElement | null;
  const focusedPath = focusedEl?.dataset.path ?? null;
  const firstVisibleEl = containerRef.value?.querySelector('[role="row"][data-path]') as HTMLElement | null;
  const firstVisiblePath = firstVisibleEl?.dataset.path ?? null;
  selectedPathBeforeSwitch.value = focusedPath ?? firstVisiblePath;

  // 等 useVirtualList 响应 rowHeight 变化重算 totalHeight / visibleRange
  await nextTick();
  await nextTick();

  if (selectedPathBeforeSwitch.value) {
    scrollToPath(selectedPathBeforeSwitch.value);
  }
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
 * marks key 形如 `${descriptorId}|${entry.path}` — 用 lastIndexOf('|') 取 path 段.
 * finished 用 readStatus.finishedSet O(1) (Task 1.3); reading 仍走 marks map (readingSet 暂未实现).
 * 优先级: reading > finished > none.
 */
const markByPath = computed<Map<string, 'reading' | 'finished' | 'none'>>(() => {
  const m = new Map<string, 'reading' | 'finished' | 'none'>();
  const finished = readStatus.finishedSet;
  // reading 仍走 marks map (O(n*m) 但实际 marks 量小, 暂不优化)
  const readingPaths = new Set<string>();
  for (const [k, v] of Object.entries(props.marks)) {
    if (v === 'reading') {
      const idx = k.indexOf('|');
      readingPaths.add(idx >= 0 ? k.slice(idx + 1) : k);
    }
  }
  for (const e of props.entries) {
    if (e.isDirectory || e.isArchive) {
      if (readingPaths.has(e.path)) m.set(e.path, 'reading');
      else if (finished.has(e.path)) m.set(e.path, 'finished');
      else m.set(e.path, 'none');
    } else {
      m.set(e.path, 'none');
    }
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
  // 记录 hovered entry + 鼠标位置, 渲染 Teleport tooltip 显示全名 (truncate 时看不全)
  hoveredName.value = entry.name
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  hoverPos.value = {
    top: rect.bottom + 4,  // name 下方 4px (对齐 hotfix15 原版, 不是上方)
    left: rect.left,  // 左对齐 name 左边缘 (不是水平居中)
  }
  emit('name-hover', entry, event);
}
function onNameLeave(): void {
  hoveredName.value = null
  hoverPos.value = null
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

/* ─── 暴露 scrollToPath / scrollToIndex / regenerateBatch / retryBatch 给父级 ─── */
const masonryRef = ref<InstanceType<typeof MasonryView> | null>(null);
/** 强制重建指定图片缩略图（单图，右键菜单兼容），转发到 MasonryView.regenerate。 */
function regenerateThumbnail(path: string): void {
  masonryRef.value?.regenerate(path);
}
/** 批量重新生成（多选右键菜单）。masonry 视图转发到 MasonryView；details 视图逐个调 RPC
 * （详情视图缩略图刷新是已知问题，单图 regenerate 也有，本次不解决）。 */
function regenerateBatch(items: MediaEntry[]): void {
  if (props.viewMode === 'masonry') {
    masonryRef.value?.regenerateBatch(items.map((e) => e.path));
  } else {
    for (const e of items) {
      masonryRef.value?.regenerate(e.path);
    }
  }
}
/** 批量重试。分发策略同 regenerateBatch。 */
function retryBatch(items: MediaEntry[]): void {
  if (props.viewMode === 'masonry') {
    masonryRef.value?.retryBatch(items.map((e) => e.path));
  } else {
    for (const e of items) {
      masonryRef.value?.retry(e.path);
    }
  }
}

/* ─── v0.1.0-module3.0.8 (任务 9): 转发 masonry 浏览位置到 FileBrowser ─── */
/** 监听 MasonryView 暴露的 browsePosition.lastBrowseProgress（FileList 是中间层） */
const masonryLastBrowseProgress = ref<ProgressItem | null>(null);
watch(
  () => masonryRef.value?.browsePosition?.lastBrowseProgress?.value ?? null,
  (v) => { masonryLastBrowseProgress.value = v; },
  { immediate: true },
);
/** 转发 masonry 跳到上次浏览位置（FileBrowser toolbar「↶ 跳到上次」按钮用） */
async function masonryJumpToLast(): Promise<void> {
  await masonryRef.value?.jumpToLast();
}

defineExpose({
  scrollToPath,
  scrollToIndex,
  scrollTop,
  viewportHeight,
  regenerateThumbnail,
  regenerateBatch,
  retryBatch,
  masonryJumpToLast,
  masonryLastBrowseProgress: computed(() => masonryLastBrowseProgress.value),
});
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

    <!-- masonry 视图: 变高卡片, 由 MasonryView 自己管布局 -->
    <MasonryView
      v-else-if="viewMode === 'masonry'"
      ref="masonryRef"
      :entries="entries"
      :marks="marks || {}"
      :selected-paths="selectedPaths || new Set()"
      :descriptor="descriptor || { type: 'local', rootPath: rootPath || '' }"
      :root-path="rootPath || ''"
      :current-path="currentPath || ''"
      :col-count="colCount"
      :h-gap="hGap"
      :v-gap="vGap"
      :canonical-image-names="canonicalImageNames"
      @row-click="onRowClick"
      @row-dblclick="onRowDblclick"
      @row-contextmenu="onRowContextmenu"
    />

    <!-- details 视图: 虚拟滚动 -->
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

    <!-- name-wrap 全名 tooltip (Teleport to body 跳出容器 overflow) -->
    <Teleport to="body">
      <div
        v-if="hoveredName && hoverPos"
        class="name-tooltip-portal"
        :style="{
          position: 'fixed',
          top: hoverPos.top + 'px',
          left: hoverPos.left + 'px',
        }"
        role="tooltip"
        data-test="name-tooltip"
      >
        {{ hoveredName }}
      </div>
    </Teleport>
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

/* ─── name 全名 tooltip (Teleport to body) ─── */
.name-tooltip-portal {
  background: var(--color-surface-1);
  border: 1px solid var(--color-border-default);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-text-primary);
  z-index: 1100;
  white-space: nowrap;
  max-width: 80vw;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  pointer-events: none;
}

/* details 列头 — 沿用 v0.1.0-module1.23 样式 (Xplorer 风格) */
.details-header button {
  cursor: pointer;
  transition: color 120ms var(--ease-out);
}
</style>