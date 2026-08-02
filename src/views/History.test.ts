/**
 * History.vue 测试 — v0.1.0-module3.0 folder-level + delete + 跳 FileBrowser
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import zhCN from '@/locales/zh-CN';
import History from './History.vue';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import type { BrowseHistoryEntry } from '@/lib/tauri';

const sample: BrowseHistoryEntry[] = [
  {
    sourceDescriptor: { type: 'local', rootPath: 'C:/comics' },
    relPath: '',
    displayName: 'root',
    lastVisitedAt: 1000,
    bookId: null,
  },
  {
    sourceDescriptor: { type: 'local', rootPath: 'C:/comics' },
    relPath: 'Vol.01',
    displayName: 'Vol.01',
    lastVisitedAt: 2000,
    bookId: 7,
  },
];

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    // 模拟 Rust list_history ORDER BY last_visited_at DESC
    listHistory: vi.fn(async () => [...sample].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)),
    recordHistory: vi.fn(async () => undefined),
    deleteHistory: vi.fn(async () => undefined),
  };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'home', component: { template: '<div/>' } },
    { path: '/history', component: History },
  ],
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('History.vue', () => {
  it('mount → 列 items', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain('Vol.01'); // lastVisitedAt DESC
    expect(rows[1]!.text()).toContain('root');
  });

  it('点击 Vol.01 row → setRoot + navigate + router.push home', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const fb = useFileBrowserStore();
    const setRootSpy = vi.spyOn(fb, 'setRoot').mockResolvedValue();
    const navigateSpy = vi.spyOn(fb, 'navigate').mockResolvedValue();
    const pushSpy = vi.spyOn(router, 'push');

    await wrapper.findAll('button.name')[0]!.trigger('click');
    await flushPromises();
    expect(setRootSpy).toHaveBeenCalledWith('C:/comics');
    expect(navigateSpy).toHaveBeenCalledWith('Vol.01');
    expect(pushSpy).toHaveBeenCalledWith({ name: 'home' });
  });

  it('点击 root 行（relPath=""）→ setRoot 不 navigate', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const fb = useFileBrowserStore();
    const setRootSpy = vi.spyOn(fb, 'setRoot').mockResolvedValue();
    const navigateSpy = vi.spyOn(fb, 'navigate').mockResolvedValue();

    // root 是 lastVisitedAt 较小的，排序后是 rows[1]
    await wrapper.findAll('button.name')[1]!.trigger('click');
    await flushPromises();
    expect(setRootSpy).toHaveBeenCalledWith('C:/comics');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('删除按钮 → deleteEntry', async () => {
    const { deleteHistory } = await import('@/lib/tauri');
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();

    // rows[0] 是 lastVisitedAt 最大的（即 Vol.01）
    await wrapper.findAll('button.delete')[0]!.trigger('click');
    await flushPromises();
    expect(deleteHistory).toHaveBeenCalledWith(
      sample[1]!.sourceDescriptor,  // Vol.01
      sample[1]!.relPath,
    );
  });
});