/**
 * EntryDetailPanel.test.ts — 详情面板派生
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import EntryDetailPanel from './EntryDetailPanel.vue';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import { useFileBrowserStore } from '@/stores/fileBrowser';

// M3 任务 8：选中远程 archive 条目 → metadata stat 预热（mock IPC）
const notifySpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/tauri', () => ({
  notifyArchiveWindow: vi.fn((...args: unknown[]) => notifySpy(...args)),
}));

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
    size: 1024,
    modifiedAt: 1700000000,
    ...opts,
  };
}

describe('EntryDetailPanel.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    notifySpy.mockClear();
  });
  it('entry=null 显示 noFileSelected', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: null, rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    expect(w.find('[data-test="entry-detail-empty"]').exists()).toBe(true);
    expect(w.find('[data-test="entry-detail-panel"]').exists()).toBe(false);
  });

  it('文件类型: 派生 extension + mime', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('photo.jpg'), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    const html = w.find('[data-test="entry-detail-panel"]').html();
    expect(html).toContain('photo.jpg');
    expect(html).toContain('image/jpeg');
    expect(html).toContain('jpg');
    expect(html).toContain('C:/x/photo.jpg');
  });

  it('文件夹: size 显示 —, type = 文件夹 (i18n)', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('subdir', { isDirectory: true, size: 0 }), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    const html = w.html();
    expect(html).toContain('文件夹');
    expect(html).toContain('—'); // size 为 '—'
  });

  it('压缩包: type = 压缩包 (i18n)', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('comic.cbz', { isArchive: true }), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    const html = w.html();
    expect(html).toContain('压缩包');
  });

  it('目录不显示扩展名 (避免误识别名字里的 \'.\')', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('VOL.11 5 NIKKE', { isDirectory: true }), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    const html = w.html();
    // 目录的 extension 字段必须显示 '—', 不是 '11 5 nikke'
    const m = html.match(/<dd[^>]*>([^<]+)<\/dd>/g);
    expect(m).toBeTruthy();
    expect(m!.some((s) => s.includes('—'))).toBe(true);
  });

  it('无扩展名文件: extension 显示 —', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('README'), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    const html = w.html();
    expect(html).toContain('—'); // extension + mime 都是 —
  });

  it('modified 缺失显示 —', () => {
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('no-mtime.txt', { modifiedAt: undefined }), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    const html = w.html();
    expect(html).toContain('—'); // extension + mime 都是 —
  });

  // ─── M3 任务 8：选中 archive 条目 → metadata stat 预热 ───────────────
  const webdav: SourceDescriptor = { type: 'webdav', accountId: 1, baseUrl: 'https://d/x', path: '' };

  it('远程源选中 archive 条目触发 metadata 预热（rel = lastFetchedPath/name）', async () => {
    const fb = useFileBrowserStore();
    fb.currentDescriptor = webdav;
    fb.lastFetchedPath = 'sub';
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('x.jpg'), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    // watch 非 immediate——挂载时不触发；选中变化（jpg → cbz）触发
    expect(notifySpy).not.toHaveBeenCalled();
    await w.setProps({ entry: entry('comic.cbz', { isArchive: true }) });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, ['sub/comic.cbz'], 'metadata');
  });

  it('Local 源选中 archive 条目不触发（物化器仅支持 webdav/smb origin）', async () => {
    const fb = useFileBrowserStore();
    fb.currentDescriptor = null;
    fb.rootPath = 'D:/x';
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('x.jpg'), rootPath: 'D:/x' },
      global: { plugins: [i18n] },
    });
    await w.setProps({ entry: entry('comic.cbz', { isArchive: true }) });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('选中非 archive 条目不触发 metadata 预热', async () => {
    const fb = useFileBrowserStore();
    fb.currentDescriptor = webdav;
    fb.lastFetchedPath = '';
    const w = mount(EntryDetailPanel, {
      props: { entry: entry('x.jpg'), rootPath: 'C:/x' },
      global: { plugins: [i18n] },
    });
    await w.setProps({ entry: entry('y.png') });
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
