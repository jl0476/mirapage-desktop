<script setup lang="ts">
/**
 * VirtualRow.vue — 虚拟列表的单 row 渲染组件 (Phase 3 FileList 集成)
 *
 * v0.1.0-module3.0.4-virtuallist: 父级 useVirtualList 给 absoluteTop,
 * 单 row 渲染由绝对定位 + transform 摆位, 只触发 composite (不触发 layout).
 *
 * 设计要点:
 * - 三视图 (list/grid/details) block 同挂, **无 v-if** 包装, viewMode 切换不重建 DOM
 *   (CSS `:not()` 选择器显隐, 保留组件复用 + Vue 渲染缓存)
 * - iconType / iconClass 用 WeakMap 缓存 (defer 自 Task 1.2)
 * - padding 6px 12px 对齐 CLAUDE.md §1.4 (py-1.5 px-3)
 *
 * 依赖: FileIcon 子组件, settings store (locale), vue-i18n (t), format helpers.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MediaEntry } from '@/lib/sourceDescriptor'
import FileIcon from './FileIcon.vue'
import { useSettingsStore } from '@/stores/settings'
import { formatBytes, formatDate } from '@/locales/helpers'
import { mimeFromName, getMimeCategory } from '@/lib/mime'

type RowMark = 'reading' | 'finished' | 'none'
type ViewMode = 'list' | 'grid' | 'details'
type FileIconType = 'folder' | 'archive' | 'image' | 'file'

interface Props {
  entry: MediaEntry
  rowIndex: number
  absoluteTop: number
  mark: RowMark
  selected: boolean
  viewMode: ViewMode
  rowHeight: number
}
const props = defineProps<Props>()

defineEmits<{
  (e: 'row-click', entry: MediaEntry, event: MouseEvent): void
  (e: 'row-dblclick', entry: MediaEntry, event: MouseEvent): void
  (e: 'row-keydown', entry: MediaEntry, event: KeyboardEvent): void
  (e: 'row-contextmenu', entry: MediaEntry, event: MouseEvent): void
  (e: 'name-hover', entry: MediaEntry, event: MouseEvent): void
  (e: 'name-leave'): void
}>()

const { t } = useI18n()
const settings = useSettingsStore()

/**
 * host class: 包含 viewMode 控制类 (CSS 显隐依赖 row-host-list/grid/details)
 * 内层 view block 也用同样 class (is-*, is-selected) → 让 :hover / .is-selected
 * 等状态规则在三个 view block 里都生效.
 */
const rowClasses = computed(() => ({
  'row-host': true,
  [`row-host-${props.viewMode}`]: true,
  'is-directory': props.entry.isDirectory,
  'is-archive': props.entry.isArchive,
  'is-finished': props.mark === 'finished',
  'is-reading': props.mark === 'reading',
  'is-selected': props.selected,
}))

const rowStyle = computed(() => ({
  position: 'absolute' as const,
  top: '0',
  left: '0',
  right: '0',
  height: props.rowHeight + 'px',
  transform: `translateY(${props.absoluteTop}px)`,
  contain: 'layout style',
}))

// iconType / iconClass WeakMap 缓存 (按 entry 引用缓存, 列表复用时命中)
const iconTypeCache = new WeakMap<MediaEntry, FileIconType>()
const iconClassCache = new WeakMap<MediaEntry, string>()

function iconType(entry: MediaEntry): FileIconType {
  const cached = iconTypeCache.get(entry)
  if (cached !== undefined) return cached
  let kind: FileIconType
  if (entry.isDirectory) kind = 'folder'
  else if (entry.isArchive) kind = 'archive'
  else {
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) kind = 'image'
    else kind = 'file'
  }
  iconTypeCache.set(entry, kind)
  return kind
}

function iconClass(entry: MediaEntry): string {
  const cached = iconClassCache.get(entry)
  if (cached !== undefined) return cached
  const cls = `icon-${iconType(entry)}`
  iconClassCache.set(entry, cls)
  return cls
}

function statusLabel(m: RowMark): string {
  if (m === 'none') return ''
  return m === 'reading' ? t('fileBrowser.status.reading') : t('fileBrowser.status.finished')
}

function getTypeLabel(entry: MediaEntry): string {
  if (entry.isDirectory) return t('properties.typeDirectory')
  if (entry.isArchive) return t('properties.typeArchive')
  const mime = mimeFromName(entry.name)
  const category = mime ? getMimeCategory(mime) : null
  if (category === 'image') return t('properties.typeImage')
  if (category === 'video') return t('properties.typeVideo')
  if (category === 'audio') return t('properties.typeAudio')
  if (category === 'text') return t('properties.typeText')
  return t('properties.typeFile')
}
</script>

