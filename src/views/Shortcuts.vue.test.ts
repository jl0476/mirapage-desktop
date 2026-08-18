/**
 * Shortcuts 视图测试 (v0.1.0-module3.0.5: 跨源 + 子目录)
 * 覆盖：空状态、列表、点击「打开」(含子目录两步打开)、点击「删除」confirm + 取消
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

function localJson(rootPath: string): string {
  return JSON.stringify({ type: 'local', rootPath });
}
/** 构造一条 ShortcutItem mock */
function mkItem(id: number, rootPath: string, alias: string | null, relPath = '') {
  return {
    id,
    sourceDescriptorJson: localJson(rootPath),
    relPath,
    alias,
    iconHint: 'local',
    createdAt: id * 100,
  };
}

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

  it('列表：每行显示 display name + full path + 打开/删除按钮', async () => {
    mockedList.mockResolvedValue([
      mkItem(1, 'C:/a', '漫画 A'),
      mkItem(2, 'D:/b/sub', null),
    ]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(2);

    expect(rows[0].text()).toContain('漫画 A');
    expect(rows[0].text()).toContain('C:/a');
    expect(rows[0].find('[data-test="btn-open"]').exists()).toBe(true);
    expect(rows[0].find('[data-test="btn-delete"]').exists()).toBe(true);

    // basename fallback for alias=null: 'sub' (full path D:/b/sub 的最后段)
    expect(rows[1].text()).toContain('sub');
    expect(rows[1].text()).toContain('D:/b/sub');
  });

  it('列表：子目录 shortcut 显示 rootPath/relPath 拼接的完整路径', async () => {
    mockedList.mockResolvedValue([
      mkItem(3, 'D:/manga', '咒术 Vol.05', 'jujutsu/vol05'),
    ]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    const row = wrapper.find('[data-test="row"]');
    expect(row.text()).toContain('咒术 Vol.05');
    // full path = rootPath + '/' + relPath
    expect(row.text()).toContain('D:/manga/jujutsu/vol05');
  });

  it('搜索：按别名/路径子串过滤，无结果显示「没有匹配项」', async () => {
    mockedList.mockResolvedValue([
      mkItem(1, 'C:/a', '漫画 A'),
      mkItem(2, 'D:/b/sub', null),
    ]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    const input = wrapper.get('[data-test="list-search-input"]');
    await input.setValue('漫画');              // 别名命中
    expect(wrapper.findAll('[data-test="row"]').length).toBe(1);
    await input.setValue('D:/b');              // 路径命中
    expect(wrapper.findAll('[data-test="row"]').length).toBe(1);
    await input.setValue('zzz不存在');
    expect(wrapper.find('[data-test="search-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(false);
  });

  it('点击「打开」 → router.push("/") + shortcuts.setActive(id) (执行收敛到 FileBrowser)', async () => {
    // 路径身份修复 (2026-08-12, spec §6.4): Shortcuts.vue 只 setActive + push('/');
    // setRoot + navigate 由 FileBrowser.vue openShortcut 统一执行, 本视图不再碰 fb。
    mockedList.mockResolvedValue([mkItem(7, 'C:/a', 'A')]);
    const wrapper = await mountShortcuts();
    const router = wrapper.vm.$.appContext.config.globalProperties.$router;
    const pushSpy = vi.spyOn(router, 'push');
    await flushPromises();

    await wrapper.find('[data-test="row"] [data-test="btn-open"]').trigger('click');
    await flushPromises();

    expect(pushSpy).toHaveBeenCalledWith('/');
    const store = useShortcutsStore();
    expect(store.activeId).toBe(7);
    // 收敛后: Shortcuts.vue 不再调 fb.setRoot (执行点在 FileBrowser)
    const { useFileBrowserStore } = await import('@/stores/fileBrowser');
    const fb = useFileBrowserStore();
    expect(fb.rootPath).toBeNull();
  });

  it('点击「打开」子目录 shortcut → setActive + push (relPath 由 FileBrowser 校验+执行)', async () => {
    mockedList.mockResolvedValue([mkItem(9, 'D:/manga', '咒术', 'jujutsu/vol05')]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    await wrapper.find('[data-test="row"] [data-test="btn-open"]').trigger('click');
    await flushPromises();

    const store = useShortcutsStore();
    expect(store.activeId).toBe(9);
    // 收敛后: Shortcuts.vue 不再调 fb.setRoot/navigate
    const { useFileBrowserStore } = await import('@/stores/fileBrowser');
    const fb = useFileBrowserStore();
    expect(fb.rootPath).toBeNull();
    expect(fb.currentPath).toBe('');
  });

  it('点击「删除」+ dialog 确认 → store.remove(id) (经 IPC)', async () => {
    mockedList.mockResolvedValue([mkItem(7, 'C:/a', 'A')]);
    mockedDelete.mockResolvedValue(undefined);
    const wrapper = await mountShortcuts();
    await flushPromises();

    // 打开删除确认 dialog
    await wrapper.find('[data-test="row"] [data-test="btn-delete"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(true);
    // 确认按钮
    await wrapper.find('[data-test="confirm-confirm"]').trigger('click');
    await flushPromises();

    expect(mockedDelete).toHaveBeenCalledWith(7);
  });

  it('点击「删除」+ dialog 取消 → 不删除', async () => {
    mockedList.mockResolvedValue([mkItem(7, 'C:/a', 'A')]);
    const wrapper = await mountShortcuts();
    await flushPromises();

    await wrapper.find('[data-test="row"] [data-test="btn-delete"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="confirm-cancel"]').trigger('click');
    await flushPromises();

    expect(mockedDelete).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(false);
  });

  it('mount 时自动 refresh() 拉列表', async () => {
    mockedList.mockResolvedValue([mkItem(1, 'C:/a', 'A')]);
    await mountShortcuts();
    await flushPromises();

    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});
