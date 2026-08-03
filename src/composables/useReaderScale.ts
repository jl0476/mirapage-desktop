/**
 * useReaderScale.ts — Cluster C: OSD 缩放控制 (v0.1.0-module3.0.2-reader-polish)
 *
 * - 接收 OSD viewer (含 bounds + viewport API) + 一个可写 ref<ScaleMode>
 * - watch ref, 变化时立即 applyScale
 * - 6 种 scale mode 映射到 OSD viewport API
 * - 跨 spread / mode (single ↔ double) 切换时手动重 apply (调用方负责)
 *
 * 抽象 OSDViewer 接口, 测试时直接 mock, 不依赖真实 OpenSeadragon 实例.
 */
import { watch, type Ref } from 'vue';
import type { ScaleMode } from '@/lib/readerSettings';

/** OSD viewport 暴露的最小 API 子集 (Cluster C 需要) */
export interface OSDBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OSDViewerLike {
  viewport: {
    goHome: (immediately?: boolean) => void;
    fitBounds: (bounds: OSDBounds, immediately?: boolean) => void;
    fitBoundsWithAlignment: (bounds: OSDBounds, align: { x: number; y: number }, immediately?: boolean) => void;
    zoomTo: (zoom: number, refPoint?: { x: number; y: number } | null, immediately?: boolean) => void;
    panTo: (point: { x: number; y: number }, immediately?: boolean) => void;
    getContainerSize: () => { x: number; y: number };
  };
  world: {
    getItemAt: (idx: number) => { getBounds: () => OSDBounds } | null;
  };
}

export interface UseReaderScaleOptions {
  /** ref<OSDViewer | null>, viewer mount 后会更新 (单页) 或包含两个 (双页) */
  viewerRef: Ref<OSDViewerLike | null>;
  /** ref<ScaleMode>, 监听变化触发 applyScale */
  mode: Ref<ScaleMode>;
}

/**
 * useReaderScale - 把 ScaleMode 应用到 OSD viewer.
 *
 * 测试时 mock OSDViewerLike + Ref, 验证 6 种 mode 都调对应 API.
 */
export function useReaderScale(opts: UseReaderScaleOptions): void {
  function applyScale(mode: ScaleMode): void {
    const viewer = opts.viewerRef.value;
    if (!viewer) return;
    const item = viewer.world.getItemAt(0);
    if (!item) return;
    const bounds = item.getBounds();
    const container = viewer.viewport.getContainerSize();

    switch (mode) {
      case 'fit-screen':
        viewer.viewport.goHome();
        break;
      case 'fit-width':
        // 顶部对齐 + 水平居中 (Xplorer 风)
        viewer.viewport.fitBoundsWithAlignment(bounds, { x: 0.5, y: 0 }, false);
        break;
      case 'fit-height':
        viewer.viewport.fitBoundsWithAlignment(bounds, { x: 0.5, y: 0.5 }, false);
        break;
      case 'full-screen':
        // 不留黑边 (assumeFillViewport)
        viewer.viewport.fitBounds(bounds, true);
        break;
      case 'original': {
        // 1:1 缩放 = zoom 1
        viewer.viewport.zoomTo(1, null, false);
        // 居中到图心
        viewer.viewport.panTo({
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        });
        break;
      }
      case 'stretch': {
        // 双方向覆盖 = 取 max(widthRatio, heightRatio)
        const zoomX = container.x / bounds.width;
        const zoomY = container.y / bounds.height;
        const stretchZoom = Math.max(zoomX, zoomY);
        viewer.viewport.zoomTo(stretchZoom, null, true);
        break;
      }
    }
  }

  watch(
    () => opts.mode.value,
    (mode) => applyScale(mode),
    { immediate: false },  // 不要 immediate, viewer mount 后由调用方触发一次
  );
}