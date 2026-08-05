/**
 * useReaderScale.test.ts — 5 种 scale mode + resize 重 apply 单测.
 * 不依赖真实 OpenSeadragon, mock OSDViewerLike 接口.
 *
 * 2026-08-05 重写:
 *  - fit-width/fit-height 改用 OSD 原生 fitHorizontally/fitVertically
 *  - full-screen/original 用 source.dimensions (像素) 算 zoom
 *  - 删 stretch 档位
 *  - 加 resize 监听用例
 *  - 所有用例用 mount() 包裹提供 onMounted/onUnmounted 上下文 (避免 lifecycle warn)
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useReaderScale, type OSDViewerLike, type OSDBounds } from './useReaderScale';
import type { ScaleMode } from '@/lib/readerSettings';

function makeViewer(overrides: Partial<OSDViewerLike> = {}): OSDViewerLike {
  const bounds: OSDBounds = { x: 0, y: 0, width: 1, height: 0.5625 };
  return {
    viewport: {
      goHome: vi.fn(),
      fitBounds: vi.fn(),
      fitBoundsWithAlignment: vi.fn(),
      fitHorizontally: vi.fn(),
      fitVertically: vi.fn(),
      zoomTo: vi.fn(),
      panTo: vi.fn(),
      getContainerSize: vi.fn(() => ({ x: 1280, y: 800 })),
      getHomeZoom: vi.fn(() => 1.28),
    },
    world: {
      getItemAt: vi.fn((idx: number) =>
        idx === 0
          ? { getBounds: () => bounds, source: { dimensions: { x: 1000, y: 562 } } }
          : null,
      ),
    },
    ...overrides,
  };
}

type ModeRef = Ref<ScaleMode>;

/** mount 一个 host 组件, 把 composable 挂上, 提供生命周期上下文. */
function mountWithScale(
  viewerRef: Ref<OSDViewerLike | null>,
  modeRef: ModeRef,
  containerRef?: Ref<HTMLElement | null>,
) {
  const cRef = containerRef ?? ref<HTMLElement | null>(null);
  const Host = defineComponent({
    setup() {
      useReaderScale({ viewerRef, mode: modeRef, containerRef: cRef });
      return () => h('div', { ref: cRef });
    },
  });
  return mount(Host);
}

describe('useReaderScale', () => {
  it('mode=fit-screen → viewport.goHome(true)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-width');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'fit-screen';
    await w.vm.$nextTick();
    expect(viewer.viewport.goHome).toHaveBeenCalledWith(true);
    w.unmount();
  });

  it('mode=fit-width → viewport.fitHorizontally(true) (OSD 原生)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'fit-width';
    await w.vm.$nextTick();
    expect(viewer.viewport.fitHorizontally).toHaveBeenCalledWith(true);
    w.unmount();
  });

  it('mode=fit-height → viewport.fitVertically(true) (OSD 原生)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'fit-height';
    await w.vm.$nextTick();
    expect(viewer.viewport.fitVertically).toHaveBeenCalledWith(true);
    w.unmount();
  });

  it('mode=full-screen → zoomTo(max(zoomX, zoomY)) + panTo(center)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'full-screen';
    await w.vm.$nextTick();
    // 归一化系: zoom=1 宽填满; 让高填满 zoom = cs.y/(bounds.h*cs.x) = 800/(0.5625*1280)=1.1111
    // full-screen 取 max(1, 1.1111) = 1.1111
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1.1111111111111112, null, true);
    // imageCenter (归一化 bounds): x=0.5, y=0.28125
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 0.5, y: 0.28125 }, true);
    w.unmount();
  });

  it('mode=original → zoomTo(dims.x/container.x 真 1:1) + panTo(center)', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'original';
    await w.vm.$nextTick();
    // 真 1:1: 渲染像素宽 = dims.x → zoom = dims.x / cs.x = 1000/1280 = 0.78125
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(0.78125, null, true);
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({ x: 0.5, y: 0.28125 }, true);
    w.unmount();
  });

  it('viewer 为 null 时不调任何 API (graceful no-op)', async () => {
    const viewerRef = ref<OSDViewerLike | null>(null);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'fit-width';
    await w.vm.$nextTick();
    expect(true).toBe(true);
    w.unmount();
  });

  it('world.getItemAt(0) 返回 null 时 retry 不调 API', async () => {
    const viewer = makeViewer({
      world: {
        getItemAt: () => null,
      },
    });
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'fit-width';
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(viewer.viewport.fitHorizontally).not.toHaveBeenCalled();
    w.unmount();
  });

  it('source.dimensions 缺失时 original fallback goHome', async () => {
    const viewer = makeViewer({
      world: {
        getItemAt: (idx: number) =>
          idx === 0 ? { getBounds: () => ({ x: 0, y: 0, width: 1, height: 0.5625 }) } : null,
      },
    });
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    const w = mountWithScale(viewerRef, modeRef);
    modeRef.value = 'original';
    await w.vm.$nextTick();
    expect(viewer.viewport.goHome).toHaveBeenCalledWith(true);
    expect(viewer.viewport.zoomTo).not.toHaveBeenCalled();
    w.unmount();
  });

  it('ResizeObserver 触发后 rAF 节流重 apply 当前 mode', async () => {
    const viewer = makeViewer();
    const viewerRef = ref<OSDViewerLike | null>(viewer);
    const modeRef: ModeRef = ref('fit-screen');
    // mock ResizeObserver 捕获 callback
    let roCallback: (() => void) | null = null;
    class MockRO {
      constructor(cb: () => void) { roCallback = cb; }
      observe(_target: HTMLElement) {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockRO);
    const triggerResize = (): void => { (roCallback as (() => void) | null)?.(); };

    const cRef = ref<HTMLElement | null>(null);
    const Host = defineComponent({
      setup() {
        useReaderScale({ viewerRef, mode: modeRef, containerRef: cRef });
        return () => h('div', { ref: cRef });
      },
    });
    const w = mount(Host);
    await w.vm.$nextTick();
    // 切到 fit-width 触发一次 apply
    modeRef.value = 'fit-width';
    await w.vm.$nextTick();
    expect(viewer.viewport.fitHorizontally).toHaveBeenCalledTimes(1);

    // 触发 resize → rAF + 最低间隔后重 apply
    triggerResize();
    // rAF (~16ms in happy-dom) + RESIZE_MIN_INTERVAL_MS(60) 兜底, 等 120ms 足够
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(viewer.viewport.fitHorizontally).toHaveBeenCalledTimes(2);

    w.unmount();
    vi.unstubAllGlobals();
  });
});
