// useMasonryLayout.ts — 瀑布流变高多列布局
// 借鉴 v3-waterfall 贪心放最短列算法；本实现固定列数（v3 是固定列宽，方向相反）。
// 设计文档 §5。

import type { MediaEntry } from '@/lib/sourceDescriptor';
import { computed, type ComputedRef, type Ref } from 'vue';

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

/** 固定列数 → 列宽。colWidth = (containerWidth - (cols-1)*hGap) / cols, 取整避免 absolute
 * 定位的亚像素缝隙 (有的行无缝有的有缝)。右侧少量留白可接受。 */
export function computeColWidth(containerWidth: number, cols: number, hGap: number): number {
  if (cols <= 1) return Math.floor(containerWidth);
  return Math.floor((containerWidth - (cols - 1) * hGap) / cols);
}

/**
 * entry.path 相对 currentPath（= lastFetchedPath），但 Rust list_image_dimensions → read_file
 * 期望相对 rootPath 的完整路径。拼接 currentPath 前缀（'/' 分隔，LocalMediaSource 接受 '/'）。
 * currentPath 为空（根目录）时原样返回。
 *
 * 修复 F1：之前直接传 entry.path 给 IPC，子目录（lastFetchedPath 非空）场景 read_file
 * 读 rootPath/<entry.path>（文件不存在）→ 返回 None → measuredMap 永远空 → 全估算高度。
 */
export function toRootRelativePath(currentPath: string, relPath: string): string {
  const base = currentPath.replace(/[\\/]+$/, '');
  if (!base) return relPath;
  return `${base}/${relPath}`.replace(/\/+/g, '/');
}

export interface MasonryLayoutResult {
  map: Map<string, MasonryItem>;
  totalHeight: number;
}

/**
 * 贪心放最短列布局。inputs 必须已排序（调用方保证）。
 * 返回 path→MasonryItem 的 Map + totalHeight（最长列，含末尾 vGap）。
 * 所有坐标取整到像素, 消除 absolute 定位的亚像素缝隙 (colWidth 已 floor, 进一步确保 width/top/height 整数)。
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
    const w = Math.round(inp.width);
    const h = Math.round(inp.height);
    const gapH = Math.round(hGap);
    const gapV = Math.round(vGap);
    const top = Math.round(colTops[minCol]);
    const left = minCol * (w + gapH);
    map.set(inp.path, {
      path: inp.path,
      width: w,
      height: h,
      top,
      left,
      col: minCol,
    });
    colTops[minCol] = top + h + gapV;
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

export interface MasonryLayoutParams {
  entries: Ref<readonly MediaEntry[]>;
  containerWidth: Ref<number>;
  containerHeight: Ref<number>;
  colCount: Ref<number>;
  hGap: Ref<number>;
  vGap: Ref<number>;
  scrollTop: Ref<number>;
  measuredMap: Ref<Map<string, { width: number; height: number }>>;
}

export interface MasonryLayoutOutput {
  colWidth: ComputedRef<number>;
  layout: ComputedRef<MasonryLayoutResult>;
  visibleRange: ComputedRef<{ start: number; end: number }>;
  measuredCount: ComputedRef<number>;
  needPrefetch: ComputedRef<boolean>;
  nextBatchPaths: ComputedRef<string[]>;
  /**
   * 预读区 paths (visibleRange 前后各 PREFETCH_BUFFER 屏行)。
   * MasonryView 对这些 paths 调 new Image(src) 提前 fetch + decode 进浏览器缓存,
   * 滚动到时 <img> 命中缓存无网络+解码延迟 (对齐阅读器 preload 策略)。
   */
  prefetchPaths: ComputedRef<string[]>;
}

const PREFETCH_SCREENS = 3;
const VISIBLE_BUFFER = 2;
/** 图片字节预读区: 视口前后各 PREFETCH_BUFFER 屏行 (new Image 缓存) */
const PREFETCH_BUFFER = 2;

