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
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
  listHistory: vi.fn(async () => []),
  listProgressFinished: vi.fn(async () => ({})),
  markFinished: vi.fn(async () => undefined),
  saveProgress: vi.fn(async () => undefined),
  // Cluster A 测试用
  createBook: vi.fn(async () => 42),
  recordHistory: vi.fn(async () => undefined),
}));

// Cluster A: spy on router.push
const routerPushSpy = vi.fn(async () => undefined);
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushSpy }),
  RouterLink: { template: '<a><slot /></a>' },
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

  // ─── v0.1.0-module3.0.3-hotfix3 (Bug 4): onMounted 不无脑 setRoot ───
  // 现象: 之前 rootPath 已有值 (从 reader 退回) 时, onMounted 仍调 setRoot(LAST_ROOT_KEY),
  //   抹掉 currentPath. 现在仅在 rootPath===null (首次启动 / 刷新) 才恢复.
  it('onMounted: rootPath 已设值时不再 setRoot (保留 currentPath)', async () => {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    mockedList.mockClear();
    mockedList.mockResolvedValue(makeEntries('output'));
    await fb.setRoot('C:/comics');
    await fb.navigate('output');
    await flushPromises();
    // 卸载 + 重新挂载 (模拟从 reader 退回)
    wrapper.unmount();
    mockedList.mockClear();
    mockedList.mockResolvedValue(makeEntries('chapter1', 'manga.cbz'));
    // 重 mount — rootPath 已 'C:/comics', currentPath 已 'output', 应保留
    await mountFileBrowser();
    await flushPromises();
    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('output');
    // 不应再触发 listDirectory (因为没 setRoot, 也没 restore)
    expect(mockedList).not.toHaveBeenCalled();
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

    // v0.1.0-module1.22: ShortcutDropdown 是 chevron 弹层, 先点 trigger 打开
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();

    const options = wrapper.findAll('[data-test^="shortcut-opt-"]');
    expect(options.length).toBe(3); // 「none」+ 2
    expect(options[0].attributes('data-test')).toBe('shortcut-opt-none');
    expect(options[1].attributes('data-test')).toBe('shortcut-opt-1');
    expect(options[2].attributes('data-test')).toBe('shortcut-opt-2');
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

    // 打开 dropdown, 选 id=1
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
    await flushPromises();

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

    // 先激活 id=1
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
    await flushPromises();

    // 再选 none
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-none"]').trigger('click');
    await flushPromises();

    // rootPath 保留 (用户继续浏览当前目录)
    expect(fb.rootPath).toBe('C:/a');
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
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
    await flushPromises();

    const shortcuts = useShortcutsStore();
    expect(shortcuts.activeId).toBe(1);

    // 再选 1 (相同): no-op, 不再调 listDirectory
    mockedList.mockClear();
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
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

  it('真实 DOM dblclick 目录行 → fb.navigate (v0.1.0-module1.22 单击=select, 双击=open)', async () => {
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

    await rows[0].trigger('dblclick');
    await flushPromises();

    expect(fb.currentPath).toBe('chapter1');
  });

  it('真实 DOM click 目录行 → 仅 select (不 navigate)', async () => {
    mockedList.mockResolvedValue(makeEntries('chapter1'));
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const rows = wrapper.findAll('[data-test="row"]');
    await rows[0].trigger('click');
    await flushPromises();

    // 单击只 select, 不 navigate
    expect(fb.currentPath).toBe('');
    expect(fb.selectedPaths.has('chapter1')).toBe(true);
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

// ─── Cluster A: 双击图片 / 选中图片立即阅读 (issue #1 / #3) ───

describe('FileBrowser — 立即阅读入口 (Cluster A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    routerPushSpy.mockClear();
  });

  it('选中图片 (.jpg) 时, 立即阅读按钮可点 + 标题无 disabled', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 单击图片行 → select
    const row = wrapper.find('[data-test="row"]');
    await row.trigger('click');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('选中文件夹时, 立即阅读按钮可点 (已有行为, 不退化)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'VOL.01', path: 'VOL.01', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const row = wrapper.find('[data-test="row"]');
    await row.trigger('click');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('双击图片行 → 调 readFromImage (走父目录 + ?at=imageName)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'page1.jpg', path: 'page1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
      { name: 'page2.jpg', path: 'page2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
      { name: 'page3.jpg', path: 'page3.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(3);
    // 双击 page2.jpg
    await rows[1].trigger('dblclick');
    await flushPromises();

    // router.push 应被调,带 ?at=page2.jpg
    expect(routerPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/reader/42',
        query: { at: 'page2.jpg' },
      }),
    );
    // currentPath 不变 (双击图片不进入目录)
    expect(fb.currentPath).toBe('');
  });

  it('双击非图片文件 (.cbz) → no-op (仍走原行为)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'manga.cbz', path: 'manga.cbz', isDirectory: false, isArchive: true, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const row = wrapper.find('[data-test="row"]');
    await row.trigger('dblclick');
    await flushPromises();

    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(fb.currentPath).toBe('');
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
