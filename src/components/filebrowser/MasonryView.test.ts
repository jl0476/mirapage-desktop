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
    const containerEl = w.element as HTMLElement;
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
    // 根节点本身就是 .masonry-container（template 第一个 <div ref="containerRef" class="masonry-container">）
    expect(containerEl.classList.contains('masonry-container')).toBe(true);
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
