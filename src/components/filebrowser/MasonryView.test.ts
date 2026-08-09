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
      needPrefetch: computed(() => false),
      nextBatchPaths: computed(() => []),
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
