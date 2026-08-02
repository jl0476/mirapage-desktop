<script setup lang="ts">
/**
 * SinglePageViewer.vue
 * 单页 OpenSeadragon 阅读器（DESIGn §8.2 示例）
 *
 * - props.imageUrl: 图片 URL（来自 Phase 2/3/7/8 的 read_file 接口 — Uint8Array 转 blob URL）
 * - onMounted: 实例化 OpenSeadragon viewer
 * - watch(imageUrl): 切换图片时 viewer.open({ type: 'image', url })
 * - onBeforeUnmount: viewer.destroy()
 */
import OpenSeadragon from 'openseadragon';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { log } from '@/lib/logger';

interface Props {
  imageUrl: string;
}
const props = defineProps<Props>();

const containerRef = ref<HTMLDivElement | null>(null);
let viewer: OpenSeadragon.Viewer | null = null;

onMounted(() => {
  if (!containerRef.value) {
    log('[SinglePageViewer] mount: containerRef is null');
    return;
  }
  log('[SinglePageViewer] mount: init OSD with url', props.imageUrl);
  viewer = OpenSeadragon({
    element: containerRef.value,
    tileSources: { type: 'image', url: props.imageUrl },
    showNavigator: false,
    // v0.1.0-module3.0.2 (M5): 关掉 OSD 滚轮缩放, 改由 ReaderView 的
    // useReaderWheel 接管翻页. 否则滚轮先被 OSD 缩吞, 翻页不响应.
    gestureSettingsMouse: { scrollToZoom: false },
    animationTime: 0.3,
  });
  // v0.1.0-module3.0.2-hotfix3: OSD tile load 失败/成功 hook — 便于诊断特殊字符 URL
  viewer.addHandler('open-failed', (event) => {
    log('[SinglePageViewer] OSD open-failed', { source: event.source, message: event.message, url: props.imageUrl });
  });
  viewer.addHandler('tile-load-failed', (event) => {
    const failedUrl = (event.tile as { source?: { url?: string } } | undefined)?.source?.url;
    log('[SinglePageViewer] OSD tile-load-failed', { failedUrl, originalUrl: props.imageUrl });
  });
  viewer.addHandler('open', () => {
    log('[SinglePageViewer] OSD open ok');
  });
});

watch(
  () => props.imageUrl,
  (url) => {
    log('[SinglePageViewer] watch imageUrl →', url);
    if (!viewer) {
      log('[SinglePageViewer] watch: viewer is null, skip open');
      return;
    }
    viewer.open({ type: 'image', url });
  },
);

onBeforeUnmount(() => {
  viewer?.destroy();
  viewer = null;
});
</script>

<template>
  <div
    ref="containerRef"
    data-test="viewer-container"
    class="single-page-viewer"
  />
</template>

<style scoped>
.single-page-viewer {
  width: 100%;
  height: 100%;
  background: #000;
}
</style>