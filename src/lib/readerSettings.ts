// src/lib/readerSettings.ts
// 阅读器设置相关枚举与默认值。对齐 PerfectViewer AppSettings.kt 的语义，名称按桌面端 kebab 约定改写。
// 无 Vue / Pinia / Tauri 依赖，可独立测试。

export type ScaleMode =
  | 'fit-screen' | 'fit-width' | 'fit-height'
  | 'original' | 'full-screen';

export type ReadDirection = 'ltr' | 'rtl';

export type TouchZone =
  | 'tl' | 'tm' | 'tr'
  | 'ml' | 'mm' | 'mr'
  | 'bl' | 'bm' | 'br';

export const TOUCH_ZONES: TouchZone[] = [
  'tl', 'tm', 'tr',
  'ml', 'mm', 'mr',
  'bl', 'bm', 'br',
] as const;

/** Full-name mapping for DB key (e.g. 'tl' → 'top_left'). Aligns with PV export key names. */
export const TOUCH_ZONE_KEY: Record<TouchZone, string> = {
  tl: 'top_left', tm: 'top_center', tr: 'top_right',
  ml: 'mid_left', mm: 'mid_center', mr: 'mid_right',
  bl: 'bot_left', bm: 'bot_center', br: 'bot_right',
};

/** 11 个对外可选动作（toggle-chrome 已弃用） */
export type TouchAction =
  | 'none'
  | 'prev-page' | 'next-page'
  | 'jump-first' | 'jump-last'
  | 'open-main-menu'
  | 'slideshow-toggle'
  | 'fit-width'
  | 'folder-prev' | 'folder-next'
  | 'open-file-browser';

export const TOUCH_ACTIONS: TouchAction[] = [
  'none',
  'prev-page', 'next-page',
  'jump-first', 'jump-last',
  'open-main-menu',
  'slideshow-toggle',
  'fit-width',
  'folder-prev', 'folder-next',
  'open-file-browser',
] as const;

export const DEFAULT_TOUCH_SCHEME: Record<TouchZone, TouchAction> = {
  tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
  ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
  bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
};

export const DEFAULT_SCALE_MODE: ScaleMode = 'fit-screen';
export const DEFAULT_READ_DIRECTION: ReadDirection = 'ltr';

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
