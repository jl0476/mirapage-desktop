// 缩略图领域协议 — 前后端共享类型 + 设置枚举 + 预设 + 值域归一化
//
// 设计依据：docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md
// 实现计划：docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md
//
// 本文件只暴露「协议层」：枚举、请求/状态类型、固定预设和离散值归一化。
// 内部的尺寸档位选择、大图阈值、像素预算等策略在 Rust `thumbnail/policy.rs`
// 与前端镜像函数中实现，**不**在此向设置层暴露具体数值。

// ─── 资源模式 / 清晰度 / 优先级 枚举 ────────────────────────────────────

/** 资源模式（§8.1）。custom 表示用户已手动改过高级参数，无固定预设。 */
export type ThumbnailResourceMode = 'powerSaver' | 'balanced' | 'performance' | 'custom';

/** 缩略图清晰度（§6.1）。UI 三档，内部映射到 quality_margin/WebP 质量/最大档位。 */
export type ThumbnailQuality = 'standard' | 'high' | 'ultra';

/** 任务优先级（§5.2）。visible > ahead > behind > idle。 */
export type ThumbnailPriority = 'visible' | 'ahead' | 'behind' | 'idle';

// ─── 尺寸档位 ──────────────────────────────────────────────────────────

/**
 * 缩略图输出尺寸档位（§6.1）。
 * 选择「不小于需求宽度的最小档位」；需求宽度 = card_css_width × dpr × quality_margin。
 */
export const THUMBNAIL_SIZE_BUCKETS = [512, 768, 1024, 1536, 2048] as const;
export type ThumbnailSizeBucket = (typeof THUMBNAIL_SIZE_BUCKETS)[number];

// ─── 默认值 ────────────────────────────────────────────────────────────

export const DEFAULT_THUMBNAIL_RESOURCE_MODE: ThumbnailResourceMode = 'balanced';
export const DEFAULT_THUMBNAIL_QUALITY: ThumbnailQuality = 'high';
export const DEFAULT_THUMBNAIL_WORKER_LIMIT = 2;
export const DEFAULT_THUMBNAIL_DECODE_MEMORY_MB = 128;
export const DEFAULT_THUMBNAIL_PREFETCH_SCREENS = 1.5;
export const DEFAULT_THUMBNAIL_IDLE_GENERATION = true;
export const DEFAULT_THUMBNAIL_IDLE_PREFETCH_SCREENS = 1;
export const DEFAULT_THUMBNAIL_CACHE_LIMIT_MB = 512;

// ─── 资源预设（§8.1）────────────────────────────────────────────────────

/** 一个资源预设的全部可调维度。custom 模式无预设，由用户高级参数决定。 */
export interface ThumbnailPreset {
  /** 解码 worker 并发上限（第一阶段 Local 1–4）。 */
  workerLimit: number;
  /** 预计解码内存总预算（MB）。 */
  decodeMemoryMb: number;
  /** 向下预生成范围（屏）。 */
  prefetchScreens: number;
  /** 是否启用停止滚动后的空闲额外生成。 */
  idleGeneration: boolean;
  /** 空闲额外向下预生成范围（屏）；idleGeneration=false 时为 0。 */
  idlePrefetchScreens: number;
}

const PRESETS: Record<Exclude<ThumbnailResourceMode, 'custom'>, ThumbnailPreset> = {
  powerSaver: {
    workerLimit: 1,
    decodeMemoryMb: 64,
    prefetchScreens: 0.5,
    idleGeneration: false,
    idlePrefetchScreens: 0,
  },
  balanced: {
    workerLimit: 2,
    decodeMemoryMb: 128,
    prefetchScreens: 1.5,
    idleGeneration: true,
    idlePrefetchScreens: 1,
  },
  performance: {
    workerLimit: 3,
    decodeMemoryMb: 256,
    prefetchScreens: 2.5,
    idleGeneration: true,
    idlePrefetchScreens: 2,
  },
};

/**
 * 按资源模式名解析固定预设。
 * `custom` 无预设，返回 null —— 由用户在高级设置里填写的 worker/内存/预读决定。
 */
