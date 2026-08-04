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
import type { OSDViewerLike } from '@/composables/useReaderScale';

interface Props {
  imageUrl: string;
}
const props = defineProps<Props>();

const containerRef = ref<HTMLDivElement | null>(null);
let viewer: OpenSeadragon.Viewer | null = null;

// Cluster C: 暴露 viewer + bounds 给父 (ReaderScreen → useReaderScale 应用缩放)
defineExpose({
  /** 获取 OSD viewer 实例 (供 useReaderScale 调用 viewport API) */
  getViewer: (): OSDViewerLike | null => {
    if (!viewer) return null;
    // OSD viewer 自带 viewport / world API, 类型结构匹配 OSDViewerLike
    return viewer as unknown as OSDViewerLike;
  },
  /** 获取当前图项 bounds (Point2D → 转 OSDBounds). 加载未完成时返回 null. */
  getBounds: () => {
    if (!viewer) return null;
    const item = viewer.world.getItemAt(0);
    if (!item) return null;
    const b = item.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  },
});

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
    // v0.1.0-module3.0.2-reader-polish (#5/#7): 关闭 OSD 默认 nav 控件
    // (左上 zoom in/out/home/fullscreen 按钮). WebView2 加载图标失败显示 "X"
    // 占位, 不仅视觉破碎, 还拦截 pointer events 阻碍 ReaderOverlay 按钮.
    showNavigationControl: false,
    // v0.1.0-module3.0.2 (M5): 关掉 OSD 滚轮缩放, 改由 ReaderView 的
    // useReaderWheel 接管翻页. 否则滚轮先被 OSD 缩吞, 翻页不响应.
    // 需求3: 关闭 OSD 内置滚轮缩放 + 点击缩放，让 click 完全交给 useReaderTouchZones 9 宫格
    gestureSettingsMouse: { scrollToZoom: false, clickToZoom: false, dblClickToZoom: false },
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