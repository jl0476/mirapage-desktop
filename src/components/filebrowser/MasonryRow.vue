<script setup lang="ts">
// MasonryRow.vue — 瀑布流单卡片（图片 + 选中态 + 阅读状态 badge）
// 事件签名与 VirtualRow 一致（复用 FileList 的事件转发逻辑）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MediaEntry } from '@/lib/sourceDescriptor';

type RowMark = 'reading' | 'finished' | 'none';

interface Props {
  entry: MediaEntry;
  src: string;          // 父级 convertFileSrc 后的图片 URL
  width: number;
  height: number;
  top: number;
  left: number;
  mark: RowMark;
  selected: boolean;
}
const props = defineProps<Props>();

defineEmits<{
  (e: 'row-click', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-dblclick', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-contextmenu', entry: MediaEntry, event: MouseEvent): void;
}>();

const { t } = useI18n();

const classes = computed(() => ({
  'masonry-row': true,
  'is-selected': props.selected,
  'is-finished': props.mark === 'finished',
  'is-reading': props.mark === 'reading',
}));

const style = computed(() => ({
  position: 'absolute' as const,
  top: props.top + 'px',
  left: props.left + 'px',
  width: props.width + 'px',
  height: props.height + 'px',
}));

function statusLabel(m: RowMark): string {
  if (m === 'none') return '';
  return m === 'reading' ? t('fileBrowser.status.reading') : t('fileBrowser.status.finished');
}
</script>

<template>
  <div
    role="row"
    :aria-selected="selected"
    :data-path="entry.path"
    :data-status="mark"
    :class="classes"
    :style="style"
    @click="$emit('row-click', entry, $event)"
    @dblclick="$emit('row-dblclick', entry, $event)"
    @contextmenu="$emit('row-contextmenu', entry, $event)"
    tabindex="-1"
  >
    <img
      :src="src"
      loading="lazy"
      class="masonry-img"
      :alt="entry.name"
      draggable="false"
    />
    <span v-if="mark !== 'none'" class="masonry-badge" :class="mark">{{ statusLabel(mark) }}</span>
  </div>
</template>

<style scoped>
.masonry-row {
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-surface-1);
  border: 1px solid var(--color-border-default);
  transition: outline 80ms ease-out; /* v0.1.0-module3.0.5-masonry (阶段 E2) 修 D1: 替换未定义 var(--ease-out) */
  contain: layout style;
}
.masonry-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.masonry-row.is-selected {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.masonry-row.is-finished .masonry-img { opacity: 0.55; }
.masonry-badge {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 9px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
  line-height: 1.4;
}
.masonry-badge.reading { background: rgb(99 102 241 / 0.18); color: var(--color-status-reading); }
.masonry-badge.finished { background: rgb(52 211 153 / 0.15); color: var(--color-status-finished); }
</style>