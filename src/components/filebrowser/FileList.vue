<script setup lang="ts">
/**
 * FileList.vue
 * 展示目录列表：图片/目录/压缩包分组，自然排序
 *
 * v0.1.0-module1.15+: 用 FileIcon (lucide 线条 SVG) 替代 emoji.
 * v0.1.0-module1.19: 重写样式 — 旧 var(--accent) 已废弃, 改用新 --color-* token.
 * v0.1.0-module1.21: 加 marks prop → 目录行 is-finished / is-reading 双染色 + label
 * v0.1.0-module1.22: 删 sortField / sortAscending props (store 持有), 接 selectedPaths.
 *                  单击 = selectFile(entry, $event) (走 store),
 *                  双击 = open, Enter = open, Space = select.
 */
import type { MediaEntry, ReadStatusMap } from '@/lib/sourceDescriptor';
import { log } from '@/lib/logger';
import FileIcon from './FileIcon.vue';

interface Props {
  /** 排序由父级 fileBrowser store 完成 (sortedEntries), 此处只接收已排序列表 */
  entries: MediaEntry[];
  /** 父级 fetch 进行中. true 时整列表 pointer-events:none, 防止 race */
  loading?: boolean;
  /** v0.1.0-module1.21: 目录级阅读状态. key 用 descriptor-prefixed (父级算), value 'reading'/'finished'. */
  marks?: ReadStatusMap;
  /** v0.1.0-module1.22: 当前选中 entry.path 集合 (从 store.sortedEntries.filter 派生) */
  selectedPaths?: Set<string>;
  /** v0.1.0-module1.22: 当前 viewMode (list/grid) — 影响行的 layout */
  viewMode?: 'list' | 'grid';
}
const props = withDefaults(defineProps<Props>(), {
  loading: false,
  marks: () => ({}),
  selectedPaths: () => new Set<string>(),
  viewMode: 'list',
});

interface Emits {
  (e: 'open', entry: MediaEntry): void;
  (e: 'contextmenu', entry: MediaEntry, x: number, y: number): void;
  (e: 'select', entry: MediaEntry, event: MouseEvent | KeyboardEvent): void;
}
const emit = defineEmits<Emits>();

function onClick(entry: MediaEntry, event: MouseEvent) {
  log('[FileList] click', entry.name, 'isDirectory=', entry.isDirectory, 'path=', entry.path);
  emit('select', entry, event);
}

function onDblClick(entry: MediaEntry) {
  log('[FileList] dblclick', entry.name, 'path=', entry.path);
  emit('open', entry);
}

function onKeydown(entry: MediaEntry, event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('open', entry);
  } else if (event.key === ' ') {
    event.preventDefault();
    // Space = 单选 (不传 modifier)
    emit('select', entry, event);
  }
}

function onContextMenu(entry: MediaEntry, e: MouseEvent) {
  e.preventDefault();
  log('[FileList] contextmenu', entry.name, 'x=', e.clientX, 'y=', e.clientY);
  emit('contextmenu', entry, e.clientX, e.clientY);
}

/** 文件类型图标 type (FileIcon props) */
function iconType(entry: MediaEntry): 'folder' | 'image' | 'archive' | 'file' {
  if (entry.isDirectory) return 'folder';
  if (entry.isArchive) return 'archive';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  return 'file';
}

/** 文件类型颜色 class (对应 CSS .icon-folder / .icon-image / .icon-archive) */
function iconClass(entry: MediaEntry): string {
  if (entry.isDirectory) return 'icon-folder';
  if (entry.isArchive) return 'icon-archive';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'icon-image';
  return 'icon-default';
}

/** v0.1.0-module1.21: 行阅读状态 class (供 scoped CSS 双染色). */
function markFor(entry: MediaEntry): 'none' | 'reading' | 'finished' {
  if (!entry.isDirectory && !entry.isArchive) return 'none';
  const pathSuffix = `|${entry.path}`;
  for (const [k, v] of Object.entries(props.marks)) {
    if (k.endsWith(pathSuffix) && (v === 'reading' || v === 'finished')) {
      return v;
    }
  }
  return 'none';
}

function isSelected(entry: MediaEntry): boolean {
  return props.selectedPaths.has(entry.path);
}
</script>

