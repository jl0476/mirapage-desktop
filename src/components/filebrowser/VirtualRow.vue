<script setup lang="ts">
/**
 * VirtualRow.vue — 虚拟列表的单 row 渲染组件 (Phase 3 FileList 集成)
 *
 * v0.1.0-module3.0.4-virtuallist: 父级 useVirtualList 给 absoluteTop,
 * 单 row 渲染由绝对定位 + transform 摆位, 只触发 composite (不触发 layout).
 *
 * v0.1.0-module3.0.5-masonry (阶段 E2): 模板仅剩 details view block.
 *  list/grid 已从 ViewMode union 收窄出, 此组件不再支持其他视图.
 *  - absoluteTop → transform: translateY (只触发 composite)
 *  - iconType / iconClass 用 WeakMap 缓存 (defer 自 Task 1.2)
 *  - padding 6px 12px 对齐 CLAUDE.md §1.4 (py-1.5 px-3)
 *
 * 依赖: FileIcon 子组件, settings store (locale), vue-i18n (t), format helpers.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MediaEntry } from '@/lib/sourceDescriptor'
import FileIcon from './FileIcon.vue'
import { useSettingsStore } from '@/stores/settings'
import { formatBytes, formatDateTime } from '@/locales/helpers'
import { mimeFromName, getMimeCategory } from '@/lib/mime'

type RowMark = 'reading' | 'finished' | 'none'
// v0.1.0-module3.0.5-masonry (阶段 B / B4): 收窄为 details | masonry (对齐 fileBrowser.store ViewMode).
// 局部 type 保留 (而非 import store) — store 走 preload/Settings/迁移的语义, 组件内只关心 row 渲染.
type ViewMode = 'details' | 'masonry'
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

const rowStyle = computed(() => {
  // v0.1.0-module3.0.5-masonry (阶段 E2): grid 已收窄出 ViewMode union 并删 template 分支,
  // 此处 rowStyle 只走 details (absolute + translateY 虚拟滚动定位), 不再需要 grid/list 分支.
  return {
    position: 'absolute' as const,
    top: '0',
    left: '0',
    right: '0',
    height: props.rowHeight + 'px',
    transform: `translateY(${props.absoluteTop}px)`,
    contain: 'layout style',
  }
})

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
    <!-- details view block (唯一保留: 阶段 E2 删 list/grid) -->
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
      <span class="date-cell truncate">{{ entry.modifiedAt ? formatDateTime(entry.modifiedAt * 1000, settings.locale) : '—' }}</span>
      <span class="type-cell truncate">{{ getTypeLabel(entry) }}</span>
      <span class="size-cell truncate">{{ entry.isDirectory ? '—' : formatBytes(entry.size) }}</span>
      <span v-if="mark === 'reading'" class="status-badge reading">{{ statusLabel(mark) }}</span>
      <span v-else-if="mark === 'finished'" class="status-badge finished">{{ statusLabel(mark) }}</span>
    </div>
  </div>
</template>

<style scoped>
.row-host {
  cursor: pointer;
}
/* viewMode 切换: 阶段 E2 只剩 details, 不再需要 :not() 显隐 (template 已无其他 view block) */

/* details view block 样式 */
.row-view-details {
  display: grid;
  /* #序号 / icon / name / date / type / size / status */
  grid-template-columns: 40px 28px minmax(80px, 1fr) minmax(0, 160px) minmax(0, 120px) minmax(0, 100px) minmax(0, 110px);
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--color-text-primary);  /* 详情列文字默认主色, 比 secondary 深 */
  height: 100%;
  box-sizing: border-box;
}
.row-view-details .name-wrap { position: relative; overflow: visible !important; min-width: 0; }
.row-view-details .name-wrap > .name-cell {
  display: block;  /* hotfix15 风格: span 默认 inline, 不支持 text-overflow:ellipsis, 需 block */
  min-width: 0;
}
/* hotfix15 风格: 数据列 truncate ellipsis (窄面板时列收缩不重叠, 列按 minmax(0, ...) 收缩).
   scoped CSS 兜底 (Tailwind utility .truncate 在 scoped 环境下需 data-v-XXX 选择器) */
.row-view-details > .truncate,
.row-view-details > .name-wrap > .name-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-view-details .index { text-align: right; color: var(--color-text-tertiary); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; }
.row-view-details .date-cell { text-align: right; font-family: ui-monospace, SFMono-Regular, monospace; }
.row-view-details .type-cell { text-align: center; }
.row-view-details .size-cell { text-align: right; font-family: ui-monospace, SFMono-Regular, monospace; }

/* 行状态 — 选择器限定 [role="row"] 避免内层 block 也带 row-host class 时 outline/background 重叠. */
.row-host[role="row"]:hover { background: var(--color-surface-light); color: var(--color-text-primary); }
.row-host[role="row"].is-selected {
  background: rgb(99 102 241 / 0.18);
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
.row-host[role="row"]:hover .icon :deep(.file-icon) { filter: drop-shadow(0 0 4px currentColor); }

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

/* details name cell — truncate */
.name-cell {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 阅读状态双染色 (icon tint + name 颜色) */
.row-host.is-finished .icon { color: var(--color-status-finished); }
.row-host.is-reading .icon { color: var(--color-status-reading); }
.row-host.is-directory .name-cell { font-weight: 500; color: var(--color-text-primary); }
.row-host.is-archive .name-cell { color: var(--color-file-archive); }

/* status badge (details 视图) */
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