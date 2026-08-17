/**
 * ReaderView.vue 测试 — v0.1.0-module3.0 (get_book IPC)
 * 覆盖：mount 路由 /reader/:bookId → 调 getBook / setRoot / openBook
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import zhCN from '@/locales/zh-CN';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    getBook: vi.fn(async () => ({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 0,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    })),
    setRoot: vi.fn(async () => undefined),
    saveProgress: vi.fn(async () => undefined),
    getProgress: vi.fn(async () => null),  // v0.1.0-module3.0.2 (H5)
    readFile: vi.fn(async () => new Uint8Array()),
    listDirectory: vi.fn(async () => [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ]),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined),
    setFavorite: vi.fn(async () => undefined),
    findNextVolume: vi.fn(async () => null),
    markFinished: vi.fn(async () => undefined),
    listImageDimensions: vi.fn(async () => []),
    addBookmark: vi.fn(async () => ({ id: 1, bookId: 7, page: 0, label: null, createdAt: 0 })),
    recordHistory: vi.fn(async () => undefined),
    createBook: vi.fn(async () => 8),
  };
});

vi.mock('@/composables/useReaderHotkeys', () => ({ useReaderHotkeys: vi.fn() }));
vi.mock('@/composables/useReaderWheel', () => ({ useReaderWheel: vi.fn() }));
vi.mock('@/composables/useKeepScreenOn', () => ({ useKeepScreenOn: vi.fn() }));

vi.mock('@/components/reader/WebtoonViewer.vue', () => {
  // module3.1.0 编排测试专用 stub：expose 契约与真实 viewer 一致（全 getter），
  // 状态集中在 __registry，测试直接改 topImage/atBottom/zoom 并断言滚动副作用。
  const registry = {
    topImage: 'a.jpg' as string | null,
    atBottom: false,
    zoom: 1,
    scrollTargets: [] as string[],
    steps: 0,
    setZoomCalls: [] as number[],
    el: { clientHeight: 100, scrollHeight: 500, scrollTop: 0, scrollBy: vi.fn() },
  };
  const component = {
    name: 'WebtoonViewer',
    template: '<div data-test="webtoon-viewer-stub" />',
    setup(_props: unknown, ctx: { expose: (exposed: Record<string, unknown>) => void }) {
      ctx.expose({
        getTopVisibleImage: () => registry.topImage,
        isAtBottom: () => registry.atBottom,
        getZoom: () => registry.zoom,
        setZoom: (z: number) => { registry.zoom = z; registry.setZoomCalls.push(z); },
        scrollToImage: (name: string) => { registry.scrollTargets.push(name); },
        autoScrollStep: (dt: number) => { registry.steps += dt; },
        getScrollEl: () => registry.el,
      });
    },
    __registry: registry,
  };
  return { default: component };
});
vi.mock('@tauri-apps/api/core', () => ({
  // v0.1.0-module3.0.2-hotfix4 (H9): mock 模拟 Tauri 真实 convertFileSrc 行为
  // (单层 percent-encode, encodeURI + 额外 encode sub-delims ( ) ! * ').
  // 老的 pass-through mock 不能验证单层 vs 双层.
  convertFileSrc: (p: string) => {
    const encoded = encodeURI(p)
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A')
      .replace(/!/g, '%21')
      .replace(/'/g, '%27');
    return `tauri://localhost/${encoded.replace(/^\//, '')}`;
  },
  invoke: vi.fn(async () => null),
}));

import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { getBook, getProgress, listDirectory, setFavorite, findNextVolume, createBook, recordHistory } from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settings';
import ReaderView from './ReaderView.vue';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { useReaderWheel } from '@/composables/useReaderWheel';
import { markFinished, addBookmark } from '@/lib/tauri';
import WebtoonViewerStub from '@/components/reader/WebtoonViewer.vue';

interface WebtoonRegistry {
  topImage: string | null;
  atBottom: boolean;
  zoom: number;
  scrollTargets: string[];
  steps: number;
  setZoomCalls: number[];
  el: { clientHeight: number; scrollHeight: number; scrollTop: number; scrollBy: ReturnType<typeof vi.fn> };
}
const wtStub = WebtoonViewerStub as unknown as { __registry: WebtoonRegistry };

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/reader/:bookId', name: 'reader', component: ReaderView },
    ],
  });
  router.push('/reader/7');
  return router;
}

/** Cluster A 测试用: 支持自定义 query (例如 ?at=imageName).
 *  使用 LocationAsObject 而非 URL 字符串, 避免 createMemoryHistory 对
 *  query string 解析不一致的问题. */
function makeRouterWithQuery(path: string, query?: Record<string, string>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/reader/:bookId', name: 'reader', component: ReaderView },
    ],
  });
  router.push({ path, query });
  return router;
}