<template>
  <div
    role="row"
    :aria-rowindex="rowIndex + 1"
    :aria-selected="selected"
    :data-path="entry.path"
    :data-test="'row'"
    :data-status="mark"
    :class="rowClasses"
    :style="rowStyle"
    @click="$emit('row-click', entry, $event)"
    @dblclick="$emit('row-dblclick', entry, $event)"
    @keydown="$emit('row-keydown', entry, $event)"
    @contextmenu="$emit('row-contextmenu', entry, $event)"
    tabindex="-1"
  >
    <!-- list view block -->
    <div class="row-view-list" :class="rowClasses">
      <span class="icon" :class="iconClass(entry)">
        <FileIcon :type="iconType(entry)" />
      </span>
      <span class="name truncate">{{ entry.name }}</span>
      <span v-if="mark !== 'none'" class="status" :class="mark">{{ statusLabel(mark) }}</span>
    </div>

    <!-- grid view block -->
    <div class="row-view-grid" :class="rowClasses">
      <div class="grid-icon" :class="iconClass(entry)">
        <FileIcon :type="iconType(entry)" />
      </div>
      <div class="grid-name truncate">{{ entry.name }}</div>
      <span v-if="mark !== 'none'" class="status-badge" :class="mark">{{ statusLabel(mark) }}</span>
    </div>

    <!-- details view block -->
    <div class="row-view-details" :class="rowClasses">
      <span class="index">{{ rowIndex + 1 }}</span>
      <span class="icon" :class="iconClass(entry)">
        <FileIcon :type="iconType(entry)" />
      </span>
      <span
        class="name-wrap"
        @mouseenter="$emit('name-hover', entry, $event)"
        @mouseleave="$emit('name-leave')"
      >
        <span class="name-cell truncate">{{ entry.name }}</span>
      </span>
      <span class="date-cell">{{ entry.modifiedAt ? formatDate(entry.modifiedAt * 1000, settings.locale) : '—' }}</span>
      <span class="type-cell">{{ getTypeLabel(entry) }}</span>
      <span class="size-cell">{{ entry.isDirectory ? '—' : formatBytes(entry.size) }}</span>
      <span v-if="mark === 'reading'" class="status-badge reading">{{ statusLabel(mark) }}</span>
      <span v-else-if="mark === 'finished'" class="status-badge finished">{{ statusLabel(mark) }}</span>
    </div>
  </div>
</template>

<style scoped>
.row-host {
  cursor: pointer;
}
/* viewMode 切换: CSS 显隐 (无 v-if, viewMode 切换不重建 DOM)
   .row-host:not(.row-host-list) 选中 host 但不在 list 模式 → 隐藏 list block */
.row-host:not(.row-host-list) .row-view-list { display: none; }
.row-host:not(.row-host-grid) .row-view-grid { display: none; }
.row-host:not(.row-host-details) .row-view-details { display: none; }

/* list view block 样式 */
.row-view-list {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;  /* py-1.5 px-3 per CLAUDE.md §1.4 */
  font-size: 12px;
  color: var(--color-text-secondary);
}
.row-view-list .name { flex: 1; min-width: 0; }

/* grid view block 样式 */
.row-view-grid {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.row-view-grid .grid-icon {
  font-size: 32px;
  margin-bottom: 6px;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.row-view-grid .grid-name { max-width: 100%; }

/* details view block 样式 */
.row-view-details {
  display: grid;
  /* #序号 / icon / name / date / type / size / status */
  grid-template-columns: 40px 28px minmax(80px, 1fr) minmax(0, 160px) minmax(0, 120px) minmax(0, 100px) minmax(0, 110px);
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.row-view-details .name-wrap { position: relative; overflow: visible !important; min-width: 0; }
.row-view-details .index { text-align: right; color: var(--color-text-tertiary); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; }
.row-view-details .date-cell { text-align: right; font-family: ui-monospace, SFMono-Regular, monospace; }
.row-view-details .type-cell { text-align: center; }
.row-view-details .size-cell { text-align: right; font-family: ui-monospace, SFMono-Regular, monospace; }

/* 通用行状态 — 三视图都生效 */
.row-host:hover { background: var(--color-surface-light); color: var(--color-text-primary); }
.row-host.is-selected {
  background: rgb(99 102 241 / 0.18);
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
.row-host:hover .icon :deep(.file-icon) { filter: drop-shadow(0 0 4px currentColor); }

/* 文件类型彩色图标 */
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  flex-shrink: 0;
}
.icon-folder { color: var(--color-file-folder); }
.icon-image { color: var(--color-file-image); }
.icon-archive { color: var(--color-file-archive); }
.icon-file { color: var(--color-file-default); }

/* 列表/详情 name cell — truncate */
.name,
.grid-name,
.name-cell {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.grid-name {
  flex: 0 1 auto;
  text-align: center;
  width: 100%;
}

/* 阅读状态双染色 (icon tint + name 颜色) */
.row-host.is-finished .icon { color: var(--color-status-finished); }
.row-host.is-reading .icon { color: var(--color-status-reading); }
.row-host.is-directory .name,
.row-host.is-directory .name-cell { font-weight: 500; color: var(--color-text-primary); }
.row-host.is-archive .name,
.row-host.is-archive .name-cell { color: var(--color-file-archive); }

/* status badge (list/grid/details 共用) */
.status {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  margin-left: auto;
  line-height: 1.4;
}
.status.finished {
  background: rgb(52 211 153 / 0.15);
  color: var(--color-status-finished);
}
.status.reading {
  background: rgb(99 102 241 / 0.18);
  color: var(--color-status-reading);
}
.status-badge {
  font-size: 9px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
  display: inline-block;
  line-height: 1.4;
}
.status-badge.reading {
  background: rgb(99 102 241 / 0.18);
  color: var(--color-status-reading);
}
.status-badge.finished {
  background: rgb(52 211 153 / 0.15);
  color: var(--color-status-finished);
}
</style>