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

interface TestProps {
  entries: MediaEntry[];
  loading?: boolean;
  marks?: ReadStatusMap;
  selectedPaths?: Set<string>;
  viewMode?: 'list' | 'grid' | 'details';
}

function mountList(
  props: Partial<TestProps> = {},
  opts: Record<string, unknown> = {},
) {
  return mount(FileList, {
    props: { entries: [], ...props } as TestProps,
    global: { plugins: [createPinia(), i18n] },
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
      { entries, viewMode: 'list' },
      { attachTo: document.body },
    );
    await settle();
    const rowCount = w.findAll('[data-test="row"]').length;
    expect(rowCount).toBeLessThan(100);
    w.unmount();
  });

  it('.virt-content height = entries.length × rowHeight', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries, viewMode: 'list' });
    const content = w.find('.virt-content');
    expect(content.attributes('style')).toContain('29000px');
  });

  it('aria-rowcount 同步 entries.length', () => {
    const entries = Array.from({ length: 14949 }, (_, i) => entry(`f${i}`));
    const w = mountList({ entries, viewMode: 'list' });
    expect(w.find('.virt-container').attributes('aria-rowcount')).toBe('14949');
  });

  it('search 14949 → 3: scrollTop clamp', async () => {
    const big = Array.from({ length: 14949 }, (_, i) => entry(`f${i}`));
    const small = Array.from({ length: 3 }, (_, i) => entry(`match${i}`));
    const w = mountList(
      { entries: big, viewMode: 'list' },
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

  it('viewMode 切换: DOM row 元素复用 (CSS 显隐)', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(`f${i}`));
    const w = mountList(
      { entries, viewMode: 'list' },
      { attachTo: document.body },
    );
    await settle();
    const beforeRow = w.findAll('[data-test="row"]')[0]?.element;
    await w.setProps({ viewMode: 'grid' });
    await nextTick();
    const afterRow = w.findAll('[data-test="row"]')[0]?.element;
    // 同一 element 复用 (DOM 重建 = 不同 element)
    expect(afterRow).toBe(beforeRow);
    w.unmount();
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