describe('ReaderView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('mount 时调 getBook 并拿 sourceDescriptor', async () => {
    const fb = useFileBrowserStore();
    useReaderStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(getBook).toHaveBeenCalledWith(7);
  });

  it('getBook 返回 null 时显示错误', async () => {
    vi.mocked(getBook).mockResolvedValueOnce(null);
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-test="reader-error"]').exists()).toBe(true);
  });

  // v0.1.0-module3.0.2: H1 修复后 sourceDescriptor 是对象,
  // reader 应正确解析 .rootPath, 进 ready 状态(而非 "source descriptor 缺 rootPath" 错误).
  it('sourceDescriptor 是对象时, 正确解析 rootPath 进入 ready', async () => {
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-test="reader-view"]').exists()).toBe(true);
    expect(w.find('[data-test="reader-error"]').exists()).toBe(false);
  });

  // v0.1.0-module3.0.2: H1 防御性 - 即使 sourceDescriptor 是 JSON string, 也能解析
  it('sourceDescriptor 是 JSON string 时也能正确解析 (legacy 兼容)', async () => {
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: JSON.stringify({ type: 'local', rootPath: '/test/manga' }),
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-test="reader-error"]').exists()).toBe(false);
  });

  // v0.1.0-module3.0.2-hotfix1 (N3): 还原到末页时不应触发跨卷.
  // 当前 spreadIndex = spreads.length - 1 会被 slideshow.tick() atLast() 立即 pause
  // + setPendingNextVolume, 用户感知"刚开就跨卷". 修法: getProgress 返回末页
  // 时, resolveInitialSpreadIndex 把 spreadIndex 钳到 last - 1 (倒数第二 spread).
  // v0.1.0-module3.0.2-hotfix7 (H13): 单页模式每 spread 1 张图, 3 张图 → 3 spread,
  // page=2 (末张) → spread 2 → last=2 → 钳到 last-1=1.
  it('getProgress 末页 → initialSpreadIndex 钳到 last - 1 (避免立刻触发跨卷)', async () => {
    // 3 张图 (单页模式): spreads = [{0,1},{1,2},{2,3}] → last spread index = 2
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    // getProgress 返回末页 (page=2 = 0-indexed, 3 张图最后一张)
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7,
      page: 2,
      imageName: null,
      readerMode: 'single',
      updatedAt: 100,
      finished: false,
    });
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 末页钳位: page=2 (单页模式每 spread 一张) → spreads[2].start=2, last=2
    // 应钳到 last-1=1 (倒数第二), 不在末 spread
    expect(reader.currentSpreadIndex).toBe(1);
    expect(reader.currentSpreadIndex).toBeLessThan(reader.spreads.length - 1);
  });

  // v0.1.0-module3.0.2-hotfix2 (H7): absolutePath 回归 — 端到端
  // getBook 返回 rootPath='/root' + absolutePath='漫画' (裸子目录, 真实 useReaderActions
  // 传 entry.path, 没 rootPath 前缀)
  // ReaderView 必须拼成 '/root/漫画' 才能正确枚举图片
  it('getBook 返回 absolutePath 裸子目录时, 正确拼上 rootPath 枚举图片', async () => {
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: '漫画 A',
      sourceDescriptor: { type: 'local', rootPath: '/root' },
      sourceType: 'Local',
      absolutePath: '漫画',  // ← 真实: 裸子目录 (useReaderActions 传 entry.path)
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    vi.mocked(listDirectory).mockImplementation(async (_sd, p) => {
      if ((p as string).includes('漫画')) {
        return [
          { name: 'p1.jpg', path: '/root/漫画/p1.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
          { name: 'p2.jpg', path: '/root/漫画/p2.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
          { name: 'p3.jpg', path: '/root/漫画/p3.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        ] as never;
      }
      return Array.from({ length: 458 }, (_, i) => ({
        name: `noise${i}`,
        path: `/root/noise${i}`,
        isDirectory: false,
        isArchive: false,
        size: 0,
        modifiedAt: 0,
      })) as never;
    });
    const fb = useFileBrowserStore();
    fb.entries = [];
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-test="reader-error"]').exists()).toBe(false);
    // listDirectory 必须收到 '/root/漫画' (rootPath + absolutePath 拼接后)
    expect(listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/root' }),
      expect.stringContaining('漫画'),
    );
  });

  // v0.1.0-module3.0.2-hotfix3 撤回 → hotfix4 (H9): convertFileSrc 内部已 encode,
  // 前端不要再 pre-encode. 否则双重编码 '%2528' 解码一次是 '%28' (不是 '('),
  // Tauri Rust 端找不到文件 → OSD open-failed.
  // 测法: 给含特殊字符的 path, pageUrls 应是单层 encode (Tauri 自己处理),
  // 不应看到 '%25' (那意味着双重 encode).
  it('pageUrls 文件名/目录含特殊字符时, URL 应单层 encode (Tauri convertFileSrc 内部处理)', async () => {
    // 路径身份修复 (2026-08-12): absolutePath 用 source-relative (相对 rootPath),
    // 不再用绝对盘符路径 (那是污染数据格式, 会被新校验拒绝)。
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 99,
      title: '(林星阑) - 秀人网模特 红衣黑丝',
      sourceDescriptor: { type: 'local', rootPath: 'Q:\\00down\\2603' },
      sourceType: 'Local',
      absolutePath: '(林星阑) - 秀人网模特 红衣黑丝',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 85,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    vi.mocked(listDirectory).mockImplementation(async (_sd, p) => {
      // loadBookById 用 joinPath(rootPath, 'manga名') 调 listDirectory
      if (p === '' || p === 'Q:\\00down\\2603') {
        return [] as never;
      }
      return [
        { name: 'c (1).jpg', path: 'c (1).jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never;
    });
    const fb = useFileBrowserStore();
    fb.entries = [];
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    const reader = useReaderStore();
    const url = reader.pages[0] as string;
    expect(url).toBeDefined();
    // 关键: URL 不能含 '%25' (双重编码的标志)
    expect(url).not.toContain('%25');
    // URL 必须含单层 encode 的 UTF-8 (林 = %E6%9E%97) 或 (1) = %281%29
    expect(url).toMatch(/%E6%9E%97|%28/);
  });

  // ─── Cluster A: route.query.at → 从指定 image 开始 ───
  // 注: file-level mockImplementation 被前面 'getBook 返回 absolutePath' /
  // 'pageUrls 特殊字符' 测试设为持久实现, 不被 vi.clearAllMocks 清除.
  // 新测试需显式 mockReset listDirectory + 重设默认实现, 否则拿到上一次的返回.

  it('route.query.at=b.jpg → initialSpreadIndex 指向 b.jpg 所在 spread (单页模式 3 张图 → spread 1)', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouterWithQuery('/reader/7', { at: 'b.jpg' });
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // b.jpg 是第 2 张 (0-indexed=1) → singlePage spread = page 1
    expect(reader.currentSpreadIndex).toBe(1);
  });

  it('route.query.at=不存在的图片名 → 回退到 saved progress', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    // saved progress = page 0
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7, page: 0, imageName: null, readerMode: 'single', updatedAt: 100, finished: false,
    });
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouterWithQuery('/reader/7', { at: 'nonexistent.jpg' });
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // fallback 到 saved progress page=0 → spread 0
    expect(reader.currentSpreadIndex).toBe(0);
  });

  it('route.query.at 含特殊字符 (encodeURIComponent) → 正确解析到对应 spread', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c (1).jpg', path: '/test/manga/c (1).jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c (1).jpg', path: '/test/manga/c (1).jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    // 'c (1).jpg' encodeURIComponent = 'c%20(1).jpg', but 在 route.query 里是 decode 后的原值
    const router = makeRouterWithQuery('/reader/7', { at: 'c (1).jpg' });
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 'c (1).jpg' 是 index 2 → singlePage spread = page 2
    expect(reader.currentSpreadIndex).toBe(2);
  });

  // ─── Cluster A 增强: reader 排序与 file browser 排序一致 ───
  // 当用户在 file browser 改了排序 (按 modifiedAt / size, ascending / descending),
  // reader 打开同一文件夹时图片顺序应当一致 (而非总是按 name 字母序).

  it('reader 排序跟随 fileBrowser.effectiveSortField=name (默认) → 按 name 字母序', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'z.jpg', path: '/test/manga/z.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 300 },
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 300, modifiedAt: 100 },
      { name: 'm.jpg', path: '/test/manga/m.jpg', isDirectory: false, isArchive: false, size: 200, modifiedAt: 200 },
    ] as never);
    const fb = useFileBrowserStore();
    // v0.1.0-module3.0.3-hotfix4: ReaderView 现在用 directorySort.resolve(sd, absPath),
    // fallback 到 fb.sortField / fb.sortAscending (settings). 不用 effectiveSortField
    // 因为那是 fileBrowser 最后 fetch 的目录排序, 不一定是 book 目录.
    fb.sortField = 'name';
    fb.sortAscending = true;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 按 name 字母升序: a, m, z
    const urls = reader.pages;
    expect(urls[0]).toContain('a.jpg');
    expect(urls[1]).toContain('m.jpg');
    expect(urls[2]).toContain('z.jpg');
  });

  it('reader 排序跟随 fileBrowser.sortField=modifiedAt,sortAscending=true → 按修改时间正序', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 300 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 300, modifiedAt: 100 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 200, modifiedAt: 200 },
    ] as never);
    const fb = useFileBrowserStore();
    fb.sortField = 'modifiedAt';
    fb.sortAscending = true;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // modifiedAt 升序: b(100), c(200), a(300)
    const urls = reader.pages;
    expect(urls[0]).toContain('b.jpg');
    expect(urls[1]).toContain('c.jpg');
    expect(urls[2]).toContain('a.jpg');
  });

  it('reader 排序跟随 fileBrowser.sortField=size,sortAscending=false → 按大小倒序', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 300 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 300, modifiedAt: 100 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 200, modifiedAt: 200 },
    ] as never);
    const fb = useFileBrowserStore();
    fb.sortField = 'size';
    fb.sortAscending = false;  // 倒序
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // size 倒序: b(300), c(200), a(100)
    const urls = reader.pages;
    expect(urls[0]).toContain('b.jpg');
    expect(urls[1]).toContain('c.jpg');
    expect(urls[2]).toContain('a.jpg');
  });

  it('排序变化时 ?at= 仍指向双击的图片 (新顺序中的 spread index)', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 300 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 300, modifiedAt: 100 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 200, modifiedAt: 200 },
    ] as never);
    vi.mocked(getProgress).mockReset();
    vi.mocked(getProgress).mockResolvedValue(null);
    const fb = useFileBrowserStore();
    fb.sortField = 'size';
    fb.sortAscending = false;  // 倒序: b, c, a
    const reader = useReaderStore();
    useSlideshowStore();
    // 双击 c.jpg (在新顺序中 index=1, spread=1)
    const router = makeRouterWithQuery('/reader/7', { at: 'c.jpg' });
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 排序 b,c,a → c 的 spread = 1
    expect(reader.currentSpreadIndex).toBe(1);
  });

  // ─── v0.1.0-module3.0.8: 进度恢复 imageName 优先 + page fallback ───
  // 4 个 fallback 用例: 命中 / 不命中 / imageName=null 旧行 / ?at= 优先

  it('恢复路径：progress.imageName 命中 imageNames → 用 imageName（不走 page）', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    // imageName='b.jpg' (index=1) 应胜出; page=0 → spread=0 (与 imageName 不同,
    // 旧实现走 page 会得到 0; 新实现命中 imageName 应得到 1 — 这是 RED 测试)
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7, page: 0, imageName: 'b.jpg', readerMode: 'single', updatedAt: 100, finished: false,
    });
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // b.jpg 是第 2 张 (0-indexed=1) → spread=1 (singlePage mode)
    expect(reader.currentSpreadIndex).toBe(1);
  });

  it('恢复路径：progress.imageName 不在 imageNames 中（改名/删除） → fallback page', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    // imageName='deleted.jpg' 不在 imageNames (a/b/c) 中 → 走 page=1
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7, page: 1, imageName: 'deleted.jpg', readerMode: 'single', updatedAt: 100, finished: false,
    });
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // page=1 → spread=1 (singlePage mode)
    expect(reader.currentSpreadIndex).toBe(1);
  });

  it('恢复路径：progress.imageName=null（旧行 image_name=NULL） → fallback page', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    // imageName=null（旧行 image_name=NULL, migration 010 之前）
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7, page: 1, imageName: null, readerMode: 'single', updatedAt: 100, finished: false,
    });
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // page=1 → spread=1
    expect(reader.currentSpreadIndex).toBe(1);
  });

  it('恢复路径：?at=imageName 优先于 progress.imageName（用户显式选择胜出）', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    // progress.imageName='a.jpg' (index=0), 但 ?at='c.jpg' 应胜出
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7, page: 0, imageName: 'a.jpg', readerMode: 'single', updatedAt: 100, finished: false,
    });
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    const reader = useReaderStore();
    useSlideshowStore();
    // ?at=c.jpg → index=2 → spread=2 (singlePage mode)
    const router = makeRouterWithQuery('/reader/7', { at: 'c.jpg' });
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // ?at=c.jpg (index=2) 优先于 progress.imageName=a.jpg (index=0)
    expect(reader.currentSpreadIndex).toBe(2);
  });

  // v0.1.0-module3.0.3-hotfix4: book 目录排序独立于 fileBrowser 上次 fetch.
  // 之前用 effectiveSortField (fileBrowser 上次 fetch 的目录排序), 错把父目录排序
  // 应用到子目录 book. 现在直接用 directorySort.resolve(book 目录的 relPath).
  // 路径身份修复 (2026-08-12): mock 数据用 source-relative (rootPath=/test, absolutePath=manga).
  it('reader 排序使用 book 目录的 per-folder override (与 fileBrowser 上次 fetch 无关)', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: 'manga/a.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 300 },
      { name: 'b.jpg', path: 'manga/b.jpg', isDirectory: false, isArchive: false, size: 300, modifiedAt: 100 },
      { name: 'c.jpg', path: 'manga/c.jpg', isDirectory: false, isArchive: false, size: 200, modifiedAt: 200 },
    ] as never);
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockResolvedValue({
      id: 7,
      title: 'manga',
      absolutePath: 'manga',  // book 目录相对 rootPath=/test
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      isFavorite: false,
      sourceDescriptor: { type: 'local', rootPath: '/test' },
      sourceType: 'Local',
    } as never);
    const { useDirectorySortStore } = await import('@/stores/directorySort');
    const ds = useDirectorySortStore();
    // 给 book 目录 manga 设 ASC (覆盖默认)
    await ds.set({ type: 'local', rootPath: '/test' }, 'manga', { sortField: 'modifiedAt', ascending: true });
    // fb 默认 sortField 是 modifiedAt 倒序 — 模拟父目录的设置
    const fb = useFileBrowserStore();
    fb.sortField = 'modifiedAt';
    fb.sortAscending = false;
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 应该用 book 目录的 ASC (modifiedAt 升序): b(100), c(200), a(300)
    // 而不是 fb 的 DESC: a(300), c(200), b(100)
    const urls = reader.pages;
    expect(urls[0]).toContain('b.jpg');
    expect(urls[1]).toContain('c.jpg');
    expect(urls[2]).toContain('a.jpg');
  });

  // ─── 2026-08-12 跨卷任务 8: route watch immediate + loadRouteBook + commitBookSnapshot ───
  // spec §11.1-§11.2 + §17.2. 不变量 2/3/5. 复用真实 loader (走 mocked tauri).

  it('commitBookSnapshot 原子提交: loadBookById 成功后 reader.sourceDescriptor + currentRelPath 写入 (Controller.identity 依赖)', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockResolvedValue({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: 'subdir',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 0,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    const fb = useFileBrowserStore();
    fb.entries = [];
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(reader.status).toBe('ready');
    // 跨卷 currentIdentity() 依赖这两个字段 (spec §11.2 P1-1)
    expect(reader.sourceDescriptor).toEqual({ type: 'local', rootPath: '/test/manga' });
    expect(reader.currentRelPath).toBe('subdir');
  });

  it('loadBookById 失败: status=error + reader.closeBook 调 (bookId/sourceDescriptor/currentRelPath 清) + 旧 refs 清空', async () => {
    // 第一次 loadBookById 成功（给 reader store 写入数据以便验证失败时清空）
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 0,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    const fb = useFileBrowserStore();
    fb.entries = [];
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(reader.status).toBe('ready');
    expect(reader.bookId).toBe(7);

    // 第二次跨到 /reader/99 时 getBook 拒绝 → loadBookById 抛 → 不保留旧卷
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockRejectedValue(new Error('找不到 bookId 99'));
    // 加一条 /reader/99 路由（避免 push 报 No match）
    router.addRoute({ path: '/reader/:bookId', name: 'reader', component: ReaderView });
    await router.push('/reader/99');
    await flushPromises();
    await flushPromises();
    await flushPromises();

    // 不变量 3：失败不保留旧卷（route 已是新 bookId → reader.closeBook + 清 refs + error UI）
    expect(reader.status).toBe('idle');   // reader store 已被 closeBook 重置为 idle
    expect(reader.bookId).toBeNull();        // closeBook 调
    expect(reader.sourceDescriptor).toBeNull();  // closeBook 调
    expect(reader.currentRelPath).toBe('');  // closeBook 调
    // 模板显示 error UI (ReaderView 自身 status=error, pageUrls/book/imageNames 清)
    expect(w.find('[data-test="reader-error"]').exists()).toBe(true);
  });

  it('stale 丢弃: 第一次 loadRouteBook 晚于第二次返回 → 第一次结果不 commit, 最终状态是第二次', async () => {
    // book 7 用 deferred promise（晚返回）, book 99 立即返回
    let resolveBook7: (v: unknown) => void = () => undefined;
    const deferredBook7 = new Promise<unknown>((resolve) => { resolveBook7 = resolve; });

    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockImplementation(((id: number) => {
      if (id === 7) return deferredBook7 as Promise<ReturnType<typeof getBook>>;
      if (id === 99) return Promise.resolve({
        id: 99,
        title: 'Manga 99',
        sourceDescriptor: { type: 'local', rootPath: '/test/manga99' },
        sourceType: 'Local',
        absolutePath: '',
        coverEntryPath: null,
        coverEntryName: null,
        pageCount: 0,
        lastReadAt: null,
        addedAt: 0,
        isFavorite: false,
      } as never);
      return Promise.resolve(null as never);
    }) as never);
    vi.mocked(getProgress).mockReset();
    vi.mocked(getProgress).mockResolvedValue(null);

    const fb = useFileBrowserStore();
    fb.entries = [];
    const reader = useReaderStore();
    useSlideshowStore();
    const router = makeRouter();  // initial push /reader/7 → deferred
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();  // 让 loadRouteBook(7) 启动并停在 await loader

    // 立即跨到 /reader/99 → loadRouteBook(99) 启动并快速完成
    await router.push('/reader/99');
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 此时 book 99 应已 commit（activeLoadSeq=2, seq=2）
    expect(reader.bookId).toBe(99);

    // 现在让 book 7 的 deferred resolve（应被 activeLoadSeq 守卫丢弃, seq=1 != 2）
    resolveBook7({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 0,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    // 最终状态应是 99, 不是 7 (activeLoadSeq guard 丢弃旧卷晚返回)
    expect(reader.bookId).toBe(99);
    expect(reader.title).toBe('Manga 99');
    expect(reader.sourceDescriptor).toEqual({ type: 'local', rootPath: '/test/manga99' });
  });

  // v0.1.0-module3.0.7: Reader 主菜单 ❤️ toggle 连续切换
  // 验证: ① onToggleLike 调 setFavorite ② book ref 同步 ③ 同会话可反复切换
  // 这是代码审查 P1 反馈要求 — 原本 toggleLike 写 like 表 + book 快照不刷,无法取消喜欢
  it('ReaderMainMenu emit toggle-like 连续两次 → setFavorite(true)→(false),book.isFavorite 同步翻转', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockResolvedValue({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    vi.mocked(setFavorite).mockReset();
    vi.mocked(setFavorite).mockResolvedValue(undefined);
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const wrapper = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    const menu = wrapper.findComponent({ name: 'ReaderMainMenu' });
    expect(menu.exists()).toBe(true);
    expect(menu.props('isLiked')).toBe(false);

    menu.vm.$emit('toggle-like');
    await flushPromises();
    expect(setFavorite).toHaveBeenCalledWith(7, true);
    expect(setFavorite).toHaveBeenCalledTimes(1);
    expect(menu.props('isLiked')).toBe(true);

    menu.vm.$emit('toggle-like');
    await flushPromises();
    expect(setFavorite).toHaveBeenCalledWith(7, false);
    expect(setFavorite).toHaveBeenCalledTimes(2);
    expect(menu.props('isLiked')).toBe(false);
  });

  // v0.1.0-module3.0.7 round-4 P1: 并发竞态修复
  // 若无 in-flight guard,用户在 await setFavorite 期间再次点击会触发两次调用,
  // 都基于同一个旧 isFavorite 计算 nextFav,写出重复值。
  // 修复后 in-flight 期间第二次 emit 被静默忽略。
  it('onToggleLike in-flight 期间第二次 emit 被忽略(setFavorite 只调 1 次)', async () => {
    vi.mocked(listDirectory).mockReset();
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    vi.mocked(getBook).mockReset();
    vi.mocked(getBook).mockResolvedValue({
      id: 7,
      title: 'Manga 7',
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never);
    let resolveFirst!: () => void;
    vi.mocked(setFavorite).mockReset();
    vi.mocked(setFavorite).mockImplementation(() => new Promise<void>((r) => { resolveFirst = r; }));

    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const wrapper = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    const menu = wrapper.findComponent({ name: 'ReaderMainMenu' });

    menu.vm.$emit('toggle-like');
    await flushPromises();
    expect(setFavorite).toHaveBeenCalledTimes(1);
    expect(setFavorite).toHaveBeenCalledWith(7, true);
    expect(menu.props('isLiked')).toBe(false);

    menu.vm.$emit('toggle-like');
    await flushPromises();
    expect(setFavorite).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flushPromises();
    expect(setFavorite).toHaveBeenCalledTimes(1);
    expect(menu.props('isLiked')).toBe(true);

    vi.mocked(setFavorite).mockResolvedValue(undefined);
    menu.vm.$emit('toggle-like');
    await flushPromises();
    expect(setFavorite).toHaveBeenCalledTimes(2);
    expect(setFavorite).toHaveBeenNthCalledWith(2, 7, false);
    expect(menu.props('isLiked')).toBe(false);
  });

  // ─── 2026-08-16 — 阅览记录：所有进阅读器的路径统一记录 ──────────────
  // 此前 recordHistory 只在 useReaderActions（文件浏览器打开动作）调用，
  // 自动跨卷（navigateToVolume → router.replace → loadRouteBook）漏记。
  // 修法：loadRouteBook 提交成功后统一记录（幂等 upsert，失败静默）。
  it('mount 加载成功后记录 browse_history（loadRouteBook 统一入口）', async () => {
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useReaderStore();
    useSlideshowStore();
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordHistory).mock.calls[0]).toEqual([
      expect.objectContaining({ type: 'local' }),
      expect.any(String),
      'Manga 7',
      7,
    ]);
    w.unmount();
  });

  // ─── bugfix 2026-08-15 — 幻灯片跨卷续播 ──────────────────────────────
  // 现象：幻灯片播放中末页自动跨卷成功后，播放停止，不再续播下一卷。
  // 根因：slideshow.tick 末页分支先 pause() 再置 pendingNextVolume ——
  // useCrossVolume.maybeContinue 入口读 isPlaying 已是 false →
  // A7 wasSlideshowPlaying 恒 false → 跨卷成功后 resumeSlideshow 永不调用。
  // 修法：tick 置 flag 前记 pendingNextVolumeFromSlideshow；ReaderView 注入
  // isSlideshowPlaying 读 isPlaying || fromSlideshow；resumeSlideshow 在新卷
  // commit（navigateToVolume await 加载完成）后 start。
  it('slideshow 播放中末页 tick → auto 跨卷 → 新卷 ready 后自动续播', async () => {
    const fb = useFileBrowserStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useReaderStore();
    const slideshow = useSlideshowStore();
    const settings = useSettingsStore();
    settings.continueToNextVolume = 'auto';

    vi.mocked(getBook).mockImplementation(async (id: number) => ({
      id,
      title: 'Manga ' + id,
      sourceDescriptor: { type: 'local', rootPath: '/test/manga' },
      sourceType: 'Local',
      absolutePath: '',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: false,
    } as never));
    vi.mocked(findNextVolume).mockResolvedValueOnce({
      descriptor: { type: 'local', rootPath: '/test/manga' },
      relPath: 'vol2',
      title: 'Vol 2',
    } as never);
    vi.mocked(createBook).mockResolvedValueOnce(8);

    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    // 播放中，末页 tick（模拟 interval 在末页触发跨卷意图）
    slideshow.start();
    expect(slideshow.isPlaying).toBe(true);
    slideshow.tick(vi.fn(), vi.fn(), () => true);
    expect(slideshow.isPlaying).toBe(false); // tick 内已 pause

    // 链路：watch → maybeContinue(auto) → findNextVolume → navigate →
    // ensureBookId(8) → router.replace → loadRouteBook(8) → ready → 续播
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.params.bookId).toBe('8');
    expect(slideshow.pendingNextVolume).toBe(false); // 意图已消费
    expect(vi.mocked(findNextVolume).mock.calls[0]?.[3]).toEqual({ skipFinished: true }); // 自动跨卷跳过已读完
    await flushPromises();
    // 2026-08-16: 跨卷也要记阅览记录（loadRouteBook 统一入口）
    expect(vi.mocked(recordHistory).mock.calls.at(-1)).toEqual([
      expect.objectContaining({ type: 'local' }),
      expect.any(String),
      'Manga 8',
      8,
    ]);
    expect(slideshow.isPlaying).toBe(true);          // ← 跨卷后续播

    slideshow.pause();
    w.unmount();
  });

});


