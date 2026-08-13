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
  /** 任务 10: mock getProgress 返回 finished=true（用于 A7 幂等跳过 + A10 缓存单调） */
  initialFinished: boolean;
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

  // 任务 10: initialFinished mock — 给 A7 幂等跳过 + A10 缓存单调测试提供 DB 已 finished 的语境
  if (overrides.initialFinished) {
    vi.mocked(getProgress).mockResolvedValue({
      bookId: 1,
      page: 0,
      imageName: 'a.jpg',
      readerMode: 'single',
      updatedAt: 0,
      finished: true,
    });
  }

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

/** 任务 10: STABLE_MS 必须与 composable 同步（composable:STABLE_MS） */
const STABLE_MS = 1200;

function img(n: string): MediaEntry {
  return { name: n, path: n, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
}
function dir(n: string): MediaEntry {
  return { name: n, path: n, isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * flushPromises: 排空 microtask 队列直到稳定 (chained await 全跑完).
 * queueMicrotask 不受 fake timers 影响, 适合 fake-timer 测试场景.
 */
const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    await new Promise<void>((r) => queueMicrotask(() => r()));
  }
};

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

  // ── 任务 10: finished 核心状态机(spec §2.3 + §2.7 + §2.8) ──

  it('A-T1: 滚到底停留<STABLE_MS: 写 finished=undefined, 不升级', async () => {
    // fake timers 推进 stableTimer(任务 10 验证 finishedNow 计算)
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false); // 初始 false, 手动翻 true 触发 atBottom watch
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50, // baseline 落在 a.jpg 内
      atBottom: atBottomRef,
    });
    await start();
    // 翻 true → atBottom watch 异步触发 scheduleRecord → 300ms debounce
    atBottomRef.value = true;
    // Vue watch 异步 — 先 flushPromises 触发 watch → scheduleRecord 设 debouncer
    await flushPromises();
    // 推进 300ms debounce → recordCurrentTop 首次写普通进度
    // 关键: 此处不要推进 STABLE_MS, 保持停留 < STABLE_MS, 否则会触发升级
    vi.advanceTimersByTime(301);
    await flushPromises();
    // 第 1 次 recordCurrentTop: finished=undefined
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect((saveProgress as Mock).mock.calls[0]?.[3]).toBeUndefined();
    stop();
  }, 15000);

  it('A-T2: 滚到底停留>=STABLE_MS: 第 2 次写 finished=true(同图升级, A9 复合去重放行)', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // 推进 300ms debounce → 第 1 次 recordCurrentTop
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect((saveProgress as Mock).mock.calls[0]?.[3]).toBeUndefined();
    // 推进 STABLE_MS+1 → stableTimer 触发第 2 次 recordCurrentTop
    vi.advanceTimersByTime(STABLE_MS + 1);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect((saveProgress as Mock).mock.calls[1]?.[3]).toBe(true); // 升级
    stop();
  }, 15000);

  it('A-T3: 已 finished 再滚到底: 不重复 saveProgress(A7 幂等)', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
      initialFinished: true, // ← 关键: setup mock getProgress 返回 finished=true
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    vi.advanceTimersByTime(301);
    await flushPromises();
    // initialFinished=true → 入口 A7 跳过(lastBrowseProgress.finished===true), saveProgress 不调
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  }, 15000);

  // A-T4: 滚到底 → 离开 → 写 undefined(不降级), clearStableTimer 取消在途 timer
  it('A-T4: 滚到底后离开: clearStableTimer 取消在途 timer, finished 传 undefined(不降级)', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // 推进 300ms → 第 1 次 recordCurrentTop (finished=undefined) + scheduleStableTimer
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect((saveProgress as Mock).mock.calls[0]?.[3]).toBeUndefined();
    // 离开底部 → clearStableTimer 清 timer + bottomSince
    atBottomRef.value = false;
    await flushPromises();
    // 推进 STABLE_MS+1 → 假设 timer 残留会触发第 2 次写; 实际已被清 → 不会触发
    vi.advanceTimersByTime(STABLE_MS + 1);
    await flushPromises();
    // 仍 1 次(timer 已被 clear), 验证没残留
    expect(saveProgress).toHaveBeenCalledTimes(1);
    stop();
  }, 15000);

  // A-T5: 滚到底 → 调度 stableTimer → 中途离开 → 再回来: 重新计 STABLE_MS
  it('A-T5: 滚到底中途离开再回来: 重新计 STABLE_MS, 不立刻升级', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    // 第 1 次到底
    atBottomRef.value = true;
    await flushPromises();
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // 中途离开
    atBottomRef.value = false;
    await flushPromises();
    // 再回来 — 重新记 bottomSince + 重新调度 stableTimer
    atBottomRef.value = true;
    await flushPromises();
    // 推进到第二次 recordCurrentTop 触发(300ms debounce) + STABLE_MS+1(stableTimer 触发升级)
    vi.advanceTimersByTime(300 + STABLE_MS + 1);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect((saveProgress as Mock).mock.calls[1]?.[3]).toBe(true);
    stop();
  }, 15000);

  // A-T14: 瞬时失败重试 — saveProgress catch 调 scheduleRetryIfStillAtBottom
  it('A-T14: saveProgress 瞬时失败 → scheduleRetryIfStillAtBottom 重排, 最终成功', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    // 第一次 saveProgress 抛错, 第二次 resolve
    vi.mocked(saveProgress)
      .mockRejectedValueOnce(new Error('IPC transient'))
      .mockResolvedValue(undefined);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // 第 1 次 recordCurrentTop → saveProgress 抛错 → scheduleRetryIfStillAtBottom
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // 推进 STABLE_MS+1 → stableTimer 触发重试 → saveProgress 成功
    vi.advanceTimersByTime(STABLE_MS + 1);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    // 第 2 次为 stableTimer 触发(已过 STABLE_MS), finishedNow=true → finished=true
    expect((saveProgress as Mock).mock.calls[1]?.[3]).toBe(true);
    stop();
  }, 15000);

  // A-T16: 持久失败不重试 — bookId==null 直接 return, 不调 scheduleRetryIfStillAtBottom
  it('A-T16: bookId==null 持久失败 → 不重试, 不调 scheduleRetryIfStillAtBottom', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    // 强制 createBook 失败 → ensureBookId 返 null → bookId==null → 不调 scheduleRetry
    vi.mocked(createBook).mockResolvedValue(null as unknown as number);
    const { start, stop } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // 第 1 次 → createBook 返 0 → bookId==null → 不调 scheduleRetry → saveProgress 不调
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).not.toHaveBeenCalled();
    // 推进 STABLE_MS+1 → 假设重试; 实际不重试 → 仍 0 次
    vi.advanceTimersByTime(STABLE_MS + 1);
    await flushPromises();
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  }, 15000);

  // A-T20: 最新请求成功写入 — 阶段 2 必须提交本地状态
  it('A-T20: 最新请求成功写入: lastBrowseProgress.finished 提交, lastWritten* 更新', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop, lastBrowseProgress } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // 推进 300ms debounce → 第 1 次 recordCurrentTop (finished=undefined)
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // 推进 STABLE_MS+1 → 第 2 次 recordCurrentTop (finished=true)
    vi.advanceTimersByTime(STABLE_MS + 1);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    // 阶段 2 提交: lastBrowseProgress.finished === true
    expect(lastBrowseProgress.value?.finished).toBe(true);
    expect(lastBrowseProgress.value?.imageName).toBe('a.jpg');
    stop();
  }, 15000);

  // A-T21: 陈旧请求成功不污染 UI — 阶段 2 区分 DB 成功 vs UI 缓存
  it('A-T21: 陈旧请求成功不污染 UI: A(finished=true)写入在途, 用户滚到 B, A 晚返回 → A 的 DB 成功, B 的 UI 缓存保留', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
      ['b.jpg', { top: 100, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    // 让 saveProgress resolve 比 scheduleRecord 慢(A 写入在途时 B 触发 scheduleRecord → ++writeSeq)
    let resolveSaveA!: () => void;
    const slowPromise = new Promise<void>((r) => { resolveSaveA = r; });
    vi.mocked(saveProgress)
      .mockImplementationOnce(async () => await slowPromise)  // A 慢
      .mockResolvedValue(undefined);                          // B 正常
    const { start, stop, lastBrowseProgress, scrollTop } = await setup({
      renderEntries: [img('a.jpg'), img('b.jpg')],
      canonicalImageNames: ['a.jpg', 'b.jpg'],
      layoutMap,
      scrollTopValue: 50, // baseline 落在 a.jpg
      atBottom: atBottomRef,
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // 第 1 次 recordCurrentTop 触发 saveProgress 慢(Lets A 在途)
    vi.advanceTimersByTime(301);
    await flushPromises();
    // 此时 saveProgress 仍未完成 (slowPromise 未 resolve)
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // 现在 A 写还在途时, 用户滚到 B → scrollTop 变化 → scheduleRecord → ++writeSeq → B 触发
    scrollTop.value = 150; // baseline 落在 b.jpg
    await flushPromises();
    // 推进 debounce → B 触发
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    // 现在 resolve A 的 slowPromise (陈旧成功)
    resolveSaveA();
    await flushPromises();
    // A 的 DB 写入已完成 (陈旧), 但 lastBrowseProgress 仍指向 B (新请求胜)
    expect(lastBrowseProgress.value?.imageName).toBe('b.jpg');
    // 用户滚回 A → A9 慢路径去重命中 (successfulWrites 已记 A 的 identity) → 不重写
    scrollTop.value = 50;
    await flushPromises();
    vi.advanceTimersByTime(301);
    await flushPromises();
    // 仍是 2 次 (A 不重写)
    expect(saveProgress).toHaveBeenCalledTimes(2);
    stop();
  }, 15000);

  // A-T9: enabled=false 入口守卫 — flushNow 也不写(审查 P1-2)
  it('A-T9: enabled=false 时 flushNow 也不写(recordCurrentTop 入口守卫, 跨卷前 flush 安全)', async () => {
    vi.useFakeTimers();
    const layoutMap = new Map([
      ['a.jpg', { top: 0, height: 100 }],
    ]);
    const atBottomRef = ref(false);
    const { start, stop, flushNow } = await setup({
      renderEntries: [img('a.jpg')],
      canonicalImageNames: ['a.jpg'],
      layoutMap,
      scrollTopValue: 50,
      atBottom: atBottomRef,
      enabled: false,  // 关键: 关闭 recordBrowsePosition
    });
    await start();
    atBottomRef.value = true;
    await flushPromises();
    // flushNow 绕过 debounce 直接调 recordCurrentTop(enabled=false 入口守卫应拦)
    await flushNow();
    await flushPromises();
    expect(saveProgress).not.toHaveBeenCalled();
    stop();
  }, 15000);
});