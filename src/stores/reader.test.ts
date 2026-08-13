/**
 * Reader store 测试
 * 状态机:Loading → Ready → (close/error);Ready 内 next/prev/jump/atFirst/Last。
 * 防抖:onPageChanged 500ms 内多次调用合并为 1 次 saveProgress。
 *
 * 设计参考 DESIGN §12.4 + §15.6 进度保存策略。
 *
 * v0.1.0-module1.21: saveProgress 多了一个 finished 入参.
 * v0.1.0-module3.0.8: saveProgress 第 5 参 imageName（瀑布流端共用锚点）.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  saveProgress: vi.fn(async () => undefined),
  markFinished: vi.fn(async () => undefined),
  listProgressFinished: vi.fn(async () => ({})),
}));
vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

import { useReaderStore } from './reader';
import { saveProgress } from '@/lib/tauri';

describe('reader store — initial state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts in idle state with empty fields', () => {
    const r = useReaderStore();
    expect(r.status).toBe('idle');
    expect(r.bookId).toBeNull();
    expect(r.pages).toEqual([]);
    expect(r.spreads).toEqual([]);
    expect(r.currentSpreadIndex).toBe(0);
    expect(r.isAtFirstSpread).toBe(true);
    expect(r.isAtLastSpread).toBe(true);
  });
});

describe('reader store — open', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('transitions to ready with pages + spreads', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
      ],
      initialSpreadIndex: 0,
    });
    expect(r.status).toBe('ready');
    expect(r.bookId).toBe(1);
    expect(r.pages).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(r.spreads.length).toBe(2);
    expect(r.currentSpreadIndex).toBe(0);
    expect(r.isAtFirstSpread).toBe(true);
    expect(r.isAtLastSpread).toBe(false);
  });

  it('treats single spread as both first and last', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 2,
      title: 'one',
      pages: ['only.jpg'],
      spreads: [{ start: 0, end: 1 }],
      initialSpreadIndex: 0,
    });
    expect(r.isAtFirstSpread).toBe(true);
    expect(r.isAtLastSpread).toBe(true);
  });

  it('transitions to error when payload missing required fields', () => {
    const r = useReaderStore();
    // 故意传入非法 payload
    // @ts-expect-error: 测试非法入参
    r.openBook({ bookId: 3 });
    expect(r.status).toBe('error');
    expect(r.errorKind).toBe('Empty');
  });
});

describe('reader store — pagination', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
      ],
      initialSpreadIndex: 0,
    });
  });

  it('nextPage advances by 1 spread', () => {
    const r = useReaderStore();
    r.nextPage();
    expect(r.currentSpreadIndex).toBe(1);
    expect(r.isAtFirstSpread).toBe(false);
    expect(r.isAtLastSpread).toBe(false);
  });

  it('nextPage is no-op at last spread', () => {
    const r = useReaderStore();
    r.jumpToSpread(2);
    expect(r.currentSpreadIndex).toBe(2);
    r.nextPage();
    expect(r.currentSpreadIndex).toBe(2);
    expect(r.isAtLastSpread).toBe(true);
  });

  it('prevPage goes back by 1 spread', () => {
    const r = useReaderStore();
    r.jumpToSpread(2);
    r.prevPage();
    expect(r.currentSpreadIndex).toBe(1);
  });

  it('prevPage is no-op at first spread', () => {
    const r = useReaderStore();
    r.prevPage();
    expect(r.currentSpreadIndex).toBe(0);
    expect(r.isAtFirstSpread).toBe(true);
  });

  it('jumpToSpread sets absolute index and clamps', () => {
    const r = useReaderStore();
    r.jumpToSpread(99); // 超界 → 钳到最后
    expect(r.currentSpreadIndex).toBe(2);

    r.jumpToSpread(-5); // 负数 → 钳到 0
    expect(r.currentSpreadIndex).toBe(0);
  });
});

describe('reader store — chrome toggle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('chromeVisible toggles', () => {
    const r = useReaderStore();
    expect(r.chromeVisible).toBe(true);
    r.toggleChrome();
    expect(r.chromeVisible).toBe(false);
    r.toggleChrome();
    expect(r.chromeVisible).toBe(true);
  });
});

describe('reader store — continueSwipePull (跨卷触发累计 — v0.1.0-module3.0.2: 字段已删除, 兼容抛错)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 0,
    });
  });

  it('continueSwipePull 字段已删除 (YAGNI 清理)', () => {
    const r = useReaderStore();
    expect((r as unknown as { continueSwipePull?: unknown }).continueSwipePull).toBeUndefined();
  });

  it('accumulateContinuePull 字段已删除 (YAGNI 清理)', () => {
    const r = useReaderStore();
    expect((r as unknown as { accumulateContinuePull?: unknown }).accumulateContinuePull).toBeUndefined();
  });
});

describe('reader store — debounced saveProgress (500ms)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const r = useReaderStore();
    // 4 个 spread,允许 nextPage 在 last 之前都触发 emit
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
      ],
      initialSpreadIndex: 0,
    });
  });

  it('flushes once after 500ms quiet period', async () => {
    const r = useReaderStore();
    const saved: Array<{ bookId: number; page: number }> = [];
    r.onPageChanged((info) => {
      saved.push({ bookId: info.bookId, page: info.page });
    });

    r.jumpToSpread(1); // 触发 1 次
    r.nextPage(); // 触发 1 次(同位置 spread 1)
    r.nextPage(); // 触发 1 次(同位置 spread 1,因为 jumpTo 之后 next 不能从 1 直接到 2,因为 nextPage 在 spread 1 != last 时再 advance 1,但已经在 1,所以 nextPage 不动...让我重新设计)

    expect(saved.length).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved.length).toBe(1);
    expect(saved[0].bookId).toBe(1);
  });

  it('coalesces multiple page changes that reset the debounce window', async () => {
    const r = useReaderStore();
    const saves: number[] = [];
    r.onPageChanged((info) => saves.push(info.page));

    r.jumpToSpread(1); // 触发,timer set @ 500ms
    await vi.advanceTimersByTimeAsync(200); // t = 200
    r.jumpToSpread(2); // 触发,reset timer @ 200+500 = 700
    await vi.advanceTimersByTimeAsync(200); // t = 400
    r.jumpToSpread(3); // 触发,reset timer @ 400+500 = 900
    await vi.advanceTimersByTimeAsync(200); // t = 600,从上次 reset 算 200

    expect(saves.length).toBe(0); // 每次 reset 都被续期,还没触发
    await vi.advanceTimersByTimeAsync(500); // 再过 500 触发
    expect(saves.length).toBe(1);
    expect(saves[0]).toBe(3); // 最后一次 jumpTo(3) 的页码
  });
});

describe('reader store — v0.1.0-module3.0.8 emitChanged imageName 锚点', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    vi.mocked(saveProgress).mockClear();
  });

  it('emitChanged payload includes imageName (jump 到 spread 2 → c.jpg)', async () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
      ],
      initialSpreadIndex: 0,
    });
    // 任务 5 之前由 ReaderView loadBook 填充；此处直接赋值模拟
    r.imageNames = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'];

    const received: Array<{ bookId: number; page: number; imageName: string | null }> = [];
    r.onPageChanged((info) => {
      received.push({ bookId: info.bookId, page: info.page, imageName: info.imageName });
    });

    r.jumpToSpread(2); // → spread 2, start=2, imageNames[2]='c.jpg'
    await vi.advanceTimersByTimeAsync(500);

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({ bookId: 1, page: 2, imageName: 'c.jpg' });
    // saveProgress 收到 imageName 作为第 5 参
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(1, 2, 'single', undefined, 'c.jpg');
  });

  it('imageNames 未设置时 → imageName=null, saveProgress 5 参 = undefined', async () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 2,
      title: 'no-names',
      pages: ['x.jpg', 'y.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 0,
    });
    // 不设 imageNames, 留默认空数组 → imageNames[0] = undefined → imageName = null

    const received: Array<{ imageName: string | null }> = [];
    r.onPageChanged((info) => received.push({ imageName: info.imageName }));

    r.nextPage(); // → spread 1 (last), start=1, imageNames[1] = undefined → imageName = null
    await vi.advanceTimersByTimeAsync(500);

    expect(received.length).toBe(1);
    expect(received[0].imageName).toBeNull();
    // null ?? undefined → undefined, 由 saveProgress ?? null 走保留分支
    expect(saveProgress).toHaveBeenCalledWith(2, 1, 'single', true, undefined);
  });

  it('imageNames 短于 spreads → 越界 index → imageName=null', async () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 3,
      title: 'short',
      pages: ['p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
      ],
      initialSpreadIndex: 0,
    });
    // 只设 2 个名字, spread 3 (start=3) 越界
    r.imageNames = ['p0.jpg', 'p1.jpg'];

    r.jumpToSpread(3);
    await vi.advanceTimersByTimeAsync(500);

    expect(saveProgress).toHaveBeenCalledWith(3, 3, 'single', true, undefined);
  });
});

/**
 * 2026-08-12 跨卷任务 4：reader store 扩展
 * - saveCurrentProgressNow（构造当前快照 await 写入；P1-1 修复）
 * - nextPage atLast 调 onAtLastNextAttempt（不翻页）
 * - setOnAtLastNextAttempt(null) 清理（不变量 11）
 * - sourceDescriptor / currentRelPath state + OpenBookPayload 扩展
 */
