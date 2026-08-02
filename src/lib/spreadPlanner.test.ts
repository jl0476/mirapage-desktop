/**
 * SpreadPlanner TS 镜像测试
 * 语义与 `src-tauri/src/algorithm/spread_planner.rs` 严格 1:1
 *
 * `plan(pageCount, coverStandalone=true)`:
 *   - 0 → []
 *   - 1 → [0..1]（无论 coverStandalone）
 *   - >1 且 cover=true → [0..1] + [1..3] + [3..5] + ... + 余单页 [i..i+1]
 *   - >1 且 cover=false → [0..2] + [2..4] + ...
 */
import { describe, it, expect } from 'vitest';
import { SpreadPlanner } from './spreadPlanner';

describe('SpreadPlanner.plan', () => {
  it('returns empty array for 0 pages', () => {
    expect(SpreadPlanner.plan(0, true)).toEqual([]);
    expect(SpreadPlanner.plan(0, false)).toEqual([]);
  });

  it('returns single page range for 1 page', () => {
    expect(SpreadPlanner.plan(1, true)).toEqual([{ start: 0, end: 1 }]);
    expect(SpreadPlanner.plan(1, false)).toEqual([{ start: 0, end: 1 }]);
  });

  it('splits 2 pages with coverStandalone: cover + rest', () => {
    expect(SpreadPlanner.plan(2, true)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it('merges 2 pages without coverStandalone: one spread', () => {
    expect(SpreadPlanner.plan(2, false)).toEqual([{ start: 0, end: 2 }]);
  });

  it('splits 8 pages with coverStandalone', () => {
    // [0..1], [1..3], [3..5], [5..7], [7..8]
    expect(SpreadPlanner.plan(8, true)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 5 },
      { start: 5, end: 7 },
      { start: 7, end: 8 },
    ]);
  });

  it('splits 10 pages with coverStandalone', () => {
    // [0..1], [1..3], [3..5], [5..7], [7..9], [9..10]
    expect(SpreadPlanner.plan(10, true)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 5 },
      { start: 5, end: 7 },
      { start: 7, end: 9 },
      { start: 9, end: 10 },
    ]);
  });

  it('splits 11 pages with coverStandalone (no trailing single)', () => {
    // [0..1], [1..3], [3..5], [5..7], [7..9], [9..11]
    expect(SpreadPlanner.plan(11, true)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 5 },
      { start: 5, end: 7 },
      { start: 7, end: 9 },
      { start: 9, end: 11 },
    ]);
  });

  // v0.1.0-module3.0.2-hotfix7 (H13): singlePage=true 时每 spread 1 张
  // 单页模式读者预期滚轮一次 = 跳 1 张图 (不是双页模式那样跨 2 张).
  it('singlePage=true: 77 pages → 77 spreads, each size 1 (except cover)', () => {
    const spreads = SpreadPlanner.plan(77, true, true);
    expect(spreads.length).toBe(77);
    expect(spreads[0]).toEqual({ start: 0, end: 1 });
    expect(spreads[1]).toEqual({ start: 1, end: 2 });
    expect(spreads[76]).toEqual({ start: 76, end: 77 });
  });

  it('singlePage=true + pageCount=1 → single spread', () => {
    expect(SpreadPlanner.plan(1, true, true)).toEqual([{ start: 0, end: 1 }]);
  });

  it('singlePage=true + pageCount=0 → empty', () => {
    expect(SpreadPlanner.plan(0, true, true)).toEqual([]);
  });

  it('singlePage=false (default double): 77 pages → cover + 38 pairs (39 spreads)', () => {
    const spreads = SpreadPlanner.plan(77, true, false);
    // [0..1] + [1..3] + [3..5] + ... + [75..77] = 1 + 38 = 39 spreads
    expect(spreads.length).toBe(39);
    expect(spreads[0]).toEqual({ start: 0, end: 1 });
    expect(spreads[1]).toEqual({ start: 1, end: 3 });
    expect(spreads[38]).toEqual({ start: 75, end: 77 });
  });
});

describe('SpreadPlanner.spreadIndexForPage', () => {
  const spreads = [
    { start: 0, end: 1 },
    { start: 1, end: 3 },
    { start: 3, end: 5 },
  ];

  it('returns 0 for first spread', () => {
    expect(SpreadPlanner.spreadIndexForPage(0, spreads)).toBe(0);
  });

  it('returns spread index for page inside a spread', () => {
    expect(SpreadPlanner.spreadIndexForPage(1, spreads)).toBe(1);
    expect(SpreadPlanner.spreadIndexForPage(2, spreads)).toBe(1);
    expect(SpreadPlanner.spreadIndexForPage(3, spreads)).toBe(2);
  });

  it('returns 0 when page not in any spread', () => {
    expect(SpreadPlanner.spreadIndexForPage(99, spreads)).toBe(0);
  });

  it('returns 0 for empty spreads', () => {
    expect(SpreadPlanner.spreadIndexForPage(5, [])).toBe(0);
  });
});

describe('SpreadPlanner.firstPageOfSpread', () => {
  it('returns the start of a spread range', () => {
    expect(SpreadPlanner.firstPageOfSpread({ start: 3, end: 5 })).toBe(3);
    expect(SpreadPlanner.firstPageOfSpread({ start: 0, end: 1 })).toBe(0);
  });
});
