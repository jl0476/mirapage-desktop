/**
 * Reader store 测试
 * 状态机:Loading → Ready → (close/error);Ready 内 next/prev/jump/atFirst/Last。
 * 防抖:onPageChanged 500ms 内多次调用合并为 1 次 saveProgress。
 *
 * 设计参考 DESIGN §12.4 + §15.6 进度保存策略。
 *
 * v0.1.0-module1.21: saveProgress 多了一个 finished 入参.
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

describe('reader store — continueSwipePull (跨卷触发累计)', () => {
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

  it('accumulates pull while at last spread with NEXT direction', () => {
    const r = useReaderStore();
    r.jumpToSpread(1);
    expect(r.isAtLastSpread).toBe(true);

    r.accumulateContinuePull(0.2);
    r.accumulateContinuePull(0.2);
    expect(r.continueSwipePull).toBeCloseTo(0.4);
  });

  it('resets pull on leaving last spread', () => {
    const r = useReaderStore();
    r.jumpToSpread(1);
    r.accumulateContinuePull(0.5);
    expect(r.continueSwipePull).toBeGreaterThan(0);

    r.jumpToSpread(0);
    expect(r.continueSwipePull).toBe(0);
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
