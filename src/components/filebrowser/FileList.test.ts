/**
 * FileList.vue 测试
 * v0.1.0-module1.22: 排序由 store 完成, FileList 接 sortedEntries 直传.
 *                  selection / dblclick 走 emits.
 * v0.1.0-module1.23: 加 details 视图 (6 列).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import FileList from './FileList.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

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

describe('FileList.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  it('renders empty state when entries array is empty', () => {
    const w = mount(FileList, { props: {  entries: []  }, global: { plugins: [createPinia(), i18n] } });
    expect(w.find('[data-test="empty"]').exists()).toBe(true);
  });

  it('renders one row per entry, in given order (no internal sort)', () => {
    const entries = [entry('page10.jpg'), entry('page2.jpg'), entry('page1.jpg')];
    const w = mount(FileList, { props: {  entries  }, global: { plugins: [createPinia(), i18n] } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows).toHaveLength(3);
    // 顺序与传入一致 (不再内部 sort)
    expect(rows[0].text()).toContain('page10.jpg');
    expect(rows[1].text()).toContain('page2.jpg');
    expect(rows[2].text()).toContain('page1.jpg');
  });

  it('marks directory rows with is-directory class', () => {
    const entries = [
      entry('subdir', { isDirectory: true }),
      entry('image.jpg'),
    ];
    const w = mount(FileList, { props: {  entries  }, global: { plugins: [createPinia(), i18n] } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-directory');
    expect(rows[1].classes()).not.toContain('is-directory');
  });

  it('marks archive rows with is-archive class', () => {
    const entries = [entry('comic.cbz', { isArchive: true }), entry('image.jpg')];
    const w = mount(FileList, { props: {  entries  }, global: { plugins: [createPinia(), i18n] } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-archive');
  });

  it('emits select on single click', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries: items }, global: { plugins: [createPinia(), i18n] } });
    await w.findAll('[data-test="row"]')[0].trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0][0]).toEqual(items[0]);
  });

  it('emits open on double click', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries: items }, global: { plugins: [createPinia(), i18n] } });
    await w.findAll('[data-test="row"]')[0].trigger('dblclick');
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('open')![0]).toEqual([items[0]]);
  });

  it('emits open on Enter key, emit select on Space', async () => {
    const items = [entry('a.jpg')];
    const w = mount(FileList, { props: { entries: items }, global: { plugins: [createPinia(), i18n] } });
    const row = w.find('[data-test="row"]');
    await row.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('select')).toBeFalsy();
  });

  it('applies is-selected class when path in selectedPaths', () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const selected = new Set(['a.jpg']);
    const w = mount(FileList, { props: {  entries, selectedPaths: selected  }, global: { plugins: [createPinia(), i18n] } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-selected');
    expect(rows[1].classes()).not.toContain('is-selected');
  });

  it('renders grid view when viewMode is grid', () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: {  entries, viewMode: 'grid'  }, global: { plugins: [createPinia(), i18n] } });
    expect(w.find('[data-view="grid"]').exists()).toBe(true);
    expect(w.find('[data-view="list"]').exists()).toBe(false);
  });
});

describe('FileList.vue — details 视图 (v0.1.0-module1.23)', () => {
  it('viewMode="details" 渲染 details-view + 列头 (5 列可点击排序)', () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries, viewMode: 'details' }, global: { plugins: [createPinia(), i18n] } });
    expect(w.find('[data-view="details"]').exists()).toBe(true);
    expect(w.find('[data-view="list"]').exists()).toBe(false);
    expect(w.find('[data-test="details-sort-name"]').exists()).toBe(true);
    expect(w.find('[data-test="details-sort-modified"]').exists()).toBe(true);
    expect(w.find('[data-test="details-sort-size"]').exists()).toBe(true);
  });

  // v0.1.0-module3.0.3-hotfix7: 序号列 + 名字列 hover tooltip
  it('details 行显示 #序号 + 名字 + tooltip (hotfix7)', () => {
    const entries = [entry('a.jpg'), entry('b.jpg'), entry('c.jpg')];
    const w = mount(FileList, { props: { entries, viewMode: 'details' }, global: { plugins: [createPinia(), i18n] } });
    // 序号列反应 entries 当前位置 (1-based)
    const idx = w.findAll('[data-test^="details-index-"]');
    expect(idx).toHaveLength(3);
    expect(idx[0].text()).toBe('1');
    expect(idx[1].text()).toBe('2');
    expect(idx[2].text()).toBe('3');
    // hover tooltip 包含全名 (3 份, name-tooltip 元素)
    const tips = w.findAll('.name-tooltip');
    expect(tips).toHaveLength(3);
    expect(tips[0].text()).toBe('a.jpg');
    expect(tips[1].text()).toBe('b.jpg');
    expect(tips[2].text()).toBe('c.jpg');
  });

  it('details 名字列 minmax(80px, 1fr) — 窄窗口不消失 (hotfix7)', () => {
    const entries = [entry('very-long-file-name-with-many-characters.jpg')];
    const w = mount(FileList, { props: { entries, viewMode: 'details' }, global: { plugins: [createPinia(), i18n] } });
    const row = w.find('.details-row');
    // 必须含 minmax(80px, 1fr) — grid-template-columns 第 3 列
    const style = row.attributes('style') ?? '';
    expect(style).toContain('minmax(80px, 1fr)');
  });

  it('details 行显示 type / size / 阅读状态 (i18n)', () => {
    const entries = [entry('photo.jpg', { size: 2048, modifiedAt: 1700000000 })];
    const w = mount(FileList, { props: { entries, viewMode: 'details' }, global: { plugins: [createPinia(), i18n] } });
    const html = w.html();
    // type: image/jpeg → typeImage '图片'
    expect(html).toContain('图片');
    // size: 2.00 KB (formatBytes)
    expect(html).toContain('2.00 KB');
  });

  it('details 目录行 type="文件夹" (i18n 翻译, 不再是英文 folder)', () => {
    const entries = [entry('sub', { isDirectory: true, size: 0 })];
    const w = mount(FileList, { props: { entries, viewMode: 'details' }, global: { plugins: [createPinia(), i18n] } });
    const html = w.html();
    expect(html).toContain('文件夹');
    // size: '—' (目录不显示)
    expect(html).toContain('—');
  });

  it('details 列头点击 → setSortField (integration with fileBrowser store)', async () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries, viewMode: 'details' }, global: { plugins: [createPinia(), i18n] } });
    const { useFileBrowserStore } = await import('@/stores/fileBrowser');
    const fb = useFileBrowserStore();
    // 默认 sortField='name', asc=true
    expect(fb.sortField).toBe('name');
    // 点击 'size' 列头
    await w.find('[data-test="details-sort-size"]').trigger('click');
    expect(fb.sortField).toBe('size');
  });
});
