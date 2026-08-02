/**
 * SinglePageViewer.vue 测试
 * 单页 OpenSeadragon 实例：1 个 OpenSeadragon viewer + imageUrl prop
 *
 * OpenSeadragon 是依赖 DOM canvas 的库，本测试用最小化的 mock 验证 props / emits。
 * 完整渲染验证留给 tauri:dev 集成测试。
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

interface MockViewer {
  id: number;
  opts: { tileSources: unknown; element: HTMLElement };
  open: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  addHandler: ReturnType<typeof vi.fn>;
}

// esbuild 在导入期就把 OpenSeadragon 实例化为带 _viewers 的 class
vi.mock('openseadragon', () => {
  const viewers: MockViewer[] = [];
  let nextId = 0;
  function Viewer(opts: { tileSources: unknown; element: HTMLElement }): unknown {
    const v: MockViewer = {
      id: nextId++,
      opts,
      open: vi.fn(),
      destroy: vi.fn(),
      // v0.1.0-module3.0.2-hotfix3: OSD tile load 失败日志 hook
      addHandler: vi.fn(),
    };
    viewers.push(v);
    return v as unknown;
  }
  (Viewer as unknown as { _viewers: MockViewer[] })._viewers = viewers;
  (Viewer as unknown as { _reset: () => void })._reset = () => {
    viewers.length = 0;
    nextId = 0;
  };
  return { default: Viewer };
});

import OpenSeadragon from 'openseadragon';
import SinglePageViewer from './SinglePageViewer.vue';

function getViewers(): MockViewer[] {
  return (OpenSeadragon as unknown as { _viewers: MockViewer[] })._viewers;
}

describe('SinglePageViewer.vue', () => {
  it('mounts an OpenSeadragon viewer bound to its container element', () => {
    (OpenSeadragon as unknown as { _reset: () => void })._reset();
    const w = mount(SinglePageViewer, {
      props: { imageUrl: 'file:///a.jpg' },
      attachTo: document.body,
    });
    // container element 存在
    expect(w.find('[data-test="viewer-container"]').exists()).toBe(true);
    // OpenSeadragon 已被实例化（mock 拦截）
    expect(getViewers().length).toBe(1);
    w.unmount();
  });

  it('calls viewer.open when imageUrl prop changes', async () => {
    (OpenSeadragon as unknown as { _reset: () => void })._reset();
    const w = mount(SinglePageViewer, {
      props: { imageUrl: 'file:///a.jpg' },
      attachTo: document.body,
    });
    const viewer = getViewers()[0];
    expect(viewer.open).not.toHaveBeenCalled();

    await w.setProps({ imageUrl: 'file:///b.jpg' });
    expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url: 'file:///b.jpg' });
    w.unmount();
  });

  it('destroys viewer on unmount', () => {
    (OpenSeadragon as unknown as { _reset: () => void })._reset();
    const w = mount(SinglePageViewer, {
      props: { imageUrl: 'file:///a.jpg' },
      attachTo: document.body,
    });
    const viewer = getViewers()[0];
    w.unmount();
    expect(viewer.destroy).toHaveBeenCalled();
  });
});
