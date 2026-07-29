/**
 * FileList.vue 测试
 * 展示目录项列表（目录/图片/压缩包分组），按名称排序（已有 lib/naturalSort）
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
    const w = mount(FileList, {
      props: { entries: [], sortField: 'name', sortAscending: true },
    });
    expect(w.find('[data-test="empty"]').exists()).toBe(true);
  });

  it('renders one row per entry with name', () => {
    const entries = [entry('page1.jpg'), entry('page2.jpg'), entry('page10.jpg')];
    const w = mount(FileList, {
      props: { entries, sortField: 'name', sortAscending: true },
    });
    const rows = w.findAll('[data-test="row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toContain('page1.jpg');
    expect(rows[1].text()).toContain('page2.jpg');
    expect(rows[2].text()).toContain('page10.jpg');
  });

  it('marks directory rows with directory icon class', () => {
    const entries = [
      entry('subdir', { isDirectory: true }),
      entry('image.jpg', { isDirectory: false }),
    ];
    const w = mount(FileList, {
      props: { entries, sortField: 'name', sortAscending: true },
    });
    const rows = w.findAll('[data-test="row"]');
    // 自然排序 image.jpg < subdir → image 在前 (rows[0]), subdir 在后 (rows[1])
    expect(rows[0].classes()).not.toContain('is-directory');
    expect(rows[1].classes()).toContain('is-directory');
  });

  it('marks archive rows with archive class', () => {
    const entries = [
      entry('comic.cbz', { isArchive: true }),
      entry('image.jpg'),
    ];
    const w = mount(FileList, {
      props: { entries, sortField: 'name', sortAscending: true },
    });
    const rows = w.findAll('[data-test="row"]');
    expect(rows[0].classes()).toContain('is-archive');
  });

  it('emits open with the MediaEntry when a row is clicked', async () => {
    const items = [entry('a.jpg'), entry('b.jpg')];
    const w = mount(FileList, {
      props: { entries: items, sortField: 'name', sortAscending: true },
    });
    await w.findAll('[data-test="row"]')[1].trigger('click');
    expect(w.emitted('open')).toBeTruthy();
    expect(w.emitted('open')![0]).toEqual([items[1]]);
  });

  it('sorts descending when sortAscending is false', async () => {
    const entries = [entry('page1.jpg'), entry('page2.jpg'), entry('page10.jpg')];
    const w = mount(FileList, {
      props: { entries, sortField: 'name', sortAscending: false },
    });
    const rows = w.findAll('[data-test="row"]');
    // 自然升序 [page1, page2, page10] → 反转 = [page10, page2, page1]
    expect(rows[0].text()).toContain('page10.jpg');
    expect(rows[1].text()).toContain('page2.jpg');
    expect(rows[2].text()).toContain('page1.jpg');
  });
});