/**
 * 响应式瀑布流 composable 主体。把 C1/C2 纯函数接成响应式数据流，
 * 输出 colWidth / layout / visibleRange / measuredCount / needPrefetch / nextBatchPaths 给 MasonryView 消费。
 * 本 composable 不直接调 IPC（listImageDimensions）——预读由 MasonryView watch(needPrefetch) 触发。
 */
export function useMasonryLayout(params: MasonryLayoutParams): MasonryLayoutOutput {
  const colWidth = computed(() =>
    computeColWidth(params.containerWidth.value, params.colCount.value, params.hGap.value),
  );

  // 每个 entry 的输入（已测量用真实宽高，未测量估算）
  const inputs = computed<MasonryInput[]>(() => {
    const cw = colWidth.value;
    const measured = params.measuredMap.value;
    // 动态平均宽高比（已测量的均值，无则默认）
    let sumW = 0, sumH = 0;
    for (const v of measured.values()) { sumW += v.width; sumH += v.height; }
    const avgRatio = measured.size > 0 && sumH > 0 ? sumW / sumH : DEFAULT_ASPECT_RATIO;
    return params.entries.value.map((e) => {
      const m = measured.get(e.path);
      // 已测量: 按 colWidth 等比缩放真实高度 (m.height/m.width 是原始像素, 须缩到卡片宽度)。
      // 不能直接用 m.height -- 否则卡片 180px 宽 × 1280px 高 (极长), cover 裁左右。
      const height = m ? (cw * m.height) / m.width : estimateHeight(cw, avgRatio);
      return { path: e.path, width: cw, height };
    });
  });

  const layout = computed(() =>
    layoutMasonry(inputs.value, params.colCount.value, params.hGap.value, params.vGap.value),
  );

  // 可见范围（基于 layout map 的 top/height 与 scrollTop/viewportHeight）
  const visibleRange = computed(() => {
    const top = params.scrollTop.value;
    const bottom = top + params.containerHeight.value;
    const map = layout.value.map;
    let start = -1, end = 0;
    const entries = params.entries.value;
    for (let i = 0; i < entries.length; i++) {
      const item = map.get(entries[i].path);
      if (!item) continue;
      const itemBottom = item.top + item.height;
      if (itemBottom >= top && item.top <= bottom) {
        if (start === -1) start = i;
        end = i + 1;
      }
    }
    if (start === -1) return { start: 0, end: 0 };
    start = Math.max(0, start - VISIBLE_BUFFER);
    end = Math.min(entries.length, end + VISIBLE_BUFFER);
    return { start, end };
  });

  const measuredCount = computed(() => params.measuredMap.value.size);

  // 预读触发：visibleRange.end 接近已测量边界
  const needPrefetch = computed(() => {
    const entries = params.entries.value;
    if (entries.length === 0) return false;
    const cw = colWidth.value;
    const estItemH = cw / DEFAULT_ASPECT_RATIO;
    const oneScreen = Math.max(1, Math.ceil(params.colCount.value * (params.containerHeight.value / estItemH)));
    return visibleRange.value.end + oneScreen > measuredCount.value;
  });

  const nextBatchPaths = computed(() => {
    if (!needPrefetch.value) return [];
    const batchSize = PREFETCH_SCREENS * Math.max(1, params.colCount.value) * 10;
    const start = measuredCount.value;
    return params.entries.value
      .slice(start, start + batchSize)
      .map((e) => e.path);
  });

  // 预读区: 视口前后各 PREFETCH_BUFFER 屏行. MasonryView 用来 new Image() 提前缓存.
  const prefetchPaths = computed(() => {
    const r = visibleRange.value;
    const cols = Math.max(1, params.colCount.value);
    const extend = PREFETCH_BUFFER * cols;
    const start = Math.max(0, r.start - extend);
    const end = Math.min(params.entries.value.length, r.end + extend);
    return params.entries.value.slice(start, end).map((e) => e.path);
  });

  return { colWidth, layout, visibleRange, measuredCount, needPrefetch, nextBatchPaths, prefetchPaths };
}
