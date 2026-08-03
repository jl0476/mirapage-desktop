/**
 * useReaderTouchZones.ts — 桌面端阅读屏幕 9 宫格点击检测
 *
 * v0.1.0-module3.0: 动作源从硬编码 DEFAULT_READER_ZONES 改为 settings.touchScheme.
 *  - 3x3 网格 (上/中/下 × 左/中/右), 命中后查 store.touchScheme[key].
 *  - 默认映射对齐 PerfectViewer TouchScheme.DEFAULT (src/lib/readerSettings.ts).
 *  - 点击触发, 不依赖 drag.
 */
import { onMounted, onUnmounted, type Ref } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import type { TouchAction, TouchZone } from '@/lib/readerSettings';

export type ReaderZoneAction = TouchAction;

export interface UseReaderTouchZonesOptions {
  containerRef: Ref<HTMLElement | null>;
  /**
   * v0.1.0-module3.0.2 (M4): 9 宫格 listener 落在该 selector 容器内的 click 直接忽略.
   * 解决 overlay 顶/底栏按钮被 9 宫格拦截双触发.
   */
  ignoreSelector?: string;
  onAction: (a: TouchAction) => void;
}

export function useReaderTouchZones(opts: UseReaderTouchZonesOptions): void {
  const settings = useSettingsStore();

  function onClick(e: MouseEvent): void {
    const el = opts.containerRef.value;
    if (!el) return;
    if (opts.ignoreSelector) {
      const target = e.target as Element | null;
      if (target && target.closest(opts.ignoreSelector)) return;
    }
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    const col: 'l' | 'm' | 'r' = xRatio < 1 / 3 ? 'l' : xRatio < 2 / 3 ? 'm' : 'r';
    const row: 't' | 'm' | 'b' = yRatio < 1 / 3 ? 't' : yRatio < 2 / 3 ? 'm' : 'b';
    const key = (row + col) as TouchZone;
    opts.onAction(settings.touchScheme[key]);
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
 * Zone action → reader 调用映射 (供 ReaderView 集成)
 */
export function dispatchZoneAction(
  action: TouchAction,
  ctx: {
    openMainMenu: () => void;
    prevPage: () => void;
    nextPage: () => void;
    jumpToFirst: () => void;
    jumpToLast: () => void;
    toggleSlideshow: () => void;
    prevVolume: () => void;
    nextVolume: () => void;
    fitWidth: () => void;
    openFileBrowser: () => void;
  },
): void {
  switch (action) {
    case 'none': /* noop */ break;
    case 'prev-page':         ctx.prevPage(); break;
    case 'next-page':         ctx.nextPage(); break;
    case 'jump-first':        ctx.jumpToFirst(); break;
    case 'jump-last':         ctx.jumpToLast(); break;
    case 'open-main-menu':    ctx.openMainMenu(); break;
    case 'slideshow-toggle':  ctx.toggleSlideshow(); break;
    case 'fit-width':         ctx.fitWidth(); break;
    case 'folder-prev':       ctx.prevVolume(); break;
    case 'folder-next':       ctx.nextVolume(); break;
    case 'open-file-browser': ctx.openFileBrowser(); break;
  }
}
