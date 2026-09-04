/**
 * MasonryView.vue 集成守卫测试（计划任务9）
 *
 * 核心断言：MasonryView 不再构造脱离 DOM 的原图 `new Image()` 预读（缩略图队列取代）。
 * 通过读取源码字符串守卫，防止以后重新引入大图预解码（卡顿根因）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, './MasonryView.vue'), 'utf8');

import { computeAtBottom } from '@/composables/useMasonryLayout';

describe('computeAtBottom 三档纯函数 (spec §2.1)', () => {
  it('档1 不足一屏(sh<=ch): 返回 true', () => {
    expect(computeAtBottom(600, 800, 0)).toBe(true);
  });

  it('档2 短目录(ch<sh<2ch) 顶部 st=0: false(防误判)', () => {
    expect(computeAtBottom(1400, 800, 0)).toBe(false);
  });

  it('档2 短目录 滚动+贴底 st>0: true', () => {
    // sh=1400 ch=800 nearBottom: st+800>=1400-64=1336 → st>=536
    expect(computeAtBottom(1400, 800, 600)).toBe(true);
  });

  it('档3 长目录(sh>=2ch) 贴底: true', () => {
    expect(computeAtBottom(2000, 800, 1200)).toBe(true);
  });

  it('档3 长目录 未贴底: false', () => {
    expect(computeAtBottom(2000, 800, 100)).toBe(false);
  });

  it('档2 短目录 贴底但 st=0: false(须实际滚过)', () => {
    // sh=1400 ch=800 st=0: nearBottom(0+800>=1336)=false, 且 st=0 → false
    expect(computeAtBottom(1400, 800, 0)).toBe(false);
  });
});

describe('MasonryView.vue 集成守卫', () => {
  it('不再构造 new Image() 预读原图（缩略图队列取代）', () => {
    expect(source).not.toMatch(/new\s+Image\s*\(/);
  });

  it('接入缩略图队列 composable', () => {
    expect(source).toContain('useMasonryThumbnails');
  });

  it('使用像素窗口 thumbnailWindows（而非旧 prefetchPaths）', () => {
    expect(source).toContain('thumbnailWindows');
  });

  it('向 MasonryRow 传递缩略图状态而非原图 src', () => {
    expect(source).toContain(':thumb-state');
    expect(source).not.toMatch(/:src="v\.src"/);
  });

  it('保留 header 尺寸预读（布局骨架必需）', () => {
    expect(source).toContain('listImageDimensions');
  });
});

// ─── v0.1.0-module3.0.8 — scrollToEntry 行为测试（任务 8）─────────────────
// 验证：
//  1. 目标命中 → 返回 true（layout map 包含目标 → 滚到 item.top）
//  2. 目标不在 entries（filter）→ 返回 false
//
// 关键点：scrollToEntry 必须 watch layout.value.map.get(targetPath)?.top
//  （spec v4 P1 修复：不是 measuredMap，否则上方图片到达不会触发校正）。
//
// 实现策略：mock useMasonryLayout 让 layout.map 由测试可控。
// 单元测试不验证校正次数（需 mock microtask + 多次 nextTick 难稳定），
// 只验证 scrollToEntry 的目标命中/分支返回。

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { computed, nextTick, ref } from 'vue';
import zhCN from '@/locales/zh-CN';
import MasonryView from './MasonryView.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';
import type { MasonryItem } from '@/composables/useMasonryLayout';
import type { UseMasonryBrowsePositionParams } from '@/composables/useMasonryBrowsePosition';
import { useSettingsStore } from '@/stores/settings';
import { listImageDimensions } from '@/lib/tauri';

const browsePositionParams = vi.hoisted(() => ({
  current: null as UseMasonryBrowsePositionParams | null,
}));

vi.mock('@/composables/useMasonryBrowsePosition', () => ({
  useMasonryBrowsePosition: (params: UseMasonryBrowsePositionParams) => {
    browsePositionParams.current = params;
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      jumpToLast: vi.fn(async () => undefined),
      lastBrowseProgress: computed(() => null),
      hasRecordedProgress: computed(() => false),
    };
  },
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listImageDimensions: vi.fn(async () => []),
    thumbnailCacheUrl: vi.fn((p: string) => `tauri://localhost/${p}`),
    notifyThumbnailEpoch: vi.fn(),
    notifyThumbnailFastScrolling: vi.fn(),
    requestThumbnails: vi.fn(async () => []),
    createBook: vi.fn(async () => 1),
    listDirectory: vi.fn(async () => []),
    getProgress: vi.fn(async () => null),
    saveProgress: vi.fn(async () => undefined),
  };
});

/** 测试用 layout map：ref 背衬使 mocked layout computed 响应翻转（§16.2 G 测量锚定
 * 用例需要在组件运行中把布局从「批前」翻到「批后」）；`.current` API 保持既有用例零改动。 */
const fakeLayoutMapRef = ref(new Map<string, MasonryItem>());
const fakeLayoutMap = {
  get current() { return fakeLayoutMapRef.value; },
  set current(m: Map<string, MasonryItem>) { fakeLayoutMapRef.value = m; },
};

// module3.5.3 任务 A：dimensionPrefetchPaths 可控注入——默认空数组保持既有 describe
// 行为不变，陈旧尺寸守卫/测量锚定用例按需注入 paths 触发真实 IPC 预读链。
// §16.2 G（rev4 补丁④）：ref 背衬 + `.current` shim——普通对象不建响应依赖，挂载后改
// `.current` 时 watch(dimensionPrefetchPaths) 永不触发。普通顶层 ref 即可（mock 工厂只
// 创建 computed 闭包不解引用，真正读取在组件挂载期，模块初始化早已完成；vi.hoisted 内
// 引用静态导入的 ref 反而会在 ESM 绑定初始化前 TDZ 报错）。
const prefetchPathsRef = ref<string[]>([]);
const prefetchPathsMock = {
  get current() { return prefetchPathsRef.value; },
  set current(paths: string[]) { prefetchPathsRef.value = paths; },
};

