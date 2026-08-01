/**
 * ReaderView.vue 测试 — v0.1.0-module2.0
 * 覆盖：mount 路由 /reader/:bookId → 调 listHistory / setRoot / openBook
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
    listHistory: vi.fn(async () => [
      { bookId: 7, sourceDescriptor: { rootPath: '/test/manga' }, title: 'Manga 7' },
    ]),
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
import { listHistory } from '@/lib/tauri';
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

  it('mount 时调 listHistory 并拿 sourceDescriptor', async () => {
    const fb = useFileBrowserStore();
    useReaderStore();
    fb.entries = [
      { name: 'a.jpg', path: '/test/manga/a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'b.jpg', path: '/test/manga/b.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'c.jpg', path: '/test/manga/c.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never;
    useSlideshowStore(); // hydrate
    const router = makeRouter();
    await router.isReady();
    mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    // 至少 listHistory 调了
    expect(listHistory).toHaveBeenCalled();
  });

  it('history 找不到 bookId 时显示错误', async () => {
    vi.mocked(listHistory).mockResolvedValueOnce([]);
    const router = makeRouter();
    await router.isReady();
    const w = mount(ReaderView, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-test="reader-error"]').exists()).toBe(true);
  });
});