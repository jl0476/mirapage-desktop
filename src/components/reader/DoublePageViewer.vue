<script setup lang="ts">
/**
 * DoublePageViewer.vue
 * 双页阅读器：渲染当前 spread 涵盖的 1-2 张图
 *
 * - currentSpreadIndex 决定显示哪个 spread
 * - spread.start/end 索引 pageUrls 切片 → 1 张或 2 张 URL
 * - 子组件 SinglePageViewer 各渲染一张
 *
 * RTL 通过 CSS `direction: rtl` 在 viewport 上镜像，组件本身不感知方向。
 */
import { computed } from 'vue';
import SinglePageViewer from './SinglePageViewer.vue';

interface PageRange {
  start: number;
  end: number;
}

interface Props {
  pageUrls: string[];
  spreads: PageRange[];
  currentSpreadIndex: number;
}
const props = defineProps<Props>();

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
</script>

<template>
  <div class="double-page-viewer" data-test="current-pages" :data-pages="currentPageUrls.join(',')">
    <div
      v-for="(url, idx) in currentPageUrls"
      :key="url + '/' + idx"
      class="page-slot"
      :class="{ left: idx === 0, right: idx === 1 }"
    >
      <SinglePageViewer :image-url="url" />
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
.page-slot {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
}
</style>
