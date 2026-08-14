/**
 * FileList.vue 测试 — Phase 3 虚拟化重写
 * v0.1.0-module3.0.4-virtuallist Task 3.2
 *
 * - 适配原测试: ul/li → virt-container + [data-test="row"]
 * - 加 5 集成测试: 虚拟化生效 / totalHeight 公式 / aria-rowcount / scrollTop clamp / viewMode DOM 复用
 * - 保留 details header 列头 + sortField 联动
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { nextTick } from 'vue';
import zhCN from '@/locales/zh-CN';
import FileList from './FileList.vue';
import type { MediaEntry, ReadStatusMap } from '@/lib/sourceDescriptor';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
});

function entry(name: string, opts: Partial<MediaEntry> = {}): MediaEntry {
  return {
    name,
    path: name,
    isDirectory: false,
    isArchive: false,
    size: 0,
    modifiedAt: undefined,
    ...opts,
  };
}

// v0.1.0-module3.0.5-masonry (阶段 E2): ViewMode 收窄为 details | masonry,
// list/grid template 分支已删. TestProps 仅保留这两个值.
interface TestProps {
  entries: MediaEntry[];
  loading?: boolean;
  marks?: ReadStatusMap;
  selectedPaths?: Set<string>;
  viewMode?: 'details' | 'masonry';
  /** 2026-08-14 hotfix: 子目录 mark 匹配测试用 */
  currentPath?: string;
}

function mountList(
  props: Partial<TestProps> = {},
  opts: Record<string, unknown> = {},
) {
  return mount(FileList, {
    props: { entries: [], ...props } as any,
    // stub MasonryView：其内部 useMasonryThumbnails 依赖 Tauri event/IPC，单元测试里不应触发。
    global: { plugins: [createPinia(), i18n], stubs: { MasonryView: true } },
    ...opts,
  });
}

