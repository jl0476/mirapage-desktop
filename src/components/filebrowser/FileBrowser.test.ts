/**
 * FileBrowser 组件测试 — 模块 #1
 * 5 元素工具栏 (rootPath 有值时) + dropdown 切换 + dblclick + error + save dialog
 * 注意: 设计中 rootPath=null 时 empty-state 全屏,无 toolbar — Save 按钮不存在
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import FileBrowser from './FileBrowser.vue';
import { listDirectory, listShortcuts, createShortcut, findNextVolume, createBook, getSetting } from '@/lib/tauri';
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
  // 详情视图「立即阅读」读进度用
  getProgress: vi.fn(async () => null),
  // v0.1.0-module3.0.x-cross-volume (任务 9): 瀑布流跨卷按钮
  findNextVolume: vi.fn(async () => null),
  getDirectoryMasonry: vi.fn(async () => null),
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
const mockedFindNextVolume = vi.mocked(findNextVolume);
const mockedGet = vi.mocked(getSetting);
const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

// 审查修复 (2026-08-13): 跟踪 mountFileBrowser 挂载的 wrapper, 全局 afterEach 统一卸载.
// navigate() 会触发 watch(lastFetchedPath) 调度真实 setTimeout(prefetchNextVolume, 300);
// 用例不卸载时泄漏的 300ms timer 会在后续用例 (Task 6) 执行期 fire, 对 mock findNextVolume
// 额外调用 — 消耗 once-queue + 打破 toHaveBeenCalledTimes, 是全文件偶发失败根因
// (已用 B-T1 诊断断言捕获到来自 line-832 用例的泄漏调用 ['C:/comics','sub','next']).
const _mountedWrappers: ReturnType<typeof mount>[] = [];

// 全局卸载: 覆盖所有经 mountFileBrowser 挂载的组件（含 6 个 navigate 泄漏点 +
// 未来新增用例）。二次 unmount 安全 — VTU app.unmount() 幂等（Vue render(null) 空容器 no-op，
// 实测不抛错）；显式 wrapper.unmount() 的用例也走这里兜底。
afterEach(() => {
  for (const w of _mountedWrappers) {
    w.unmount();
  }
  _mountedWrappers.length = 0;
});

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
  _mountedWrappers.push(wrapper);
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

  it('同根不同 relPath shortcut 切换: setRoot 无条件执行, currentPath 切到 relPath (code-review #1)', async () => {
    // v0.1.0-module3.0.5 code-review: rootPath 相同时不做 setRoot 守卫会漏切子目录.
    // 两个 shortcut 同 descriptor (D:/manga) 但 relPath 不同 ('vol05' vs 'vol06'):
    //   激活 vol05 → 激活 vol06, rootPath 相同但必须切 currentPath.
    mockedShortcuts.mockResolvedValue([
      mkShortcut(1, 'D:/manga', 'Vol.05', 'vol05'),
      mkShortcut(2, 'D:/manga', 'Vol.06', 'vol06'),
    ]);
    mockedList.mockResolvedValue([]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 激活 Vol.05 (relPath='vol05')
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
    await flushPromises();
    expect(fb.rootPath).toBe('D:/manga');
    expect(fb.currentPath).toBe('vol05');

    // 切 Vol.06 (同根 D:/manga, relPath='vol06') — 必须切 currentPath
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-2"]').trigger('click');
    await flushPromises();
    expect(fb.rootPath).toBe('D:/manga');
    expect(fb.currentPath).toBe('vol06');

    // 切回 Vol.05 — currentPath 切回 vol05
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
    await flushPromises();
    expect(fb.currentPath).toBe('vol05');
  });

  it('同根 shortcut 从子目录切回根 (relPath=""): currentPath 清空 (code-review #1)', async () => {
    // 根 shortcut (relPath='') 和子目录 shortcut (relPath='sub') 同根:
    //   激活 sub → 激活根, currentPath 必须清空回 ''.
    mockedShortcuts.mockResolvedValue([
      mkShortcut(1, 'D:/manga', '根', ''),
      mkShortcut(2, 'D:/manga', '子目录', 'sub'),
    ]);
    mockedList.mockResolvedValue([]);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 激活子目录
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-2"]').trigger('click');
    await flushPromises();
    expect(fb.currentPath).toBe('sub');

    // 切回根 shortcut — currentPath 必须清空
    await wrapper.find('[data-test="shortcut-dropdown"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="shortcut-opt-1"]').trigger('click');
    await flushPromises();
    expect(fb.currentPath).toBe('');
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

// ─── v0.1.0-module3.0.8 (任务 10): masonry 浏览位置接入 toolbar ───
//
// spec: docs/superpowers/specs/2026-08-10-masonry-browse-position-design.md v4
// 5 处改动:
//   1. canonicalImageNames computed (FB → FileList → MasonryView)
//   2. canReadNow 扩展: 未选中 + masonryLastBrowseProgress 有 imageName → true
//   3. onReadNowClick 改: 未选中 + cachedProgress → readFromCurrentPath
//   4. onJumpToLastClick: 转发到 fileListRef.masonryJumpToLast
//   5. toolbar「↶ 跳到上次」按钮 (仅 masonry 视图)
//
// 测试策略: 用 FileList stub 暴露 masonryLastBrowseProgress (computed) +
// masonryJumpToLast (action), 验证 canReadNow + jumpToLast 按钮 + 转发链.
// canonicalImageNames 用真实 FileList 验证 (改 entries + ViewMode = masonry).

describe('FileBrowser — masonry 浏览位置接入 toolbar (Task 10)', () => {
  let scrollToPathStub: ReturnType<typeof vi.fn>;
  let scrollToIndexStub: ReturnType<typeof vi.fn>;
  let masonryJumpToLastStub: ReturnType<typeof vi.fn>;
  let masonryLastBrowseProgressValue: { current: { bookId: number; page: number; imageName: string | null; readerMode: 'single' | 'double'; updatedAt: number } | null };

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    routerPushSpy.mockClear();
    scrollToPathStub = vi.fn();
    scrollToIndexStub = vi.fn();
    masonryJumpToLastStub = vi.fn();
    masonryLastBrowseProgressValue = { current: null };
  });

  function mountWithFileListStub() {
    const FileListStub = {
      name: 'FileList',
      setup(_: unknown, { expose }: { expose: (e: Record<string, unknown>) => void }) {
        expose({
          scrollToPath: scrollToPathStub,
          scrollToIndex: scrollToIndexStub,
          masonryJumpToLast: masonryJumpToLastStub,
          // Vue 3 `<script setup>` defineExpose 暴露 ref/computed 时自动 unwrap.
          // 在测试 stub 中直接暴露 unwrapped value (对象引用), 让 FileBrowser
          // 通过 fileListRef.value.masonryLastBrowseProgress 拿到的就是 ProgressItem | null.
          // masonryLastBrowseProgressValue.current 变化 → 解引用触发响应式更新.
          get masonryLastBrowseProgress() {
            return masonryLastBrowseProgressValue.current;
          },
        });
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

  it('canReadNow: 未选中 + masonryLastBrowseProgress 有 imageName → 立即阅读按钮可点', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    masonryLastBrowseProgressValue.current = {
      bookId: 1, page: 0, imageName: 'p1.jpg', readerMode: 'single', updatedAt: 0,
    };
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 立即阅读按钮: 未选中, 但 masonryLastBrowseProgress.imageName 有值 → 可点
    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it('canReadNow: masonry 视图下 + 未选 + masonryLastBrowseProgress 空 → 立即阅读按钮不可点', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    masonryLastBrowseProgressValue.current = null;
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    // 切到 masonry 视图, masonry 浏览位置为空 → 按钮不可点
    fb.setViewMode('masonry');
    await flushPromises();

    // 立即阅读按钮: 未选 + masonry 视图 + 无 progress → 不可点
    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it('canReadNow: masonry 视图下 + 未选 + masonryLastBrowseProgress.imageName = null → 立即阅读按钮不可点', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    masonryLastBrowseProgressValue.current = {
      bookId: 1, page: 0, imageName: null, readerMode: 'single', updatedAt: 0,
    };
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    fb.setViewMode('masonry');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it('toolbar「↶ 跳到上次」按钮: masonry 视图可见 + 点击调 masonryJumpToLast', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    masonryLastBrowseProgressValue.current = {
      bookId: 1, page: 0, imageName: 'p1.jpg', readerMode: 'single', updatedAt: 0,
    };
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 切到 masonry 视图
    fb.setViewMode('masonry');
    await flushPromises();

    // masonry 视图下按钮可见
    const btn = wrapper.find('[data-test="btn-jump-to-last"]');
    expect(btn.exists()).toBe(true);

    // 点击 → masonryJumpToLast 被调
    await btn.trigger('click');
    await flushPromises();
    expect(masonryJumpToLastStub).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('toolbar「↶ 跳到上次」按钮: details 视图不可见 (v-if="fb.viewMode === \'masonry\'")', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    masonryLastBrowseProgressValue.current = {
      bookId: 1, page: 0, imageName: 'p1.jpg', readerMode: 'single', updatedAt: 0,
    };
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 默认 details 视图 → 按钮不存在
    expect(wrapper.find('[data-test="btn-jump-to-last"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('toolbar「↶ 跳到上次」按钮: masonry + 无 progress → 按钮 disabled', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    masonryLastBrowseProgressValue.current = null;
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setViewMode('masonry');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-jump-to-last"]');
    expect(btn.exists()).toBe(true);
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it('onReadNowClick 未选中 → 调 readFromCurrentPath (走 IPC, 详情视图下从第一张开始)', async () => {
    // 验证无选中 entry 调立即阅读按钮时, 走 readFromCurrentPath (而非 readNow / readFromImage).
    // 详情视图下 readFromCurrentPath 内部读 progress (mock 返 null) → 走"从第一张开始"路径
    // → router.push('/reader/42') (无 ?at=).
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 未选中 → 点 立即阅读按钮
    const btn = wrapper.find('[data-test="btn-read-now"]');
    await btn.trigger('click');
    await flushPromises();

    // getProgress mock 返 null → readFromCurrentPath 走"从第一张开始"路径
    // router.push 被调, 走 '/reader/42' (无 ?at=)
    expect(routerPushSpy).toHaveBeenCalledWith('/reader/42');
    // 同步走 createBook 链路 (与 readNow 一致)
    expect(vi.mocked(createBook)).toHaveBeenCalled();
    wrapper.unmount();
  });
});

// ─── v0.1.0-...: viewMode 变化刷 readStatus (瀑布流读后退详情能看到徽章) ───
describe('FileBrowser — viewMode 变化刷 readStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    routerPushSpy.mockClear();
  });

  it('切到 masonry → 切回 details → 详情视图的 marks 是新数据', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // mock readStatus.refresh 调用计数
    const readStatusStore = useReadStatusStore();
    const refreshSpy = vi.spyOn(readStatusStore, 'refresh');

    // 切到 masonry 触发 refresh
    fb.setViewMode('masonry');
    await flushPromises();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // 切回 details 也触发 refresh
    fb.setViewMode('details');
    await flushPromises();
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });
});

describe('FileBrowser — canonicalImageNames 传给 FileList (Task 10)', () => {
  // canonicalImageNames: fb.sortedEntries 过滤图片 → name[] (computed 派生)
  // 传给 FileList prop, 内部转发到 MasonryView (任务 8 已接 prop)
  // 验证 FileList 收到正确数组 (仅图片, 顺序与 sortedEntries 一致)

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
  });

  it('canonicalImageNames: 仅图片 (过滤目录/压缩包), 顺序与 sortedEntries 一致', async () => {
    // 3 个图片 + 1 个目录 + 1 个压缩包 → 3 个名字
    mockedList.mockResolvedValueOnce([
      { name: 'chapter1', path: 'chapter1', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'page1.jpg', path: 'page1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
      { name: 'manga.cbz', path: 'manga.cbz', isDirectory: false, isArchive: true, size: 1, modifiedAt: 0 },
      { name: 'page2.jpg', path: 'page2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
      { name: 'page3.jpg', path: 'page3.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const fileList = wrapper.findComponent({ name: 'FileList' });
    const names = fileList.props('canonicalImageNames') as string[];
    // 仅 3 个图片 (按 sortedEntries 顺序 — image_first 不排序, 自然顺序)
    expect(names).toEqual(['page1.jpg', 'page2.jpg', 'page3.jpg']);
  });
});

// ─── v0.1.0-module3.0.8 (任务 9): 瀑布流跨卷工具栏「下一卷」按钮 ───
//
// spec: docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md §14
//  3 处改动:
//   1. flushNow 转发链 (MasonryView.flushBrowsePosition → FileList.masonryFlushNow
//      → FileBrowser.onCrossNextVolume via fileListRef)
//   2. 工具栏「下一卷」按钮 (不绑 viewMode, P1-3 修复 — disabled 不含 !hasImages)
//   3. onCrossNextVolume (findNextVolume + lastFetchedPath + 双重陈旧校验)
describe('FileBrowser — 跨卷连续阅读 toolbar (Task 9)', () => {
  let masonryFlushNowStub: ReturnType<typeof vi.fn>;
  let masonryJumpToLastStub: ReturnType<typeof vi.fn>;
  let masonryLastBrowseProgressValue: { current: { bookId: number; page: number; imageName: string | null; readerMode: 'single' | 'double'; updatedAt: number } | null };

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    routerPushSpy.mockClear();
    masonryFlushNowStub = vi.fn(async () => undefined);
    masonryJumpToLastStub = vi.fn(async () => undefined);
    masonryLastBrowseProgressValue = { current: null };
  });

  function mountWithFileListStub() {
    const FileListStub = {
      name: 'FileList',
      setup(_: unknown, { expose }: { expose: (e: Record<string, unknown>) => void }) {
        expose({
          masonryJumpToLast: masonryJumpToLastStub,
          masonryFlushNow: masonryFlushNowStub,
          get masonryLastBrowseProgress() {
            return masonryLastBrowseProgressValue.current;
          },
        });
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

  it('btn-next-volume 在 rootPath 设值 + 进子目录后启用 (swapping || !rootPath || !lastFetchedPath 守卫)', async () => {
    // 初始 rootPath=null → toolbar 不渲染 (empty state), 按钮不存在
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    expect(wrapper.find('[data-test="toolbar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="btn-next-volume"]').exists()).toBe(false);

    // setRoot 后 toolbar 渲染 + 按钮可见; lastFetchedPath='' (根目录 fetch) → 禁用
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    await fb.setRoot('C:/comics');
    await flushPromises();
    let btn = wrapper.find('[data-test="btn-next-volume"]');
    expect(btn.exists()).toBe(true);
    // lastFetchedPath='' → 仍禁用 (根目录自身不能作"卷"起点)
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);

    // 进子目录 → lastFetchedPath 有值 → 启用
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    await fb.navigate('vol02');
    await flushPromises();
    btn = wrapper.find('[data-test="btn-next-volume"]');
    expect(fb.lastFetchedPath).toBe('vol02');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);

    wrapper.unmount();
  });

  it('btn-next-volume: 进子目录 lastFetchedPath 有值 → 启用 (不绑 viewMode)', async () => {
    // 验证: 在 details 视图 (非 masonry) 也显示 + 可点 (P1-3 修复)
    mockedList
      .mockResolvedValueOnce([{ name: 'vol02', path: 'vol02', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }] as never) // setRoot fetch
      .mockResolvedValueOnce([{ name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 }] as never); // navigate fetch
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    await fb.navigate('vol02');
    await flushPromises();
    expect(fb.lastFetchedPath).toBe('vol02');

    // 默认 details 视图, 按钮仍可见 (不绑 viewMode)
    const btn = wrapper.find('[data-test="btn-next-volume"]');
    expect(btn.exists()).toBe(true);
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it('onCrossNextVolume: masonryFlushNow → findNextVolume → navigate (双重陈旧校验通过)', async () => {
    // 流程: 早捕获 path+root → masonryFlushNow → findNextVolume → 校验未变 → fb.navigate
    mockedList
      .mockResolvedValueOnce([{ name: 'vol02', path: 'vol02', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }] as never) // setRoot
      .mockResolvedValueOnce([{ name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 }] as never) // navigate vol02
      .mockResolvedValueOnce([{ name: 'p2.jpg', path: 'p2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 }] as never); // navigate vol03 (跨卷)
    mockedFindNextVolume.mockResolvedValueOnce({
      descriptor: { type: 'local', rootPath: 'C:/comics' },
      relPath: 'vol03',
      title: 'vol03',
    });
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    await fb.navigate('vol02');
    await flushPromises();
    expect(fb.lastFetchedPath).toBe('vol02');

    // 点下一卷按钮
    const btn = wrapper.find('[data-test="btn-next-volume"]');
    await btn.trigger('click');
    await flushPromises();

    // masonryFlushNow 必调 (flush 当前浏览位置)
    expect(masonryFlushNowStub).toHaveBeenCalledTimes(1);
    // findNextVolume 调: descriptor + lastFetchedPath (无 filter 参数)
    expect(mockedFindNextVolume).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'C:/comics' },
      'vol02',
      'next',
    );
    // fb.navigate 被调 — 跳到 vol03
    expect(fb.currentPath).toBe('vol03');
    wrapper.unmount();
  });

  it('onCrossNextVolume: findNextVolume 返回 null → 不 navigate (无下一卷)', async () => {
    mockedList
      .mockResolvedValueOnce([{ name: 'vol02', path: 'vol02', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }] as never)
      .mockResolvedValueOnce([{ name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 }] as never);
    mockedFindNextVolume.mockResolvedValueOnce(null);
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    await fb.navigate('vol02');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-next-volume"]');
    await btn.trigger('click');
    await flushPromises();

    // masonryFlushNow + findNextVolume 都被调
    expect(masonryFlushNowStub).toHaveBeenCalledTimes(1);
    expect(mockedFindNextVolume).toHaveBeenCalledTimes(1);
    // currentPath 不变 (仍在 vol02)
    expect(fb.currentPath).toBe('vol02');
    wrapper.unmount();
  });

  it('onCrossNextVolume: swapping 守卫 — 重复点不并发触发', async () => {
    // 验证 swapping 守卫生效: 第一次 click 在飞时, 第二次 click 被忽略
    let resolveNext!: (v: { descriptor: { type: 'local'; rootPath: string }; relPath: string; title: string } | null) => void;
    mockedFindNextVolume.mockImplementationOnce(
      () => new Promise<{ descriptor: { type: 'local'; rootPath: string }; relPath: string; title: string } | null>(
        (r) => { resolveNext = r; },
      ),
    );
    mockedList
      .mockResolvedValueOnce([{ name: 'vol02', path: 'vol02', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }] as never)
      .mockResolvedValueOnce([{ name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 }] as never)
      .mockResolvedValue([{ name: 'p2.jpg', path: 'p2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 }] as never);
    const wrapper = mountWithFileListStub();
    await flushPromises();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    await fb.navigate('vol02');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-next-volume"]');
    // 第一次 click — 启动 swapping, findNextVolume 在飞
    await btn.trigger('click');
    await flushPromises();
    // 第二次 click — swapping=true, onCrossNextVolume 入口 return
    await btn.trigger('click');
    await flushPromises();
    expect(mockedFindNextVolume).toHaveBeenCalledTimes(1);

    // resolve 让第一次完成
    resolveNext({ descriptor: { type: 'local', rootPath: 'C:/comics' }, relPath: 'vol03', title: 'vol03' });
    await flushPromises();
    wrapper.unmount();
  });
});

// ─── v0.1.0-...: 详情视图「立即阅读」按钮读取上次阅读进度 ───
// 新行为:
//   - 详情视图 + 未选 + 含图 → 按钮可点 (点击调 readFromCurrentPath)
//   - 详情视图 + 未选 + 不含图 → 按钮不可点
//   - 瀑布流视图 → 保持 masonry 浏览位置判断 (不影响本次新增)
describe('FileBrowser — 详情视图「立即阅读」按目录含图启用', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    routerPushSpy.mockClear();
  });

  it('详情视图 + 未选 + 目录含图 → 立即阅读按钮可点', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();
    // 默认 viewMode = 'details'; 不选任何行
    expect(fb.viewMode).toBe('details');
    expect(fb.selectedPaths.size).toBe(0);

    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('详情视图 + 未选 + 目录不含图 → 立即阅读按钮不可点', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'notes.txt', path: 'notes.txt', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-read-now"]');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('详情视图 + 未选 + 点击 → 调 readFromCurrentPath (走 IPC 读进度 / 从上次或第一张进入)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
      { name: 'p2.jpg', path: 'p2.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 不选行, 直接点按钮
    const btn = wrapper.find('[data-test="btn-read-now"]');
    await btn.trigger('click');
    await flushPromises();

    // createBook 走的是 mock 默认值 42 (line 29). 详情视图无浏览记录, 走"从第一张开始"路径.
    // router.push 会被调, push '/reader/42' (无 ?at=)
    expect(routerPushSpy).toHaveBeenCalledWith('/reader/42');
    // recordHistory 也被调 (与 readNow 一致)
    expect(vi.mocked(createBook)).toHaveBeenCalled();
  });

  it('详情视图 + 选中图片 → 按钮可点 (保持现有行为, 不退化)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
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

  it('详情视图 + 选中目录 → 按钮可点 (保持现有行为)', async () => {
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
});

// ─── 路径身份修复 (2026-08-12, spec §6.4): shortcut 单一执行点 + relPath 校验 ───
describe('FileBrowser — openShortcut 唯一执行点 + 路径校验', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('合法 shortcut: setActive 后 setRoot + navigate 正常执行', async () => {
    mockedList.mockResolvedValue([]);
    const sc = mkShortcut(5, 'C:/comics', '漫画A', 'sub/vol01');
    mockedShortcuts.mockResolvedValue([sc]);
    const wrapper = await mountFileBrowser();
    expect(wrapper.exists()).toBe(true);
    const fb = useFileBrowserStore();
    const shortcuts = useShortcutsStore();
    await flushPromises();
    expect(shortcuts.items.length).toBe(1);

    shortcuts.setActive(5);
    await flushPromises();
    await flushPromises();

    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('sub/vol01');

    // 审查修复 (2026-08-13): 卸载清 nextVolumeDebounce — navigate 到子目录已调度 300ms
    // 真实 timer, 不卸载会在后续 Task 6 用例执行期 fire, 产生多余的 findNextVolume 调用
    // (消耗 mock once-queue / 打破 toHaveBeenCalledTimes 断言), 是全文件偶发失败根因之一。
    wrapper.unmount();
  });

  it('坏 shortcut (绝对 relPath): setActive 后拒绝导航, currentPath 不被污染', async () => {
    mockedList.mockResolvedValue([]);
    const sc = mkShortcut(8, 'C:/normal', '坏快捷方式', 'F:/WallPaper');
    mockedShortcuts.mockResolvedValue([sc]);
    const wrapper = await mountFileBrowser();
    expect(wrapper.exists()).toBe(true);
    const fb = useFileBrowserStore();
    const shortcuts = useShortcutsStore();
    await flushPromises();

    shortcuts.setActive(8);
    await flushPromises();
    await flushPromises();

    // 拒绝: currentPath 不会被设成绝对路径
    expect(fb.currentPath).toBe('');
    // listDirectory 不应收到绝对路径
    expect(mockedList).not.toHaveBeenCalledWith(expect.anything(), 'F:/WallPaper');

    // 审查修复: 卸载清 nextVolumeDebounce (setRoot 重置 lastFetchedPath 也会调度 300ms timer)
    wrapper.unmount();
  });

  it('根目录 shortcut (relPath=""): setActive 后 setRoot, 不 navigate', async () => {
    mockedList.mockResolvedValue([]);
    const sc = mkShortcut(1, 'C:/root', '根', '');
    mockedShortcuts.mockResolvedValue([sc]);
    const wrapper = await mountFileBrowser();
    expect(wrapper.exists()).toBe(true);
    const fb = useFileBrowserStore();
    const shortcuts = useShortcutsStore();
    await flushPromises();

    shortcuts.setActive(1);
    await flushPromises();
    await flushPromises();

    expect(fb.rootPath).toBe('C:/root');
    expect(fb.currentPath).toBe(''); // 根目录, 不 navigate

    // 审查修复: 卸载清 nextVolumeDebounce (setRoot 重置 lastFetchedPath 可能触发 watcher)
    wrapper.unmount();
  });
});

// ─── v0.1.0-module3.1.1 (任务 6 功能 B): 底栏下一卷预查 + StatusBar 绑定 ───
//
// spec: docs/superpowers/specs/2026-08-12-masonry-finished-and-statusbar-next-volume-design.md §3.5
//  4 处改动:
//   1. FileBrowser prefetchNextVolume (请求序号三分支陈旧校验)
//   2. watch fb.lastFetchedPath → debounce 300ms → 预查
//   3. onCrossNextVolume 成功后调 prefetchNextVolume 刷新
//   4. StatusBar 绑 nextVolumeTitle/nextVolumeLoading/nextVolumeDisabled + @next-volume
//
// 测试策略: 复用现有 vi.mock('@/lib/tauri', ...) + mockedFindNextVolume 控制返回.
// 用 fake timers + advanceTimersByTime 推进 debounce. 不依赖 DOM (StatusBar props via findComponent).
describe('FileBrowser — 底栏 StatusBar 下一卷预查 (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 审查修复 (2026-08-13): clearAllMocks 不清 mockResolvedValueOnce/mockImplementationOnce
    // once-queue — B-T7 泄漏的 never-resolving mockImplementationOnce 会被 B-T8 第一次预查消费,
    // 导致 title 永远 undefined。mockReset 清空 once-queue + 默认实现, 再重设默认。
    mockedFindNextVolume.mockReset();
    setActivePinia(createPinia());
    mockedList.mockResolvedValue([]);
    mockedShortcuts.mockResolvedValue([]);
    // 默认无下一卷 (mockResolvedValue 影响所有调用; 个例用 mockResolvedValueOnce/mockImplementationOnce 覆盖)
    mockedFindNextVolume.mockResolvedValue(null);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Mount helper: 模拟用户 setRoot(root) 后 navigate(path) 到达 lastFetchedPath.
   * setRoot + navigate 各触发一次 listDirectory, 都 mock 成空 entries.
   * 返回的 wrapper + fb 都可被测试继续操作.
   */
  async function mountFileBrowserWithRoot(root: string, lastFetchedPath: string) {
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    // setRoot 触发 fetch('')
    await fb.setRoot(root);
    await flushPromises();
    if (lastFetchedPath !== '') {
      // navigate 触发 fetch(lastFetchedPath)
      await fb.navigate(lastFetchedPath);
      await flushPromises();
    }
    return wrapper;
  }

  /** 切到新目录: 同步改 fb.lastFetchedPath (走 store.fetch). 等价用户 navigate 行为. */
  async function setLastFetchedPath(wrapper: ReturnType<typeof mount>, path: string) {
    const fb = useFileBrowserStore();
    await fb.navigate(path);
    await flushPromises();
    return wrapper;
  }

  it('B-T1: lastFetchedPath 变化 → debounce 300ms → findNextVolume 返回 title → StatusBar 收到', async () => {
    mockedFindNextVolume.mockResolvedValue({
      descriptor: { type: 'local', rootPath: 'D:/comics' },
      relPath: 'vol02',
      title: 'vol02',
    });
    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    // 推进 debounce 300ms (setTimeout(prefetchNextVolume, 300))
    vi.advanceTimersByTime(300);
    await flushPromises();

    // findNextVolume 应被调: descriptor + 'vol01' + 'next' (仅预查 1 次 — 泄漏 timer 已修)
    expect(mockedFindNextVolume).toHaveBeenCalledTimes(1);
    expect(mockedFindNextVolume).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'D:/comics' },
      'vol01',
      'next',
    );
    // StatusBar 收到 nextVolumeTitle = 'vol02'
    const sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.exists()).toBe(true);
    expect(sb.props('nextVolumeTitle')).toBe('vol02');
    expect(sb.props('nextVolumeLoading')).toBe(false);
  });

  it('B-T2: findNextVolume 返回 null → nextVolumeTitle=null (无下一卷)', async () => {
    // 默认 mockedFindNextVolume.mockResolvedValue(null) → null
    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();

    const sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe(null);
    expect(sb.props('nextVolumeLoading')).toBe(false);
  });

  it('B-T3: 旧请求晚返回失败不覆盖新目录(请求序号陈旧校验, 审查 P1-3)', async () => {
    // vol01 预查: 挂起(返回可控 promise)
    let rejectVol01: (e: Error) => void = () => { /* noop */ };
    mockedFindNextVolume.mockImplementationOnce(
      () => new Promise<{ descriptor: { type: 'local'; rootPath: string }; relPath: string; title: string } | null>(
        (_, rej) => { rejectVol01 = rej; },
      ),
    );
    // vol02 预查: 成功返回 title 'vol03'
    mockedFindNextVolume.mockResolvedValueOnce({
      descriptor: { type: 'local', rootPath: 'D:/comics' },
      relPath: 'vol03',
      title: 'vol03',
    });

    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    // 推进 300ms → vol01 预查发出(挂起, seq=1)
    vi.advanceTimersByTime(300);
    await flushPromises();

    // 切到 vol02: 新 fetch + 新预查 (seq=2)
    await setLastFetchedPath(wrapper, 'vol02');
    vi.advanceTimersByTime(300);
    await flushPromises();

    // 此时 vol02 预查完成: title='vol03', loading=false
    let sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol03');
    expect(sb.props('nextVolumeLoading')).toBe(false);

    // vol01 旧请求现在失败返回(陈旧)
    rejectVol01(new Error('network'));
    await flushPromises();

    // vol01 失败不该把 vol02 的 title 覆盖成 null, loading 不该被提前关
    sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol03');
    expect(sb.props('nextVolumeLoading')).toBe(false);
  });

  it('B-T4: 旧请求晚返回成功也不覆盖新目录 title (陈旧成功路径校验)', async () => {
    // vol01 预查: 挂起
    let resolveVol01!: (v: { descriptor: { type: 'local'; rootPath: string }; relPath: string; title: string } | null) => void;
    mockedFindNextVolume.mockImplementationOnce(
      () => new Promise<{ descriptor: { type: 'local'; rootPath: string }; relPath: string; title: string } | null>(
        (r) => { resolveVol01 = r; },
      ),
    );
    // vol02 预查: 成功 'vol03'
    mockedFindNextVolume.mockResolvedValueOnce({
      descriptor: { type: 'local', rootPath: 'D:/comics' },
      relPath: 'vol03',
      title: 'vol03',
    });

    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();

    await setLastFetchedPath(wrapper, 'vol02');
    vi.advanceTimersByTime(300);
    await flushPromises();

    let sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol03');

    // vol01 旧请求晚成功返回 (title='vol01Next')
    resolveVol01({
      descriptor: { type: 'local', rootPath: 'D:/comics' },
      relPath: 'vol01Next',
      title: 'vol01Next',
    });
    await flushPromises();

    // 陈旧成功不该覆盖 vol02 的 title='vol03'
    sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol03');
  });

  it('B-T5: StatusBar @next-volume 触发 onCrossNextVolume (复用跳转逻辑)', async () => {
    // 预查 + 点击 → 触发 onCrossNextVolume
    mockedList
      .mockResolvedValueOnce([]) // setRoot fetch
      .mockResolvedValueOnce([]) // navigate vol01
      .mockResolvedValueOnce([]); // navigate vol02 (跨卷)
    mockedFindNextVolume
      .mockResolvedValueOnce({
        descriptor: { type: 'local', rootPath: 'D:/comics' },
        relPath: 'vol02',
        title: 'vol02',
      }) // 1. 预查 vol01 (mount 时)
      .mockResolvedValueOnce({
        descriptor: { type: 'local', rootPath: 'D:/comics' },
        relPath: 'vol02',
        title: 'vol02',
      }) // 2. onCrossNextVolume 内的 findNextVolume
      .mockResolvedValueOnce({
        descriptor: { type: 'local', rootPath: 'D:/comics' },
        relPath: 'vol03',
        title: 'vol03',
      }); // 3. 跨卷成功后显式 prefetchNextVolume (spec §3.6)

    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();

    // 预查到 title='vol02'
    const sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol02');

    // 点 StatusBar 右段 (StatusBar.vue data-test="statusbar-next-volume")
    const nextBtn = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(nextBtn.exists()).toBe(true);
    await nextBtn.trigger('click');
    await flushPromises();

    // onCrossNextVolume 应调 findNextVolume (第二次) + fb.navigate('vol02') + 跨卷后显式预查 (第三次)
    expect(mockedFindNextVolume).toHaveBeenCalledTimes(3);
    const fb = useFileBrowserStore();
    expect(fb.currentPath).toBe('vol02');
    // 跨卷成功后,显式 prefetchNextVolume 已更新右段为新卷 vol02 的下一卷 'vol03'
    expect(sb.props('nextVolumeTitle')).toBe('vol03');
  });

  it('B-T6: 根目录 lastFetchedPath="" → prefetchNextVolume 早返, 不查 IPC', async () => {
    // 只 setRoot 不 navigate → lastFetchedPath = ''
    const wrapper = await mountFileBrowserWithRoot('D:/comics', '');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();

    // findNextVolume 不应被调(根目录无"卷"起点)
    expect(mockedFindNextVolume).not.toHaveBeenCalled();
    // StatusBar nextVolumeDisabled = true (无 lastFetchedPath)
    const sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeDisabled')).toBe(true);
  });

  it('B-T7: 切目录瞬间 nextVolumeLoading=true (右段不闪空, spec §3.3)', async () => {
    // 第一次预查返回 'vol02' → title 已设
    mockedFindNextVolume.mockResolvedValueOnce({
      descriptor: { type: 'local', rootPath: 'D:/comics' },
      relPath: 'vol02',
      title: 'vol02',
    });
    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();

    let sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol02');
    expect(sb.props('nextVolumeLoading')).toBe(false);

    // 切到 vol02 (新挂起的请求)
    mockedFindNextVolume.mockImplementationOnce(
      () => new Promise<{ descriptor: { type: 'local'; rootPath: string }; relPath: string; title: string } | null>(
        () => { /* never resolves */ },
      ),
    );
    await setLastFetchedPath(wrapper, 'vol02');
    // 切目录后立刻 (debounce 未到) → loading 已置 true, title 保持旧值(不闪空)
    sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeLoading')).toBe(true);
    expect(sb.props('nextVolumeTitle')).toBe('vol02'); // 保持, 不闪空
  });

  it('B-T8: 子目录切回根目录 → 早返清 loading, StatusBar 显示「已是最后一卷」而非「…」', async () => {
    // 审查修复 (2026-08-13): 早返分支漏关 loading — watcher 切目录同步置 true,
    // 根目录 (lastFetchedPath='') 早返后 loading 永久 true, 右段永远「…」。
    // 先有子目录 title ('vol02'), 再切回根目录模拟转换 (B-T6 初始即根测不到)。
    mockedFindNextVolume.mockResolvedValueOnce({
      descriptor: { type: 'local', rootPath: 'D:/comics' },
      relPath: 'vol02',
      title: 'vol02',
    });
    const wrapper = await mountFileBrowserWithRoot('D:/comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();

    // 子目录预查完成: title='vol02', loading=false
    let sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeTitle')).toBe('vol02');
    expect(sb.props('nextVolumeLoading')).toBe(false);
    expect(wrapper.find('[data-test="statusbar-next-volume"]').text()).toBe('下一卷: vol02');

    // 切回根目录: lastFetchedPath='' → watcher 置 loading=true, debounce 300ms
    await setLastFetchedPath(wrapper, '');
    sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeLoading')).toBe(true); // 过渡态

    // 300ms 后 prefetchNextVolume 早返 → loading=false, title=null (修复点)
    vi.advanceTimersByTime(300);
    await flushPromises();
    sb = wrapper.findComponent({ name: 'StatusBar' });
    expect(sb.props('nextVolumeLoading')).toBe(false);
    expect(sb.props('nextVolumeTitle')).toBe(null);
    // 右段渲染「已是最后一卷」而非「…」
    expect(wrapper.find('[data-test="statusbar-next-volume"]').text()).toBe('已是最后一卷');
    // 根目录无"卷"起点, 不查 IPC (只有 vol01 那一次预查)
    expect(mockedFindNextVolume).toHaveBeenCalledTimes(1);
  });
});