import type { SourceDescriptorLocal } from '@/lib/sourceDescriptor';

describe('reader store — sourceDescriptor / currentRelPath state (跨卷任务 4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('openBook 写入 sourceDescriptor + currentRelPath', () => {
    const r = useReaderStore();
    const desc: SourceDescriptorLocal = { type: 'local', rootPath: 'C:\\comics' };
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg'],
      spreads: [{ start: 0, end: 1 }],
      initialSpreadIndex: 0,
      sourceDescriptor: desc,
      currentRelPath: 'vol1',
    });
    expect(r.sourceDescriptor).toEqual(desc);
    expect(r.currentRelPath).toBe('vol1');
  });

  it('openBook 不传 sourceDescriptor / currentRelPath 时 → null / ""', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg'],
      spreads: [{ start: 0, end: 1 }],
      initialSpreadIndex: 0,
    });
    expect(r.sourceDescriptor).toBeNull();
    expect(r.currentRelPath).toBe('');
  });

  it('closeBook 清 sourceDescriptor + currentRelPath', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg'],
      spreads: [{ start: 0, end: 1 }],
      initialSpreadIndex: 0,
      sourceDescriptor: { type: 'local', rootPath: 'C:\\comics' },
      currentRelPath: 'vol1',
    });
    r.closeBook();
    expect(r.sourceDescriptor).toBeNull();
    expect(r.currentRelPath).toBe('');
  });
});

