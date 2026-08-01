/**
 * useReaderWheel.ts — 桌面端 (Windows/macOS) 鼠标滚轮翻页
 *
 * v0.1.0-module2.0: 参考 Perfect-Viewer 音量键模式.
 *  - 滚轮向下 (deltaY > 0) → 下一页
 *  - 滚轮向上 (deltaY < 0) → 上一页
 *  - 250ms 节流 (避免 Mac 触控板惯性触发多页)
 *  - passive: false → preventDefault 阻止页面整体滚动
 *
 * 不依赖 OpenSeadragon: OSD 内部已 disable 鼠标滚轮缩放, 我们接管.
 * 也不影响 OpenSeadragon 的拖动 / 双击缩放.
 */
import { onMounted, onUnmounted, type Ref } from 'vue';

export interface UseReaderWheelOptions {
  /** 滚轮容器的 ref (Vue 模板里的 <div ref="container">) */
  containerRef: Ref<HTMLElement | null>;
  onPrev: () => void;
  onNext: () => void;
  /** 节流毫秒, 默认 250ms */
  throttleMs?: number;
  /** 禁用 (例如打开 Dialog 时让底层仍滚动) */
  disabled?: Ref<boolean>;
}

export function useReaderWheel(opts: UseReaderWheelOptions): void {
  const THROTTLE_MS = opts.throttleMs ?? 250;
  let lastFireAt = 0;

  function onWheel(e: WheelEvent): void {
    if (opts.disabled?.value) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastFireAt < THROTTLE_MS) return;
    lastFireAt = now;
    if (e.deltaY > 0) opts.onNext();
    else if (e.deltaY < 0) opts.onPrev();
  }

  onMounted(() => {
    const el = opts.containerRef.value;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
  });

  onUnmounted(() => {
    const el = opts.containerRef.value;
    if (!el) return;
    el.removeEventListener('wheel', onWheel);
  });
}
