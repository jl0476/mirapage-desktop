<script setup lang="ts">
/**
 * FileList.vue
 * 展示目录列表：图片/目录/压缩包分组，自然排序
 */
import { computed } from 'vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';
import { naturalSort } from '@/lib/naturalSort';

type SortField = 'name' | 'modifiedAt' | 'size';

interface Props {
  entries: MediaEntry[];
  sortField?: SortField;
  sortAscending?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  sortField: 'name',
  sortAscending: true,
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
  // eslint-disable-next-line no-console
  console.log('[FileList] click', entry.name, 'isDirectory=', entry.isDirectory, 'path=', entry.path);
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
  <ul v-else class="filelist" data-test="filelist" aria-label="Directory contents">
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
.filelist,
.empty {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.filelist > li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.filelist > li:hover {
  background: rgba(74, 158, 255, 0.12);
}

.filelist > li:focus {
  outline: 2px solid #4a9eff;
  outline-offset: -2px;
}

.icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.name {
  flex: 1;
  font-size: 13px;
}

.is-directory .name {
  font-weight: 600;
}

.is-archive .name {
  color: #d29bff;
}

.empty {
  text-align: center;
  color: var(--color-muted, #888);
  padding: 24px;
  font-size: 13px;
}
</style>
