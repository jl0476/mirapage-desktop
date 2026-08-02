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
  convertFileSrc: (p: string) => `tauri://localhost/${p}`,
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
  // 当前 spreadIndex = spreads.length - 1 会被 slideshow.tick() atLast() 立即 pause + setPendingNextVolume,
  // 用户感知"刚开就跨卷". 修法: getProgress 返回末页 (page = pageCount - 1) 时,
  // resolveInitialSpreadIndex 把 spreadIndex 钳到 last - 1 (倒数第二页).
  it('getProgress 末页 → initialSpreadIndex 钳到 last - 1 (避免立刻触发跨卷)', async () => {
    // 3 张图 → spreads: [{start:0,end:1},{start:1,end:3}] → last spread index = 1
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
    // 末页钳位: page=2 → spreads[1].start=1, 但 last spread index = 1
    // 应钳到 0 (倒数第二), 不在末 spread
    expect(reader.currentSpreadIndex).toBe(0);
    expect(reader.currentSpreadIndex).toBeLessThan(reader.spreads.length - 1);
  });

  // v0.1.0-module3.0.2-hotfix2 (H7): absolutePath 回归 — 端到端
  // getBook 返回 rootPath='/root' + absolutePath='/root/漫画' (子目录)
  // ReaderView 应该用 absolutePath 枚举图片, 而非 setRoot 到 root
  it('getBook 返回 absolutePath 子目录时, 正确枚举子目录图片 (不读根目录)', async () => {
    vi.mocked(getBook).mockResolvedValueOnce({
      id: 7,
      title: '漫画 A',
      sourceDescriptor: { type: 'local', rootPath: '/root' },
      sourceType: 'Local',
      absolutePath: '/root/漫画',  // ← 关键: 子目录
      coverEntryPath: null,
      coverEntryName: null,
      pageCount: 3,
      lastReadAt: null,
      addedAt: 0,
      isFavorite: true,
    } as never);
    // listDirectory('/root/漫画')  返回 3 张图
    // listDirectory('/root')       返回 458 个杂项 (模拟真实用户场景)
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
    // 关键断言: 不应读根目录的 458 entries, 应该读 absolutePath 子目录的 3 张图
    expect(listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/root' }),
      '/root/漫画',
    );
  });

  // v0.1.0-module3.0.2-hotfix3 (H8): pageUrls URL 必须 percent-encode
  // 文件名/目录含特殊字符 ('(', ')', ' ', 中文) 时, WebView2 fetch asset://
  // 失败导致 OSD tile load fail, 翻页后图片不显示.
  // 现状: pageUrls = convertFileSrc(`Q:\\dir\\(林星阑) - 秀人网模特 红衣黑丝\\c (1).jpg`)
  //       → 'http://asset.localhost/Q:\\dir\\(林星阑) - 秀人网模特 红衣黑丝\\c (1).jpg'
  //       括号 / 空格 / 中文未 encode, WebView2 fetch 路径解析失败.
  // 修: 拼接 url 时对每个 path segment 用 encodeURIComponent, 但保留 path
  //     分隔符 '/'. 更稳的做法: 对整路径 split('/') 然后 encode 再 join.
  it('pageUrls 文件名/目录含特殊字符时, URL 应 percent-encode', async () => {
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
      // setRoot 调的 fetch('') 拿根目录
      if (p === '' || p === 'Q:\\00down\\2603') {
        return [] as never;
      }
      // 实际子目录
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
    // 关键断言: pageUrls 第 1 个不应含未 encode 的 '(' ')' 或空格
    const reader = useReaderStore();
    const url = reader.pages[0] as string;
    expect(url).toBeDefined();
    // 不能含未编码的 '(' ')' 或 ' ' (空格)
    expect(url).not.toMatch(/[ ()]/);
    // 应该含 '%E6%9E%97' (林) 和 '%20' (空格)
    expect(url).toContain('%E6%9E%97');
    expect(url).toContain('%20');
  });
});