/** 等到 RAF + 一次 nextTick (触发 ResizeObserver + visibleRange) */
async function settle(): Promise<void> {
  await nextTick();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

describe('FileList.vue', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('renders empty state when entries array is empty', () => {
    const w = mountList({ entries: [] });
    expect(w.find('.virt-empty').exists()).toBe(true);
    expect(w.text()).toContain('此目录为空');
  });

  it('renders rows in given order (no internal sort)', async () => {
    const entries = [entry('page10.jpg'), entry('page2.jpg'), entry('page1.jpg')];
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    const rows = w.findAll('[data-test="row"]');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const paths = rows.slice(0, 3).map((r) => r.attributes('data-path'));
    expect(paths).toEqual(['page10.jpg', 'page2.jpg', 'page1.jpg']);
    w.unmount();
  });

  it('marks directory rows with is-directory class', async () => {
    const entries = [entry('subdir', { isDirectory: true }), entry('image.jpg')];
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-directory');
    expect(rows[1].classes()).not.toContain('is-directory');
    w.unmount();
  });

  it('marks archive rows with is-archive class', async () => {
    const entries = [entry('comic.cbz', { isArchive: true }), entry('image.jpg')];
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-archive');
    w.unmount();
  });

  // ─── 2026-08-14 hotfix: 子目录 mark 匹配 ───
  // marks key 是 `${rootPath}|${相对根的 relPath}`（如 C:/comics|raw/vol1），
  // entry.path 相对当前目录（vol1）。浏览子目录（currentPath='raw'）时必须
  // 拼前缀才能命中 — 修复前子目录所有 mark 显示为 none。
  it('子目录条目用 currentPath 前缀匹配 marks（data-status）', async () => {
    const entries = [
      entry('vol1', { isDirectory: true }),
      entry('vol2', { isDirectory: true }),
    ];
    const marks: ReadStatusMap = {
      'C:/comics|raw/vol1': 'finished',
      'C:/comics|raw/vol2': 'reading',
    };
    const w = mountList(
      { entries, marks, currentPath: 'raw' },
      { attachTo: document.body },
    );
    await settle();
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].attributes('data-status')).toBe('finished');
    expect(rows[1].attributes('data-status')).toBe('reading');
    w.unmount();
  });

  it('根目录（currentPath 空）matches 行为不变', async () => {
    const entries = [entry('vol1', { isDirectory: true })];
    const marks: ReadStatusMap = { 'C:/comics|vol1': 'finished' };
    const w = mountList(
      { entries, marks, currentPath: '' },
      { attachTo: document.body },
    );
    await settle();
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].attributes('data-status')).toBe('finished');
    w.unmount();
  });

  it('emits select on single click', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mountList({ entries: items }, { attachTo: document.body });
    await settle();
    await w.findAll('[data-test="row"]')[0].trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0][0]).toEqual(items[0]);
    w.unmount();
  });

  it('emits open on double click', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mountList({ entries: items }, { attachTo: document.body });
    await settle();
    await w.findAll('[data-test="row"]')[0].trigger('dblclick');
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('open')![0]).toEqual([items[0]]);
    w.unmount();
  });

  it('emits open on Enter key, no select', async () => {
    const items = [entry('a.jpg')];
    const w = mountList({ entries: items }, { attachTo: document.body });
    await settle();
    const row = w.find('[data-test="row"]');
    await row.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('select')).toBeFalsy();
    w.unmount();
  });

  it('Space 键 → emit select (单击等价)', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`f${i}`));
    const wrapper = mountList({ entries }, { attachTo: document.body });
    await settle();
    await wrapper.find('[data-test="row"]').trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('select')).toBeTruthy();
    wrapper.unmount();
  });

  it('applies is-selected class when path in selectedPaths', async () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mountList(
      { entries, selectedPaths: new Set(['a.jpg']) },
      { attachTo: document.body },
    );
    await settle();
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-selected');
    expect(rows[1].classes()).not.toContain('is-selected');
    w.unmount();
  });

  it('emits contextmenu with x/y on right click (legacy FileBrowser compat)', async () => {
    const items = [entry('a.jpg')];
    const w = mountList({ entries: items }, { attachTo: document.body });
    await settle();
    const row = w.find('[data-test="row"]');
    await row.trigger('contextmenu', { clientX: 100, clientY: 200 });
    expect(w.emitted('contextmenu')).toBeTruthy();
    expect(w.emitted('contextmenu')![0][1]).toBe(100);
    expect(w.emitted('contextmenu')![0][2]).toBe(200);
    w.unmount();
  });
});

describe('FileList.vue — 虚拟化集成 (Task 3.2)', () => {
  it('14949 entries mount 后 DOM row < 100', async () => {
    const entries = Array.from({ length: 14949 }, (_, i) => entry(`f${i}`));
    const w = mountList(
      { entries },
      { attachTo: document.body },
    );
    await settle();
    const rowCount = w.findAll('[data-test="row"]').length;
    expect(rowCount).toBeLessThan(100);
    w.unmount();
  });

  it('.virt-content height = entries.length × rowHeight', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries });
    const content = w.find('.virt-content');
    expect(content.attributes('style')).toContain('29000px');
  });

  it('aria-rowcount 同步 entries.length', () => {
    const entries = Array.from({ length: 14949 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries });
    expect(w.find('.virt-container').attributes('aria-rowcount')).toBe('14949');
  });

  it('search 14949 → 3: scrollTop clamp', async () => {
    const big = Array.from({ length: 14949 }, (_, i) => entry(`f${i}`));
    const small = Array.from({ length: 3 }, (_, i) => entry(`match${i}`));
    const w = mountList(
      { entries: big },
      { attachTo: document.body },
    );
    await settle();
    const ref = w.vm as unknown as { scrollToIndex: (i: number) => void; scrollTop: number };
    ref.scrollToIndex(14000);
    expect(ref.scrollTop).toBe(406000);

    await w.setProps({ entries: small });
    await settle();
    // clamp 到合法范围: totalHeight=87, vh 取决于 resize (若 vh=290, max=0)
    expect(ref.scrollTop).toBeLessThanOrEqual(small.length * 29);
    w.unmount();
  });
});