// ─── v0.1.0-module3.0.10: pendingOpenLocation 消费（likes「浏览」跳转）───
// spec §4.3/§5.3：消费点必须在 loadLayout 之后（否则旧持久化 fb_view_mode 覆盖
// setViewMode('masonry')）；优先级 pending > restoreNavigationContext > shortcut。
// FileList stub 对齐 Task 10 模式（避免真实 MasonryView 拉起未 mock 的缩略图 IPC）。
describe('FileBrowser — pendingOpenLocation 消费（likes 浏览跳转）', () => {
  const FileListNullStub = { name: 'FileList', setup: () => () => null };

  function mountBrowser() {
    const wrapper = mount(FileBrowser, {
      global: { plugins: [i18n], stubs: { FileList: FileListNullStub } },
    });
    _mountedWrappers.push(wrapper);
    return wrapper;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // 必须含图片条目：FileBrowser.vue 有守卫 watch([viewMode, hasImages])——
    // masonry + 无图目录会自动回落 details，空 mock 会让 viewMode 断言失败
    mockedList.mockResolvedValue([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    mockedShortcuts.mockResolvedValue([]);
  });

  it('消费 pending → setRoot + navigate + masonry，且 loadLayout 旧持久化值(list)不覆盖', async () => {
    // loadLayout 的 4 次 getSetting 依序: fb_sort_field / fb_sort_ascending / fb_view_mode / fb_hide_finished
    mockedGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('list')
      .mockResolvedValueOnce(null);
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    fb.requestOpenLocation('C:/comics', 'VOL.11');
    mountBrowser();
    await flushPromises();

    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('VOL.11');
    expect(fb.viewMode).toBe('masonry');
    // 一次性：已消费
    expect(fb.consumePendingOpenLocation()).toBeNull();
  });

  it("relPath=''（root 级书）→ 仅 setRoot + masonry，不 navigate", async () => {
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    fb.requestOpenLocation('C:/comics', '');
    mountBrowser();
    await flushPromises();

    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('');
    expect(fb.viewMode).toBe('masonry');
  });

  it('relPath 非法 → 不 setRoot 不 navigate，viewMode 保持 details', async () => {
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    fb.requestOpenLocation('C:/comics', '..\\evil');
    mountBrowser();
    await flushPromises();

    expect(fb.rootPath).toBeNull();
    expect(fb.viewMode).toBe('details');
  });

  it('pending 优先于 savedNavigationContext（request 时点已清空旧上下文）', async () => {
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/old');
    fb.saveNavigationContext();
    fb.requestOpenLocation('C:/comics', 'VOL.11');
    mountBrowser();
    await flushPromises();

    // 导航到 pending 目标，而非旧上下文 C:/old
    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('VOL.11');
  });

  it('setActive(3) 后浏览跳转 → 重挂载不重放旧 shortcut', async () => {
    mockedShortcuts.mockResolvedValue([mkShortcut(3, 'C:/other', '别的', 'sub')]);
    setActivePinia(createPinia());
    const shortcuts = useShortcutsStore();
    const fb = useFileBrowserStore();
    shortcuts.setActive(3);
    fb.requestOpenLocation('C:/comics', 'VOL.11');

    const w1 = mountBrowser();
    await flushPromises();
    // pending 执行、shortcut 未导航；activeId 已在 request 时点清空
    expect(fb.currentPath).toBe('VOL.11');
    expect(shortcuts.activeId).toBeNull();
    w1.unmount();

    // 二次挂载（无新意图）：activeId 已清 → 不得重放 shortcut 3（C:/other/sub）
    mountBrowser();
    await flushPromises();
    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('VOL.11');
  });
});
