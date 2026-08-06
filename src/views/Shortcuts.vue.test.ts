/**
 * Shortcuts 视图测试 — 模块 #1
 * 覆盖：空状态、列表、点击「打开」、点击「删除」confirm + 取消
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import zhCN from '@/locales/zh-CN';
import Shortcuts from './Shortcuts.vue';
import { useShortcutsStore } from '@/stores/shortcuts';
import { listShortcuts, deleteShortcut } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  listShortcuts: vi.fn(async () => []),
  deleteShortcut: vi.fn(async () => undefined),
}));

const mockedList = vi.mocked(listShortcuts);
const mockedDelete = vi.mocked(deleteShortcut);
const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/shortcuts', name: 'shortcuts', component: Shortcuts },
    ],
  });
}

async function mountShortcuts() {
  setActivePinia(createPinia());
  const router = makeRouter();
  router.push('/shortcuts');
  await router.isReady();
  return mount(Shortcuts, { global: { plugins: [i18n, router] } });
}

describe('Shortcuts.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空状态：items=[] 时显示 empty hint + 「去文件浏览器」链接', async () => {
    mockedList.mockResolvedValue([]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    expect(wrapper.find('[data-test="empty-hint"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="link-to-filebrowser"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="list"]').exists()).toBe(false);
  });

  it('列表：每行显示 display name + 打开/删除按钮', async () => {
    mockedList.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: '漫画 A', createdAt: 100 },
      { id: 2, rootPath: 'D:/b/sub', label: null, createdAt: 200 },
    ]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(2);

    expect(rows[0].text()).toContain('漫画 A');
    expect(rows[0].text()).toContain('C:/a');
    expect(rows[0].find('[data-test="btn-open"]').exists()).toBe(true);
    expect(rows[0].find('[data-test="btn-delete"]').exists()).toBe(true);

    // basename fallback for label=null: 'sub' (last path segment)
    expect(rows[1].text()).toContain('sub');
    expect(rows[1].text()).toContain('D:/b/sub');
  });

  it('点击「打开」 → router.push("/") + shortcuts.setActive(id) + fb.setRoot(shortcut.rootPath)', async () => {
    mockedList.mockResolvedValue([
      { id: 7, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    const wrapper = await mountShortcuts();
    const router = wrapper.vm.$.appContext.config.globalProperties.$router;
    const pushSpy = vi.spyOn(router, 'push');
    await flushPromises();

    await wrapper.find('[data-test="row"] [data-test="btn-open"]').trigger('click');
    await flushPromises();

    expect(pushSpy).toHaveBeenCalledWith('/');
    const store = useShortcutsStore();
    expect(store.activeId).toBe(7);
    // #2 修复: 同时调 fb.setRoot(7 的 rootPath)
    const { useFileBrowserStore } = await import('@/stores/fileBrowser');
    const fb = useFileBrowserStore();
    expect(fb.rootPath).toBe('C:/a');
  });

  it('点击「删除」+ dialog 确认 → store.remove(id) (经 IPC)', async () => {
    mockedList.mockResolvedValue([
      { id: 7, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    mockedDelete.mockResolvedValue(undefined);
    const wrapper = await mountShortcuts();
    await flushPromises();

    // 打开删除确认 dialog
    await wrapper.find('[data-test="row"] [data-test="btn-delete"]').trigger('click');
    await flushPromises();
    // 默认 dialog 不可见
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(true);
    // 确认按钮
    await wrapper.find('[data-test="confirm-confirm"]').trigger('click');
    await flushPromises();

    expect(mockedDelete).toHaveBeenCalledWith(7);
  });

  it('点击「删除」+ dialog 取消 → 不删除', async () => {
    mockedList.mockResolvedValue([
      { id: 7, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    await wrapper.find('[data-test="row"] [data-test="btn-delete"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="confirm-cancel"]').trigger('click');
    await flushPromises();

    expect(mockedDelete).not.toHaveBeenCalled();
    // dialog 关闭
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(false);
  });

  it('mount 时自动 refresh() 拉列表', async () => {
    mockedList.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    await mountShortcuts();
    await flushPromises();

    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});