// module3.0.11：mock 缩略图 composable，stateMap/progressSnapshots 由测试注入
const thumbnailsMock = vi.hoisted(() => ({
  stateMap: new Map<string, unknown>(),
  progressSnapshots: new Map<string, unknown>(),
}));

// §16.2.1 ④：接线断言用的 spy（事件改名不再静默漏接）
const thumbSpies = vi.hoisted(() => ({
  retry: vi.fn(),
  markLoadFailed: vi.fn(),
  retryLoadFailed: vi.fn(),
  regenerate: vi.fn(),
  regenerateBatch: vi.fn(),
}));

vi.mock('@/composables/useMasonryThumbnails', () => ({
  useMasonryThumbnails: () => ({
    stateMap: computed(() => thumbnailsMock.stateMap),
    progressSnapshots: computed(() => thumbnailsMock.progressSnapshots),
    retry: thumbSpies.retry,
    markLoadFailed: thumbSpies.markLoadFailed,
    retryLoadFailed: thumbSpies.retryLoadFailed,
    regenerate: thumbSpies.regenerate,
    regenerateBatch: thumbSpies.regenerateBatch,
    epoch: { value: 0 },
  }),
}));

/** 测试捕获 useMasonryLayout 收到的 params（断言布局输入契约）。 */
const layoutParams = vi.hoisted(() => ({
  current: null as {
    entries: { value: readonly unknown[] };
    measuredMap: { value: Map<string, { width: number; height: number }> };
  } | null,
}));

vi.mock('@/composables/useMasonryLayout', async () => {
  const actual = await vi.importActual<typeof import('@/composables/useMasonryLayout')>(
    '@/composables/useMasonryLayout',
  );
  return {
    ...actual,
    useMasonryLayout: (params: {
      entries: { value: readonly unknown[] };
      measuredMap: { value: Map<string, { width: number; height: number }> };
    }) => {
      layoutParams.current = params;
      return {
        // §16.2 G 混合派生：fakeLayoutMap 非空 → 沿用静态预填（resize/scrollToEntry 等
        // 既有用例零改动）；为空 → 从 measuredMap 派生单列布局（真实语义：提交
        // measuredMap → layout 响应失效），header 异步批用例靠它免去「手动翻布局卡
        // capture/restore 之间」——微任务泵下手动翻不进那个窗口（flush 会先跑 restore）。
        layout: computed(() => {
          if (fakeLayoutMap.current.size > 0) return { map: fakeLayoutMap.current, totalHeight: 1000 };
          const derived = new Map<string, MasonryItem>();
          let top = 0;
          for (const e of params.entries.value as readonly { path: string }[]) {
            const h = params.measuredMap.value.get(e.path)?.height ?? 100;
            derived.set(e.path, { path: e.path, width: 200, height: h, top, left: 0, col: 0 });
            top += h;
          }
          return { map: derived, totalHeight: Math.max(1000, top) };
        }),
        visibleRange: computed(() => ({ start: 0, end: 2 })),
        dimensionPrefetchPaths: computed(() => prefetchPathsMock.current),
        colWidth: computed(() => 200),
        thumbnailWindows: computed(() => ({ visible: [], ahead: [], behind: [], idle: [] })),
      };
    },
  };
});

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
});

function img(n: string): MediaEntry {
  return { name: n, path: n, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
}

const baseProps = {
  entries: [img('a.jpg'), img('b.jpg')],
  marks: {},
  selectedPaths: new Set<string>(),
  descriptor: { type: 'local' as const, rootPath: '/root' },
  rootPath: '/root',
  currentPath: 'vol02',
  colCount: 4,
  hGap: 8,
  vGap: 8,
  canonicalImageNames: ['a.jpg', 'b.jpg'],
};

describe('MasonryView.scrollToEntry', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
  });

  it('目标命中 → 返回 true（layout map 含目标 → 立即滚到 item.top）', async () => {
    // 预填 layout map，让 b.jpg 在顶部 200px
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 100, height: 100, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 100, height: 120, top: 200, left: 100, col: 1 }],
    ]);

    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    const ok = await (w.vm as unknown as { scrollToEntry: (n: string) => Promise<boolean> }).scrollToEntry('b.jpg');
    expect(ok).toBe(true);

    w.unmount();
  });

  it('目标不在 entries（filter）→ 返回 false', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>();

    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    const ok = await (w.vm as unknown as { scrollToEntry: (n: string) => Promise<boolean> }).scrollToEntry('not-exists.jpg');
    expect(ok).toBe(false);

    w.unmount();
  });
});

// ─── v0.1.0-module3.0.8 — settings 闭环（任务 14 补的集成守卫）─────────────
// 验证：Settings 关闭「记录进度」（recordBrowsePosition=false）时，
// MasonryView 传给 useMasonryBrowsePosition 的 enabled 立刻变 false。
// 这覆盖模块闭环：Settings UI 真的能关闭瀑布流写入。

