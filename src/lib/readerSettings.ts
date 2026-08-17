// src/lib/readerSettings.ts
// 阅读器设置相关枚举与默认值。对齐 PerfectViewer AppSettings.kt 的语义，名称按桌面端 kebab 约定改写。
// 无 Vue / Pinia / Tauri 依赖，可独立测试。

export type ScaleMode =
  | 'fit-screen' | 'fit-width' | 'fit-height'
  | 'original' | 'full-screen';

export type ReadDirection = 'ltr' | 'rtl';

/** 阅读模式（module3.1.0：webtoon = 竖向连续滚动） */
export type ReadMode = 'single' | 'double' | 'webtoon';

export const DEFAULT_SCALE_MODE: ScaleMode = 'fit-screen';
export const DEFAULT_READ_DIRECTION: ReadDirection = 'ltr';
export const DEFAULT_READ_MODE: ReadMode = 'single';

/** 合法 ScaleMode 集合 (用于校验 DB 老数据) */
const VALID_SCALE_MODES: ReadonlySet<ScaleMode> = new Set([
  'fit-screen', 'fit-width', 'fit-height', 'original', 'full-screen',
]);

/**
 * 把 DB 读出的 scale_mode 值规范化为合法 ScaleMode.
 * 老 DB 可能存 'stretch' (已移除档位), fallback 到 DEFAULT_SCALE_MODE.
 */
export function normalizeScaleMode(v: string): ScaleMode {
  return VALID_SCALE_MODES.has(v as ScaleMode) ? (v as ScaleMode) : DEFAULT_SCALE_MODE;
}

const VALID_READ_MODES: ReadonlySet<ReadMode> = new Set(['single', 'double', 'webtoon']);

/** 把 DB 读出的 reader_mode 值规范化为合法 ReadMode。 */
export function normalizeReadMode(v: string): ReadMode {
  return VALID_READ_MODES.has(v as ReadMode) ? (v as ReadMode) : DEFAULT_READ_MODE;
}