<template>
  <ul
    v-if="entries.length === 0"
    class="list-none p-8 text-center text-text-tertiary text-sm"
    data-test="empty"
  >
    <li>{{ $t?.('fileBrowser.empty') ?? '空目录' }}</li>
  </ul>
  <ul
    v-else-if="viewMode === 'grid'"
    class="grid-view flex-1 min-h-0 overflow-y-auto list-none py-2 m-0 grid gap-2 px-3"
    data-test="filelist"
    data-view="grid"
    aria-label="Directory contents"
  >
    <div
      v-for="entry in entries"
      :key="entry.path"
      class="grid-item"
      :class="{
        'is-directory': entry.isDirectory,
        'is-archive': entry.isArchive,
        'is-finished': markFor(entry) === 'finished',
        'is-reading': markFor(entry) === 'reading',
        'is-selected': isSelected(entry),
      }"
      data-test="row"
      role="button"
      tabindex="0"
      @click="onClick(entry, $event)"
      @dblclick="onDblClick(entry)"
      @keydown="onKeydown(entry, $event)"
      @contextmenu="onContextMenu(entry, $event)"
    >
      <span class="icon" :class="iconClass(entry)" aria-hidden="true">
        <FileIcon :type="iconType(entry)" />
      </span>
      <span class="name">{{ entry.name }}</span>
      <span
        v-if="markFor(entry) !== 'none'"
        class="status"
        :class="markFor(entry)"
        data-test="read-status"
      >{{ $t(markFor(entry) === 'finished' ? 'fileBrowser.status.finished' : 'fileBrowser.status.reading') }}</span>
    </div>
  </ul>
  <ul
    v-else
    :class="['filelist flex-1 min-h-0 overflow-y-auto list-none py-1 m-0 flex flex-col gap-px transition-opacity duration-100', { loading }]"
    data-test="filelist"
    data-view="list"
    aria-label="Directory contents"
  >
    <li
      v-for="entry in entries"
      :key="entry.path"
      class="row"
      :class="{
        'is-directory': entry.isDirectory,
        'is-archive': entry.isArchive,
        'is-finished': markFor(entry) === 'finished',
        'is-reading': markFor(entry) === 'reading',
        'is-selected': isSelected(entry),
      }"
      data-test="row"
      :data-status="markFor(entry)"
      role="button"
      tabindex="0"
      @click="onClick(entry, $event)"
      @dblclick="onDblClick(entry)"
      @keydown="onKeydown(entry, $event)"
      @contextmenu="onContextMenu(entry, $event)"
    >
      <span class="icon" :class="iconClass(entry)" aria-hidden="true">
        <FileIcon :type="iconType(entry)" />
      </span>
      <span class="name">{{ entry.name }}</span>
      <span
        v-if="markFor(entry) !== 'none'"
        class="status"
        :class="markFor(entry)"
        data-test="read-status"
      >{{ $t(markFor(entry) === 'finished' ? 'fileBrowser.status.finished' : 'fileBrowser.status.reading') }}</span>
    </li>
  </ul>
</template>

<style scoped>
.filelist.loading,
.grid-view.loading {
  pointer-events: none;
  opacity: 0.55;
}

/* ─── 行 (list view) ───────────────────────────────── */
.filelist > .row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  margin: 0 4px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
}
.filelist > .row:hover {
  background: var(--color-surface-light);
  color: var(--color-text-primary);
}
.filelist > .row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.filelist > .row:active {
  background: var(--color-surface-3);
}
.filelist > .row.is-selected {
  background: rgb(99 102 241 / 0.18);
  border: 1px solid var(--color-accent);
  outline: 2px solid rgb(99 102 241 / 0.6);
  outline-offset: -1px;
}

/* ─── 行 (grid view) ───────────────────────────────── */
.grid-view {
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
}
.grid-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  color: var(--color-text-secondary);
  transition: background 120ms var(--ease-out), color 120ms var(--ease-out), border-color 120ms var(--ease-out);
}
.grid-item:hover {
  background: var(--color-surface-light);
  color: var(--color-text-primary);
}
.grid-item.is-selected {
  background: rgb(99 102 241 / 0.18);
  border-color: var(--color-accent);
}
.grid-item .icon {
  width: 32px;
  height: 32px;
}
.grid-item .name {
  font-size: 12px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}
.grid-item .status {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 9px;
}

/* ─── 文件类型彩色图标 (Xplorer 风格) ────────────────── */
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
.icon-default { color: var(--color-file-default); }

/* hover 时图标轻微 glow */
.row:hover .icon :deep(.file-icon),
.grid-item:hover .icon :deep(.file-icon) {
  filter: drop-shadow(0 0 4px currentColor);
}

.name {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.is-directory .name {
  font-weight: 500;
  color: var(--color-text-primary);
}

.is-archive .name {
  color: var(--color-file-archive);
}

/* ─── v0.1.0-module1.21: 阅读状态双染色 (icon tint + label badge) ─── */
.filelist > .row.is-finished .icon,
.grid-item.is-finished .icon {
  color: var(--color-status-finished);
}
.filelist > .row.is-finished .name {
  color: var(--color-text-secondary);
}
.filelist > .row.is-reading .icon,
.grid-item.is-reading .icon {
  color: var(--color-status-reading);
}
.filelist > .row.is-reading .name {
  color: var(--color-text-primary);
}

.status {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  margin-left: auto;
  text-transform: none;
  letter-spacing: 0;
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
</style>