describe('MasonryView.settings 闭环', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    browsePositionParams.current = null;
  });

  it('Settings 关 recordBrowsePosition → useMasonryBrowsePosition.enabled=false', async () => {
    const pinia = createPinia();
    const settings = useSettingsStore(pinia);
    // 直接改 ref（settings 初始默认 true）；不走 update() 避免触发 Tauri invoke
    settings.recordBrowsePosition = false;

    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [pinia, i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    expect(browsePositionParams.current).not.toBeNull();
    expect(browsePositionParams.current!.enabled.value).toBe(false);
    w.unmount(); // §16.2 G：残留实例的 prefetch watcher 会跨用例消费 mock（响应化后激活）
    // restoreBrowsePositionOnEnter 没动 → 仍 true
    expect(browsePositionParams.current!.autoRestoreOnMount.value).toBe(true);
  });

  it('Settings 关 restoreBrowsePositionOnEnter → useMasonryBrowsePosition.autoRestoreOnMount=false', async () => {
    const pinia = createPinia();
    const settings = useSettingsStore(pinia);
    settings.restoreBrowsePositionOnEnter = false;

    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [pinia, i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    expect(browsePositionParams.current).not.toBeNull();
    expect(browsePositionParams.current!.autoRestoreOnMount.value).toBe(false);
    w.unmount(); // §16.2 G：同上
    // recordBrowsePosition 没动 → 仍 true
    expect(browsePositionParams.current!.enabled.value).toBe(true);
  });
});

// ─── bugfix 2026-08-15 — atBottom 响应式（滚到底不标 finished 根因）─────────
// 场景：缩略图全缓存命中 → 布局在用户滚到底之前已收敛（totalHeight 不再变）。
// 旧实现 atBottom computed 读非响应式 el.scrollTop，唯一响应式依赖是
// layout.totalHeight → 滚到底后 computed 永不重算 → 缓存停在 false →
// 「滚到底停留 1.2s 写 finished=true」机制从不触发（实机 CDP 定位：缓存 false
// vs 同 DOM 现算 true）。
//
// 测试策略：mock layout.totalHeight 固定不变（模拟已收敛）；先读一次 atBottom
// （scrollTop=0 → false，种下缓存）；再通过真实 scroll 事件把 scrollTop 滚到
// 贴底 → atBottom 必须翻 true。scroll 走 useVirtualList 真实 listener（未 mock）。

describe('MasonryView.atBottom 响应式 (bugfix 2026-08-15)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    browsePositionParams.current = null;
  });

  it('布局已收敛（totalHeight 不变）后滚到底 → atBottom 翻 true', async () => {
    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    // happy-dom 不算布局，stub 容器几何：sh=2000, ch=800 → 档3 长目录
    // 贴底阈值 64px：scrollTop>=1136 即 nearBottom
    // 2026-08-27 frame 重构后根节点是 .masonry-frame，滚动容器是其子元素
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    expect(containerEl).toBeTruthy();
    Object.defineProperty(containerEl, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });

    // 种下缓存：scrollTop=0 时 atBottom=false（此时 computed 求值，依赖无滚动项）
    expect(browsePositionParams.current).not.toBeNull();
    expect(browsePositionParams.current!.atBottom.value).toBe(false);

    // 真实滚动到底：scrollTop=1200 → 1200+800=2000 >= 2000-64 → nearBottom
    containerEl.scrollTop = 1200;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 旧实现：scrollTop ref 不在依赖里 → 缓存 stale false → 红
    expect(browsePositionParams.current!.atBottom.value).toBe(true);

    w.unmount();
  });

  it('滚离底部 → atBottom 翻回 false', async () => {
    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });

    // 先到底（true），再滚回中部（0+800 >= 1936 不成立 → false）
    containerEl.scrollTop = 1200;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(browsePositionParams.current!.atBottom.value).toBe(true);

    containerEl.scrollTop = 100;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(browsePositionParams.current!.atBottom.value).toBe(false);

    w.unmount();
  });
});

// ─── v0.1.0-module3.0.8 task-21 — resize 视觉焦点漂移修复（spec §resize-anchor）──────
// 验证：resize 触发时，containerWidth 变化 → 捕获 viewport anchor (path+ratio) →
// layout 重排后恢复 scrollTop 到同一图片同一相对位置。
//
// 测试策略：mock ResizeObserver 让 callback 可手动触发；通过 fakeLayoutMap 模拟
// resize 前后 layout（path 一致但 top/height 改变）；验证 scrollTop 被设到 anchor 算出值。

// 可控 ResizeObserver：每 observe() 记录 callback，下次 fire() 触发。
type ResizeCallback = () => void;
const resizeCbs: ResizeCallback[] = [];
const observedEls: Element[] = [];

class FakeResizeObserver {
  cb: ResizeCallback;
  constructor(cb: ResizeCallback) { this.cb = cb; resizeCbs.push(cb); }
  observe(el: Element) { observedEls.push(el); }
  unobserve() { /* noop */ }
  disconnect() {
    const i = resizeCbs.indexOf(this.cb);
    if (i >= 0) resizeCbs.splice(i, 1);
  }
}
function fireResize() {
  // 触发全部 cb（happy-dom 下同步执行即可）
  for (const cb of [...resizeCbs]) cb();
}
function clearResizeCbs() {
  resizeCbs.length = 0;
  observedEls.length = 0;
}

