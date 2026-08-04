<script setup lang="ts">
/**
 * DoublePageViewer.vue
 * 双页阅读器：渲染当前 spread 涵盖的 1-2 张图
 *
 * - currentSpreadIndex 决定显示哪个 spread
 * - spread.start/end 索引 pageUrls 切片 → 1 张或 2 张 URL
 * - 子组件 SinglePageViewer 各渲染一张
 *
 * v0.1.0-module3.0.2-reader-polish:
 *  - Cluster B #5: SinglePageViewer 已设 showNavigationControl=false, 双页模式继承
 *  - Cluster C: 暴露 getBounds 给 useReaderScale — 取首个 page slot 的 bounds
 *    (双页图片尺寸近似, fit-screen/width/height 用首个即可; stretch / original
 *    也按并集近似处理)
 *
 * v0.1.0-reader-review-fix:
 *  - 加 getViewer 暴露首个 page slot 的 OSD viewer (single mode 之外 scale 也能用)
 *  - 实现 RTL: 父级传 direction, RTL 时 flex-direction: row-reverse (CSS direction: rtl)
 *    镜像 spread 顺序, 让双页阅读方向真的可见
 */
import { computed, reactive } from 'vue';
import SinglePageViewer from './SinglePageViewer.vue';

interface PageRange {
  start: number;
  end: number;
}

interface Props {
  pageUrls: string[];
  spreads: PageRange[];
  currentSpreadIndex: number;
  /** v0.1.0-reader-review-fix: 阅读方向. 'rtl' → flex-direction: row-reverse */
  direction?: 'ltr' | 'rtl';
}
const props = withDefaults(defineProps<Props>(), { direction: 'ltr' });

// v0.1.0-reader-review-fix-17: 转发子 SinglePageViewer 的 image-loaded 事件
// (任一 slot 完成 OSD open 即触发, 让父级尽早开始预加载)
const emit = defineEmits<{
  (e: 'image-loaded'): void;
}>();

function onSlotLoaded(): void {
  emit('image-loaded');
}

/** 当前 spread 含有的页 URL 列表（1 或 2 个） */
const currentPageUrls = computed<string[]>(() => {
  const spread = props.spreads[props.currentSpreadIndex];
  if (!spread) return [];
  const urls: string[] = [];
  for (let i = spread.start; i < spread.end && i < props.pageUrls.length; i++) {
    urls.push(props.pageUrls[i]);
  }
  return urls;
});

/** RTL 镜像页序: spread[1,2] → DOM 中 [2, 1] */
const orderedPageUrls = computed<string[]>(() => {
  if (props.direction !== 'rtl') return currentPageUrls.value;
  return [...currentPageUrls.value].reverse();
});

/** Cluster C: 收集子 SinglePageViewer 实例到数组.
 * 使用 reactive object (key 是 idx) 而非 ref<Array>, 避免 Vue 自动 unwrap
 * 导致的 .value[idx] = undefined 写入错误. */
const viewerRefs = reactive<Record<number, InstanceType<typeof SinglePageViewer> | null>>({});
function setViewerRef(el: unknown, idx: number): void {
  viewerRefs[idx] = el as InstanceType<typeof SinglePageViewer> | null;
}

defineExpose({
  /** 取首个 page slot 的 bounds. 用于 useReaderScale 计算 zoom. */
  getBounds: () => {
    const first = viewerRefs[0];
    if (!first || typeof (first as { getBounds?: () => unknown }).getBounds !== 'function') return null;
    return (first as { getBounds: () => unknown }).getBounds() as { x: number; y: number; width: number; height: number } | null;
  },
  /** v0.1.0-reader-review-fix: 暴露首个 page slot 的 OSD viewer (single mode 之外 useReaderScale 也能用) */
  getViewer: () => {
    const first = viewerRefs[0];
    if (!first || typeof (first as { getViewer?: () => unknown }).getViewer !== 'function') return null;
    return (first as { getViewer: () => unknown }).getViewer();
  },
});
</script>

<template>
  <div
    class="double-page-viewer"
    :class="direction === 'rtl' ? 'rtl' : 'ltr'"
    data-test="current-pages"
    :data-pages="currentPageUrls.join(',')"
    :data-direction="direction"
  >
    <div
      v-for="(url, idx) in orderedPageUrls"
      :key="url + '/' + idx"
      class="page-slot"
      :class="{ left: idx === 0, right: idx === 1 }"
    >
      <SinglePageViewer
        :ref="(el: unknown) => setViewerRef(el, idx)"
        :image-url="url"
        @image-loaded="onSlotLoaded"
      />
    </div>
  </div>
</template>

<style scoped>
.double-page-viewer {
  display: flex;
  width: 100%;
  height: 100%;
  background: #000;
  gap: 4px;
}
/* v0.1.0-reader-review-fix-2: RTL 只用 flex-direction: row-reverse (不要 direction: rtl,
   避免和 .page-slot 的 flex 子项方向冲突) */
.double-page-viewer.rtl {
  flex-direction: row-reverse;
}
.page-slot {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
}
</style>