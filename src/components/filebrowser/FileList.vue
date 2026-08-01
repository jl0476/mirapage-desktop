<script setup lang="ts">
/**
 * FileList.vue
 * 展示目录列表：图片/目录/压缩包分组，自然排序
 *
 * v0.1.0-module1.15+: 用 FileIcon (lucide 线条 SVG) 替代 emoji.
 * v0.1.0-module1.19: 重写样式 — 旧 var(--accent) 已废弃, 改用新 --color-* token.
 *                  FileList 行高更紧凑、hover/focus 用 indigo accent.
 * v0.1.0-module1.21: 加 marks prop → 目录行 is-finished / is-reading 双染色 + label
 *                  (参考 perfect-viewer FileBrowserScreen.kt:664-730 EntryRow)
 */
import { computed } from 'vue';
import type { MediaEntry, ReadStatusMap } from '@/lib/sourceDescriptor';
import { naturalSort } from '@/lib/naturalSort';
import { log } from '@/lib/logger';
import FileIcon from './FileIcon.vue';

type SortField = 'name' | 'modifiedAt' | 'size';

interface Props {
  entries: MediaEntry[];
  sortField?: SortField;
  sortAscending?: boolean;
  /** 父级 fetch 进行中. true 时整列表 pointer-events:none, 防止 race */
  loading?: boolean;
  /** v0.1.0-module1.21: 目录级阅读状态. key 用 descriptor-prefixed (父级算), value 'reading'/'finished'. */
  marks?: ReadStatusMap;
}
const props = withDefaults(defineProps<Props>(), {
  sortField: 'name',
  sortAscending: true,
  loading: false,
  marks: () => ({}),
});

interface Emits {
  (e: 'open', entry: MediaEntry): void;
  (e: 'contextmenu', entry: MediaEntry, x: number, y: number): void;
}
const emit = defineEmits<Emits>();

const sorted = computed<MediaEntry[]>(() => {
  const by = (a: MediaEntry, b: MediaEntry): number => {
    if (props.sortField === 'modifiedAt') {
      return (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
    }
    if (props.sortField === 'size') {
      return a.size - b.size;
    }
    return 0;
  };
  const sortedByName = naturalSort(props.entries, (e) => e.name);
  if (props.sortField === 'name') {
    return props.sortAscending ? sortedByName : [...sortedByName].reverse();
  }
  const stable = [...sortedByName].sort(by);
  return props.sortAscending ? stable : stable.reverse();
});

function onClick(entry: MediaEntry) {
  log('[FileList] click', entry.name, 'isDirectory=', entry.isDirectory, 'path=', entry.path);
  emit('open', entry);
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

/**
 * v0.1.0-module1.21: 行阅读状态 class (供 scoped CSS 双染色).
 * marks prop 是 readStatus.marks: key = `${rootPath}|${bookId}`,
 * value = 'reading' | 'finished'. 行查 marks 用 entry.path 后缀匹配
 * (父级 FileBrowser 已经把 readStatus.marks 原样传过来).
 */
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
</script>

<template>
  <ul
    v-if="sorted.length === 0"
    class="list-none p-8 text-center text-text-tertiary text-sm"
    data-test="empty"
  >
    <li>{{ $t?.('fileBrowser.empty') ?? '空目录' }}</li>
  </ul>
  <ul
    v-else
    :class="['filelist flex-1 min-h-0 overflow-y-auto list-none py-1 m-0 flex flex-col gap-px transition-opacity duration-100', { loading }]"
    role="button"
    data-test="filelist"
    aria-label="Directory contents"
  >
    <li
      v-for="entry in sorted"
      :key="entry.path"
      class="row"
      :class="{
        'is-directory': entry.isDirectory,
        'is-archive': entry.isArchive,
        'is-finished': markFor(entry) === 'finished',
        'is-reading': markFor(entry) === 'reading',
      }"
      data-test="row"
      :data-status="markFor(entry)"
      role="button"
      tabindex="0"
      @click="onClick(entry)"
      @keydown.enter="onClick(entry)"
      @keydown.space.prevent="onClick(entry)"
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
.filelist.loading {
  pointer-events: none;
  opacity: 0.55;
}

/* ─── 行 ────────────────────────────────────────────── */
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
  /* Xplorer hover 用 --xp-surface-light (#161630) 实色, 不是 surface-2 半透 */
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
.row:hover .icon :deep(.file-icon) {
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
.filelist > .row.is-finished .icon {
  color: var(--color-status-finished);
}
.filelist > .row.is-finished .name {
  color: var(--color-text-secondary); /* 略微暗 */
}
.filelist > .row.is-reading .icon {
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