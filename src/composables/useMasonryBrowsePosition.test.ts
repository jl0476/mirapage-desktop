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
 * - enabled=false → restoreAndScroll 仍查（getProgress 调, lastBrowseProgress 有值），
 *   但 recordCurrentTop 不写（saveProgress 不调，按钮可 enable）
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
    recordHistory: vi.fn(async () => undefined),
  };
});

// 在 mock 建立后 import mock 引用
import { saveProgress, getProgress, listDirectory, createBook, recordHistory } from '@/lib/tauri';

// 测 helper：构造 composable 调用
async function setup(overrides: Partial<{
  enabled: boolean;
  autoRestoreOnMount: boolean;
  scrollTopValue: number;
  colWidthValue: number;
  renderEntries: MediaEntry[];
  layoutMap: Map<string, { top: number; height: number }>;
  canonicalImageNames: string[];
  /** 任务 8: atBottom 注入 ref（不传则默认 ref(false)，所有现有用例自动兼容） */
  atBottom: import('vue').Ref<boolean>;
}> = {}) {
  const descriptor = ref({ type: 'local' as const, rootPath: '/root' });
  const currentPath = ref('vol02');
  const renderEntries = ref<MediaEntry[]>(overrides.renderEntries ?? []);
  const canonicalImageNames = computed(() => overrides.canonicalImageNames ?? []);
  const scrollTop = ref(overrides.scrollTopValue ?? 0);
  const colWidth = ref(overrides.colWidthValue ?? 280);
  const layoutMap = computed(() => overrides.layoutMap ?? new Map());
  const scrollToEntry = vi.fn(async () => true);
  const atBottom = overrides.atBottom ?? ref(false);

  const composable = useMasonryBrowsePosition({
    descriptor,
    currentPath,
    renderEntries,
    canonicalImageNames,
    layoutMap,
    scrollTop,
    colWidth,
    scrollToEntry,
    atBottom,
    enabled: computed(() => overrides.enabled ?? true),
    autoRestoreOnMount: computed(() => overrides.autoRestoreOnMount ?? true),
  });
  return { ...composable, scrollTop, colWidth, currentPath, renderEntries, descriptor, scrollToEntry, atBottom };
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
    // v0.1.0-...: recordHistory 写在 start() 入口, 不在 recordCurrentTop 滚动路径
    // (滚动太频繁, 反复更新 last_visited_at 不妥). 滚动期间 recordHistory 只被调 1 次 (start 时).
    expect(recordHistory).toHaveBeenCalledTimes(1);
    stop();
  });

  it('进入瀑布流时写一次 history (start → recordHistory), 滚动不写', async () => {
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
    // start 前: recordHistory 未调
    expect(recordHistory).not.toHaveBeenCalled();
    await start();
    // start 后: 写 1 次 history
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(
      { type: 'local', rootPath: '/root' },
      'vol02',
      'vol02',
      1,
    );
    // 滚动
    scrollTop.value = 60;
    await wait(350);
    // 滚动后: recordHistory 仍是 1 次 (没增加)
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalled();
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
      finished: false,
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

  it('enabled=false → restoreAndScroll 仍查（getProgress 调, lastBrowseProgress 有值），但 recordCurrentTop 不写', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 1,
      page: 0,
      imageName: 'a.jpg',
      readerMode: 'single',
      updatedAt: 0,
      finished: false,
    });
    const { start, stop, scrollTop, lastBrowseProgress } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      enabled: false,
      scrollTopValue: 50,
    });
    await start();
    // enabled=false → restoreAndScroll 不在入口守，getProgress 仍调，lastBrowseProgress 设上（按钮 enable）
    expect(getProgress).toHaveBeenCalled();
    expect(lastBrowseProgress.value?.imageName).toBe('a.jpg');
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

  it('resize 后 500ms 内滚动不写 progress（窗口尺寸变化不污染阅读进度）', async () => {
    // 模拟 a.jpg/b.jpg 都在 viewport 内，scrollTop=300 baseline 在 a.jpg (top=0,h=400)
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 400 }],
      ['b.jpg', { top: 400, height: 400 }],
    ]);
    const { start, stop, scrollTop, colWidth } = await setup({
      renderEntries: [img('a.jpg'), img('b.jpg')],
      canonicalImageNames: ['a.jpg', 'b.jpg'],
      layoutMap,
      scrollTopValue: 300,
      colWidthValue: 280,
    });
    await start();
    // resize：colWidth 变化 → resize watcher fire → lastResizeAt = now, 杀 debounce
    colWidth.value = 250;
    // 立即触发 scroll 漂移（layout 重排后 scrollTop 跳）
    scrollTop.value = 613;
    // 等 cooldown 完整 (500ms) + debounce (300ms) 都过期
    await wait(900);
    // 整个 cooldown + debounce 窗口内 scheduleRecord 都被丢弃
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  });

  it('flushNow 立即写入顶部图不等 debounce（跨卷前 flush 用）', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
      ['b.jpg', { top: 100, height: 100 }],
    ]);
    const { start, stop, scrollTop, flushNow } = await setup({
      renderEntries: [img('a.jpg'), img('b.jpg')],
      canonicalImageNames: ['a.jpg', 'b.jpg'],
      layoutMap,
      scrollTopValue: 50, // baseline 落在 a.jpg 内
    });
    await start();
    // 触发滚动 — watcher fire → scheduleRecord → debounce 300ms 计时中
    scrollTop.value = 51;
    // 100ms 后还没到 300ms debounce → saveProgress 不应被调
    await wait(100);
    expect(saveProgress).not.toHaveBeenCalled();
    // flushNow 应立即清 debounce + recordCurrentTop,不需等剩余 200ms
    await flushNow();
    expect(saveProgress).toHaveBeenCalled();
    const calls = (saveProgress as Mock).mock.calls;
    expect(calls[0]?.[1]).toBe(0); // pageAtEntry
    expect(calls[0]?.[4]).toBe('a.jpg'); // imageName
    stop();
  });

  it('flushNow 重复调: 同图去重,不重复写', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const { start, stop, scrollTop, flushNow } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
    });
    await start();
    scrollTop.value = 51;
    // 让 scroll watcher 触发 scheduleRecord 把 activeWriteSeq 推到 1 + 设 debounce.
    // 现实场景: 用户滚一下 → 过一会儿点"下一卷"按钮 → flushNow. 直接 sync 调会让
    // watcher microtask 在 recordCurrentTop 内 await 期间 fire,把 writeSeqAtEntry=0
    // 跟 activeWriteSeq=1 对不齐, writeSeq guard 误判.
    await wait(50);
    // 第一次 flushNow: 清 debounce + 写 a.jpg
    await flushNow();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // 第二次 flushNow（同一图,lastWrittenPath 已设）→ recordCurrentTop 入口同图去重,不写
    await flushNow();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    stop();
  });

  it('flushNow 无顶部图时: 清 debounce,不写 progress（空目录 / 测量未到）', async () => {
    // renderEntries 空 → topmostImage=null → recordCurrentTop 直接 return
    const { start, stop, scrollTop, flushNow } = await setup({
      renderEntries: [], // 空
      canonicalImageNames: [],
      layoutMap: new Map(),
      scrollTopValue: 0,
    });
    await start();
    scrollTop.value = 10; // scheduleRecord → debounce
    await wait(50);
    await flushNow();
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  });

  it('resize 冷却期结束后滚动才写 progress', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 400 }],
      ['b.jpg', { top: 400, height: 400 }],
    ]);
    const { start, stop, scrollTop, colWidth } = await setup({
      renderEntries: [img('a.jpg'), img('b.jpg')],
      canonicalImageNames: ['a.jpg', 'b.jpg'],
      layoutMap,
      scrollTopValue: 300,
      colWidthValue: 280,
    });
    await start();
    // resize：触发 cooldown
    colWidth.value = 250;
    // 等 cooldown 完整过期 (500ms + 余量)
    await wait(550);
    // 现在 scroll → scheduleRecord 正常工作 → debounce 300ms 后写
    scrollTop.value = 500; // baseline 在 b.jpg (top=400, h=400)
    await wait(100);
    // 100ms < debounce 300ms → 还没写
    expect(saveProgress).not.toHaveBeenCalled();
    await wait(350);
    expect(saveProgress).toHaveBeenCalled();
    const calls = (saveProgress as Mock).mock.calls;
    expect(calls[0]?.[4]).toBe('b.jpg'); // imageName 是新的顶部图
    expect(calls[0]?.[1]).toBe(1); // page = indexOf('b.jpg') = 1
    stop();
  });

  // ── 任务 8 合并(原任务 8/9): atBottom 管线 + stableTimer 骨架 ──

  it('atBottom false→true 触发 scheduleRecord(布局变化入口, 审查 P1)', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50, // baseline 落在 a.jpg 内, 顶部图 = a.jpg
      atBottom: atBottomRef,
    });
    await start();
    expect(saveProgress).not.toHaveBeenCalled();
    // scrollTop 不变, 仅 atBottom 翻 true(模拟布局收敛后贴底)
    atBottomRef.value = true;
    // 内部 watch(atBottom) 触发 scheduleRecord → debounce 300ms
    await wait(100);
    expect(saveProgress).not.toHaveBeenCalled();
    await wait(350);
    expect(saveProgress).toHaveBeenCalled();
    stop();
  });

  it('atBottom true→false 调 clearStableTimer(不残留), 后续翻 true 重启路径', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(true);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    // 离开底部, 调 clearStableTimer(任务 9 实现的清 timer + bottomSince 骨架)
    atBottomRef.value = false;
    await wait(50);
    // 没崩 + 没残留 timer
    expect(saveProgress).not.toHaveBeenCalled();
    // 再次翻 true → 重启 scheduleRecord 路径
    atBottomRef.value = true;
    await wait(350);
    expect(saveProgress).toHaveBeenCalled();
    stop();
  });

  it('enabled=false: flushNow 也不写(flushNow 走 recordCurrentTop 入口, 审查 P1-2)', async () => {
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const { start, stop, flushNow } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      enabled: false,
    });
    await start();
    // enabled=false → recordCurrentTop 入口守卫, flushNow 也走同一入口 → 不写
    await flushNow();
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  });
});