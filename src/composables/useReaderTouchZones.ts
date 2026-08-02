/**
 * useReaderTouchZones.ts — 桌面端阅读屏幕 9 宫格点击检测
 *
 * v0.1.0-module2.0: 参考 Perfect-Viewer TouchScheme.kt.
 *  - 3x3 网格 (上/中/下 × 左/中/右)
 *  - 默认动作: 左上=first / 上中+正中=open-menu / 右上=last
 *               左中=prev / 右中=next / 下中=toggle-slideshow
 *               左下=prev-volume / 右下=next-volume
 *  - click 触发, 不依赖 drag
 *  - 中央 / 上中 都映射 open-menu (用户能稳定打开控制)
 */
import { onMounted, onUnmounted, type Ref } from 'vue';

export type ReaderZoneAction =
  | 'open-menu'
  | 'prev'
  | 'next'
  | 'first'
  | 'last'
  | 'prev-volume'
  | 'next-volume'
  | 'toggle-slideshow';

export interface ReaderZoneConfig {
  tl: ReaderZoneAction;
  tm: ReaderZoneAction;
  tr: ReaderZoneAction;
  ml: ReaderZoneAction;
  mm: ReaderZoneAction;
  mr: ReaderZoneAction;
  bl: ReaderZoneAction;
  bm: ReaderZoneAction;
  br: ReaderZoneAction;
}

export const DEFAULT_READER_ZONES: ReaderZoneConfig = {
  // 3 列
  tl: 'first',
  tm: 'open-menu',   // 顶中 = open-menu
  tr: 'last',
  // 2 列 (中间合并)
  ml: 'prev',
  mm: 'open-menu',   // 中央 (正中) = open-menu
  mr: 'next',
  // 3 列
  bl: 'prev-volume',
  bm: 'toggle-slideshow',  // 底中 = 轮播
  br: 'next-volume',
};

export interface UseReaderTouchZonesOptions {
  containerRef: Ref<HTMLElement | null>;
  zones?: ReaderZoneConfig;
  /**
   * v0.1.0-module3.0.2 (M4): 9 宫格 listener 落在该 selector 容器内的 click
   * 直接忽略. 解决 overlay 顶/底栏按钮被 9 宫格拦截双触发.
   */
  ignoreSelector?: string;
  onAction: (a: ReaderZoneAction) => void;
}

export function useReaderTouchZones(opts: UseReaderTouchZonesOptions): void {
  const zones = opts.zones ?? DEFAULT_READER_ZONES;

  function onClick(e: MouseEvent): void {
    const el = opts.containerRef.value;
    if (!el) return;
    // v0.1.0-module3.0.2 (M4): 落点命中 ignoreSelector 容器内则跳过
    if (opts.ignoreSelector) {
      const target = e.target as Element | null;
      if (target && target.closest(opts.ignoreSelector)) return;
    }
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;   // 0..1
    const yRatio = (e.clientY - rect.top) / rect.height;  // 0..1
    const col: 'l' | 'm' | 'r' = xRatio < 1 / 3 ? 'l' : xRatio < 2 / 3 ? 'm' : 'r';
    const row: 't' | 'm' | 'b' = yRatio < 1 / 3 ? 't' : yRatio < 2 / 3 ? 'm' : 'b';
    const key = (row + col) as keyof ReaderZoneConfig;
    opts.onAction(zones[key]);
  }

  onMounted(() => {
    const el = opts.containerRef.value;
    if (!el) return;
    el.addEventListener('click', onClick);
  });

  onUnmounted(() => {
    const el = opts.containerRef.value;
    if (!el) return;
    el.removeEventListener('click', onClick);
  });
}

/**
 * Zone action → reader 调用映射 (供 ReaderScreen 集成)
 */
export function dispatchZoneAction(
  action: ReaderZoneAction,
  ctx: {
    openMainMenu: () => void;
    prevPage: () => void;
    nextPage: () => void;
    jumpToFirst: () => void;
    jumpToLast: () => void;
    toggleSlideshow: () => void;
    prevVolume: () => void;
    nextVolume: () => void;
  },
): void {
  switch (action) {
    case 'open-menu':       ctx.openMainMenu(); break;
    case 'prev':            ctx.prevPage(); break;
    case 'next':            ctx.nextPage(); break;
    case 'first':           ctx.jumpToFirst(); break;
    case 'last':            ctx.jumpToLast(); break;
    case 'toggle-slideshow':ctx.toggleSlideshow(); break;
    case 'prev-volume':     ctx.prevVolume(); break;
    case 'next-volume':     ctx.nextVolume(); break;
  }
}
