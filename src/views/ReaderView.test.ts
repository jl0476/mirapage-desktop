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
import { getBook, getProgress } from '@/lib/tauri';
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
});