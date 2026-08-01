/**
 * useReaderActions.test.ts — v0.1.0-module2.0 触发阅读入口
 *
 * - 复用同 rootPath 的 bookId (从 listHistory 拿)
 * - 没有则 createBook
 * - 最后 router.push('/reader/' + bookId)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listHistory: vi.fn(async () => []),
    recordHistory: vi.fn(async () => undefined),
    createBook: vi.fn(async (_title: string, _sd: unknown) => 42),
  };
});

import { listHistory, recordHistory, createBook } from '@/lib/tauri';
import { useReaderActions } from './useReaderActions';
import type { MediaEntry } from '@/lib/sourceDescriptor';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': {} } });

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/reader/:bookId', name: 'reader', component: { template: '<div />' } },
    ],
  });
}

describe('useReaderActions — readNow', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('history 没记录 → createBook 拿新 ID → recordHistory → push /reader/42', async () => {
    vi.mocked(listHistory).mockResolvedValueOnce([]);
    const router = makeRouter();
    router.push('/');
    await router.isReady();

    let captured: ReturnType<typeof useReaderActions> | null = null;
    mount({
      setup() {
        captured = useReaderActions({
          resolveRootPath: () => '/test/manga/VOL.01',
          buildSourceDescriptor: (p) => ({ type: 'local', rootPath: p }),
          router,
        });
        return () => null;
      },
      global: { plugins: [i18n, router] },
    });

    const entry: MediaEntry = {
      name: 'VOL.01', path: 'VOL.01', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0,
    };
    await captured!.readNow(entry);
    await flushPromises();

    expect(createBook).toHaveBeenCalledWith('VOL.01', { type: 'local', rootPath: '/test/manga/VOL.01' });
    expect(recordHistory).toHaveBeenCalledWith({ type: 'local', rootPath: '/test/manga/VOL.01' }, 42, 0);
    expect(router.currentRoute.value.path).toBe('/reader/42');
  });

  it('history 有同 rootPath → 复用 bookId', async () => {
    vi.mocked(listHistory).mockResolvedValueOnce([
      { bookId: 7, sourceDescriptor: { rootPath: '/test/manga/VOL.01' }, title: 'VOL.01' },
    ] as never);
    const router = makeRouter();
    router.push('/');
    await router.isReady();

    let captured: ReturnType<typeof useReaderActions> | null = null;
    mount({
      setup() {
        captured = useReaderActions({
          resolveRootPath: () => '/test/manga/VOL.01',
          buildSourceDescriptor: (p) => ({ type: 'local', rootPath: p }),
          router,
        });
        return () => null;
      },
      global: { plugins: [i18n, router] },
    });

    const entry: MediaEntry = {
      name: 'VOL.01', path: 'VOL.01', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0,
    };
    await captured!.readNow(entry);
    await flushPromises();

    expect(createBook).not.toHaveBeenCalled();
    expect(recordHistory).toHaveBeenCalledWith({ type: 'local', rootPath: '/test/manga/VOL.01' }, 7, 0);
    expect(router.currentRoute.value.path).toBe('/reader/7');
  });

  it('非目录条目 → 不调 IPC / 不导航', async () => {
    const router = makeRouter();
    router.push('/');
    await router.isReady();

    let captured: ReturnType<typeof useReaderActions> | null = null;
    mount({
      setup() {
        captured = useReaderActions({
          resolveRootPath: () => '/test/manga/x.jpg',
          buildSourceDescriptor: (p) => ({ type: 'local', rootPath: p }),
          router,
        });
        return () => null;
      },
      global: { plugins: [i18n, router] },
    });

    const entry: MediaEntry = {
      name: 'x.jpg', path: 'x.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0,
    };
    await captured!.readNow(entry);

    expect(createBook).not.toHaveBeenCalled();
    expect(recordHistory).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('addToLibrary 不导航', async () => {
    vi.mocked(listHistory).mockResolvedValueOnce([]);
    const router = makeRouter();
    router.push('/');
    await router.isReady();

    let captured: ReturnType<typeof useReaderActions> | null = null;
    mount({
      setup() {
        captured = useReaderActions({
          resolveRootPath: () => '/test/manga/VOL.01',
          buildSourceDescriptor: (p) => ({ type: 'local', rootPath: p }),
          router,
        });
        return () => null;
      },
      global: { plugins: [i18n, router] },
    });

    const entry: MediaEntry = {
      name: 'VOL.01', path: 'VOL.01', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0,
    };
    const bookId = await captured!.addToLibrary(entry);
    expect(bookId).toBe(42);
    expect(createBook).toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/'); // 不应导航
  });
});