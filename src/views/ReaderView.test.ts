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
  };
});

vi.mock('@/composables/useReaderHotkeys', () => ({ useReaderHotkeys: vi.fn() }));
vi.mock('@/composables/useReaderTouchZones', () => ({
  useReaderTouchZones: vi.fn(),
  dispatchZoneAction: vi.fn(),
}));
vi.mock('@/composables/useReaderWheel', () => ({ useReaderWheel: vi.fn() }));
vi.mock('@/composables/useKeepScreenOn', () => ({ useKeepScreenOn: vi.fn() }));
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
import { getBook, getProgress, listDirectory } from '@/lib/tauri';
import ReaderView from './ReaderView.vue';

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
      readerMode: 'single',
      updatedAt: 100,
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
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 99,
      title: '(林星阑) - 秀人网模特 红衣黑丝',
      sourceDescriptor: { type: 'local', rootPath: 'Q:\\00down\\2603' },
      sourceType: 'Local',
      absolutePath: 'Q:\\00down\\2603\\(林星阑) - 秀人网模特 红衣黑丝',
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 85,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    vi.mocked(listDirectory).mockImplementation(async (_sd, p) => {
      if (p === '' || p === 'Q:\\00down\\2603') {
        return [] as never;
      }
      return [
        { name: 'c (1).jpg', path: 'Q:\\00down\\2603\\(林星阑) - 秀人网模特 红衣黑丝\\c (1).jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
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
      bookId: 7, page: 0, readerMode: 'single', updatedAt: 100,
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
});