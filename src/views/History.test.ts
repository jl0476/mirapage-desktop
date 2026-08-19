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
    lastVisitedAt: 1699990000,
    bookId: null,
  },
  {
    sourceDescriptor: { type: 'local', rootPath: 'C:/comics' },
    relPath: 'Vol.01',
    displayName: 'Vol.01',
    lastVisitedAt: 1700000000,
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
    exportBrowseHistory: vi.fn(async () => ({ exported: false, path: null, totalCount: 0 })),
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

  it('Unix 秒时间戳按毫秒转换后显示真实日期', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const time = wrapper.findAll('[data-test="time"]')[0]!;
    expect(time.text()).not.toContain('1970');
    expect(time.text()).toContain('2023');
  });

  it('搜索：输入子串即时过滤，清空恢复', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="row"]').length).toBe(2);
    const input = wrapper.get('[data-test="list-search-input"]');
    await input.setValue('vol');
    expect(wrapper.findAll('[data-test="row"]').length).toBe(1);
    expect(wrapper.find('[data-test="row"]').text()).toContain('Vol.01');
    await input.setValue('');
    expect(wrapper.findAll('[data-test="row"]').length).toBe(2);
  });

  it('搜索无结果显示「没有匹配项」而非空状态', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    await wrapper.get('[data-test="list-search-input"]').setValue('zzz不存在');
    expect(wrapper.find('[data-test="search-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(false);
  });

  it('点击 Vol.01 row → setRoot + navigate + router.push home', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const fb = useFileBrowserStore();
    const openSpy = vi.spyOn(fb, 'openDescriptorAt').mockResolvedValue();
    const pushSpy = vi.spyOn(router, 'push');

    await wrapper.findAll('button.name')[0]!.trigger('click');
    await flushPromises();
    expect(openSpy).toHaveBeenCalledWith({ type: 'local', rootPath: 'C:/comics' }, 'Vol.01');
    expect(pushSpy).toHaveBeenCalledWith({ name: 'home' });
  });

  it('点击 root 行（relPath=""）→ setRoot 不 navigate', async () => {
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const fb = useFileBrowserStore();
    const openSpy = vi.spyOn(fb, 'openDescriptorAt').mockResolvedValue();

    // root 是 lastVisitedAt 较小的，排序后是 rows[1]
    await wrapper.findAll('button.name')[1]!.trigger('click');
    await flushPromises();
    expect(openSpy).toHaveBeenCalledWith({ type: 'local', rootPath: 'C:/comics' }, '');
  });

  it('module3.2.0: webdav 记录可打开（不再因类型防御 return）', async () => {
    const remote = {
      sourceDescriptor: { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' },
      relPath: 'comics/v1',
      displayName: 'v1',
      lastVisitedAt: 1700000001,
      bookId: null,
    };
    const { listHistory } = await import('@/lib/tauri');
    (listHistory as any).mockResolvedValueOnce([remote]);
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();
    const fb = useFileBrowserStore();
    const openSpy = vi.spyOn(fb, 'openDescriptorAt').mockResolvedValue();
    const pushSpy = vi.spyOn(router, 'push');

    await wrapper.findAll('button.name')[0]!.trigger('click');
    await flushPromises();
    expect(openSpy).toHaveBeenCalledWith(remote.sourceDescriptor, 'comics/v1');
    expect(pushSpy).toHaveBeenCalledWith({ name: 'home' });
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

  it('渲染导出按钮，点击调 exportBrowseHistory 且成功后显示条数', async () => {
    const { exportBrowseHistory } = await import('@/lib/tauri');
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: true, path: 'X:/o.json', totalCount: 3 });
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-export"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('导出');

    await btn.trigger('click');
    await flushPromises();
    expect(exportBrowseHistory).toHaveBeenCalledWith(
      expect.stringMatching(/^browse_history_\d{8}_\d{6}\.json$/)
    );
    expect(wrapper.find('[data-test="btn-export"]').text()).toContain('3');
  });

  it('导出中按钮 disabled，完成后恢复', async () => {
    const { exportBrowseHistory } = await import('@/lib/tauri');
    let resolveFn: (v: { exported: boolean; path: string | null; totalCount: number }) => void = () => {};
    vi.mocked(exportBrowseHistory).mockImplementation(
      () => new Promise((res) => { resolveFn = res; })
    );
    const wrapper = mount(History, { global: { plugins: [i18n, router] } });
    await flushPromises();

    await wrapper.find('[data-test="btn-export"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="btn-export"]').attributes('disabled')).toBeDefined();

    resolveFn({ exported: false, path: null, totalCount: 0 });
    await flushPromises();
    expect(wrapper.find('[data-test="btn-export"]').attributes('disabled')).toBeUndefined();
  });
});