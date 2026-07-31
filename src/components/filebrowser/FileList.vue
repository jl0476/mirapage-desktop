<script setup lang="ts">
/**
 * FileList.vue
 * 展示目录列表：图片/目录/压缩包分组，自然排序
 *
 * v0.1.0-module1.12+: `loading` prop 锁住 in-flight 切换期.
 * 父级 fetch 中 (loading=true) 加 .loading class → CSS pointer-events:none,
 * 避免快速连点两个目录时把第二次当作第一次子目录 (race condition).
 */
import { computed } from 'vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';
import { naturalSort } from '@/lib/naturalSort';
import { log } from '@/lib/logger';

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
  // 自然排序（页2 < 页10）
  const by = (a: MediaEntry, b: MediaEntry): number => {
    if (props.sortField === 'modifiedAt') {
      return (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
    }
    if (props.sortField === 'size') {
      return a.size - b.size;
    }
    // name: 自然排序
    return 0; // 由 naturalSort 处理
  };
  const sortedByName = naturalSort(props.entries, (e) => e.name);
  if (props.sortField === 'name') {
    return props.sortAscending ? sortedByName : [...sortedByName].reverse();
  }
  // modifiedAt / size: 先 name sort 再 by sort
  const stable = [...sortedByName].sort(by);
  return props.sortAscending ? stable : stable.reverse();
});

function onClick(entry: MediaEntry) {
  log('[FileList] click', entry.name, 'isDirectory=', entry.isDirectory, 'path=', entry.path);
  emit('open', entry);
}

function iconFor(entry: MediaEntry): string {
  if (entry.isDirectory) return '📁';
  if (entry.isArchive) return '🗜';
  return '🖼';
}
</script>

<template>
  <ul v-if="sorted.length === 0" data-test="empty" class="empty">
    <li>{{ $t?.('fileBrowser.empty') ?? '空目录' }}</li>
  </ul>
  <ul v-else :class="['filelist', { loading }]" role="button" data-test="filelist" aria-label="Directory contents">
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
      <span class="icon" aria-hidden="true">{{ iconFor(entry) }}</span>
      <span class="name">{{ entry.name }}</span>
    </li>
  </ul>
</template>

<style scoped>
.filelist {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  padding: var(--space-2) 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.filelist.loading {
  pointer-events: none;
  opacity: 0.55;
}
.empty {
  list-style: none;
  padding: var(--space-8) var(--space-4);
  margin: 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-base);
}
.filelist > li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  margin: 0 var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
.filelist > li:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}
.filelist > li:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.filelist > li:active {
  background: var(--surface-3);
}

.icon {
  font-size: 15px;
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.name {
  flex: 1;
  font-size: var(--text-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.is-directory .name {
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.is-archive .name {
  color: var(--accent);
}
</style>