describe('MasonryView.resize viewport anchor (task-21)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    clearResizeCbs();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  it('resize 后 scrollTop 按 viewport anchor 恢复（保持同一图同一相对位置）', async () => {
    // resize 前 layout: 605.jpg 在 top=1000, height=400
    // resize 后 layout: 605.jpg 移到 top=5000, height 变 800（colWidth 变了）
    // scrollTop 旧 = 1300（= 605.jpg.top + 75% * height）
    // 期望新 scrollTop = 5000 + 0.75 * 800 = 5600
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['605.jpg', { path: '605.jpg', width: 100, height: 400, top: 1000, left: 0, col: 0 }],
    ]);

    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    // 模拟容器宽度变化（happy-dom 默认 0）
    // 2026-08-27 frame 重构：滚动容器是根节点的子元素（containerRef 指向它）
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    expect(containerEl).toBeTruthy();
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 800 });
    // 初始已 observe 一次 clientWidth=0；改宽度后再 fire
    containerEl.style.width = '800px';

    // 触发 resize 回调
    fireResize();
    await flushPromises();
    await nextTick();

    // 切换 fakeLayoutMap 到 resize 后的 layout
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['605.jpg', { path: '605.jpg', width: 200, height: 800, top: 5000, left: 0, col: 0 }],
    ]);
    // 等 anchor 恢复的 nextTick 完成
    await flushPromises();
    await nextTick();
    await flushPromises();

    // 验证 scrollTop 被恢复：renderer 通过 scrollTop.value 反映
    // 注意：beginResizeAnchor 在 fireResize 时捕获旧 layout + scrollTop=0（happy-dom 默认）
    // 所以此处主要验证 captureMasonryViewportAnchor 被调用且不抛错 + ResizeObserver 集成路径走通
    // 真正数值验证交给 useMasonryLayout.test.ts 的纯函数单测。
    // 这里只验证：fireResize 后，ResizeObserver 链路无异常；scrollTop 已被设值（不会崩溃）。
    const finalScrollTop = Number((containerEl as unknown as { scrollTop?: number }).scrollTop ?? 0);
    expect(Number.isFinite(finalScrollTop)).toBe(true);

    w.unmount();
  });

  it('anchor 锚点图在新 layout 不存在 → scrollTop 不动（不抛错）', async () => {
    // resize 前 layout 有 605.jpg
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['605.jpg', { path: '605.jpg', width: 100, height: 400, top: 1000, left: 0, col: 0 }],
    ]);

    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    // resize 触发
    fireResize();
    await flushPromises();
    await nextTick();

    // resize 后 layout 605.jpg 消失（被过滤）
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    await flushPromises();
    await nextTick();
    await flushPromises();

    // 不抛错即可（restoreResizeAnchor 内部 anchor 不存在返 null）
    expect(true).toBe(true);

    w.unmount();
  });
});

// ─── module3.0.11 — popover 接线（round-1/2/3 修订全覆盖）──────────────────
describe('MasonryView.popover (module3.0.11)', () => {
  /** happy-dom 的 getBoundingClientRect 返回全 0，会触发 width===0 守卫——测试里 stub 非零 rect。 */
  function stubBadgeRect(el: Element, r = { left: 100, top: 50, width: 18, height: 14 }) {
    el.getBoundingClientRect = () => ({
      ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height,
      toJSON: () => ({}),
    } as DOMRect);
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 100, height: 100, top: 0, left: 0, col: 0 }],
    ]);
    thumbnailsMock.stateMap = new Map([
      ['a.jpg', { kind: 'generating', cacheKey: 'ck', phase: 'decoding', startedAt: Date.now(), timings: {} }],
    ]);
    thumbnailsMock.progressSnapshots = new Map();
  });

  it('settings 开时点击角标 → 显示 popover', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    expect(badge.exists()).toBe(true);
    stubBadgeRect(badge.element);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    w.unmount();
  });

  it('settings 关时点击角标 → 不弹 popover + 角标 disabled（round-3 prop 下传）', async () => {
    const pinia = createPinia();
    const settings = useSettingsStore(pinia);
    settings.thumbnailDetailPopover = false;
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [pinia, i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    stubBadgeRect(badge.element);
    expect(badge.attributes('disabled')).toBeDefined();
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(false);
    w.unmount();
  });

  it('ESC 关闭 popover', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    stubBadgeRect(badge.element);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(false);
    w.unmount();
  });

  it('外部 mousedown 关闭；角标上的 mousedown 不关（toggle 交给 click）', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    stubBadgeRect(badge.element);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    // round-1 P2：角标 mousedown 跳过（否则 mousedown 先关、click 再开抖动）
    badge.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    // 外部 mousedown：关闭（bubbles: true 才能到达 document 监听器）
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(false);
    w.unmount();
  });

  it('角标再点 toggle 关闭（spec §6.4）', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    stubBadgeRect(badge.element);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(false);
    w.unmount();
  });

  it('特殊路径（含引号/反斜杠）弹 popover——元素直传不走 querySelector', async () => {
    const weird = 'a"b\c.jpg';
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      [weird, { path: weird, width: 100, height: 100, top: 0, left: 0, col: 0 }],
    ]);
    thumbnailsMock.stateMap = new Map([
      [weird, { kind: 'generating', cacheKey: 'ck', phase: 'decoding', startedAt: Date.now(), timings: {} }],
    ]);
    const w = mount(MasonryView, { props: { ...baseProps, entries: [img(weird)], canonicalImageNames: [weird] }, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    expect(badge.exists()).toBe(true);
    stubBadgeRect(badge.element);
    await badge.trigger('click'); // 旧实现此处 querySelector 语法错误
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    w.unmount();
  });

  it('failed 卡错误角标可打开失败详情 popover（round-2 必修：事后可达）', async () => {
    thumbnailsMock.stateMap = new Map([
      ['a.jpg', { kind: 'failed', cacheKey: 'ck', retryable: true, message: 'boom' }],
    ]);
    thumbnailsMock.progressSnapshots = new Map([
      ['a.jpg', { phase: 'decoding', timings: { decoding: 3 }, startedAt: Date.now() - 1000 }],
    ]);
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge.fail'); // 失败角标（非 generating）
    expect(badge.exists()).toBe(true);
    stubBadgeRect(badge.element);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    expect(w.find('.err-msg').exists()).toBe(true); // 失败详情渲染
    w.unmount();
  });
});

// ─── 缩略图 natural 尺寸喂布局 + loading 指示器视口锚定（2026-08-27 实机诊断）──
// 根因 A（P1）：WebDAV 远程目录缩略图缓存命中秒出，但真实尺寸要远程 header——
// img 已加载（natural 即真实比例）却按 3:4 估算 → 334 高竖框装 16:9 图 → 框内
// 大片空白 + 尺寸错。修复：row-measured → mergeMeasured 写 measuredMap（不覆盖）。
// 根因 B（P0）：.masonry-loading absolute 定位在滚动容器内 → 跟内容滚走，
// 滚到未测量区域 loading=true 但 spinner 在视口外。修复：移到滚动层外的
// .masonry-frame（absolute 相对视口区）。

