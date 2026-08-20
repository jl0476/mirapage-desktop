/**
 * useArchiveWindowPrefetch.test.ts — M3 任务 8 步骤 5a + 复审修复（epoch 触发面）
 *
 * masonry 像素窗口 → 远程 archive 内容预载（100ms 防抖）：
 *  - 窗口变化触发 notifyArchiveWindow(descriptor, rels, 'content')
 *  - rel 构造与 fileBrowser.openArchive 的 relInside 一致（currentPath + name）
 *  - 远程源空 rels 也调用（空窗口 = 推新 epoch 取消旧批次，后端取消惯用法）
 *  - Local/Archive 源也调用但 rels 恒空（epoch 取消通道保活，不下载）
 *  - dispose 立即发一次 rels=[] 取消（不走防抖）+ 取消 pending 防抖
 *  - 快速连续窗口变化防抖合并（一次调用，携带最新窗口）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { ThumbnailWindows } from './useMasonryLayout';

const notifySpy = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@/lib/tauri', () => ({
  notifyArchiveWindow: vi.fn((...args: unknown[]) => notifySpy(...args)),
}));

// 在 mock 建立后 import
import { useArchiveWindowPrefetch } from './useArchiveWindowPrefetch';

const webdav: SourceDescriptor = { type: 'webdav', accountId: 1, baseUrl: 'https://d/x', path: '' };
const local: SourceDescriptor = { type: 'local', rootPath: 'D:/x' };

function entry(name: string, opts: Partial<MediaEntry> = {}): MediaEntry {
  return { name, path: name, isDirectory: false, isArchive: false, size: 1, ...opts };
}

function win(visible: string[]): ThumbnailWindows {
  return { visible, ahead: [], behind: [], idle: [] };
}

function setup(desc: SourceDescriptor, entries: MediaEntry[], currentPath = '') {
  const windows = ref<ThumbnailWindows>(win([])) as Ref<ThumbnailWindows>;
  const handle = useArchiveWindowPrefetch({
    descriptor: ref(desc),
    currentPath: ref(currentPath),
    entries: ref(entries),
    windows,
  });
  return { handle, windows };
}

describe('useArchiveWindowPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    notifySpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('窗口内 archive 条目触发 content 预载（100ms 防抖后，rel = currentPath/name）', async () => {
    const { handle: h, windows } = setup(webdav, [
      entry('a.cbz', { isArchive: true }),
      entry('b.jpg'),
      entry('c.cbz', { isArchive: true }),
    ], 'sub');
    windows.value = win(['a.cbz']);
    await nextTick(); // watch 默认 pre-flush（microtask 批处理）
    expect(notifySpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, ['sub/a.cbz'], 'content');
    h.dispose();
  });

  it('Local 源仍调用但 rels 恒空（epoch 取消通道保活，不下载）', async () => {
    const { handle: h, windows } = setup(local, [entry('a.cbz', { isArchive: true })]);
    windows.value = win(['a.cbz']);
    await nextTick();
    vi.advanceTimersByTime(100);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenLastCalledWith(local, [], 'content');
    h.dispose();
    // dispose 追加一次即时取消，同样 rels 恒空；此后不再有调用
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(notifySpy).toHaveBeenLastCalledWith(local, [], 'content');
    vi.advanceTimersByTime(200);
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });

  it('切到无 archive 的远程目录（窗口 rels 空）仍触发 rels=[]（推 epoch 取消旧批次）', async () => {
    const { handle: h, windows } = setup(webdav, [entry('a.cbz', { isArchive: true }), entry('b.jpg')]);
    // 先触发一次有 archive 的预载
    windows.value = win(['a.cbz']);
    await nextTick();
    vi.advanceTimersByTime(100);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, ['a.cbz'], 'content');
    // 窗口滚到无 archive 区域（visible/ahead/behind/idle 四组均无 archive）
    notifySpy.mockClear();
    windows.value = { visible: ['b.jpg'], ahead: [], behind: [], idle: [] };
    await nextTick();
    vi.advanceTimersByTime(100);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, [], 'content');
    h.dispose();
  });

  it('快速连续窗口变化合并为一次（防抖），携带最新窗口的 rels', async () => {
    const { handle: h, windows } = setup(webdav, [
      entry('a.cbz', { isArchive: true }),
      entry('z.cbz', { isArchive: true }),
    ]);
    windows.value = win(['a.cbz']);
    await nextTick();
    vi.advanceTimersByTime(50);
    windows.value = win(['a.cbz', 'z.cbz']);
    await nextTick();
    vi.advanceTimersByTime(50); // 第一次的 100ms 到点，但已被重置
    expect(notifySpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); // 第二次起算的 100ms 到点
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, ['a.cbz', 'z.cbz'], 'content');
    h.dispose();
  });

  it('dispose 取消 pending 防抖并立即发一次 rels=[] 取消（不走防抖等待）', async () => {
    const { handle: h, windows } = setup(webdav, [entry('a.cbz', { isArchive: true })]);
    windows.value = win(['a.cbz']);
    await nextTick();
    h.dispose();
    // 不 advance 计时器：取消调用即时发出（无防抖延迟）
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, [], 'content');
    // pending 的预载防抖已被清掉，不再发出第二次调用
    vi.advanceTimersByTime(200);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('dispose 多次调用只发一次取消（幂等）', async () => {
    const { handle: h } = setup(webdav, []);
    h.dispose();
    h.dispose();
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(webdav, [], 'content');
  });

  it('根目录（currentPath 空）rel 即条目名', async () => {
    const { handle: h, windows } = setup(webdav, [entry('a.cbz', { isArchive: true })]);
    windows.value = win(['a.cbz']);
    await nextTick();
    vi.advanceTimersByTime(100);
    expect(notifySpy).toHaveBeenCalledWith(webdav, ['a.cbz'], 'content');
    h.dispose();
  });
});