export function resolveThumbnailPreset(mode: ThumbnailResourceMode): ThumbnailPreset | null {
  if (mode === 'custom') return null;
  return PRESETS[mode];
}

// ─── 值域归一化（加载设置时兜底越界/脏值，§14）─────────────────────────

const WORKER_LIMIT_MIN = 1;
const WORKER_LIMIT_MAX = 4;
const DECODE_MEMORY_CHOICES = [64, 128, 256, 512];
const CACHE_LIMIT_MIN_MB = 128;

/** Worker 上限钳到第一阶段 Local 合法范围 [1, 4]。 */
export function normalizeWorkerLimit(value: number): number {
  if (!Number.isFinite(value) || value <= WORKER_LIMIT_MIN) return WORKER_LIMIT_MIN;
  if (value >= WORKER_LIMIT_MAX) return WORKER_LIMIT_MAX;
  return Math.round(value);
}

/**
 * 解码内存预算 snap 到最近的合法档位 {64,128,256,512}；
 * 平手时取较小档（更保守）。低于 64 钳到 64，高于 512 钳到 512。
 */
export function normalizeDecodeMemoryMb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THUMBNAIL_DECODE_MEMORY_MB;
  let best = DECODE_MEMORY_CHOICES[0];
  let bestDist = Infinity;
  for (const choice of DECODE_MEMORY_CHOICES) {
    const dist = Math.abs(value - choice);
    if (dist < bestDist) {
      bestDist = dist;
      best = choice;
    }
    // 平手（dist === bestDist）不更新：保留已记录的较小档位。
  }
  return best;
}

/** 缓存容量上限，仅设最小 128MB；用户自定义更大容量允许，无上界。 */
export function normalizeCacheLimitMb(value: number): number {
  if (!Number.isFinite(value) || value < CACHE_LIMIT_MIN_MB) return CACHE_LIMIT_MIN_MB;
  return Math.floor(value);
}

// ─── 前后端协议类型（§13）──────────────────────────────────────────────

/**
 * 单张缩略图请求项（§13.2）。
 * `requiredWidth` 已在前端按 cardWidth × dpr × quality_margin 算好；
 * `sourceWidth/Height` 为原图物理像素（尚未做 EXIF 方向归一化，Rust 端归一化）。
 */
export interface ThumbnailRequestItem {
  /** 相对当前 root 的图片路径（与 list_directory 返回的 entry.path 同体系）。 */
  path: string;
  /** 原文件字节数。 */
  fileSize: number;
  /** 原文件 modifiedAt（秒），可空。 */
  modifiedAt: number | null;
  /** 原图物理宽度（px）。 */
  sourceWidth: number;
  /** 原图物理高度（px）。 */
  sourceHeight: number;
  /** 本次需求宽度（px），由列宽/DPR/清晰度余量算出。 */
  requiredWidth: number;
  /** 任务优先级。 */
  priority: ThumbnailPriority;
}

/**
 * 单张卡片的缩略图状态（前端状态机，§12.1）。
 * `placeholder` 是「尚无条目」的默认态，不在此联合里（缺省即 placeholder）。
 */
export type ThumbnailState =
  | { kind: 'original'; url: string }
  | { kind: 'cached'; cacheKey: string; path: string; width: number; height: number }
  | { kind: 'queued'; cacheKey: string }
  | { kind: 'generating'; cacheKey: string }
  | { kind: 'failed'; cacheKey: string; retryable: boolean; message: string }
  | { kind: 'unsupported' };

/**
 * Rust 批量请求的同步返回（§13.2）。请求当即能判定的状态：
 * - `original`：小图满足直用条件，前端用原图 URL；
 * - `cached`：命中磁盘缓存，前端用 convertFileSrc(cachePath)；
 * - `queued`：已入队，等 thumbnail-ready 事件；
 * - `failed`：立即失败（如 unsupported_source）。
 */
export interface ThumbnailRequestResult {
  path: string;
  status: 'original' | 'cached' | 'queued' | 'failed';
  cachePath?: string;
  cacheKey?: string;
  width?: number;
  height?: number;
  errorKind?: string;
}
