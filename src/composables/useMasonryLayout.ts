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

/** atBottom 三档规则常量(spec §2.1) */
export const BOTTOM_THRESHOLD_PX = 64;

/**
 * 计算「是否滚到底」三档规则(spec §2.1, 审查 P1-b + P2)。
 * - 档1 不足一屏(sh<=ch): true(停留即可,滚不动)
 * - 档2 短目录(ch<sh<2ch): nearBottom && st>0(须实际滚过防顶部误判)
 * - 档3 长目录(sh>=2ch): nearBottom
 * 纯函数, 可独立单测(MasonryView atBottom computed 调它)。
 */
export function computeAtBottom(sh: number, ch: number, st: number): boolean {
  const nearBottom = st + ch >= sh - BOTTOM_THRESHOLD_PX;
  if (sh <= ch) return true;
  if (sh < 2 * ch) return nearBottom && st > 0;
  return nearBottom;
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

/**
 * viewport anchor：resize 后保持视觉焦点不漂移（spec v0.1.0-module3.0.8 task-21）。
 * - 捕获：旧 layout + scrollTop → 找出穿过顶线且 top 最大的图片，记录 (path, ratio)。
 * - 恢复：新 layout + anchor → 把该图片的同一相对位置放到新顶线。
 * 不读 DB、不按宽度比例换算——纯像素锚定。
 */
export interface MasonryViewportAnchor {
  path: string;
  /** 视口顶线在图片内的相对位置（0=顶边，1=底边） */
  ratio: number;
}

/**
 * 从旧 layout + scrollTop 捕获 anchor：找穿过顶线且 top 最大的图。
 * 多张图跨顶线时选 top 最大的（即顶线下方紧邻的那张）。
 * 返回 null = scrollTop 完全在图下方（视口下方无相交的图）。
 */
export function captureMasonryViewportAnchor(
  layout: Map<string, MasonryItem>,
  entries: readonly { path: string }[],
  scrollTop: number,
): MasonryViewportAnchor | null {
  let intersecting: MasonryItem | null = null;
  for (const entry of entries) {
    const item = layout.get(entry.path);
    if (!item) continue;
    const intersectsTop =
      item.top <= scrollTop && item.top + item.height > scrollTop;
    if (intersectsTop && (!intersecting || item.top > intersecting.top)) {
      intersecting = item;
    }
  }
  if (!intersecting) return null;
  const ratio = (scrollTop - intersecting.top) / intersecting.height;
  return {
    path: intersecting.path,
    ratio: Math.max(0, Math.min(1, ratio)),
  };
}

/**
 * 用 anchor + 新 layout 算出新 scrollTop；锚点图不存在（被过滤/已离开）返 null。
 * 算出值再交给调用方做 maxScrollTop 钳位。
 */
export function restoreMasonryViewportAnchor(
  anchor: MasonryViewportAnchor,
  layout: Map<string, MasonryItem>,
): number | null {
  const item = layout.get(anchor.path);
  if (!item) return null;
  return item.top + item.height * anchor.ratio;
}

// ─── 像素窗口（缩略图生成需求，§5.1）────────────────────────────────────

export interface PixelWindowParams {
  scrollTop: number;
  viewportHeight: number;
  /** 向下预生成屏数。 */
  aheadScreens: number;
  /** 向上保留屏数。 */
  behindScreens: number;
  /** 空闲额外向下屏数。 */
  idleScreens: number;
}

export interface ThumbnailWindows {
  visible: string[];
  ahead: string[];
  behind: string[];
  idle: string[];
}

/**
 * 按 layout 的 `top/height` 像素范围把 entries 划成四组（§5.1 §5.2）：
 * - visible：与视口 [scrollTop, scrollTop+vh] 相交
 * - behind：视口上方 [scrollTop-vh*behind, scrollTop]
 * - ahead：视口下方 [scrollTop+vh, scrollTop+vh*(1+ahead)]
 * - idle：ahead 之后再向下 [.., +vh*idle]
 *
 * 四组互斥（visible 优先，再 behind/ahead/idle），每组保持 entries 原顺序。
 * 与视口/窗口都不相交的 item（例如远处未滚动区）不进入任何组。
 */
export function selectPathsInPixelWindow(
  layout: Map<string, MasonryItem>,
  entries: readonly { path: string }[],
  p: PixelWindowParams,
): ThumbnailWindows {
  const vh = p.viewportHeight;
  const visTop = p.scrollTop;
  const visBottom = p.scrollTop + vh;
  const aheadTop = visBottom;
  const aheadBottom = visBottom + vh * p.aheadScreens;
  const behindBottom = visTop;
  const behindTop = Math.max(0, visTop - vh * p.behindScreens);
  const idleTop = aheadBottom;
  const idleBottom = aheadBottom + vh * p.idleScreens;

  const result: ThumbnailWindows = { visible: [], ahead: [], behind: [], idle: [] };
  // 半开区间相交：[a, b) 与 [itemTop, itemBottom] 相交当且仅当 itemTop < b && itemBottom > a。
  // 四组范围依次相接（behind/visible/ahead/idle），相邻 item 边界恰好相接时不重不漏。
  const intersect = (itemTop: number, itemBottom: number, a: number, b: number) =>
    itemTop < b && itemBottom > a;

  for (const e of entries) {
    const item = layout.get(e.path);
    if (!item) continue;
    const itTop = item.top;
    const itBottom = item.top + item.height;
    if (intersect(itTop, itBottom, visTop, visBottom)) result.visible.push(e.path);
    else if (intersect(itTop, itBottom, behindTop, behindBottom)) result.behind.push(e.path);
    else if (intersect(itTop, itBottom, aheadTop, aheadBottom)) result.ahead.push(e.path);
    else if (intersect(itTop, itBottom, idleTop, idleBottom)) result.idle.push(e.path);
  }
  return result;
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
  /** 缩略图生成窗口：向下预生成屏数（默认 1.5 = balanced）。 */
  thumbnailAheadScreens?: Ref<number>;
  /** 是否启用空闲额外生成（默认 true）。false 时 idle 窗口为 0。 */
  thumbnailIdleGeneration?: Ref<boolean>;
  /** 空闲额外向下屏数（默认 1）。 */
  thumbnailIdleScreens?: Ref<number>;
}

export interface MasonryLayoutOutput {
  colWidth: ComputedRef<number>;
  layout: ComputedRef<MasonryLayoutResult>;
  visibleRange: ComputedRef<{ start: number; end: number }>;
  measuredCount: ComputedRef<number>;
  /**
   * 预读区 paths (visibleRange 前后各 PREFETCH_BUFFER 屏行)。
   * MasonryView 对这些 paths 调 new Image(src) 提前 fetch + decode 进浏览器缓存,
   * 滚动到时 <img> 命中缓存无网络+解码延迟 (对齐阅读器 preload 策略)。
   * @deprecated 任务9 接入缩略图队列后由 thumbnailWindows 取代。
   */
  prefetchPaths: ComputedRef<string[]>;
  /**
   * 像素窗口四组 paths（visible/ahead/behind/idle），缩略图生成需求窗口（§5.1）。
   * 默认 balanced 预设（ahead 1.5 / behind 0.5 / idle 1）；任务 8/11 接 settings。
   */
  thumbnailWindows: ComputedRef<ThumbnailWindows>;
  /**
   * 尺寸预读 paths（像素窗口中心，过滤已测量，截断到 DIMENSION_BATCH_SIZE）。
   * MasonryView watch 它触发 listImageDimensions。
   * v0.1.0-module3.0.8 fix: 替代旧 nextBatchPaths（measuredCount 连续前缀）——
   * reader 返回深处时 measuredMap 空，旧逻辑从 p0 读导致深处图永远拿不到真实尺寸。
   */
  dimensionPrefetchPaths: ComputedRef<string[]>;
}

const VISIBLE_BUFFER = 2;
/** 图片字节预读区: 视口前后各 PREFETCH_BUFFER 屏行 (new Image 缓存) */
const PREFETCH_BUFFER = 2;
/**
 * 尺寸（header）预读 batch 上限：像素窗口内未测量 paths 一次请求的上限。
 * v0.1.0-module3.0.8 fix: 视口附近未测量图一次性请求真实尺寸，避免估算偏差。
 */
const DIMENSION_BATCH_SIZE = 80;

/**
 * 响应式瀑布流 composable 主体。把 C1/C2 纯函数接成响应式数据流，
 * 输出 colWidth / layout / visibleRange / measuredCount / dimensionPrefetchPaths 给 MasonryView 消费。
 * 本 composable 不直接调 IPC（listImageDimensions）——预读由 MasonryView watch(dimensionPrefetchPaths) 触发。
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

  // 预读区: 视口前后各 PREFETCH_BUFFER 屏行. MasonryView 用来 new Image() 提前缓存.
  const prefetchPaths = computed(() => {
    const r = visibleRange.value;
    const cols = Math.max(1, params.colCount.value);
    const extend = PREFETCH_BUFFER * cols;
    const start = Math.max(0, r.start - extend);
    const end = Math.min(params.entries.value.length, r.end + extend);
    return params.entries.value.slice(start, end).map((e) => e.path);
  });

  // 像素窗口（缩略图生成需求窗口）。来自设置（balanced 默认）；任务 11 接 settings。
  // behind 按 ahead 约 1/3 自动计算，启用预生成时至少 0.5 屏（§8.4）。
  const thumbnailWindows = computed<ThumbnailWindows>(() => {
    const ahead = params.thumbnailAheadScreens?.value ?? 1.5;
    const idleGen = params.thumbnailIdleGeneration?.value ?? true;
    const idle = idleGen ? (params.thumbnailIdleScreens?.value ?? 1) : 0;
    const behind = ahead > 0 ? Math.max(0.5, ahead / 3) : 0;
    return selectPathsInPixelWindow(
      layout.value.map,
      params.entries.value,
      {
        scrollTop: params.scrollTop.value,
        viewportHeight: params.containerHeight.value,
        aheadScreens: ahead,
        behindScreens: behind,
        idleScreens: idle,
      },
    );
  });

  /**
   * 尺寸预读 paths（v0.1.0-module3.0.8 fix）：以 thumbnailWindows 像素窗口为中心
   * （visible+ahead+behind），过滤已测量，截断到 DIMENSION_BATCH_SIZE。
   *
   * 旧 nextBatchPaths 用 measuredMap.size 当连续前缀起点，reader 返回瀑布流深处时
   * measuredMap 清空 → 仍从 p0 读 → 视口附近的图永远拿不到真实尺寸 → 用偏纵向的
   * avgRatio 估算 → 横向图被估算成纵向高度（如 447×760）→ 大片纵向空白。
   *
   * 新方案不依赖 measuredCount 连续前缀，直接读像素窗口——返回深处时第一批尺寸
   * 请求就是视口附近，真实尺寸到达后卡片从错误占位收敛为正确比例。配合 useMasonryLayout
   * 的 resize viewport anchor，尺寸收敛期间的视觉跳动也被锚定恢复。
   */
  const dimensionPrefetchPaths = computed<string[]>(() => {
    const w = thumbnailWindows.value;
    const candidates = [...w.visible, ...w.ahead, ...w.behind];
    const measured = params.measuredMap.value;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of candidates) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (measured.has(p)) continue;
      out.push(p);
      if (out.length >= DIMENSION_BATCH_SIZE) break;
    }
    return out;
  });

  return { colWidth, layout, visibleRange, measuredCount, prefetchPaths, thumbnailWindows, dimensionPrefetchPaths };
}
