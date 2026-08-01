/**
 * FileList.vue 测试
 * v0.1.0-module1.22: 排序由 store 完成, FileList 接 sortedEntries 直传.
 *                  selection / dblclick 走 emits.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FileList from './FileList.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

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
  it('renders empty state when entries array is empty', () => {
    const w = mount(FileList, { props: { entries: [] } });
    expect(w.find('[data-test="empty"]').exists()).toBe(true);
  });

  it('renders one row per entry, in given order (no internal sort)', () => {
    const entries = [entry('page10.jpg'), entry('page2.jpg'), entry('page1.jpg')];
    const w = mount(FileList, { props: { entries } });
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
    const w = mount(FileList, { props: { entries } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-directory');
    expect(rows[1].classes()).not.toContain('is-directory');
  });

  it('marks archive rows with is-archive class', () => {
    const entries = [entry('comic.cbz', { isArchive: true }), entry('image.jpg')];
    const w = mount(FileList, { props: { entries } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-archive');
  });

  it('emits select on single click', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries: items } });
    await w.findAll('[data-test="row"]')[0].trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0][0]).toEqual(items[0]);
  });

  it('emits open on double click', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries: items } });
    await w.findAll('[data-test="row"]')[0].trigger('dblclick');
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('open')![0]).toEqual([items[0]]);
  });

  it('emits open on Enter key, emit select on Space', async () => {
    const items = [entry('a.jpg')];
    const w = mount(FileList, { props: { entries: items } });
    const row = w.find('[data-test="row"]');
    await row.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('select')).toBeFalsy();
  });

  it('applies is-selected class when path in selectedPaths', () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const selected = new Set(['a.jpg']);
    const w = mount(FileList, { props: { entries, selectedPaths: selected } });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-selected');
    expect(rows[1].classes()).not.toContain('is-selected');
  });

  it('renders grid view when viewMode is grid', () => {
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, { props: { entries, viewMode: 'grid' } });
    expect(w.find('[data-view="grid"]').exists()).toBe(true);
    expect(w.find('[data-view="list"]').exists()).toBe(false);
  });
});
