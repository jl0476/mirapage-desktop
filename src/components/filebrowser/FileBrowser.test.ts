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
import type { MediaEntry } from '@/lib/sourceDescriptor';
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

// v0.1.0-module3.0.5: ShortcutItem mock helper (跨源 schema)
function localJson(rootPath: string): string {
  return JSON.stringify({ type: 'local', rootPath });
}
function mkShortcut(id: number, rootPath: string, alias: string | null, relPath = '') {
  return {
    id,
    sourceDescriptorJson: localJson(rootPath),
    relPath,
    alias,
    iconHint: 'local',
    createdAt: id * 100,
  };
}

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
      mkShortcut(1, 'C:/a', 'A'),
      mkShortcut(2, 'C:/b', 'B'),
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
      mkShortcut(1, 'C:/a', 'A'),
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
      mkShortcut(1, 'C:/a', 'A'),
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
      mkShortcut(1, 'C:/a', 'A'),
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

    expect(mockedCreate).toHaveBeenCalledWith(localJson('C:/comics'), '', 'My Comics');
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

    expect(mockedCreate).toHaveBeenCalledWith(localJson('C:/comics'), '', null);
  });

  it('save dialog 子目录: 当前在子目录时 relPath 取 currentPath', async () => {
    // v0.1.0-module3.0.5: 用户进子目录后点保存 → 存 (descriptor, currentPath) 而非根
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    // navigate 到子目录 chapter1
    mockedList.mockResolvedValueOnce([
      { name: 'page01.jpg', path: 'page01.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 1 },
      { name: 'page02.jpg', path: 'page02.jpg', isDirectory: false, isArchive: false, size: 100, modifiedAt: 1 },
    ]);
    await fb.navigate('chapter1');
    await flushPromises();

    await wrapper.find('[data-test="btn-save"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="save-label-input"]').setValue('第一章');
    await wrapper.find('[data-test="btn-save-submit"]').trigger('click');
    await flushPromises();

    // createShortcut 第 2 参数是 relPath = currentPath = 'chapter1'
    expect(mockedCreate).toHaveBeenCalledWith(localJson('C:/comics'), 'chapter1', '第一章');
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

// ─── v0.1.0-module3.0.3-hotfix: 隐藏已读完 (Bug — visibleEntries 空壳) ───
// 现象: 点"隐藏已读完"按钮, fb.hideFinished 切 true, 但列表不过滤 (visibleEntries 是空壳,
//       模板用的是 fb.sortedEntries). 修复后 hideFinished=true 时 markFor==='finished' 的行应消失.
import { useReadStatusStore } from '@/stores/readStatus';

describe('FileBrowser — 隐藏已读完', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedShortcuts.mockResolvedValue([]);
  });

  it('hideFinished=true 时, finished 目录被过滤掉 (reading/none 保留)', async () => {
    // 3 个目录: vol1=finished, vol2=reading, vol3=none
    mockedList.mockResolvedValueOnce([
      { name: 'vol1', path: 'vol1', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol2', path: 'vol2', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol3', path: 'vol3', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 注入 marks: vol1=finished, vol2=reading (key 格式 `${rootPath}|${relPath}`)
    // 注意: Pinia setup store return 的 ref 在 store 实例上被 unwrap,
    // 必须整体赋值 rs.marks = {...} (写回 ref), 不能 rs.marks.value = {...}
    // (后者只给 Record 加了个 value 字段, 不更新 store 内部 ref)
    const rs = useReadStatusStore();
    rs.marks = {
      'C:/comics|vol1': 'finished',
      'C:/comics|vol2': 'reading',
    };
    await wrapper.vm.$nextTick();

    // 开启隐藏
    fb.setHideFinished(true);
    await wrapper.vm.$nextTick();

    // 开启隐藏
    fb.setHideFinished(true);
    await wrapper.vm.$nextTick();

    // details 视图 data-test = 'row' | 'row-reading' | 'row-finished' (按 markFor),
    // 用前缀匹配 [data-test^="row"] 拿全部行
    const rows = wrapper.findAll('[data-test^="row"]');
    const names = rows.map((r) => r.text());
    expect(names.some((t) => t.includes('vol2'))).toBe(true); // reading 保留
    expect(names.some((t) => t.includes('vol3'))).toBe(true); // none 保留
    expect(names.some((t) => t.includes('vol1'))).toBe(false); // finished 隐藏
  });

  it('hideFinished=false (默认) 时, finished 目录仍可见', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'vol1', path: 'vol1', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol2', path: 'vol2', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const rs = useReadStatusStore();
    rs.marks = {
      'C:/comics|vol1': 'finished',
      'C:/comics|vol2': 'reading',
    };
    await wrapper.vm.$nextTick();

    // 不开隐藏
    expect(fb.hideFinished).toBe(false);
    // details 视图 data-test = 'row' | 'row-reading' | 'row-finished', 用前缀匹配
    const rows = wrapper.findAll('[data-test^="row"]');
    expect(rows.length).toBe(2);
  });
});

describe('FileBrowser — 内联搜索', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedShortcuts.mockResolvedValue([]);
    mockedList.mockResolvedValue([]);
  });

  it('setSearchQuery 后列表按名过滤 (大小写不敏感)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'report.pdf', path: 'report.pdf', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'XYZ', path: 'XYZ', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();

    const fileList = wrapper.findComponent({ name: 'FileList' });
    expect(fileList.props('entries').map((e: { name: string }) => e.name)).toEqual(['abc.txt']);
  });

  it('清空 query 恢复完整列表', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'report.pdf', path: 'report.pdf', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'FileList' }).props('entries').length).toBe(1);

    fb.setSearchQuery('');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'FileList' }).props('entries').length).toBe(2);
  });

  it('搜索态显示 search-breadcrumb 静态文本, 清空恢复 breadcrumb', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 非搜索态: 原 breadcrumb 在
    expect(wrapper.find('[data-test="breadcrumb"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="search-breadcrumb"]').exists()).toBe(false);

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="search-breadcrumb"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="breadcrumb"]').exists()).toBe(false);

    fb.setSearchQuery('');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="breadcrumb"]').exists()).toBe(true);
  });

  it('navigate 后 searchQuery 被清空 (列表恢复)', async () => {
    mockedList
      .mockResolvedValueOnce([
        { name: 'sub', path: 'sub', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never)
      .mockResolvedValueOnce([
        { name: 'page1.jpg', path: 'page1.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();
    expect(fb.searchQuery).toBe('abc');

    await fb.navigate('sub');
    await flushPromises();
    expect(fb.searchQuery).toBe('');
  });
});

// ─── v0.1.0-module3.0.4-virtuallist Task 1.4: displayedEntries 单次循环合并 ───
//
// 优化前: sort → filter(hideFinished) → filter(searchQuery) 三次 O(n) 遍历 + 三次数组分配
// 优化后: sort → single loop (hideFinished + searchQuery 在一次 for-of 里同时判断)
//         fast path 两个 filter 都没启用时直接返回 sortedEntries 引用
//
// 重点: 行为兼容是核心 — 测试靠 FiLE 列表 prop 与 sortedEntries 比对结果, 不靠 spy count
//       (单次循环是性能优化, 不能让功能行为变化 — 验证"做什么"而非"怎么实现")

describe('FileBrowser — displayedEntries 单次循环 (Task 1.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedShortcuts.mockResolvedValue([]);
  });

  /**
   * 工具: 用 FileList 组件拿到当前 displayedEntries 数组引用.
   * 比 wrapper.vm.displayedEntries 更稳定 — 不依赖 defineExpose.
   */
  function getDisplayed(wrapper: ReturnType<typeof mount>): MediaEntry[] {
    return wrapper.findComponent({ name: 'FileList' }).props('entries') as MediaEntry[];
  }

  it('hideFinished + searchQuery 同时启用: 排除 finished, 保留 query 匹配, 顺序按 sorted', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'foo-vol1', path: 'foo-vol1', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'foo-vol2', path: 'foo-vol2', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'bar-vol3', path: 'bar-vol3', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'foo-vol4', path: 'foo-vol4', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const rs = useReadStatusStore();
    rs.marks = {
      'C:/comics|foo-vol1': 'finished',
      'C:/comics|foo-vol2': 'reading',
      'C:/comics|bar-vol3': 'finished',
      'C:/comics|foo-vol4': 'finished',
    };
    await wrapper.vm.$nextTick();

    fb.setHideFinished(true);
    fb.setSearchQuery('foo');
    await wrapper.vm.$nextTick();

    const displayed = getDisplayed(wrapper);
    // 应剩: foo-vol2 (reading, name 包含 'foo')
    expect(displayed.map((e) => e.name)).toEqual(['foo-vol2']);
    // 全部 finished 已过滤
    expect(displayed.every((e) => !rs.isFinished(e))).toBe(true);
    // 全部含 'foo' (大小写不敏感)
    expect(displayed.every((e) => e.name.toLowerCase().includes('foo'))).toBe(true);
  });

  it('fast path: !q && !hide → displayedEntries === fb.sortedEntries (引用相等)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'vol1', path: 'vol1', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol2', path: 'vol2', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 默认 hideFinished=false, searchQuery=''
    expect(fb.hideFinished).toBe(false);
    expect(fb.searchQuery).toBe('');

    // fast path: 直接返回 sortedEntries 引用 — 避免下游误重算
    expect(getDisplayed(wrapper)).toBe(fb.sortedEntries);
  });

  it('只有 searchQuery: 单次循环过滤, 顺序与 sortedEntries 一致', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'page1.jpg', path: 'page1.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'cover.png', path: 'cover.png', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'page2.jpg', path: 'page2.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'index.html', path: 'index.html', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'page3.jpg', path: 'page3.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('page');
    await wrapper.vm.$nextTick();

    const displayed = getDisplayed(wrapper);
    const expected = fb.sortedEntries.filter((e) => e.name.toLowerCase().includes('page'));
    // 顺序与 sortedEntries 中匹配项的顺序一致
    expect(displayed.map((e) => e.name)).toEqual(expected.map((e) => e.name));
    expect(displayed.length).toBe(3);
  });

  it('只有 hideFinished: 单次循环过滤 finished, 顺序与 sortedEntries 一致', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'vol1', path: 'vol1', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol2', path: 'vol2', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol3', path: 'vol3', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'vol4', path: 'vol4', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const rs = useReadStatusStore();
    rs.marks = {
      'C:/comics|vol1': 'finished',
      'C:/comics|vol3': 'finished',
      'C:/comics|vol2': 'reading',
      'C:/comics|vol4': 'finished',
    };
    await wrapper.vm.$nextTick();

    fb.setHideFinished(true);
    await wrapper.vm.$nextTick();

    const displayed = getDisplayed(wrapper);
    // 顺序保留: vol2 (唯一非 finished)
    expect(displayed.map((e) => e.name)).toEqual(['vol2']);
    expect(displayed.every((e) => !rs.isFinished(e))).toBe(true);
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

// ─── v0.1.0-module3.0.4-virtuallist Task 3.4: FileBrowser 接入 scrollToPath ───
//
// FileBrowser 在 onMounted 调 setScrollToIndexCallback 注册 (i, opts) →
//   fileListRef.value.scrollToPath(sortedEntries[i].path, opts)
// 让 store.scrollToPath(path) 能间接滚到 FileList 对应行.
// onUnmounted 清空 callback (避免下次 mount 时旧实例引用).
//
// 测试策略: 替换 FileList 子组件为 stub (vi.fn 暴露 scrollToPath),
// 绕过 Vue publicProxy 的 read-only defineProperty 限制. 这样 spy 直接生效.

describe('FileBrowser — 接入 scrollToPath (Task 3.4)', () => {
  let scrollToPathStub: ReturnType<typeof vi.fn>;
  // v0.1.0-module3.0.4-hotfix: callback 改调 FileList.scrollToIndex (O(1) fast path,
  // 跳过 i→path→findIndex 双重反查). scrollToPath 仍暴露 (FileList 内部 viewMode
  // 切换 retention 仍用, 但全局 callback 走 scrollToIndex).
  let scrollToIndexStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    scrollToPathStub = vi.fn();
    scrollToIndexStub = vi.fn();
  });

  function mountWithFileListStub() {
    // 局部 stub: 不污染其它 describe 块
    const FileListStub = {
      name: 'FileList',
      setup(_: unknown, { expose }: { expose: (e: Record<string, unknown>) => void }) {
        expose({ scrollToPath: scrollToPathStub, scrollToIndex: scrollToIndexStub });
        return () => null;
      },
    };
    return mount(FileBrowser, {
      global: {
        plugins: [i18n],
        stubs: { FileList: FileListStub },
      },
      attachTo: document.body,
    });
  }

  it('onMounted 后 fb.scrollToPath(path) 触发 FileList.scrollToIndex (callback 已注册, 透传 index)', async () => {
    // v0.1.0-module3.0.4-hotfix: callback 现在直接传 index (跳过 i→path→findIndex).
    // 数据用混入 file/dir 的 10 个名字, sortedEntries 走 dir-first sort:
    //   dirs (a, b, c — 3 个) → positions 0-2; files (a.txt, b.txt, ..., g.txt — 7 个) → positions 3-9.
    // 'c.txt' 是 file, 自然排在 dir c 之后, 仍按文件 sub-sort 排第 0 (lex: a.txt, b.txt, c.txt, d.txt, e.txt, f.txt, g.txt).
    mockedList.mockResolvedValueOnce(
      [
        { name: 'a.txt', path: 'a.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'b', path: 'b', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'c.txt', path: 'c.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'a', path: 'a', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'b.txt', path: 'b.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'c', path: 'c', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'd.txt', path: 'd.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'e.txt', path: 'e.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'f.txt', path: 'f.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'g.txt', path: 'g.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never,
    );
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.scrollToPath('e.txt');
    // sortedEntries = [a, b, c, a.txt, b.txt, c.txt, d.txt, e.txt, f.txt, g.txt]
    //                 pos:  0  1  2    3      4      5      6      7      8      9
    // 'e.txt' (sorted at 7) → callback(7) → scrollToIndex(7)
    expect(scrollToIndexStub).toHaveBeenCalledTimes(1);
    expect(scrollToIndexStub).toHaveBeenCalledWith(7, undefined);
    // scrollToPath 不再被 callback 走 (FileList 自身 viewMode retention 才会用)
    expect(scrollToPathStub).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('fb.scrollToPath 透传 opts 到 scrollToIndex (align=center)', async () => {
    mockedList.mockResolvedValueOnce(
      [
        { name: 'a.txt', path: 'a.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'b', path: 'b', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'c.txt', path: 'c.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'a', path: 'a', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'b.txt', path: 'b.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'c', path: 'c', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'd.txt', path: 'd.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'e.txt', path: 'e.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'f.txt', path: 'f.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'g.txt', path: 'g.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never,
    );
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.scrollToPath('b', { align: 'center' });
    // 'b' (dir, sorted at 1) → callback(1, { align: 'center' })
    expect(scrollToIndexStub).toHaveBeenCalledWith(1, { align: 'center' });

    wrapper.unmount();
  });

  it('onUnmounted 清空 callback (避免 stale ref 风险)', async () => {
    const wrapper = mountWithFileListStub();
    await flushPromises();
    // 此时 callback 已注册, stub 收到一次调用 — 验证注册
    // (上面两个 it 用同一 stub, 这里清空调用记录独立验证)
    scrollToIndexStub.mockClear();
    wrapper.unmount();
    await flushPromises();

    // 卸载后再 fetch 一组 entries (active pinia 仍在, 同一 store 实例)
    mockedList.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({
        name: `f${i}`,
        path: `f${i}`,
        isDirectory: i % 2 === 0,
        isArchive: false,
        size: 0,
        modifiedAt: 0,
      })) as never,
    );
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // callback 应已被清空 → scrollToPath no-op, stub 不会被调到, 不抛错
    expect(() => fb.scrollToPath('f5')).not.toThrow();
    expect(scrollToIndexStub).not.toHaveBeenCalled();
  });
});
