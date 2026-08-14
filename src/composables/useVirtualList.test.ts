/**
 * useVirtualList.test.ts — v0.1.0-module3.0.4-virtuallist
 *
 * Task 2.1: 骨架 + visibleRange/visibleEntries/totalHeight
 * Task 2.2: scrollToIndex + scrollToPath
 * Task 2.3: ResizeObserver + rAF scroll 节流
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
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

  it('scrollToPath 用 pathIndex O(1): 10000 entries < 1ms', () => {
    const entries = ref(Array.from({ length: 10000 }, (_, i) => mockEntry(`f${i}`)));
    const pathIndex = ref(new Map(entries.value.map((e, i) => [e.path, i])));
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29, pathIndex });
    const t0 = performance.now();
    scrollToPath('f5000');
    const t1 = performance.now();
    expect(scrollTop.value).toBe(5000 * 29);
    // O(1) Map.get 应远小于 1ms; 留 5ms 阈值防 happy-dom 噪声
    expect(t1 - t0).toBeLessThan(5);
  });

  it('scrollToPath 用 pathIndex 时 fallback findIndex 不被调用', () => {
    const entries = ref([mockEntry('a'), mockEntry('b')]);
    const pathIndex = ref(new Map([['a', 0], ['b', 1]]));
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29, pathIndex });
    pathIndex.value.delete('a');  // Map 里删 'a', 但 entries 仍有 'a'
    scrollToPath('a');  // findIndex 会找到 0, 但 pathIndex.get 返回 undefined → no-op
    expect(scrollTop.value).toBe(0);  // 没动
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

describe('useVirtualList watch(entries) clamp', () => {
  it('entries 14949 → 10: scrollTop 超 max → 自动 clamp 到 0', async () => {
    const big = Array.from({ length: 14949 }, (_, i) => mockEntry(`f${i}`));
    const small = Array.from({ length: 10 }, (_, i) => mockEntry(`s${i}`));
    const entries = ref<MediaEntry[]>(big);
    const { scrollTop, containerRef, scrollToIndex, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    const div = document.createElement('div');
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(div, 'clientHeight', { value: 290 });
    document.body.appendChild(div);
    containerRef.value = div;
    viewportHeight.value = 290;  // happy-dom 不主动触发 ResizeObserver, 手动同步 clientHeight → viewportHeight
    scrollToIndex(10000);  // scrollTop = 290000
    expect(scrollTop.value).toBe(290000);

    entries.value = small;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));

    // 10 entries * 29 = 290, totalHeight - vh = 290 - 290 = 0 → clamp 到 0
    expect(scrollTop.value).toBe(0);
    expect(div.scrollTop).toBe(0);
    document.body.removeChild(div);
  });

  it('entries 14949 → 1000: scrollTop 部分 clamp', async () => {
    const big = Array.from({ length: 14949 }, (_, i) => mockEntry(`f${i}`));
    const medium = Array.from({ length: 1000 }, (_, i) => mockEntry(`m${i}`));
    const entries = ref<MediaEntry[]>(big);
    const { scrollTop, containerRef, scrollToIndex, viewportHeight } = useVirtualList(entries, { rowHeight: 29 });
    const div = document.createElement('div');
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(div, 'clientHeight', { value: 290 });
    document.body.appendChild(div);
    containerRef.value = div;
    viewportHeight.value = 290;
    scrollToIndex(14000);  // scrollTop = 406000
    expect(scrollTop.value).toBe(406000);

    entries.value = medium;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));

    // 1000 * 29 = 29000, totalHeight - vh = 29000 - 290 = 28710
    expect(scrollTop.value).toBe(28710);
    document.body.removeChild(div);
  });

  it('entries 100 → 1000 (扩容): scrollTop 不变 (不需要 clamp)', async () => {
    const small = Array.from({ length: 100 }, (_, i) => mockEntry(`s${i}`));
    const big = Array.from({ length: 1000 }, (_, i) => mockEntry(`b${i}`));
    const entries = ref<MediaEntry[]>(small);
    const { scrollTop, containerRef } = useVirtualList(entries, { rowHeight: 29 });
    const div = document.createElement('div');
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(div, 'clientHeight', { value: 290 });
    document.body.appendChild(div);
    containerRef.value = div;
    scrollTop.value = 1000;

    entries.value = big;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));

    // 扩容后 max = 29000 - 290 = 28710 > 1000, 不需要
    expect(scrollTop.value).toBe(1000);
    document.body.removeChild(div);
  });

  it('entries → 空数组: scrollTop clamp 到 0', async () => {
    const some = Array.from({ length: 10 }, (_, i) => mockEntry(`s${i}`));
    const entries = ref<MediaEntry[]>(some);
    const { scrollTop, containerRef } = useVirtualList(entries, { rowHeight: 29 });
    const div = document.createElement('div');
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(div, 'clientHeight', { value: 290 });
    document.body.appendChild(div);
    containerRef.value = div;
    scrollTop.value = 100;

    entries.value = [];
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));

    expect(scrollTop.value).toBe(0);
    document.body.removeChild(div);
  });
});

describe('useVirtualList rowHeight: Ref<number>', () => {
  it('rowHeight ref 变化 → totalHeight 响应式重算', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    const rowHeightRef = ref(29);
    const { totalHeight } = useVirtualList(entries, { rowHeight: rowHeightRef });
    expect(totalHeight.value).toBe(100 * 29);  // 2900

    rowHeightRef.value = 132;
    expect(totalHeight.value).toBe(100 * 132);  // 13200 (grid view)
  });

  it('rowHeight ref 变化 → visibleRange 重算 (依赖 rh 除法)', () => {
    const entries = ref(Array.from({ length: 1000 }, (_, i) => mockEntry(`f${i}`)));
    const rowHeightRef = ref(29);
    const { visibleRange, viewportHeight, scrollTop } = useVirtualList(entries, { rowHeight: rowHeightRef });
    viewportHeight.value = 290;
    scrollTop.value = 290;  // 列表视图: scrollTop/rh = 10

    // list (rh=29): rawStart = 10 - 5 = 5, rawEnd = ceil(580/29) + 5 = 20+5 = 25
    expect(visibleRange.value.start).toBe(5);
    expect(visibleRange.value.end).toBe(25);

    // 切到 grid (rh=132): rawStart = floor(290/132) - 5 = 2-5 = -3 → clamp 0
    //                     rawEnd = ceil(580/132) + 5 = 5+5 = 10
    rowHeightRef.value = 132;
    expect(visibleRange.value.start).toBe(0);
    expect(visibleRange.value.end).toBe(10);
  });
});

// ─── scroll 事件同步（module3.0.11 期间发现的预存在 bug 修复）───────────────
// 旧实现 rAF 节流两个缺陷：
//  (a) `if (rafId !== null) return` —— pending rAF 未执行期间（页面不可见时 rAF
//      暂停）所有 scroll 事件被丢弃，scrollTop.value 冻结 → thumbnailWindows
//      computed 不再覆盖可见图 → 瀑布流卡片永久 spinner（快速滚动停滚后复现）
//  (b) listener 绑 onMounted 时的元素快照，容器 DOM 被替换后失效
// 修复：事件内直接同步赋值（Vue ref 赋值仅标记 dirty，computed/watcher 异步
// 批处理，无每像素同步重算），并用 e.target 读值（自适应元素替换）。
describe('useVirtualList scroll 同步（hotfix）', () => {
  it('scroll 事件同步更新 scrollTop.value（不等 rAF）', async () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    let result!: ReturnType<typeof useVirtualList>;
    const Host = defineComponent({
      setup() {
        result = useVirtualList(entries, { rowHeight: 29 });
        return () => h('div', { ref: result.containerRef, style: 'height: 290px; overflow: auto;' }, [
          h('div', { style: 'height: 2900px' }),
        ]);
      },
    });
    const w = mount(Host, { attachTo: document.body });
    const el = result.containerRef.value!;
    result.viewportHeight.value = 290;
    el.scrollTop = 500;
    el.dispatchEvent(new Event('scroll'));
    // 同步断言：旧 rAF 实现此处 scrollTop.value 仍是 0（rAF 异步）
    expect(result.scrollTop.value).toBe(500);
    w.unmount();
  });

  it('连续快速 scroll 事件不丢最后一次的终点', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)));
    let result!: ReturnType<typeof useVirtualList>;
    const Host = defineComponent({
      setup() {
        result = useVirtualList(entries, { rowHeight: 29 });
        return () => h('div', { ref: result.containerRef, style: 'height: 290px; overflow: auto;' }, [
          h('div', { style: 'height: 2900px' }),
        ]);
      },
    });
    const w = mount(Host, { attachTo: document.body });
    const el = result.containerRef.value!;
    result.viewportHeight.value = 290;
    for (const v of [100, 300, 800, 1200, 1600]) {
      el.scrollTop = v;
      el.dispatchEvent(new Event('scroll'));
    }
    expect(result.scrollTop.value).toBe(1600);
    w.unmount();
  });
});
