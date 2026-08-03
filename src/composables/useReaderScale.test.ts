/**
 * useReaderScale.test.ts — Cluster C
 *
 * 6 种 scale mode 映射到 OSD viewport API 的单测.
 * 不依赖真实 OpenSeadragon, mock OSDViewerLike 接口.
 */
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
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
  it('mode=fit-screen → viewport.goHome()', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    // initial mode 不 apply, 必须先 set 一次才会触发 (verify watcher fires on change)
    modeRef.value = 'fit-width';
    await Promise.resolve();
    modeRef.value = 'fit-screen';
    await Promise.resolve();
    expect(viewer.viewport.goHome).toHaveBeenCalled();
  });

  it('mode=fit-width → fitBoundsWithAlignment(bounds, {x:0.5, y:0}, false)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    await Promise.resolve();
    expect(viewer.viewport.fitBoundsWithAlignment).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 1000, height: 800 },
      { x: 0.5, y: 0 },
      false,
    );
  });

  it('mode=fit-height → fitBoundsWithAlignment(bounds, {x:0.5, y:0.5}, false)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-height';
    await Promise.resolve();
    expect(viewer.viewport.fitBoundsWithAlignment).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 1000, height: 800 },
      { x: 0.5, y: 0.5 },
      false,
    );
  });

  it('mode=full-screen → viewport.fitBounds(bounds, true)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'full-screen';
    await Promise.resolve();
    expect(viewer.viewport.fitBounds).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 1000, height: 800 },
      true,
    );
  });

  it('mode=original → viewport.zoomTo(1, null, false) + panTo(center)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'original';
    await Promise.resolve();
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1, null, false);
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 500, y: 400 });
  });

  it('mode=stretch → viewport.zoomTo(max(widthRatio, heightRatio), null, true)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'stretch';
    await Promise.resolve();
    // container: 1280x800, bounds: 1000x800
    // zoomX = 1.28, zoomY = 1.0 → max = 1.28
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1.28, null, true);
  });

  it('viewer 为 null 时不调任何 API (graceful no-op)', async () => {
    const viewerRef = ref<OSDViewerLike | null>(null);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    await Promise.resolve();
    // 不应抛错. 无 viewer 即 silent noop.
    expect(true).toBe(true);
  });

  it('world.getItemAt(0) 返回 null 时不调任何 API', async () => {
    const viewer = makeViewer({
      world: {
        getItemAt: () => null,
      },
    });
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    useReaderScale({ viewerRef, mode: modeRef });
    modeRef.value = 'fit-width';
    await Promise.resolve();
    expect(viewer.viewport.fitBoundsWithAlignment).not.toHaveBeenCalled();
    expect(viewer.viewport.zoomTo).not.toHaveBeenCalled();
  });
});

// 引入 Ref 类型
import type { Ref } from 'vue';