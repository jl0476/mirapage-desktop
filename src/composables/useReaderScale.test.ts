/**
 * useReaderScale.test.ts — Cluster C
 *
 * 6 种 scale mode 映射到 OSD viewport API 的单测.
 * 不依赖真实 OpenSeadragon, mock OSDViewerLike 接口.
 *
 * v0.1.0-reader-review-fix-2: 改用 zoomTo + panTo (替代 fitBoundsWithAlignment)
 */
import { describe, it, expect, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { useReaderScale, type OSDViewerLike, type OSDBounds } from './useReaderScale';
import type { ScaleMode } from '@/lib/readerSettings';

function makeViewer(overrides: Partial<OSDViewerLike> = {}): OSDViewerLike {
  const bounds: OSDBounds = { x: 0, y: 0, width: 1000, height: 800 };
  return {
    viewport: {
      goHome: vi.fn(),
      fitBounds: vi.fn(),
      fitBoundsWithAlignment: vi.fn(),
      zoomTo: vi.fn(),
      panTo: vi.fn(),
      getContainerSize: vi.fn(() => ({ x: 1280, y: 800 })),
    },
    world: {
      getItemAt: vi.fn((idx: number) =>
        idx === 0 ? { getBounds: () => bounds } : null,
      ),
    },
    ...overrides,
  };
}

type ModeRef = Ref<ScaleMode>;

describe('useReaderScale', () => {
  it('mode=fit-screen → viewport.goHome(true)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    await Promise.resolve();
    modeRef.value = 'fit-screen';
    await Promise.resolve();
    expect(viewer.viewport.goHome).toHaveBeenCalledWith(true);
  });

  it('mode=fit-width → zoomTo(widthRatio) + panTo(top, 顶部对齐公式)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    await Promise.resolve();
    // container 1280 / bounds.width 1000 = 1.28
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1.28, null, true);
    // 顶部对齐公式: vpY = bounds.y + container.y/(2*zoom) = 0 + 800/(2*1.28) ≈ 312.5
    // vpX = bounds.x + bounds.width/2 = 500
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 500, y: 312.5 }, true);
  });

  it('mode=fit-height → zoomTo(heightRatio) + panTo(左对齐公式)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-height';
    await Promise.resolve();
    // container 800 / bounds.height 800 = 1.0
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1.0, null, true);
    // 左对齐公式: vpX = bounds.x + container.x/(2*zoom) = 0 + 1280/2 = 640
    // vpY = bounds.y + bounds.height/2 = 400
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 640, y: 400 }, true);
  });

  it('mode=full-screen → zoomTo(max(wR, hR)) + panTo(center)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'full-screen';
    await Promise.resolve();
    // max(1.28, 1.0) = 1.28
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1.28, null, true);
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 500, y: 400 }, true);
  });

  it('mode=original → zoomTo(1) + panTo(center)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'original';
    await Promise.resolve();
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1, null, true);
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 500, y: 400 }, true);
  });

  it('mode=stretch → zoomTo(max(widthRatio, heightRatio)) + panTo(center)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'stretch';
    await Promise.resolve();
    // container: 1280x800, bounds: 1000x800
    // zoomX = 1.28, zoomY = 1.0 → max = 1.28
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1.28, null, true);
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 500, y: 400 }, true);
  });

  it('viewer 为 null 时不调任何 API (graceful no-op)', async () => {
    const viewerRef = ref<OSDViewerLike | null>(null);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    await Promise.resolve();
    expect(true).toBe(true);
  });

  it('world.getItemAt(0) 返回 null 时 retry 不调 API', async () => {
    const viewer = makeViewer({
      world: {
        getItemAt: () => null,
      },
    });
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    // retry 用 setTimeout 100ms, 等到 100ms 后再断言 (确保 retry 跑过)
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(viewer.viewport.zoomTo).not.toHaveBeenCalled();
    expect(viewer.viewport.panTo).not.toHaveBeenCalled();
  });
});