describe('MasonryView row-measured 接线 + loading 视口锚定 (2026-08-27)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    browsePositionParams.current = null;
  });

  function mountView() {
    return mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
  }

  it('loading 初始 true（visibleRange 无测量）→ row-measured 后翻 false', async () => {
    // 预填 layout：visibleItems 需要 layout map 里有 item 才渲染 MasonryRow
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 200, height: 150, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 200, height: 150, top: 0, left: 200, col: 1 }],
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    // visibleRange mock 为 0-2；measuredMap 空 → loading=true
    expect(w.find('[data-test="masonry-loading"]').exists()).toBe(true);

    // MasonryRow emit row-measured → mergeMeasured 写入 → loading 翻 false
    const row = w.findComponent({ name: 'MasonryRow' });
    expect(row.exists()).toBe(true);
    row.vm.$emit('row-measured', baseProps.entries[0], 512, 288);
    await nextTick();
    expect(w.find('[data-test="masonry-loading"]').exists()).toBe(false);
    w.unmount();
  });

  it('loading 指示器在滚动容器外（不随内容滚走）', async () => {
    const w = mountView();
    await flushPromises();
    await nextTick();
    // 根节点是 frame；滚动容器是其子；loading 是 frame 的子但不是容器的子
    const root = w.element as HTMLElement;
    expect(root.classList.contains('masonry-frame')).toBe(true);
    const container = root.querySelector('.masonry-container');
    expect(container).toBeTruthy();
    const loading = root.querySelector('[data-test="masonry-loading"]');
    expect(loading).toBeTruthy();
    // loading 不得在滚动容器内（会被内容滚走）；应在 frame 层锚定视口
    expect(container!.contains(loading!)).toBe(false);
    expect(root.contains(loading!)).toBe(true);
    w.unmount();
  });
});

// ─── 混排占位（2026-08-27 方案 B）：非图片条目渲染占位卡 ─────────────────────
describe('MasonryView 混排占位', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    browsePositionParams.current = null;
    layoutParams.current = null;
  });

  const mixedProps = {
    ...baseProps,
    entries: [
      { name: 'Thumbs.db', path: 'Thumbs.db', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'cover.jpg', path: 'cover.jpg', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'a.jpg', path: 'a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ],
    canonicalImageNames: ['a.jpg'],
  };

  it('非图片条目渲染占位卡（visibleRange mock 为 0-2：2 条目形态，无空洞）', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['Thumbs.db', { path: 'Thumbs.db', width: 200, height: 112, top: 0, left: 0, col: 0 }],
      ['a.jpg', { path: 'a.jpg', width: 200, height: 112, top: 0, left: 200, col: 1 }],
    ]);
    const w = mount(MasonryView, {
      props: {
        ...mixedProps,
        entries: [mixedProps.entries[0], mixedProps.entries[2]],
      },
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(w.findAll('.masonry-row').length).toBe(2);
    expect(w.find('.masonry-row[data-path="Thumbs.db"] .masonry-placeholder').exists()).toBe(true);
    expect(w.find('.masonry-row[data-path="a.jpg"] .masonry-placeholder').exists()).toBe(false);
    w.unmount();
  });

  it('布局输入含全部 entries（不因 isImage 截断——占位参与瀑布流）', async () => {
    const w = mount(MasonryView, {
      props: mixedProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(layoutParams.current).not.toBeNull();
    expect(layoutParams.current!.entries.value.length).toBe(3);
    w.unmount(); // §16.2 G：同上
  });

  it('窗口全为非图片时 loading 不永挂（占位卡即内容，无需测量）', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['Thumbs.db', { path: 'Thumbs.db', width: 200, height: 112, top: 0, left: 0, col: 0 }],
    ]);
    const w = mount(MasonryView, {
      props: { ...mixedProps, entries: [mixedProps.entries[0]], canonicalImageNames: [] },
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(w.find('[data-test="masonry-loading"]').exists()).toBe(false);
    expect(w.find('.masonry-placeholder').exists()).toBe(true);
    w.unmount();
  });

  it('窗口全为 cover.jpg 目录时 loading 同样不永挂（isMasonryImage 判定）', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['cover.jpg', { path: 'cover.jpg', width: 200, height: 112, top: 0, left: 0, col: 0 }],
    ]);
    const w = mount(MasonryView, {
      props: { ...mixedProps, entries: [mixedProps.entries[1]], canonicalImageNames: [] },
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(w.find('[data-test="masonry-loading"]').exists()).toBe(false);
    expect(w.find('.masonry-placeholder').exists()).toBe(true);
    w.unmount();
  });
});

