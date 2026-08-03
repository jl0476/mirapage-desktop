// src/lib/readerSettings.ts
// 阅读器设置相关枚举与默认值。对齐 PerfectViewer AppSettings.kt 的语义，名称按桌面端 kebab 约定改写。
// 无 Vue / Pinia / Tauri 依赖，可独立测试。

export type ScaleMode =
  | 'fit-screen' | 'fit-width' | 'fit-height'
  | 'original' | 'full-screen' | 'stretch';

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