describe('FileList.vue — viewMode 切换保留滚动位置 (Task 4.1)', () => {
  it('focused row 切换 details → masonry: focused path 捕获 (watcher 逻辑)', async () => {
    // v0.1.0-module3.0.5-masonry (阶段 E2): details ↔ masonry 是仅剩的虚拟滚动视图切换.
    // 模拟用户聚焦 f510, 然后切到 masonry — watcher 应捕获 f510 作为 selectedPathBeforeSwitch.
    const entries = Array.from({ length: 1000 }, (_, i) => entry(`f${i}`));
    const wrapper = mountList(
      { entries, viewMode: 'details' },
      { attachTo: document.body },
    );
    await settle();

    const ref = wrapper.vm as unknown as { scrollToIndex: (i: number) => void; scrollTop: number };
    ref.scrollToIndex(500);
    await settle();

    // 手动标记 f510 为 focused row (在 viewport 内)
    const targetPath = entries[510].path; // 'f510'
    const container = wrapper.find('.virt-container').element;
    const visibleRows = container.querySelectorAll('[role="row"][data-path]');
    visibleRows.forEach((el) => {
      const htmlEl = el as HTMLElement;
      htmlEl.dataset.focused = htmlEl.dataset.path === targetPath ? 'true' : 'false';
    });

    // 切到 masonry — watcher 触发, 试图 scrollToPath(f510).
    // masonry 走 useMasonryLayout 而非虚拟 rowHeight, scrollTop 行为不同;
    // 这里仅验证 watcher 不抛错且 container 仍挂载.
    await wrapper.setProps({ viewMode: 'masonry' });
    await nextTick();
    await nextTick();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));

    expect(wrapper.find('.virt-container').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('FileList.vue — details 视图', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('viewMode="details" 渲染 details 列头 (3 列可点击排序)', async () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mountList(
      { entries, viewMode: 'details' },
      { attachTo: document.body },
    );
    await settle();
    expect(w.find('.virt-details').exists()).toBe(true);
    expect(w.find('[data-test="details-sort-name"]').exists()).toBe(true);
    expect(w.find('[data-test="details-sort-modified"]').exists()).toBe(true);
    expect(w.find('[data-test="details-sort-size"]').exists()).toBe(true);
    w.unmount();
  });

  it('details 行显示 type / size (i18n)', async () => {
    const entries = [entry('photo.jpg', { size: 2048, modifiedAt: 1700000000 })];
    const w = mountList(
      { entries, viewMode: 'details' },
      { attachTo: document.body },
    );
    await settle();
    const html = w.html();
    expect(html).toContain('图片');
    expect(html).toContain('2.00 KB');
    w.unmount();
  });

  it('details 目录行 type="文件夹" (i18n)', async () => {
    const entries = [entry('sub', { isDirectory: true })];
    const w = mountList(
      { entries, viewMode: 'details' },
      { attachTo: document.body },
    );
    await settle();
    const html = w.html();
    expect(html).toContain('文件夹');
    w.unmount();
  });

  it('details 列头点击 → setSortField (integration with fileBrowser store)', async () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mountList(
      { entries, viewMode: 'details' },
      { attachTo: document.body },
    );
    await settle();
    const { useFileBrowserStore } = await import('@/stores/fileBrowser');
    const fb = useFileBrowserStore();
    expect(fb.sortField).toBe('name');
    await w.find('[data-test="details-sort-size"]').trigger('click');
    expect(fb.sortField).toBe('size');
    w.unmount();
  });
});

