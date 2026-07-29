/**
 * SpreadPlanner TS 镜像
 * 语义与 `src-tauri/src/algorithm/spread_planner.rs` 严格 1:1
 *
 * 把扁平页表切成 spread 列表（双页阅读器使用）。
 * 范围半开: `end` 为 exclusive 上界（与 Rust `Range<u32>` 一致）。
 *
 * ## 语义
 * - `pageCount == 0` → `[]`
 * - `pageCount == 1` → `[{0..1}]`（无论 coverStandalone）
 * - `pageCount > 1 && coverStandalone` → `[{0..1}]` + `[{1..3}]` + ... + 余单页 `[{i..i+1}]`
 * - `coverStandalone == false` → 两两配对
 *
 * RTL 由调用方通过 Pager 的 reverseLayout 控制，本函数不处理。
 */
export interface PageRange {
  /** 起始页（inclusive） */
  start: number;
  /** 结束页（exclusive） */
  end: number;
}

export const SpreadPlanner = {
  /**
   * 把 `pageCount` 页切成 spread 列表
   * @param pageCount 总页数（≥ 0）
   * @param coverStandalone 封面是否独占一页
   */
  plan(pageCount: number, coverStandalone: boolean): PageRange[] {
    if (pageCount === 0) return [];
    if (pageCount === 1) return [{ start: 0, end: 1 }];

    const spreads: PageRange[] = [];

    if (coverStandalone) {
      spreads.push({ start: 0, end: 1 });
    }

    const begin = coverStandalone ? 1 : 0;
    let i = begin;
    while (i + 1 < pageCount) {
      spreads.push({ start: i, end: i + 2 });
      i += 2;
    }
    if (i < pageCount) {
      spreads.push({ start: i, end: i + 1 });
    }

    return spreads;
  },

  /**
   * 反查:给一页索引,找到它所在的 spread 索引
   * @param pageIndex 页索引
   * @param spreads plan() 返回的 spread 列表
   * @returns 第一个包含此页的 spread 索引,无匹配时返回 0
   */
  spreadIndexForPage(pageIndex: number, spreads: PageRange[]): number {
    for (let idx = 0; idx < spreads.length; idx++) {
      const spread = spreads[idx];
      if (spread.start <= pageIndex && pageIndex < spread.end) {
        return idx;
      }
    }
    return 0;
  },

  /**
   * 取某 spread 的首页
   */
  firstPageOfSpread(spread: PageRange): number {
    return spread.start;
  },
};
