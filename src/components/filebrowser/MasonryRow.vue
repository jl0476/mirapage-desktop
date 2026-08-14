<script setup lang="ts">
// MasonryRow.vue — 瀑布流单卡片（缩略图 + 选中态 + 阅读状态 badge）
// 图片区域委托给 MasonryThumbnail（占位/spinner/淡入/失败重试）。
// 事件签名与 VirtualRow 一致（复用 FileList 的事件转发逻辑）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MediaEntry } from '@/lib/sourceDescriptor';
import type { ThumbnailState } from '@/lib/thumbnail';
import MasonryThumbnail from './MasonryThumbnail.vue';

type RowMark = 'reading' | 'finished' | 'none';

interface Props {
  entry: MediaEntry;
  thumbState?: ThumbnailState;
  width: number;
  height: number;
  top: number;
  left: number;
  mark: RowMark;
  selected: boolean;
  /** 角标是否可交互（module3.0.11 round-3：MasonryView 绑设置逐层下传）。 */
  badgeInteractive?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  badgeInteractive: true,
});

defineEmits<{
  (e: 'row-click', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-dblclick', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-contextmenu', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-retry', entry: MediaEntry): void;
  (e: 'show-progress', entry: MediaEntry, el: HTMLElement): void;
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
    <MasonryThumbnail
      :state="thumbState"
      :alt="entry.name"
      :badge-interactive="badgeInteractive"
      @retry="$emit('row-retry', entry)"
      @show-progress="(el) => $emit('show-progress', entry, el)"
    />
    <span v-if="mark !== 'none'" class="masonry-badge" :class="mark">{{ statusLabel(mark) }}</span>
  </div>
</template>

<style scoped>
.masonry-row {
  cursor: pointer;
  /* 移除 border + border-radius: hGap/vGap 唯一控制间距, gap=0 时图片无缝拼接。
     选中态用 outline (.is-selected 已有 outline-offset:-2px), 不依赖 border。 */
  overflow: hidden;
  background: var(--color-surface-1);
  transition: outline 80ms ease-out;
  contain: layout style;
}
.masonry-row.is-selected {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
/* 已读完卡片半透明（作用到子组件 MasonryThumbnail 的 img） */
.masonry-row.is-finished :deep(.thumbnail-image) { opacity: 0.55; }
.masonry-badge {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 9px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
  line-height: 1.4;
  z-index: 2;
}
.masonry-badge.reading { background: rgb(99 102 241 / 0.18); color: var(--color-status-reading); }
.masonry-badge.finished { background: rgb(52 211 153 / 0.15); color: var(--color-status-finished); }
</style>