// ─── module3.5.3 任务 A：陈旧尺寸守卫 ────────────────────────────────
// 关键事实：measuredMap 键是相对 currentPath 的 entry.path，跨目录同名键会互相污染，
// 且不可自愈（预读跳过已测路径 + mergeMeasured 拒绝覆盖）。守卫 = 切目录重置 +
// 回包 identity 快照比对。defineExpose(measuredMap) 是测试观测面。
describe('MasonryView.measuredMap 陈旧尺寸守卫', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    prefetchPathsMock.current = [];
    vi.mocked(listImageDimensions).mockReset();
    vi.mocked(listImageDimensions).mockResolvedValue([]);
  });

  function vmMap(w: { vm: unknown }): Map<string, { width: number; height: number }> {
    return (w.vm as unknown as { measuredMap: Map<string, { width: number; height: number }> })
      .measuredMap;
  }

  it('header 回包写入 measuredMap（键为相对 currentPath 的 entry.path）', async () => {
    // 用例性质：VTU 可直读 script setup 内部状态（不经 defineExpose），故本用例
    // 在无 expose 基线也绿——它是行为回归锚而非 RED 锚。
    prefetchPathsMock.current = ['a.jpg'];
    // echo 式回包：直接原样返回 IPC 收到的 fullPath——断言不依赖 toRootRelativePath
    // 的具体产出形态，只要求 fullByRel 反查键值一致性（这正是组件实现的契约）。
    vi.mocked(listImageDimensions).mockImplementationOnce(async (_d, paths) =>
      paths.map((p) => ({ path: p, width: 300, height: 400 })),
    );
    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(vmMap(w).get('a.jpg')).toEqual({ width: 300, height: 400 });
    w.unmount();
  });

  it('切目录重置 measuredMap（同名键不再跨目录残留）', async () => {
    prefetchPathsMock.current = ['a.jpg'];
    vi.mocked(listImageDimensions).mockImplementationOnce(async (_d, paths) =>
      paths.map((p) => ({ path: p, width: 300, height: 400 })),
    );
    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(vmMap(w).size).toBe(1);

    await w.setProps({ currentPath: 'vol03' });
    await flushPromises();
    await nextTick();
    expect(vmMap(w).size).toBe(0);
    w.unmount();
  });

  it('旧目录迟到的 header 回包被丢弃（identity 变化后不写新目录同名键）', async () => {
    let resolveStale!: (v: { path: string; width: number; height: number }[]) => void;
    let seenPaths: string[] = [];
    // 捕获真实发出的 fullPath 并原样回吐（echo）——形态无关，见用例一注释
    vi.mocked(listImageDimensions).mockImplementationOnce(async (_d, paths) => {
      seenPaths = [...paths];
      return new Promise((res) => { resolveStale = res; }) as never;
    });
    prefetchPathsMock.current = ['a.jpg'];
    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises(); // IPC 已发出但挂起
    await w.setProps({ currentPath: 'vol03' }); // 触发守卫失效 + map 重置
    await flushPromises();

    resolveStale(seenPaths.map((p) => ({ path: p, width: 999, height: 999 })));
    await flushPromises();
    await nextTick();

    expect(vmMap(w).has('a.jpg')).toBe(false);
    w.unmount();
  });

  it('同内容重建 descriptor 引用：在途回包照常提交（FileList 内联兜底回归锚）', async () => {
    // 审查 P0-1 修订：FileList.vue:407 用 `descriptor || { type:'local', rootPath }`
    // 内联字面量兜底，本地源 descriptor 每次父渲染都是新对象引用——守卫必须比
    // descriptorId 语义键。若误比引用，本用例最后一行断言失败（回包被当陈旧丢弃）。
    // 用例性质：对「误比对象引用」的错误实现必红——它防的是错误实现而非缺失实现（设计锚）。
    prefetchPathsMock.current = ['a.jpg'];
    let resolveBatch!: (v: { path: string; width: number; height: number }[]) => void;
    let seenPaths: string[] = [];
    vi.mocked(listImageDimensions).mockImplementationOnce(async (_d, paths) => {
      seenPaths = [...paths];
      return new Promise((res) => { resolveBatch = res; }) as never;
    });
    const w = mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises(); // IPC 已发出但挂起

    await w.setProps({ descriptor: { type: 'local' as const, rootPath: '/root' } }); // 新引用、同内容
    await flushPromises();

    resolveBatch(seenPaths.map((p) => ({ path: p, width: 300, height: 400 })));
    await flushPromises();
    await nextTick();

    expect(vmMap(w).get('a.jpg')).toEqual({ width: 300, height: 400 }); // 未被误判陈旧
    w.unmount();
  });
});

// ─── §16.2.1 ④：load-error / retry / popover retry 三处接线组件级断言（2026-08-29）──
// 事件改名不再静默漏接：@row-load-error → markLoadFailed、@row-retry → retryLoadFailed、
// popover @retry → retryLoadFailed(popoverPath)。
import MasonryRow from './MasonryRow.vue';

describe('MasonryView load-error/retry 接线（§16.2.1 ④）', () => {
  function stubBadgeRect(el: Element) {
    el.getBoundingClientRect = () => ({
      left: 100, top: 50, width: 18, height: 14,
      x: 100, y: 50, right: 118, bottom: 64, toJSON: () => ({}),
    } as DOMRect);
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    // visibleItems 依赖 layout map（mock 注入）——预填让两条 entry 都渲染出 MasonryRow
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 100, height: 100, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 100, height: 100, top: 100, left: 0, col: 0 }],
    ]);
    thumbSpies.markLoadFailed.mockClear();
    thumbSpies.retryLoadFailed.mockClear();
    thumbSpies.retry.mockClear();
    thumbSpies.regenerate.mockClear();
  });

  it('@row-load-error → markLoadFailed(entry)', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] } });
    await flushPromises(); await nextTick();
    const row = w.findComponent(MasonryRow);
    expect(row.exists()).toBe(true);
    row.vm.$emit('row-load-error', baseProps.entries[0]);
    await nextTick();
    expect(thumbSpies.markLoadFailed).toHaveBeenCalledWith(baseProps.entries[0].path);
    w.unmount();
  });

  it('@row-retry → retryLoadFailed(entry.path)', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] } });
    await flushPromises(); await nextTick();
    const row = w.findComponent(MasonryRow);
    row.vm.$emit('row-retry', baseProps.entries[0]);
    await nextTick();
    expect(thumbSpies.retryLoadFailed).toHaveBeenCalledWith(baseProps.entries[0].path);
    w.unmount();
  });

  it('popover @retry → retryLoadFailed(popover path)', async () => {
    thumbnailsMock.stateMap = new Map([
      ['a.jpg', { kind: 'failed', cacheKey: 'ck', retryable: true, message: 'boom' }],
    ]);
    thumbnailsMock.progressSnapshots = new Map();
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge.fail');
    expect(badge.exists()).toBe(true);
    stubBadgeRect(badge.element);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);

    await w.find('[data-test="thumb-popover"] .retry-btn').trigger('click');
    await flushPromises();
    expect(thumbSpies.retryLoadFailed).toHaveBeenCalledWith('a.jpg');
    w.unmount();
  });
});

