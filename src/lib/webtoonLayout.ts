/**
 * Webtoon 单列布局纯函数（module3.1.0，spec §2/§3）。
 * 无 Vue / DOM 依赖：尺寸前缀和、二分窗口、滚动/缩放锚点均可独立测试。
 */

/** 未测量图片的估算宽高比（宽:高 = 3:4）。 */
export const ESTIMATED_RATIO = 3 / 4;

export interface WebtoonLayout {
  names: string[];
  heights: number[];
  /** tops[i] 是第 i 张图的顶部坐标，包含前序 gap。 */
  tops: number[];
  totalHeight: number;
}

export function computeLayout(
  names: readonly string[],
  measured: ReadonlyMap<string, { width: number; height: number }>,
  stripWidth: number,
  gap: number,
): WebtoonLayout {
  const heights = names.map((name) => {
    const dimensions = measured.get(name);
    if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
      return (stripWidth * dimensions.height) / dimensions.width;
    }
    return stripWidth / ESTIMATED_RATIO;
  });
  const tops: number[] = new Array(names.length);
  let totalHeight = 0;
  for (let index = 0; index < names.length; index += 1) {
    tops[index] = totalHeight;
    totalHeight += heights[index] + (index < names.length - 1 ? gap : 0);
  }
  return { names: [...names], heights, tops, totalHeight };
}

/** 返回与像素窗口相交的半开区间 [start, end)，默认覆盖视口前后 2.5 屏。 */
export function visibleWindow(
  layout: WebtoonLayout,
  scrollTop: number,
  viewportHeight: number,
  screens = 2.5,
): { start: number; end: number } {
  const lowerBound = scrollTop - screens * viewportHeight;
  const upperBound = scrollTop + (1 + screens) * viewportHeight;

  let start = 0;
  let end = layout.names.length;
  while (start < end) {
    const middle = (start + end) >> 1;
    if (layout.tops[middle] + layout.heights[middle] > lowerBound) end = middle;
    else start = middle + 1;
  }
  const windowStart = start;

  let right = windowStart;
  end = layout.names.length;
  while (right < end) {
    const middle = (right + end) >> 1;
    if (layout.tops[middle] > upperBound) end = middle;
    else right = middle + 1;
  }
  return { start: windowStart, end: Math.max(right, windowStart) };
}

/** 返回首个底边超过 scrollTop 的图索引，空布局返回 0。 */
export function topVisibleIndex(layout: WebtoonLayout, scrollTop: number): number {
  let start = 0;
  let end = layout.names.length;
  while (start < end) {
    const middle = (start + end) >> 1;
    if (layout.tops[middle] + layout.heights[middle] > scrollTop) end = middle;
    else start = middle + 1;
  }
  return Math.max(0, Math.min(start, layout.names.length - 1));
}

/** 将缩放限制到 1.00–4.00，并保留两位小数。 */
export function clampZoom(zoom: number): number {
  return Math.min(4, Math.max(1, Math.round(zoom * 100) / 100));
}

/** 计算缩放后保持鼠标下内容点不动所需的新 scrollTop。 */
export function anchoredScroll(
  scrollTop: number,
  clientY: number,
  oldZoom: number,
  newZoom: number,
): number {
  return (scrollTop + clientY) * (newZoom / oldZoom) - clientY;
}

/** 计算自动滚动单帧位移：px/s × factor × elapsed milliseconds。 */
export function autoScrollDelta(speed: number, factor: number, elapsedMs: number): number {
  return (speed * factor * elapsedMs) / 1000;
}

export interface WebtoonAnchor {
  index: number;
  ratio: number;
}

/** 捕获顶部图及视口在图内的相对位置，供尺寸批次应用后恢复。 */
export function captureAnchor(layout: WebtoonLayout, scrollTop: number): WebtoonAnchor | null {
  if (layout.names.length === 0) return null;
  const index = topVisibleIndex(layout, scrollTop);
  const height = layout.heights[index];
  const ratio = height > 0
    ? Math.min(1, Math.max(0, (scrollTop - layout.tops[index]) / height))
    : 0;
  return { index, ratio };
}

/** 按新布局恢复锚点位置；锚点无效或越界时返回 null。 */
export function restoreAnchor(
  layout: WebtoonLayout,
  anchor: WebtoonAnchor | null,
): number | null {
  if (!anchor || anchor.index < 0 || anchor.index >= layout.names.length) return null;
  return layout.tops[anchor.index] + layout.heights[anchor.index] * anchor.ratio;
}