describe('reader store — saveCurrentProgressNow (跨卷任务 4, P1-1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(saveProgress).mockClear();
  });

  it('有 pending debounce 时取消 + 立即写（不依赖 timer 触发）', async () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
      ],
      initialSpreadIndex: 0,
    });
    r.imageNames = ['a.jpg', 'b.jpg', 'c.jpg'];

    r.jumpToSpread(1); // 触发 debounce timer
    expect(saveProgress).not.toHaveBeenCalled();
    vi.mocked(saveProgress).mockClear();

    await r.saveCurrentProgressNow();
    // 立即写，未到 500ms 也写
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(1, 1, 'single', undefined, 'b.jpg');

    // 再 advance 500ms，timer 已被取消，不二次写
    await vi.advanceTimersByTimeAsync(500);
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it('无 pending debounce（首页未翻页）也立即写 — finished=false, page=0', async () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 2,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 0,
    });
    r.imageNames = ['a.jpg', 'b.jpg'];

    await r.saveCurrentProgressNow();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(2, 0, 'single', undefined, 'a.jpg');
  });

  it('末页时 saveCurrentProgressNow 写 finished=true + imageName', async () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 3,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
      ],
      initialSpreadIndex: 0,
    });
    r.imageNames = ['a.jpg', 'b.jpg', 'c.jpg'];
    r.jumpToSpread(2); // last spread
    vi.mocked(saveProgress).mockClear();

    await r.saveCurrentProgressNow();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(3, 2, 'single', true, 'c.jpg');
  });

  it('await saveCurrentProgressNow 验证 saveProgress 异步结果可 await', async () => {
    let resolveFn: () => void = () => {};
    const pending = new Promise<void>((resolve) => { resolveFn = resolve; });
    vi.mocked(saveProgress).mockReturnValueOnce(pending);

    const r = useReaderStore();
    r.openBook({
      bookId: 4,
      title: 'demo',
      pages: ['a.jpg'],
      spreads: [{ start: 0, end: 1 }],
      initialSpreadIndex: 0,
    });

    const awaited = r.saveCurrentProgressNow();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    resolveFn();
    await awaited;
  });

  it('status=idle（无 book）时不写', async () => {
    const r = useReaderStore();
    await r.saveCurrentProgressNow();
    expect(saveProgress).not.toHaveBeenCalled();
  });
});

describe('reader store — nextPage atLast 调 onAtLastNextAttempt (跨卷任务 4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('末页再向下：调 onAtLastNextAttempt，不翻页', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
      ],
      initialSpreadIndex: 0,
    });
    r.jumpToSpread(2); // last
    expect(r.currentSpreadIndex).toBe(2);

    const calls = vi.fn();
    r.setOnAtLastNextAttempt(calls);

    r.nextPage();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(r.currentSpreadIndex).toBe(2); // 不 ++
  });

  it('非末页正常 ++ 不调回调', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg', 'c.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
      ],
      initialSpreadIndex: 0,
    });
    const calls = vi.fn();
    r.setOnAtLastNextAttempt(calls);

    r.nextPage();
    expect(r.currentSpreadIndex).toBe(1);
    expect(calls).not.toHaveBeenCalled();
  });

  it('setOnAtLastNextAttempt(null) 清理回调（不变量 11）', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 0,
    });
    r.jumpToSpread(1); // last

    const calls = vi.fn();
    r.setOnAtLastNextAttempt(calls);
    r.setOnAtLastNextAttempt(null);

    r.nextPage();
    expect(calls).not.toHaveBeenCalled();
    expect(r.currentSpreadIndex).toBe(1);
  });

  it('从未注册回调：末页再向下不抛错', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 'demo',
      pages: ['a.jpg'],
      spreads: [{ start: 0, end: 1 }],
      initialSpreadIndex: 0,
    });
    // 单 spread → 既首又末
    expect(r.currentSpreadIndex).toBe(0);
    expect(() => r.nextPage()).not.toThrow();
    expect(r.currentSpreadIndex).toBe(0);
  });
});
