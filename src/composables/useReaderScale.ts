/**
 * useReaderScale.ts — Cluster C: OSD 缩放控制 (v0.1.0-module3.0.2-reader-polish)
 *
 * - 接收 OSD viewer (含 bounds + viewport API) + 一个可写 ref<ScaleMode>
 * - watch ref, 变化时立即 applyScale
 * - 6 种 scale mode 映射到 OSD viewport API (zoomTo + panTo — 简单可靠)
 * - 跨 spread / mode (single ↔ double) 切换时手动重 apply (调用方负责)
 *
 * 抽象 OSDViewer 接口, 测试时直接 mock, 不依赖真实 OpenSeadragon 实例.
 *
 * v0.1.0-reader-review-fix-2:
 *  - 改用 zoomTo + panTo 替代 fitBoundsWithAlignment (alignment 格式不被 OSD 接受)
 *  - retry 延长到 5s (50 * 100ms)
 *  - 详细 log: 哪个分支执行, zoom 值, pan 目标
 */
import { watch, type Ref } from 'vue';
import { log } from '@/lib/logger';
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
    fitBoundsWithAlignment: (bounds: OSDBounds, align: unknown, immediately?: boolean) => void;
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

const RETRY_INTERVAL_MS = 100;
const RETRY_MAX = 50;  // 100ms * 50 = 5s — wait for OSD tile load (WebView2 + Tauri IPC 慢)

/**
 * useReaderScale - 把 ScaleMode 应用到 OSD viewer.
 *
 * 测试时 mock OSDViewerLike + Ref, 验证 6 种 mode 都调对应 API.
 */
export function useReaderScale(opts: UseReaderScaleOptions): void {
  function applyScale(mode: ScaleMode, attempt: number = 0): void {
    const viewer = opts.viewerRef.value;
    if (!viewer) {
      log('[useReaderScale] viewerRef null, skip (mode=', mode, 'attempt=', attempt, ')');
      return;
    }
    const item = viewer.world.getItemAt(0);
    if (!item) {
      if (attempt < RETRY_MAX) {
        if (attempt % 10 === 0) {
          log('[useReaderScale] item null, retry', attempt, '/', RETRY_MAX, '(mode=', mode, ')');
        }
        setTimeout(() => applyScale(mode, attempt + 1), RETRY_INTERVAL_MS);
      } else {
        log('[useReaderScale] item null after', RETRY_MAX, 'retries, give up (mode=', mode, ')');
      }
      return;
    }

    const bounds = item.getBounds();
    const container = viewer.viewport.getContainerSize();
    const imageCenter = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };

    log('[useReaderScale] apply', mode, 'bounds=', bounds, 'container=', container, 'attempt=', attempt);

    switch (mode) {
      case 'fit-screen': {
        // OSD home bounds: 默认 fit image 在 viewport 内
        viewer.viewport.goHome(true);
        break;
      }
      case 'fit-width': {
        // 宽度填满, 顶部对齐. zoom 后 panTo 让 viewport 中心 = imageCenter.x (水平居中)
        // 且 viewport.top 落在 image.top — 这要求 viewport 中心 y = bounds.y + container.y/(2*zoom)
        const zoom = container.x / bounds.width;
        viewer.viewport.zoomTo(zoom, null, true);
        viewer.viewport.panTo({
          x: imageCenter.x,
          y: bounds.y + container.y / (2 * zoom),
        }, true);
        break;
      }
      case 'fit-height': {
        // 高度填满, 垂直居中, 左边对齐
        const zoom = container.y / bounds.height;
        viewer.viewport.zoomTo(zoom, null, true);
        viewer.viewport.panTo({
          x: bounds.x + container.x / (2 * zoom),
          y: imageCenter.y,
        }, true);
        break;
      }
      case 'full-screen': {
        // 不留黑边, 可能裁剪
        const zoomX = container.x / bounds.width;
        const zoomY = container.y / bounds.height;
        viewer.viewport.zoomTo(Math.max(zoomX, zoomY), null, true);
        viewer.viewport.panTo(imageCenter, true);
        break;
      }
      case 'original': {
        // 1:1 + 居中
        viewer.viewport.zoomTo(1, null, true);
        viewer.viewport.panTo(imageCenter, true);
        break;
      }
      case 'stretch': {
        // 双方向都填满 (uniform scale, 取 max)
        const zoomX = container.x / bounds.width;
        const zoomY = container.y / bounds.height;
        viewer.viewport.zoomTo(Math.max(zoomX, zoomY), null, true);
        viewer.viewport.panTo(imageCenter, true);
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