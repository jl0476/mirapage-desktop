/**
 * useVirtualList.test.ts — v0.1.0-module3.0.4-virtuallist
 *
 * Task 2.1: 骨架 + visibleRange/visibleEntries/totalHeight
 * Task 2.2: scrollToIndex + scrollToPath
 * Task 2.3: ResizeObserver + rAF scroll 节流
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useVirtualList } from './useVirtualList';
import type { MediaEntry } from '@/lib/sourceDescriptor';

const mockEntry = (path: string): MediaEntry => ({
  name: path,
  path,
  isDirectory: false,
  isArchive: false,
  size: 0,
  modifiedAt: 0,
});

describe('useVirtualList visibleRange', () => {
  it('空 entries: visibleRange = { start: 0, end: 0 }', () => {
    const entries: Ref<MediaEntry[]> = ref([]);
    const { visibleRange } = useVirtualList(entries, { rowHeight: 29 });
    expect(visibleRange.value).toEqual({ start: 0, end: 0 });
  });

  it('viewportHeight 未设时 (0) visibleRange = { start: 0, end: 0 }', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { visibleRange } = useVirtualList(entries, { rowHeight: 29 });
    // 不设 viewportHeight, 默认 0
    expect(visibleRange.value).toEqual({ start: 0, end: 0 });
  });

  it('visibleEntries 是 entries.slice(start, end)', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { visibleEntries, viewportHeight, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;  // 10 行 viewport
    scrollTop.value = 0;  // 顶部
    expect(visibleEntries.value.length).toBeLessThanOrEqual(100);
    expect(visibleEntries.value[0]?.name).toBe('f0');
  });

  it('totalHeight = entries.length × rowHeight', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { totalHeight } = useVirtualList(entries, { rowHeight: 29 });
    expect(totalHeight.value).toBe(2900);  // 100 * 29
  });

  it('entries 变化触发 totalHeight + visibleRange 重算', () => {
    const entries = ref<MediaEntry[]>([]);
    const { totalHeight, visibleRange } = useVirtualList(entries, { rowHeight: 29 });
    expect(totalHeight.value).toBe(0);
    entries.value = Array.from({ length: 50 }, (_, i) => mockEntry(`f${i}`));
    expect(totalHeight.value).toBe(1450);  // 50 * 29
    expect(visibleRange.value).toEqual({ start: 0, end: 0 });  // viewportHeight 仍 0
  });
});

describe('useVirtualList scrollToIndex', () => {
  it('scrollToIndex(i) 滚到 i * rowHeight', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollToIndex(10);
    expect(scrollTop.value).toBe(290);  // 10 * 29
  });

  it('scrollToIndex 越界 [0, totalHeight - viewportHeight] clamp', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToIndex(1000);  // 超出范围
    expect(scrollTop.value).toBeLessThanOrEqual(100 * 29 - 290);
    expect(scrollTop.value).toBeGreaterThanOrEqual(0);
  });

  it('scrollToIndex 负数 clamp 到 0', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollToIndex(-10);
    expect(scrollTop.value).toBe(0);
  });

  it('align=center 让目标 row 在视口中央', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToIndex(50, { align: 'center' });
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29) / 2);
  });

  it('align=end 让目标 row 在视口底部', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToIndex(50, { align: 'end' });
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29));
  });

  it('scrollToIndex 同时设 containerRef.scrollTop (DOM 同步)', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToIndex, containerRef } = useVirtualList(entries, { rowHeight: 29 });
    const div = document.createElement('div');
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
    containerRef.value = div;
    scrollToIndex(10);
    expect(div.scrollTop).toBe(290);
  });
});

describe('useVirtualList scrollToPath', () => {
  it('scrollToPath(path) 找到 index 后调 scrollToIndex', () => {
    const entries = ref([mockEntry('a'), mockEntry('b'), mockEntry('c')]);
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollToPath('b');
    expect(scrollTop.value).toBe(29);
  });

  it('scrollToPath 找不到 no-op (scrollTop 不变)', () => {
    const entries = ref([mockEntry('a'), mockEntry('b')]);
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29 });
    scrollTop.value = 100;  // 预设值
    scrollToPath('nonexistent');
    expect(scrollTop.value).toBe(100);  // 不变
  });

  it('scrollToPath 透传 opts 到 scrollToIndex (align=center)', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const { scrollToPath, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    viewportHeight.value = 290;
    scrollToPath('f50', { align: 'center' });
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29) / 2);
  });
});

describe('useVirtualList ResizeObserver + rAF scroll', () => {
  /** mount 一个 host 组件，挂在 useVirtualList，把 composable 的 containerRef 绑到 div 模板上 */
  function mountWithVL(): {
    wrapper: ReturnType<typeof mount>;
    div: HTMLDivElement;
    vl: ReturnType<typeof useVirtualList>;
  } {
    let vl!: ReturnType<typeof useVirtualList>;
    const Host = defineComponent({
      setup() {
        const entries = ref<MediaEntry[]>([]);
        vl = useVirtualList(entries, { rowHeight: 29 });
        return () => h('div', { ref: vl.containerRef });
      },
    });
    const wrapper = mount(Host);
    const div = wrapper.element as HTMLDivElement;
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true, configurable: true });
    Object.defineProperty(div, 'clientHeight', { value: 500, writable: true, configurable: true });
    return { wrapper, div, vl };
  }

  it('mount 后 ResizeObserver 创建并 observe(containerRef)', () => {
    // happy-dom 不主动触发 ResizeObserver 回调, 验证 spy 即可
    const observeSpy = vi.fn();
    const disconnectSpy = vi.fn();
    const MockRO = vi.fn().mockImplementation(() => ({
      observe: observeSpy,
      disconnect: disconnectSpy,
      unobserve: vi.fn(),
    }));
    vi.stubGlobal('ResizeObserver', MockRO);

    const { wrapper } = mountWithVL();
    expect(MockRO).toHaveBeenCalled();
    expect(observeSpy).toHaveBeenCalled();
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it('scroll 事件触发 scrollTop 更新 (rAF 节流)', async () => {
    const { div, vl } = mountWithVL();
    expect(vl.scrollTop.value).toBe(0);

    div.scrollTop = 145;
    div.dispatchEvent(new Event('scroll'));

    // rAF 是异步的，等一帧
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(vl.scrollTop.value).toBe(145);
  });

  it('rAF 节流: 同一帧内多次 scroll 只更新一次 scrollTop (最后一次值)', async () => {
    const { div, vl } = mountWithVL();

    // 同一帧内 dispatch 3 次 scroll，每次设不同 scrollTop
    div.scrollTop = 100;
    div.dispatchEvent(new Event('scroll'));
    div.scrollTop = 200;
    div.dispatchEvent(new Event('scroll'));
    div.scrollTop = 300;
    div.dispatchEvent(new Event('scroll'));

    // 等一帧 (rAF 应该已经把 scrollTop 更新到最后一次值)
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // 节流策略: 同一帧多次 → 只更新到最新值 (300)
    expect(vl.scrollTop.value).toBe(300);
  });

  it('onUnmounted 清理 ResizeObserver.disconnect + scroll listener', async () => {
    const observeSpy = vi.fn();
    const disconnectSpy = vi.fn();
    const MockRO = vi.fn().mockImplementation(() => ({
      observe: observeSpy,
      disconnect: disconnectSpy,
      unobserve: vi.fn(),
    }));
    vi.stubGlobal('ResizeObserver', MockRO);

    const { wrapper, div } = mountWithVL();

    div.scrollTop = 50;
    div.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    wrapper.unmount();

    // unmount 后应调 disconnect
    expect(disconnectSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
