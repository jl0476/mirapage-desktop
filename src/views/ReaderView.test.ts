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
vi.mock('@/composables/useKeepScreenOn', () => ({ useKeepScreenOn: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `tauri://localhost/${p}`,
  invoke: vi.fn(async () => null),
}));

import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { getBook } from '@/lib/tauri';
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
});