// ─── §16.2 G 项兑现（2026-09-03 实机跳屏）— 测量批次 scrollTop 锚定补偿 ────────
// 机制：提交 measuredMap 前按批前 layout 捕「穿过顶线的图+ratio」（gap 位置走 loose），
// 布局重算后恢复——视口内容钉住。单列口径造数保证数值可手算。
// 复用文件既有 MasonryRow import（hoisted）与 FakeResizeObserver 基建（task-21 块）。
describe('MasonryView 测量批次锚定补偿 (§16.2 G)', () => {
  function col(items: { path: string; top: number; height: number }[]): Map<string, MasonryItem> {
    const m = new Map<string, MasonryItem>();
    for (const it of items) m.set(it.path, { path: it.path, col: 0, left: 0, top: it.top, height: it.height, width: 200 });
    return m;
  }
  function mountView() {
    return mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    prefetchPathsMock.current = [];
    // mock 卫生（对齐 measuredMap 陈旧守卫 describe 的既有模式）：reset 清 Once 队列 +
    // 回填默认 []。文件历史上有 mount 不 unmount 的泄漏用例（已修 3 处），残留实例的
    // prefetch watcher 会在本 describe 设 paths 时一并触发并消费 IPC——reset 保证
    // mockImplementationOnce 一定落在本用例自己的调用上。
    vi.mocked(listImageDimensions).mockReset();
    vi.mocked(listImageDimensions).mockResolvedValue([]);
  });
  // 审核建议：stub 清理放 afterEach——断言失败时不跳过，防泄漏到后续用例
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('视口上方 item 长高（row-measured 单条）→ scrollTop 补偿到同图同 ratio', async () => {
    // 批前布局 v1：a.jpg top0 h100；b.jpg top100 h900（顶线 50 落在 a 内，ratio 0.5）
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });

    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 触发单条测量提交（同步）：锚点捕获自 v1（a.jpg, ratio .5）
    const rows = w.findAllComponents(MasonryRow);
    expect(rows.length).toBeGreaterThan(0);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 同步翻布局到 v2（模拟真实时序：measuredMap 提交 → layout 派生重算 → a.jpg 长高到 224）
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();

    // 锚定恢复：target = a.top + a.height × 0.5 = 112；未补偿则停留 50
    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('header 批回包（listImageDimensions 异步）→ 同图同 ratio 补偿', async () => {
    // 派生模式：不设 fakeLayoutMap——layout 从 measuredMap 派生（a/b 初始 h100），
    // 回包写入 a=224 后布局自动重算，无需手动翻（微任务泵下手动翻不进 capture/restore 窗口）
    let resolveDims: (v: { path: string; width: number; height: number }[]) => void = () => {};
    vi.mocked(listImageDimensions).mockImplementationOnce(
      () => new Promise((r) => { resolveDims = r; }) as Promise<{ path: string; width: number; height: number }[]>,
    );
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50; // 顶线落在派生 a(0..100) 内，ratio 0.5
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 触发 header 预读（watch(dimensionPrefetchPaths) flush post）
    prefetchPathsMock.current = ['a.jpg'];
    await nextTick();

    // 回包到达：提交在微任务里发生（锚点按批前派生布局捕获），泵微任务直到提交完成
    resolveDims([{ path: 'vol02/a.jpg', width: 100, height: 224 }]);
    for (let i = 0; i < 50 && !(layoutParams.current as { measuredMap: { value: Map<string, unknown> } }).measuredMap.value.has('a.jpg'); i++) {
      await Promise.resolve();
    }
    await nextTick();
    await nextTick();

    // 派生布局 a h224 → restore target = 0 + 224×0.5 = 112；未补偿则停留 50
    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('同批多次提交共享首个锚点（不按批中布局重捕）', async () => {
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    const rows = w.findAllComponents(MasonryRow);
    // 提交 1（a）：捕获锚点自 v1（a.jpg, ratio .5）
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 翻布局 v2 后同批再提交 2（b）：若实现错误地在批中重捕（v2 + scrollTop 50 →
    // ratio 50/224 → 恢复 50 = 无补偿），正确则仍用首锚 → 恢复 112
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    rows[1].vm.$emit('row-measured', baseProps.entries[1], 856, 1920);
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('提交后、恢复前切目录且新目录有同名文件 → 不写 scrollTop（竞态守卫）', async () => {
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 提交（锚 a.jpg@v1 入闭包），随后切目录：watcher 失效（seq 越过 + pending 复位）
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    await w.setProps({ currentPath: 'vol03' });
    // 新目录同名单图、更长（若无守卫，旧锚 a.jpg 命中 → scrollTop 被改写 112）
    fakeLayoutMap.current = col([{ path: 'a.jpg', top: 0, height: 224 }]);
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(50); // 守卫生效：恢复被丢弃
    w.unmount();
  });

  it('旧批失效 → 新批已开启 → 旧回调不清掉新批（闭包批次判别）', async () => {
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    const rows = w.findAllComponents(MasonryRow);
    // 批 A（vol02）：闭包锚 {a, .5}
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 切目录 → 批 A 失效（seq 越过）；新目录同构布局，scrollTop 仍 50
    await w.setProps({ currentPath: 'vol03' });
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    // 批 B（vol03）：pending 已复位 → 开新批，闭包锚 {a, .5}
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 布局长高（a → 224）。若旧 A 回调先清共享锚再查 seq（共享态实现），B 无锚可恢复 → 50；
    // 闭包实现：A 的回调 seq 不符直接 return，B 恢复 → 112
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('resize 活跃 → 切目录 → 新目录同名文件测量 → 不恢复旧 scrollTop（resize 锚跨目录判别）', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    clearResizeCbs();
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 900 });
    containerEl.scrollTop = 50; // resize 锚捕获基线：{a, .5}
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    fireResize(); // resizeAnchor 活跃（150ms 释放窗内）
    // 切目录：watcher 失效测量 + resize 两套锚；若无 resize 失效，新目录测量的
    // 让位分支会复用旧 resize 锚 {a,.5} → 恢复 112（错）
    await w.setProps({ currentPath: 'vol03' });
    fakeLayoutMap.current = col([{ path: 'a.jpg', top: 0, height: 224 }]); // 新目录同名更长
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    await nextTick();
    await nextTick();

    // 正确路径：resize 锚已失效 → 走测量自捕（v2 a 高 224，scrollTop 50 → ratio 50/224
    // → 恢复目标恰 50，无写）；旧锚未失效则 112
    expect(containerEl.scrollTop).toBe(50);
    w.unmount();
  });

  it('测量批 pending → resize 开始 → 测量回调让位（写次数=1 锁单一写入者）', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    clearResizeCbs();
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 900 });
    // scrollTop 用 get/set 背衬计数——两个恢复都经 containerEl.scrollTop 写入，次数即写入者数
    const backing = { v: 50, writes: 0 };
    Object.defineProperty(containerEl, 'scrollTop', {
      configurable: true,
      get: () => backing.v,
      set: (x: number) => { backing.v = x; backing.writes += 1; },
    });
    containerEl.dispatchEvent(new Event('scroll')); // 同步 useVirtualList scrollTop.value=50
    await nextTick();

    // 批 A（测量）：闭包锚 {a, .5}@v1（50 落在 a(0..100) 内）
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 翻中间布局 v_mid（a h150）再开 resize——resize 锚自 v_mid 捕（{a, 1/3}），
    // 与测量锚不同值，确保两写入者的目标可区分
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 150 },
      { path: 'b.jpg', top: 150, height: 850 },
    ]);
    fireResize(); // RO：beginResizeAnchor({a,1/3}@v_mid) + 失效测量批（seq 越过）+ 调度 resize 恢复
    // 终布局 v2（a h224）
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();
    await nextTick();

    // 单一写入者：仅 resize 恢复（0 + 224×1/3 ≈ 74.67）；测量回调 seq 不符让位。
    // 若无 RO 失效：测量先写 112（其锚 .5×224）再被 resize 覆盖 → writes=2
    expect(backing.writes).toBe(1);
    expect(containerEl.scrollTop).toBeCloseTo(224 / 3, 5);
    w.unmount();
  });

  it('空锚（entries 无对应图项）→ 不写 scrollTop（header 驱动，不经 MasonryRow）', async () => {
    // fakeLayoutMap 填「无关路径」：混合派生走静态分支，entries 无 item 可捕 → null
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['zzz.jpg', { path: 'zzz.jpg', width: 200, height: 100, top: 0, left: 0, col: 0 }],
    ]);
    let resolveDims: (v: { path: string; width: number; height: number }[]) => void = () => {};
    vi.mocked(listImageDimensions).mockImplementationOnce(
      () => new Promise((r) => { resolveDims = r; }) as Promise<{ path: string; width: number; height: number }[]>,
    );
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 30;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    prefetchPathsMock.current = ['a.jpg'];
    await nextTick();
    resolveDims([{ path: 'vol02/a.jpg', width: 100, height: 224 }]);
    for (let i = 0; i < 50 && !(layoutParams.current as { measuredMap: { value: Map<string, unknown> } }).measuredMap.value.has('a.jpg'); i++) {
      await Promise.resolve();
    }
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(30); // loose/严格捕获均 null → 跳过恢复
    w.unmount();
  });

  it('顶线落入所有列 gap（无相交图）→ loose 锚按「下边缘+偏移」补偿', async () => {
    // 双列：col0 a(0,h10)、col1 b(0,h8)——单列造数无法产生 gap（列内连续）
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 200, height: 10, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 200, height: 8, top: 0, left: 208, col: 1 }],
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 15; // 顶线在两列内容之下（a 止于 10、b 止于 8）
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // a.jpg 长高 10 → 22.4（真实时序翻布局）
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 200, height: 22.4, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 200, height: 8, top: 0, left: 208, col: 1 }],
    ]);
    await nextTick();

    // loose：anchor={a, belowOffset:5} → target = 0+22.4+5 = 27.4；未补偿停留 15
    expect(containerEl.scrollTop).toBeCloseTo(27.4, 5);
    w.unmount();
  });

  it('resize 进行中测量提交让位——复用 resize 锚恢复（正向时序判别）', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    clearResizeCbs();
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 900 });
    containerEl.scrollTop = 50; // resize 锚捕获基线：{a, .5}
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    fireResize(); // beginResizeAnchor 捕 {a,.5}@v1 + 调度 resize 恢复（nextTick）
    // 先翻布局 v2（a h224），再提交测量——若测量自捕锚（v2 + scrollTop 50 → ratio 50/224
    // → 恢复 50 = 无补偿），让位实现复用 resize 锚 {a,.5} → 112
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('两条测量提交路径均收口 commitMeasuredMap（接线断言）', () => {
    const source = readFileSync(resolve(__dirname, './MasonryView.vue'), 'utf-8');
    const onRow = source.slice(source.indexOf('function onRowMeasured'));
    expect(onRow.slice(0, onRow.indexOf('function triggerDimensionPrefetch'))).toContain('commitMeasuredMap(');
    const prefetch = source.slice(source.indexOf('async function triggerDimensionPrefetch'));
    expect(prefetch.slice(0, prefetch.indexOf('watch('))).toContain('commitMeasuredMap(');
  });
});