describe('ReaderView.vue webtoon 编排（module3.1.0）', () => {

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    wtStub.__registry.topImage = 'a.jpg';
    wtStub.__registry.atBottom = false;
    wtStub.__registry.zoom = 1;
    wtStub.__registry.scrollTargets = [];
    wtStub.__registry.steps = 0;
    wtStub.__registry.setZoomCalls = [];
    wtStub.__registry.el.scrollTop = 0;
    wtStub.__registry.el.scrollBy.mockClear();
  });

  /** webtoon 模式挂载：settings 默认模式切 webtoon 后 mount。 */
  async function mountWebtoon() {
    const settings = useSettingsStore();
    settings.readerDefaultMode = 'webtoon';
    const router = makeRouter();
    await router.isReady();
    return mount(ReaderView, { global: { plugins: [i18n, router] } });
  }
  function findViewer(w: ReturnType<typeof mount>) {
    return w.findComponent({ name: 'WebtoonViewer' });
  }

  it('恢复链：progress.imageName 命中 → scrollToImage 该图（loader 图索引映射，非 spread 索引）', async () => {
    vi.mocked(getProgress).mockResolvedValueOnce({
      bookId: 7, page: 0, imageName: 'b.jpg', readerMode: 'webtoon', updatedAt: 0, finished: false,
    });
    const w = await mountWebtoon();
    await flushPromises();
    // imageName 'b.jpg' 是第 2 张（index 1）；若误用 spread 索引会错位到别的图
    expect(wtStub.__registry.scrollTargets).toContain('b.jpg');
    expect(wtStub.__registry.scrollTargets).not.toContain('a.jpg');
    w.unmount();
  });

  it('恢复链：webtoon 挂载后按 restoreImageIndex 调 scrollToImage（progress 空 → 第 0 张）', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    expect(wtStub.__registry.scrollTargets).toContain('a.jpg');
    w.unmount();
  });

  it('跳页 dialog webtoon 分流：提交页码 → scrollToImage 该图（不碰 spread）', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    wtStub.__registry.scrollTargets = [];
    const input = w.find('[data-test="jump-dialog-input"]');
    await input.setValue(3);
    await w.find('[data-test="jump-dialog"] form').trigger('submit');
    expect(wtStub.__registry.scrollTargets).toEqual(['c.jpg']);
    w.unmount();
  });

  it('unmount 双写防护：webtoon 走 flushNow 写 webtoon 位置，不走 paged 链（P0-2）', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    wtStub.__registry.topImage = 'b.jpg';
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    w.unmount();
    await flushPromises();
    expect(markFinished).not.toHaveBeenCalled();
    const calls = vi.mocked(await import('@/lib/tauri')).saveProgress.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe(7);
    expect(calls[0]?.[2]).toBe('webtoon');
    expect(calls[0]?.[4]).toBe('b.jpg');
  });

  it('手动越底：scroll-past-bottom → ensureFinished 成功 → maybeContinue（auto 档查下一卷）', async () => {
    const settings = useSettingsStore();
    settings.continueToNextVolume = 'auto';
    const w = await mountWebtoon();
    await flushPromises();
    vi.mocked(await import('@/lib/tauri')).findNextVolume.mockClear();
    wtStub.__registry.atBottom = true;
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    findViewer(w).vm.$emit('scroll-past-bottom');
    await flushPromises();
    expect(markFinished).toHaveBeenCalledWith(7, true);
    expect(vi.mocked(await import('@/lib/tauri')).findNextVolume).toHaveBeenCalled();
    w.unmount();
  });

  it('手动越底节流：800ms 内第二次 scroll-past-bottom 不重复 ensureFinished', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    wtStub.__registry.atBottom = true;
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    findViewer(w).vm.$emit('scroll-past-bottom');
    await flushPromises();
    findViewer(w).vm.$emit('scroll-past-bottom');
    await flushPromises();
    expect(markFinished).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('手动越底身份校验：写入期间换卷（bookId 变）→ 不发起跨卷', async () => {
    const settings = useSettingsStore();
    settings.continueToNextVolume = 'auto';
    const w = await mountWebtoon();
    await flushPromises();
    const tauri = vi.mocked(await import('@/lib/tauri'));
    let resolveMark!: () => void;
    vi.mocked(markFinished).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveMark = resolve; }));
    tauri.findNextVolume.mockClear();
    wtStub.__registry.atBottom = true;
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    findViewer(w).vm.$emit('scroll-past-bottom');
    await flushPromises();
    // markFinished 挂起期间换卷（跨卷/直接 URL）
    const reader = useReaderStore();
    reader.bookId = 99;
    resolveMark();
    await flushPromises();
    expect(tauri.findNextVolume).not.toHaveBeenCalled();
    w.unmount();
  });

  it('自动滚动 autoEnd：到底 pause → STABLE_MS+200 后 ensureFinished 成功 → 发起跨卷', async () => {
    vi.useFakeTimers();
    try {
      const settingsAuto = useSettingsStore();
      settingsAuto.continueToNextVolume = 'auto';
      const w = await mountWebtoon();
      await flushPromises();
      const slideshow = useSlideshowStore();
      wtStub.__registry.atBottom = true;
      slideshow.start();
      await flushPromises();
      // rAF 帧（fake timers 接管 rAF）：step → atBottom → pause + 挂 autoEndTimer
      await vi.advanceTimersByTimeAsync(50);
      expect(slideshow.isPlaying).toBe(false);
      expect(wtStub.__registry.steps).toBeGreaterThan(0);
      expect(markFinished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(markFinished).toHaveBeenCalledWith(7, true);
      // pendingNextVolume 是一次性意图：watch 消费后由 maybeContinue 复位 false，
      // 断言链路终点——auto 档实际去查了下一卷。
      expect(vi.mocked(findNextVolume)).toHaveBeenCalled();
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoEnd 取消路径：等待期内滚离底部 → 不标完不跨卷', async () => {
    vi.useFakeTimers();
    try {
      const w = await mountWebtoon();
      await flushPromises();
      const slideshow = useSlideshowStore();
      wtStub.__registry.atBottom = true;
      slideshow.start();
      await vi.advanceTimersByTimeAsync(50);
      // 等待期内滚回上方
      wtStub.__registry.atBottom = false;
      findViewer(w).vm.$emit('scroll');
      await vi.advanceTimersByTimeAsync(1500);
      expect(markFinished).not.toHaveBeenCalled();
      expect(slideshow.pendingNextVolume).toBe(false);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoEnd 取消路径：等待期内切模式 → 不标完且 atBottom 清空（stableTimer 不迟到误标）', async () => {
    vi.useFakeTimers();
    try {
      const w = await mountWebtoon();
      await flushPromises();
      const slideshow = useSlideshowStore();
      wtStub.__registry.atBottom = true;
      slideshow.start();
      await vi.advanceTimersByTimeAsync(50);
      const settings = useSettingsStore();
      settings.readerDefaultMode = 'single';
      await vi.advanceTimersByTimeAsync(1500);
      expect(markFinished).not.toHaveBeenCalled();
      expect(slideshow.pendingNextVolume).toBe(false);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoEnd：ensureFinished 失败（写库 reject）→ 不跨卷', async () => {
    vi.useFakeTimers();
    try {
      const w = await mountWebtoon();
      await flushPromises();
      const slideshow = useSlideshowStore();
      vi.mocked(markFinished).mockRejectedValueOnce(new Error('ipc down'));
      wtStub.__registry.atBottom = true;
      slideshow.start();
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(1500);
      expect(slideshow.pendingNextVolume).toBe(false);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('interval tick 不参与结束（十轮 P1-2）：atBottom 后 tick 不推进 spread 也不跨卷', async () => {
    vi.useFakeTimers();
    try {
      const w = await mountWebtoon();
      await flushPromises();
      const slideshow = useSlideshowStore();
      const reader = useReaderStore();
      const before = reader.currentSpreadIndex;
      wtStub.__registry.atBottom = true;
      slideshow.start();
      // rAF 尚未跑（未 advance），先让 interval tick 数次
      await vi.advanceTimersByTimeAsync(0);
      slideshow.intervalMs = 50;
      await vi.advanceTimersByTimeAsync(60);
      expect(reader.currentSpreadIndex).toBe(before);
      expect(slideshow.pendingNextVolume).toBe(false);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('模式切换屏障：single（paged）先 await reader.saveCurrentProgressNow 再 cycle 到 double', async () => {
    const reader = useReaderStore();
    const spy = vi.spyOn(reader, 'saveCurrentProgressNow');
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    w.findComponent({ name: 'ReaderMainMenu' }).vm.$emit('cycle-mode');
    await flushPromises();
    expect(spy).toHaveBeenCalled();
    const settings = useSettingsStore();
    expect(settings.readerDefaultMode).toBe('double');
    w.unmount();
  });

  it('模式切换屏障：webtoon→paged 先 flushNow 写 webtoon 位置再 cycle', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    wtStub.__registry.topImage = 'c.jpg';
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    w.findComponent({ name: 'ReaderMainMenu' }).vm.$emit('cycle-mode');
    await flushPromises();
    const tauri = vi.mocked(await import('@/lib/tauri'));
    const webtoonWrites = tauri.saveProgress.mock.calls.filter((c) => c[2] === 'webtoon');
    expect(webtoonWrites.length).toBe(1);
    expect(webtoonWrites[0]?.[4]).toBe('c.jpg');
    const settings = useSettingsStore();
    expect(settings.readerDefaultMode).toBe('single');
    w.unmount();
  });

  it('hotkeys override：nextPage → scrollScreen(1)（90% 视口高），prevPage 反向', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    const actions = vi.mocked(useReaderHotkeys).mock.calls.at(-1)?.[0];
    expect(actions).toBeTruthy();
    actions!.nextPage!();
    expect(wtStub.__registry.el.scrollBy).toHaveBeenCalledWith({ top: 90, behavior: 'auto' });
    actions!.prevPage!();
    expect(wtStub.__registry.el.scrollBy).toHaveBeenLastCalledWith({ top: -90, behavior: 'auto' });
    wtStub.__registry.el.scrollTop = 50;
    actions!.jumpFirst!();
    expect(wtStub.__registry.el.scrollTop).toBe(0);
    actions!.jumpLast!();
    expect(wtStub.__registry.el.scrollTop).toBe(wtStub.__registry.el.scrollHeight);
    w.unmount();
  });

  it('useReaderWheel disabled 跟随模式：webtoon true / single false', async () => {
    const wWebtoon = await mountWebtoon();
    await flushPromises();
    const optsW = vi.mocked(useReaderWheel).mock.calls.at(-1)?.[0];
    expect(optsW?.disabled?.value).toBe(true);
    wWebtoon.unmount();
    const settings2 = useSettingsStore();
    settings2.readerDefaultMode = 'single';
    const router = makeRouter();
    await router.isReady();
    const wSingle = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const optsS = vi.mocked(useReaderWheel).mock.calls.at(-1)?.[0];
    expect(optsS?.disabled?.value).toBe(false);
    wSingle.unmount();
  });

  it('重置缩放状态链：zoom-change → webtoonZoom → MainMenu prop；reset-zoom → setZoom(1)', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    findViewer(w).vm.$emit('zoom-change', 2);
    await flushPromises();
    const menu = w.findComponent({ name: 'ReaderMainMenu' });
    expect(menu.props('webtoonZoom')).toBe(2);
    menu.vm.$emit('reset-zoom');
    await flushPromises();
    expect(wtStub.__registry.setZoomCalls).toContain(1);
    w.unmount();
  });

  it('页码 override：webtoon 下 MainMenu 显示顶部图 n / N', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    wtStub.__registry.topImage = 'b.jpg';
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    const menu = w.findComponent({ name: 'ReaderMainMenu' });
    expect(menu.props('currentPageOverride')).toBe(2);
    expect(menu.props('totalPagesOverride')).toBe(3);
    w.unmount();
  });

  it('加书签 webtoon 分流：记录顶部图索引而非 spreadIndex', async () => {
    const w = await mountWebtoon();
    await flushPromises();
    wtStub.__registry.topImage = 'c.jpg';
    findViewer(w).vm.$emit('scroll');
    await flushPromises();
    vi.mocked(addBookmark).mockClear();
    w.findComponent({ name: 'ReaderMainMenu' }).vm.$emit('add-bookmark');
    await flushPromises();
    expect(addBookmark).toHaveBeenCalledWith(7, 2, null);
    w.unmount();
  });

});
