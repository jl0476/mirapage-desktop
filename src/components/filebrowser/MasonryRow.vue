<script setup lang="ts">
// MasonryRow.vue — 瀑布流单卡片（缩略图 + 选中态 + 阅读状态 badge）
// 图片区域委托给 MasonryThumbnail（占位/spinner/淡入/失败重试）。
// 事件签名与 VirtualRow 一致（复用 FileList 的事件转发逻辑）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { isMasonryImage } from '@/lib/mime';
import type { MediaEntry } from '@/lib/sourceDescriptor';
import type { ThumbnailState } from '@/lib/thumbnail';
import MasonryThumbnail from './MasonryThumbnail.vue';
import FileIcon from './FileIcon.vue';

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
  /** 缩略图 natural 尺寸（真实宽高比）转发——MasonryView 写 measuredMap。 */
  (e: 'row-measured', entry: MediaEntry, width: number, height: number): void;
}>();

const { t } = useI18n();

const classes = computed(() => ({
  'masonry-row': true,
  'is-selected': props.selected,
  'is-finished': props.mark === 'finished',
  'is-reading': props.mark === 'reading',
}));

type PlaceholderType = 'folder' | 'archive' | 'file';
/** 非图片占位类型（isMasonryImage 先行排除图片卡；目录 > 归档 > 杂文件，
 *  对齐 VirtualRow.iconType 判定顺序——cover.jpg 目录归 folder 不归 spinner）。 */
const placeholderType = computed<PlaceholderType | null>(() => {
  if (isMasonryImage(props.entry)) return null;
  if (props.entry.isDirectory) return 'folder';
  if (props.entry.isArchive) return 'archive';
  return 'file';
});
const placeholderClass = computed(() =>
  placeholderType.value ? `ph-${placeholderType.value}` : '',
);

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
      v-if="placeholderType === null"
      :state="thumbState"
      :alt="entry.name"
      :badge-interactive="badgeInteractive"
      @retry="$emit('row-retry', entry)"
      @show-progress="(el) => $emit('show-progress', entry, el)"
      @measured="(w, h) => $emit('row-measured', entry, w, h)"
    />
    <div v-else class="masonry-placeholder" :class="placeholderClass">
      <FileIcon :type="placeholderType" :size="28" />
      <span class="placeholder-name">{{ entry.name }}</span>
    </div>
    <span v-if="mark !== 'none'" class="masonry-badge" :class="mark">{{ statusLabel(mark) }}</span>
  </div>
</template>

<style scoped>
.masonry-row {
  cursor: pointer;
  /* 移除 border + border-radius: hGap/vGap 唯一控制间距, gap=0 时图片无缝拼接.
     选中态用 ::after 置顶环 (module3.0.14): 3.0.7 缩略图卡片层 (absolute inset 0)
     铺满卡片后 outline 绘制层级不可靠, ::after + z-index 确定性盖顶。 */
  overflow: hidden;
  background: var(--color-surface-1);
  contain: layout style;
}
.masonry-row::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--color-accent);
  pointer-events: none; /* 不挡点击/双击/右键/角标 */
  opacity: 0;
  z-index: 3; /* 高于缩略图卡片层与状态/阶段角标 */
  transition: opacity 80ms ease-out;
}
.masonry-row.is-selected::after { opacity: 1; }
/* 已读完卡片半透明（作用到子组件 MasonryThumbnail 的 img） */
.masonry-row.is-finished :deep(.thumbnail-image) { opacity: 0.55; }
/* 混排占位卡（2026-08-27 方案 B）：非图片条目 FileIcon + 名称居中 */
.masonry-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--color-surface-1);
}
.masonry-placeholder.ph-folder { color: var(--color-file-folder); }
.masonry-placeholder.ph-archive { color: var(--color-file-archive); }
.masonry-placeholder.ph-file { color: var(--color-file-default); }
.placeholder-name {
  max-width: 90%;
  font-size: 11px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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