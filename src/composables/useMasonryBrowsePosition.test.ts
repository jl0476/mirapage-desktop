/**
 * useMasonryBrowsePosition.test.ts — v0.1.0-module3.0.8
 *
 * 验证瀑布流浏览位置 composable 的关键不变量：
 * - topmostImage 3 级优先级（相交 > 上方 > 下方），过滤文件夹
 * - page = canonicalImageNames.indexOf(imageName)（不受 UI 过滤）
 * - 同图持续可见去重，不重复写 IPC
 * - debounce 300ms 后写入顶部图
 * - stop() 清理 timer + watcher
 * - 文件夹混排 topmostImage 不取文件夹
 * - 异步目录切换：start() 中途切目录，旧结果丢弃
 * - autoRestoreOnMount=false → 不调 scrollToEntry 但 lastBrowseProgress 仍查
 * - enabled=false → restoreAndScroll 完全 noop（getProgress 不调, lastBrowseProgress=null）
 * - startSeq：stop() 抢占后旧 start() 完成后不写
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { computed, ref } from 'vue';
import { useMasonryBrowsePosition } from './useMasonryBrowsePosition';
import type { MediaEntry } from '@/lib/sourceDescriptor';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listDirectory: vi.fn(async () => []),
    createBook: vi.fn(async () => 1),
    getProgress: vi.fn(async () => null),
    saveProgress: vi.fn(async () => undefined),
  };
});

// 在 mock 建立后 import mock 引用
import { saveProgress, getProgress, listDirectory, createBook } from '@/lib/tauri';

// 测 helper：构造 composable 调用
async function setup(overrides: Partial<{
  enabled: boolean;
  autoRestoreOnMount: boolean;
  scrollTopValue: number;
  renderEntries: MediaEntry[];
  layoutMap: Map<string, { top: number; height: number }>;
  canonicalImageNames: string[];
}> = {}) {
  const descriptor = ref({ type: 'local' as const, rootPath: '/root' });
  const currentPath = ref('vol02');
  const renderEntries = ref<MediaEntry[]>(overrides.renderEntries ?? []);
  const canonicalImageNames = computed(() => overrides.canonicalImageNames ?? []);
  const scrollTop = ref(overrides.scrollTopValue ?? 0);
  const layoutMap = computed(() => overrides.layoutMap ?? new Map());
  const scrollToEntry = vi.fn(async () => true);

  const composable = useMasonryBrowsePosition({
    descriptor,
    currentPath,
    renderEntries,
    canonicalImageNames,
    layoutMap,
    scrollTop,
    scrollToEntry,
    enabled: computed(() => overrides.enabled ?? true),
    autoRestoreOnMount: computed(() => overrides.autoRestoreOnMount ?? true),
  });
  return { ...composable, scrollTop, currentPath, renderEntries, descriptor, scrollToEntry };
}

function img(n: string): MediaEntry {
  return { name: n, path: n, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
}
function dir(n: string): MediaEntry {
  return { name: n, path: n, isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('useMasonryBrowsePosition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(createBook).mockResolvedValue(1);
    vi.mocked(getProgress).mockResolvedValue(null);
    vi.mocked(saveProgress).mockResolvedValue(undefined);
  });

  it('debounce 300ms 后写入顶部图', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
      ['b.jpg', { top: 100, height: 100 }],
    ]);
    const { start, stop, scrollTop } = await setup({
      renderEntries: [img('a.jpg'), img('b.jpg')],
      canonicalImageNames: ['a.jpg', 'b.jpg'],
      layoutMap,
      scrollTopValue: 50, // baseline 落在 a.jpg 内 (top=0, bottom=100)
    });
    await start();
    // 触发滚动 — watcher fire → scheduleRecord → 300ms debounce
    scrollTop.value = 51;
    // 100ms 不应写（debounce 中）
    await wait(100);
    expect(saveProgress).not.toHaveBeenCalled();
    // 300ms 后写入
    await wait(350);
    expect(saveProgress).toHaveBeenCalled();
    const calls = (saveProgress as Mock).mock.calls;
    expect(calls[0]?.[1]).toBe(0); // pageAtEntry
    expect(calls[0]?.[4]).toBe('a.jpg'); // imageName
    stop();
  });

  it('同图持续可见去重不重复写', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
      ['b.jpg', { top: 100, height: 100 }],
    ]);
    const { start, stop, scrollTop } = await setup({
      renderEntries: [img('a.jpg'), img('b.jpg')],
      canonicalImageNames: ['a.jpg', 'b.jpg'],
      layoutMap,
      scrollTopValue: 50,
    });
    await start();
    // 第一次写
    scrollTop.value = 51;
    await wait(350);
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // 第二次同位置触发 — lastWrittenPath 一致，不写
    scrollTop.value = 52; // 仍 in a.jpg
    await wait(350);
    expect(saveProgress).toHaveBeenCalledTimes(1); // 仍 1 次
    stop();
  });

  it('stop 清理 timer + watcher', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const { start, stop, scrollTop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
    });
    await start();
    stop();
    // stop 后 scroll 不会触发 scheduleRecord
    scrollTop.value = 60;
    await wait(350);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it('文件夹混排 topmostImage 不取文件夹', async () => {
    const layoutMap = new Map([
      ['vol01', { top: 0, height: 50 }],
      ['page-001.jpg', { top: 50, height: 100 }],
    ]);
    const { start, stop, scrollTop } = await setup({
      renderEntries: [dir('vol01'), img('page-001.jpg')],
      canonicalImageNames: ['page-001.jpg'],
      layoutMap,
      scrollTopValue: 80, // baseline 在 page-001 内
    });
    await start();
    scrollTop.value = 81; // 触发滚动
    await wait(350);
    const calls = (saveProgress as Mock).mock.calls;
    expect(calls[0]?.[4]).toBe('page-001.jpg'); // 第 5 参数 imageName 是图片
    stop();
  });

  it('异步目录切换：start() 中途切目录，旧结果丢弃', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    // 让 listDirectory 慢一点（模拟 RPC 期间切换）
    let resolveList!: (v: MediaEntry[]) => void;
    vi.mocked(listDirectory).mockImplementationOnce(
      () => new Promise<MediaEntry[]>((r) => { resolveList = r; }),
    );
    const { start, stop, currentPath } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
    });
    // 不 await start() — 让它在飞
    const startPromise = start();
    // 让 start 进入 listDirectory
    await wait(10);
    // 切目录
    currentPath.value = 'vol03';
    // 现在 resolve listDirectory（晚返回）
    resolveList([]);
    await startPromise;
    await wait(50);
    // 旧 start() 因目录已变被丢弃，saveProgress 不调
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  });

  it('autoRestoreOnMount=false → start 后不调 scrollToEntry 但 lastBrowseProgress 仍查', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 1,
      page: 0,
      imageName: 'a.jpg',
      readerMode: 'single',
      updatedAt: 0,
    });
    const { start, stop, lastBrowseProgress, scrollToEntry } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      autoRestoreOnMount: false,
    });
    await start();
    expect(getProgress).toHaveBeenCalled();
    expect(lastBrowseProgress.value?.imageName).toBe('a.jpg');
    // autoRestoreOnMount=false → scrollToEntry 不调
    expect(scrollToEntry).not.toHaveBeenCalled();
    stop();
  });

  it('enabled=false → restoreAndScroll 完全 noop（getProgress 不调, lastBrowseProgress 仍 null）', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 1,
      page: 0,
      imageName: 'a.jpg',
      readerMode: 'single',
      updatedAt: 0,
    });
    const { start, stop, scrollTop, lastBrowseProgress } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      enabled: false,
      scrollTopValue: 50,
    });
    await start();
    // enabled=false → restoreAndScroll 直接 return, 不查 DB 不设缓存
    expect(getProgress).not.toHaveBeenCalled();
    expect(lastBrowseProgress.value).toBeNull();
    // 滚动不触发写入（enabled=false 时 watcher 不挂）
    scrollTop.value = 60;
    await wait(350);
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  });

  it('startSeq：stop 抢占后旧 start() 完成后不写', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    // 让 listDirectory 慢一点（让旧 start() 在飞）
    let resolveList!: (v: MediaEntry[]) => void;
    vi.mocked(listDirectory).mockImplementationOnce(
      () => new Promise<MediaEntry[]>((r) => { resolveList = r; }),
    );
    const { start, stop, scrollTop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
    });
    // 旧 start() 在飞：await listDirectory
    const startPromise = start();
    await wait(10);
    // stop() → activeStartSeq+1，旧 start() 完成后校验失败
    stop();
    // 现在 resolve 旧 start 的 listDirectory
    resolveList([]);
    await startPromise;
    await wait(50);
    // 旧 start() 完成时 seq 已变 → saveProgress 不调
    expect(saveProgress).not.toHaveBeenCalled();
    // 之后不再有写入触发（已 stop，watcher 已清）
    scrollTop.value = 80;
    await wait(350);
    expect(saveProgress).not.toHaveBeenCalled();
  });
});