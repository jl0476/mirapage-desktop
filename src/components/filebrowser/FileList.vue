<script setup lang="ts">
/**
 * FileList.vue
 * 展示目录列表：图片/目录/压缩包分组，自然排序
 *
 * v0.1.0-module1.15+: 用 FileIcon (lucide 线条 SVG) 替代 emoji.
 * v0.1.0-module1.19: 重写样式 — 旧 var(--accent) 已废弃, 改用新 --color-* token.
 *                  FileList 行高更紧凑、hover/focus 用 indigo accent.
 */
import { computed } from 'vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';
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
}
const props = withDefaults(defineProps<Props>(), {
  sortField: 'name',
  sortAscending: true,
  loading: false,
});

interface Emits {
  (e: 'open', entry: MediaEntry): void;
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
      :class="{ 'is-directory': entry.isDirectory, 'is-archive': entry.isArchive }"
      data-test="row"
      role="button"
      tabindex="0"
      @click="onClick(entry)"
      @keydown.enter="onClick(entry)"
      @keydown.space.prevent="onClick(entry)"
    >
      <span class="icon" :class="iconClass(entry)" aria-hidden="true">
        <FileIcon :type="iconType(entry)" />
      </span>
      <span class="name">{{ entry.name }}</span>
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
  gap: 12px;
  padding: 6px 16px;
  margin: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
}
.filelist > .row:hover {
  background: var(--color-surface-2);
  color: var(--color-text-primary);
}
.filelist > .row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.filelist > .row:active {
  background: var(--color-surface-3);
}

/* ─── 文件类型彩色图标 (Xplorer 风格) ────────────────── */
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
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
  font-size: 13px;
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
</style>