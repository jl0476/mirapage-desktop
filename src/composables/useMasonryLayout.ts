// useMasonryLayout.ts — 瀑布流变高多列布局
// 借鉴 v3-waterfall 贪心放最短列算法；本实现固定列数（v3 是固定列宽，方向相反）。
// 设计文档 §5。

export interface MasonryInput {
  path: string;
  width: number;   // 列宽
  height: number;  // 该 item 高度
}

export interface MasonryItem {
  path: string;
  width: number;
  height: number;
  top: number;
  left: number;
  col: number;
}

/** 固定列数 → 列宽。colWidth = (containerWidth - (cols-1)*hGap) / cols */
export function computeColWidth(containerWidth: number, cols: number, hGap: number): number {
  if (cols <= 1) return containerWidth;
  return (containerWidth - (cols - 1) * hGap) / cols;
}

export interface MasonryLayoutResult {
  map: Map<string, MasonryItem>;
  totalHeight: number;
}

/**
 * 贪心放最短列布局。inputs 必须已排序（调用方保证）。
 * 返回 path→MasonryItem 的 Map + totalHeight（最长列，含末尾 vGap）。
 */
export function layoutMasonry(
  inputs: readonly MasonryInput[],
  cols: number,
  hGap: number,
  vGap: number,
): MasonryLayoutResult {
  const map = new Map<string, MasonryItem>();
  if (cols < 1 || inputs.length === 0) return { map, totalHeight: 0 };
  const colTops = new Array(cols).fill(0) as number[];
  for (const inp of inputs) {
    // 找最短列（首个最小值的列号）
    let minCol = 0;
    for (let c = 1; c < cols; c++) {
      if (colTops[c] < colTops[minCol]) minCol = c;
    }
    const top = colTops[minCol];
    const left = minCol * (inp.width + hGap);
    map.set(inp.path, {
      path: inp.path,
      width: inp.width,
      height: inp.height,
      top,
      left,
      col: minCol,
    });
    colTops[minCol] = top + inp.height + vGap;
  }
  const totalHeight = Math.max(...colTops);
  return { map, totalHeight };
}

/** 默认宽高比（宽/高），漫画常见竖长 3:4 */
export const DEFAULT_ASPECT_RATIO = 3 / 4;

/** 未测量 item 的估算高度 = colWidth / aspectRatio（aspectRatio 是 w/h） */
export function estimateHeight(colWidth: number, aspectRatio: number): number {
  if (aspectRatio <= 0) return colWidth; // 防御
  return colWidth / aspectRatio;
}

export interface AnchorParams {
  oldLayout: Map<string, MasonryItem>;
  scrollTop: number;
  changedPaths: string[];
  oldHeights: Record<string, number>;
  newHeights: Record<string, number>;
}

/**
 * 尺寸到达后，对 changedPaths 的 item 计算 scrollTop 补偿量。
 * 仅累加"在当前 scrollTop 上方"（item.top < scrollTop）的 item 高度差（newH - oldH）。
 * 返回值 > 0 表示内容下移了，应把 scrollTop 往下加；< 0 表示往上减；0 表示无影响。
 * 下方 item（top >= scrollTop）不补偿（不影响视口）。
 */
export function applyMeasuredBatch(params: AnchorParams): number {
  let compensation = 0;
  for (const path of params.changedPaths) {
    const item = params.oldLayout.get(path);
    if (!item) continue;
    if (item.top < params.scrollTop) {
      const oldH = params.oldHeights[path] ?? item.height;
      const newH = params.newHeights[path] ?? item.height;
      compensation += newH - oldH;
    }
  }
  return compensation;
}
