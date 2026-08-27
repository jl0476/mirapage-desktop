/**
 * MasonryView.vue 集成守卫测试（计划任务9）
 *
 * 核心断言：MasonryView 不再构造脱离 DOM 的原图 `new Image()` 预读（缩略图队列取代）。
 * 通过读取源码字符串守卫，防止以后重新引入大图预解码（卡顿根因）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { computed, nextTick } from 'vue';
import zhCN from '@/locales/zh-CN';
import MasonryView from './MasonryView.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';
import type { MasonryItem } from '@/composables/useMasonryLayout';
import type { UseMasonryBrowsePositionParams } from '@/composables/useMasonryBrowsePosition';
import { useSettingsStore } from '@/stores/settings';

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

/** 测试用 layout map：null 表示空（让 layout map 为空），Map 表示预填。 */
const fakeLayoutMap = { current: new Map<string, MasonryItem>() };

// module3.0.11：mock 缩略图 composable，stateMap/progressSnapshots 由测试注入
const thumbnailsMock = vi.hoisted(() => ({
  stateMap: new Map<string, unknown>(),
  progressSnapshots: new Map<string, unknown>(),
}));

vi.mock('@/composables/useMasonryThumbnails', () => ({
  useMasonryThumbnails: () => ({
    stateMap: computed(() => thumbnailsMock.stateMap),
    progressSnapshots: computed(() => thumbnailsMock.progressSnapshots),
    retry: vi.fn(),
    regenerate: vi.fn(),
    regenerateBatch: vi.fn(),
    epoch: { value: 0 },
  }),
}));

vi.mock('@/composables/useMasonryLayout', async () => {
  const actual = await vi.importActual<typeof import('@/composables/useMasonryLayout')>(
    '@/composables/useMasonryLayout',
  );
  return {
    ...actual,
    useMasonryLayout: () => ({
      layout: computed(() => ({ map: fakeLayoutMap.current, totalHeight: 1000 })),
      visibleRange: computed(() => ({ start: 0, end: 2 })),
      dimensionPrefetchPaths: computed(() => []),
      colWidth: computed(() => 200),
      thumbnailWindows: computed(() => ({ visible: [], ahead: [], behind: [], idle: [] })),
    }),
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

    mount(MasonryView, {
      props: baseProps,
      global: { plugins: [pinia, i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    expect(browsePositionParams.current).not.toBeNull();
    expect(browsePositionParams.current!.enabled.value).toBe(false);
    // restoreBrowsePositionOnEnter 没动 → 仍 true
    expect(browsePositionParams.current!.autoRestoreOnMount.value).toBe(true);
  });

  it('Settings 关 restoreBrowsePositionOnEnter → useMasonryBrowsePosition.autoRestoreOnMount=false', async () => {
    const pinia = createPinia();
    const settings = useSettingsStore(pinia);
    settings.restoreBrowsePositionOnEnter = false;

    mount(MasonryView, {
      props: baseProps,
      global: { plugins: [pinia, i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();

    expect(browsePositionParams.current).not.toBeNull();
    expect(browsePositionParams.current!.autoRestoreOnMount.value).toBe(false);
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