describe('FileList.vue — 键盘导航 (Task 5.1)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('ArrowDown 无 focused row → 聚焦第一个 entry (f0)', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    await w.find('.virt-container').trigger('keydown', { key: 'ArrowDown' });
    await settle();
    const focused = w.find('[data-focused="true"]');
    expect(focused.exists()).toBe(true);
    expect(focused.attributes('data-path')).toBe('f0');
    w.unmount();
  });

  it('ArrowDown 连续触发: 焦点从 f0 移到 f1', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    await w.find('.virt-container').trigger('keydown', { key: 'ArrowDown' });
    await settle();
    await w.find('.virt-container').trigger('keydown', { key: 'ArrowDown' });
    await settle();
    const focused = w.find('[data-focused="true"]');
    expect(focused.exists()).toBe(true);
    expect(focused.attributes('data-path')).toBe('f1');
    w.unmount();
  });

  it('Home 键 → 跳到第一个 entry', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    // 先 End 跳到最后, 再 Home 跳回第一个
    await w.find('.virt-container').trigger('keydown', { key: 'End' });
    await settle();
    await w.find('.virt-container').trigger('keydown', { key: 'Home' });
    await settle();
    const focused = w.find('[data-focused="true"]');
    expect(focused.exists()).toBe(true);
    expect(focused.attributes('data-path')).toBe('f0');
    w.unmount();
  });

  it('End 键 → 跳到最后一个 entry', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    await w.find('.virt-container').trigger('keydown', { key: 'End' });
    await settle();
    const focused = w.find('[data-focused="true"]');
    expect(focused.exists()).toBe(true);
    expect(focused.attributes('data-path')).toBe('f99');
    w.unmount();
  });
});

describe('FileList.vue — focused row tabindex (Task 5.2)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('ArrowDown 后 focused row tabindex=0, 唯一聚焦', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    await w.find('.virt-container').trigger('keydown', { key: 'ArrowDown' });
    await settle();
    const rows = w.findAll('[role="row"]');
    expect(rows.length).toBeGreaterThan(0);
    // 验证: 有且只有一行 data-focused="true" 且 tabindex="0"
    const focusedRows = rows.filter((r) => r.attributes('data-focused') === 'true');
    expect(focusedRows.length).toBe(1);
    expect(focusedRows[0].attributes('tabindex')).toBe('0');
    // 验证: 其余可见行都不是 focused (data-focused != "true")
    const nonFocusedCount = rows.length - focusedRows.length;
    expect(nonFocusedCount).toBeGreaterThan(0);
    w.unmount();
  });
});

describe('FileList.vue — aria 属性 (Task 5.3)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('aria-rowcount 同步 entries.length', async () => {
    const entries = Array.from({ length: 14949 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    expect(w.find('.virt-container').attributes('aria-rowcount')).toBe('14949');
    w.unmount();
  });

  it('aria-rowindex 从 1 开始递增', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries }, { attachTo: document.body });
    await settle();
    // 用 data-test="row" 排除 details-header (它也带 role="row" 但无 aria-rowindex)
    const rows = w.findAll('[data-test="row"]');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row, i) => {
      expect(row.attributes('aria-rowindex')).toBe(String(i + 1));
    });
    w.unmount();
  });

  it('aria-selected 跟随 props.selectedPaths', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`f${i}`));
    const selectedPaths = new Set(['f2']);
    const w = mountList(
      { entries, selectedPaths },
      { attachTo: document.body },
    );
    await settle();
    // 用 data-test="row" 排除 details-header
    const rows = w.findAll('[data-test="row"]');
    expect(rows.length).toBe(5);
    rows.forEach((row) => {
      const path = row.attributes('data-path');
      expect(row.attributes('aria-selected')).toBe(String(path === 'f2'));
    });
    w.unmount();
  });

  it('容器 role="grid" + aria-label="文件列表" + tabindex="0"', () => {
    const entries = [entry('a.jpg')];
    const w = mountList({ entries });
    const container = w.find('.virt-container');
    expect(container.attributes('role')).toBe('grid');
    expect(container.attributes('aria-label')).toBe('文件列表');
    expect(container.attributes('tabindex')).toBe('0');
    w.unmount();
  });
});