/**
 * useReaderScale.ts — OSD 缩放控制
 *
 * - 接收 OSD viewer + 可写 ref<ScaleMode> + 容器 ref
 * - watch mode 变化 → applyScale
 * - ResizeObserver 监听容器,尺寸变化后 debounce 重 apply (fit-screen/width/height 在窗口
 *   极端长宽比下需重算,否则图像溢出需拖动)
 *
 * 坐标系说明 (2026-08-05 修复):
 *  - item.getBounds() 返回 **归一化坐标** (image width 归一到 1, height 按比例).
 *    旧代码把它当像素除 container, 算出 zoom=1407 飞掉.
 *  - fit-width/fit-height 改用 OSD 原生 fitHorizontally/fitVertically (内部用 _contentBounds
 *    归一化坐标自己处理, 可靠).
 *  - full-screen 需像素尺寸算 max(zoomX, zoomY), 从 TiledImage.source.dimensions (像素 Point) 取.
 *  - original 的 zoom=1 在归一化系下是 home zoom 不是 1:1; 真 1:1 用 1/getHomeZoom() 缩放.
 */
import { onMounted, onUnmounted, watch, type Ref } from 'vue';
import { log } from '@/lib/logger';
import type { ScaleMode } from '@/lib/readerSettings';

/** OSD viewport 暴露的最小 API 子集 */
export interface OSDBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OSDPoint {
  x: number;
  y: number;
}

export interface OSDTiledImage {
  getBounds: () => OSDBounds;
  source?: {
    dimensions?: OSDPoint;
  };
}

export interface OSDViewerLike {
  viewport: {
    goHome: (immediately?: boolean) => void;
    fitBounds: (bounds: OSDBounds, immediately?: boolean) => void;
    fitBoundsWithAlignment: (bounds: OSDBounds, align: unknown, immediately?: boolean) => void;
    fitHorizontally: (immediately?: boolean) => void;
    fitVertically: (immediately?: boolean) => void;
    zoomTo: (zoom: number, refPoint?: { x: number; y: number } | null, immediately?: boolean) => void;
    panTo: (point: { x: number; y: number }, immediately?: boolean) => void;
    getContainerSize: () => OSDPoint;
    getHomeZoom: () => number;
  };
  world: {
    getItemAt: (idx: number) => OSDTiledImage | null;
  };
}

export interface UseReaderScaleOptions {
  /** ref<OSDViewer | null>, viewer mount 后会更新 */
  viewerRef: Ref<OSDViewerLike | null>;
  /** ref<ScaleMode>, 监听变化触发 applyScale */
  mode: Ref<ScaleMode>;
  /** OSD 容器元素 ref, 用于 ResizeObserver 监听尺寸变化 */
  containerRef: Ref<HTMLElement | null>;
}

const RETRY_INTERVAL_MS = 100;
const RETRY_MAX = 50;  // 100ms * 50 = 5s — wait for OSD tile load
// resize 用 requestAnimationFrame 节流: 每帧最多 apply 一次 (~16ms).
// 比 setTimeout debounce 更跟手 — 拖窗口时图像实时跟着缩放, 不需等停手.
// 加最低间隔保护 (60ms), 防 OSD fitBounds 重算成本高掉帧.
const RESIZE_MIN_INTERVAL_MS = 60;

/**
 * useReaderScale - 把 ScaleMode 应用到 OSD viewer + 监听容器 resize 重 apply.
 */
export function useReaderScale(opts: UseReaderScaleOptions): void {
  let rafId: number | null = null;
  let lastApplyAt = 0;
  let resizeObserver: ResizeObserver | null = null;

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
        // OSD home bounds: 默认 fit image 在 viewport 内 (全图可见留黑边)
        viewer.viewport.goHome(true);
        break;
      }
      case 'fit-width': {
        // OSD 原生: 宽度填满, 高度自适应. 内部用 _contentBounds 归一化坐标处理.
        viewer.viewport.fitHorizontally(true);
        break;
      }
      case 'fit-height': {
        // OSD 原生: 高度填满, 宽度自适应.
        viewer.viewport.fitVertically(true);
        break;
      }
      case 'full-screen': {
        // 不留黑边, 可能裁剪. 归一化系下:
        //  - zoom=1 → 图宽(bounds.width=1)填满 container 宽
        //  - 让图高填满: zoom * bounds.height * cs.x = cs.y → zoom = cs.y / (bounds.height * cs.x)
        //  - full-screen 取 max 让至少一边填满, 另一边溢出裁剪
        const zoomW = 1;
        const zoomH = container.y / (bounds.height * container.x);
        viewer.viewport.zoomTo(Math.max(zoomW, zoomH), null, true);
        viewer.viewport.panTo(imageCenter, true);
        break;
      }
      case 'original': {
        // 1:1 像素. 归一化系下渲染像素宽 = zoom * container.x.
        // 要渲染像素宽 = source 像素宽 → zoom = dims.x / container.x
        const dims = item.source?.dimensions;
        if (!dims) {
          log('[useReaderScale] original: source.dimensions missing, fallback goHome');
          viewer.viewport.goHome(true);
          break;
        }
        viewer.viewport.zoomTo(dims.x / container.x, null, true);
        viewer.viewport.panTo(imageCenter, true);
        break;
      }
    }
  }

  watch(
    () => opts.mode.value,
    (mode) => applyScale(mode),
    { immediate: false },
  );

  // resize 监听: rAF 节流 + 最低间隔保护. 拖窗口时图像实时跟缩放, 不等停手.
  function onResize(): void {
    if (rafId !== null) return;  // 已有 pending frame, 等下一帧
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const now = Date.now();
      const elapsed = now - lastApplyAt;
      if (elapsed < RESIZE_MIN_INTERVAL_MS) {
        // 距上次太近, 延后到剩余间隔后 apply (防 OSD fitBounds 重算掉帧)
        setTimeout(() => {
          lastApplyAt = Date.now();
          applyScale(opts.mode.value);
        }, RESIZE_MIN_INTERVAL_MS - elapsed);
      } else {
        lastApplyAt = now;
        applyScale(opts.mode.value);
      }
    });
  }

  onMounted(() => {
    const el = opts.containerRef.value;
    if (!el || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(el);
  });

  onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    resizeObserver?.disconnect();
    resizeObserver = null;
  });
}
