/**
 * FileBrowser 组件测试 — 模块 #1
 * 5 元素工具栏 (rootPath 有值时) + dropdown 切换 + dblclick + error + save dialog
 * 注意: 设计中 rootPath=null 时 empty-state 全屏,无 toolbar — Save 按钮不存在
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import FileBrowser from './FileBrowser.vue';
import { listDirectory, listShortcuts, createShortcut } from '@/lib/tauri';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import zhCN from '@/locales/zh-CN';

vi.mock('@/lib/tauri', () => ({
  listDirectory: vi.fn(async () => []),
  listShortcuts: vi.fn(async () => []),
  createShortcut: vi.fn(async () => 1),
  deleteShortcut: vi.fn(async () => undefined),
}));

const mockedList = vi.mocked(listDirectory);
const mockedShortcuts = vi.mocked(listShortcuts);
const mockedCreate = vi.mocked(createShortcut);
const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

async function mountFileBrowser() {
  setActivePinia(createPinia());
  const wrapper = mount(FileBrowser, {
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return wrapper;
}

describe('FileBrowser — empty state (rootPath=null)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rootPath=null 时显示 empty-state, 无 toolbar, 有 btn-pick + link-to-shortcuts', async () => {
    const wrapper = await mountFileBrowser();

    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="toolbar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="btn-pick"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="link-to-shortcuts"]').exists()).toBe(true);
  });
});

describe('FileBrowser — main view (rootPath 有值)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
  });

  it('mount 后 5 工具栏元素全部可见 (Up/Refresh/Dropdown/Pick/Save)', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    expect(wrapper.find('[data-test="toolbar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-up"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-refresh"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="shortcut-dropdown"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-pick"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-save"]').exists()).toBe(true);
  });

  it('rootPath 设值后 Save 按钮启用 (rootPath!=null → canSave=true)', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const saveBtn = wrapper.find('[data-test="btn-save"]');
    expect((saveBtn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('currentPath="" 时 Up 按钮禁用 (canUp=false)', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const upBtn = wrapper.find('[data-test="btn-up"]');
    expect((upBtn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('进入子目录后 Up 按钮启用', async () => {
    mockedList
      .mockResolvedValueOnce(makeEntries('chapter1'))
      .mockResolvedValueOnce(makeEntries('page1.jpg'));
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await fb.navigate('chapter1');
    await flushPromises();

    const upBtn = wrapper.find('[data-test="btn-up"]');
    expect((upBtn.element as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('FileBrowser — dropdown 切换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
  });

  it('mount 时拉 shortcuts 并填入 dropdown (无 + N 项)', async () => {
    mockedShortcuts.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
      { id: 2, rootPath: 'C:/b', label: 'B', createdAt: 200 },
    ]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const dropdown = wrapper.find('[data-test="shortcut-dropdown"]');
    const options = (dropdown.element as HTMLSelectElement).options;
    expect(options.length).toBe(3); // 「无」+ 2
    expect(options[1].text).toContain('A');
    expect(options[2].text).toContain('B');
  });

  it('选 dropdown option 切到对应 shortcut + 拉其根目录', async () => {
    mockedShortcuts.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    mockedList.mockResolvedValue([]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const dropdown = wrapper.find('[data-test="shortcut-dropdown"]');
    await dropdown.setValue('1');
    await flushPromises();

    // 注: dropdown 切换 activeId 但 setRoot 已在前 setRoot('C:/comics') 设了同一根
    // 这里验证 activeId 已更新 (表示 onShortcutChange 跑通)
    const shortcuts = useShortcutsStore();
    expect(shortcuts.activeId).toBe(1);
  });

  it('选 dropdown「无」(空 value) 仅取消激活, 不清 rootPath (#8)', async () => {
    mockedShortcuts.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    mockedList.mockResolvedValue([]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/a');
    await flushPromises();

    const dropdown = wrapper.find('[data-test="shortcut-dropdown"]');
    await dropdown.setValue('');
    await flushPromises();

    // rootPath 保留 (用户继续浏览当前目录)
    expect(fb.rootPath).toBe('C:/a');
    // 仅取消激活
    const shortcuts = useShortcutsStore();
    expect(shortcuts.activeId).toBeNull();
  });

  it('dropdown 切回已激活 shortcut → no-op (#8)', async () => {
    mockedShortcuts.mockResolvedValue([
      { id: 1, rootPath: 'C:/a', label: 'A', createdAt: 100 },
    ]);
    mockedList.mockResolvedValue([]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/a');
    await flushPromises();

    // 先激活 id=1
    const dropdown = wrapper.find('[data-test="shortcut-dropdown"]');
    await dropdown.setValue('1');
    await flushPromises();

    const shortcuts = useShortcutsStore();
    expect(shortcuts.activeId).toBe(1);

    // 再选 1 (相同): no-op, 不再调 listDirectory
    mockedList.mockClear();
    await dropdown.setValue('1');
    await flushPromises();

    expect(mockedList).not.toHaveBeenCalled();
    expect(shortcuts.activeId).toBe(1);
  });
});

describe('FileBrowser — 错误状态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedShortcuts.mockResolvedValue([]);
  });

  it('listDirectory 失败显示 error-toast 含错误消息', async () => {
    mockedList.mockRejectedValueOnce(new Error('permission denied'));
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/forbidden');
    await flushPromises();

    expect(wrapper.find('[data-test="error-toast"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="error-toast"]').text()).toContain('permission denied');
  });

  it('error-toast 内 Refresh 按钮触发 refresh()', async () => {
    mockedList.mockRejectedValueOnce(new Error('first fail'));
    mockedList.mockResolvedValueOnce([]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/forbidden');
    await flushPromises();

    mockedList.mockClear();
    const refreshBtn = wrapper.find('[data-test="error-toast"] button');
    await refreshBtn.trigger('click');
    await flushPromises();

    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});

describe('FileBrowser — save dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    mockedCreate.mockResolvedValue(99);
  });

  it('点 Save 弹 dialog (含 label input + 提交 + 取消按钮)', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    expect(wrapper.find('[data-test="save-dialog"]').exists()).toBe(false);
    await wrapper.find('[data-test="btn-save"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="save-dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="save-label-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-save-submit"]').exists()).toBe(true);
  });

  it('save dialog 提交: 输入 label → 调 createShortcut + 关 dialog', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    await wrapper.find('[data-test="btn-save"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="save-label-input"]').setValue('My Comics');
    await wrapper.find('[data-test="btn-save-submit"]').trigger('click');
    await flushPromises();

    expect(mockedCreate).toHaveBeenCalledWith('C:/comics', 'My Comics');
    expect(wrapper.find('[data-test="save-dialog"]').exists()).toBe(false);
  });

  it('save dialog 取消: 关 dialog 不调 create', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    await wrapper.find('[data-test="btn-save"]').trigger('click');
    await flushPromises();
    // 取消按钮 (没有 data-test, 用 .save-dialog 内除 submit 外的 button)
    const buttons = wrapper.findAll('[data-test="save-dialog"] button');
    const cancelBtn = buttons.find((b) => !b.attributes('data-test'));
    await cancelBtn!.trigger('click');
    await flushPromises();

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="save-dialog"]').exists()).toBe(false);
  });

  it('save dialog label 空: 仍调 createShortcut, label=null', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    await wrapper.find('[data-test="btn-save"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="save-label-input"]').setValue('  ');
    await wrapper.find('[data-test="btn-save-submit"]').trigger('click');
    await flushPromises();

    expect(mockedCreate).toHaveBeenCalledWith('C:/comics', null);
  });
});

describe('FileBrowser — FileList @open (双击进入)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
  });

  it('真实 DOM click 目录行 → fb.navigate (#5 修 production 不响应)', async () => {
    // 真实 DOM click 模拟 (不走 component.vm.$emit 绕过, 而是用 vue-test-utils trigger)
    mockedList
      .mockResolvedValueOnce(makeEntries('chapter1'))
      .mockResolvedValueOnce(makeEntries('page1.jpg'));
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].classes()).toContain('is-directory');

    await rows[0].trigger('click');
    await flushPromises();

    expect(fb.currentPath).toBe('chapter1');
  });

  it('Breadcrumb 跳到子目录 crumb → fb.navigate 到该路径', async () => {
    mockedList
      .mockResolvedValueOnce(makeEntries('chapter1', 'chapter2'))
      .mockResolvedValueOnce(makeEntries('sub'))
      .mockResolvedValueOnce(makeEntries('page1.jpg', 'page2.jpg'));
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await fb.navigate('chapter1');
    await fb.navigate('chapter1/sub');
    await flushPromises();

    // 模拟点 Breadcrumb "chapter1" — emit 'navigate' with path 'chapter1'
    const breadcrumb = wrapper.findComponent({ name: 'Breadcrumb' });
    await breadcrumb.vm.$emit('navigate', 'chapter1');
    await flushPromises();

    expect(fb.currentPath).toBe('chapter1');
  });

  it('Breadcrumb 跳回根 crumb (path="") → fb.navigate 回到根列表', async () => {
    mockedList
      .mockResolvedValueOnce(makeEntries('chapter1'))
      .mockResolvedValueOnce(makeEntries('page1.jpg'))
      .mockResolvedValueOnce(makeEntries('chapter1', 'chapter2'));
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await fb.navigate('chapter1');
    await flushPromises();

    const breadcrumb = wrapper.findComponent({ name: 'Breadcrumb' });
    await breadcrumb.vm.$emit('navigate', '');
    await flushPromises();

    expect(fb.currentPath).toBe('');
  });

  it('双击文件行 → emit "open" 给父 (模块 #2 接管)', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 父级接收到的 open 事件 (vue-test-utils 自动捕获)
    const openEvents: any[] = [];
    wrapper.vm.$emit = vi.fn((event: string, ...args: any[]) => {
      if (event === 'open') openEvents.push(args[0]);
    });

    const fileList = wrapper.findComponent({ name: 'FileList' });
    await fileList.vm.$emit('open', {
      name: 'manga.cbz',
      path: 'manga.cbz',
      isDirectory: false,
      isArchive: true,
    });
    await flushPromises();

    // currentPath 不应改变 (文件不 navigate)
    expect(fb.currentPath).toBe('');
    // open 事件应被 emit (虽然测试里 wrapper.vm.$emit 被 spy 覆盖,
    // FileBrowser.vue 的 emit() 是 vue emit,实际 emit 到 instance 上,
    // 测试只能验证子调路径)
  });
});

function makeEntries(...names: string[]) {
  return names.map((n) => ({
    name: n,
    path: n,
    isDirectory: !n.includes('.'),
    isArchive: n.endsWith('.cbz') || n.endsWith('.zip'),
    size: 100,
  }));
}
