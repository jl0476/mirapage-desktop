/**
 * useSlideshow composable
 *
 * 监听 useSlideshowStore 的 isPlaying,启 / 停 setInterval。
 * 每 intervalMs 触发一次 advance(next):
 * - direction=forward → next = currentPage + 1
 * - direction=backward → next = currentPage - 1
 *
 * 边界:
 * - next < 0 或 >= pageCount:若 loop=true 回 wrap 到另一端,否则 pause
 * - pageCount=0:noop
 *
 * 返回 stop() 用于解绑 watch 与 timer。
 */
import { onBeforeUnmount, watch, type Ref } from 'vue';
import { useSlideshowStore } from '@/stores/slideshow';

export type AdvanceFn = (next: number) => void | Promise<void>;

export function useSlideshow(
  currentPage: Ref<number>,
  pageCount: Ref<number>,
  advance: AdvanceFn,
): () => void {
  const store = useSlideshowStore();
  let timerId: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const total = pageCount.value;
    if (total <= 0) return;
    const step = store.direction === 'forward' ? 1 : -1;
    let next = currentPage.value + step;

    // 边界
    if (next < 0) {
      if (store.loop) next = total - 1;
      else {
        store.pause();
        return;
      }
    } else if (next >= total) {
      if (store.loop) next = 0;
      else {
        store.pause();
        return;
      }
    }

    advance(next);
  }

  function start(): void {
    stop();
    timerId = setInterval(tick, store.intervalMs);
  }

  function stop(): void {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  // isPlaying 启停
  watch(
    () => store.isPlaying,
    (playing) => {
      if (playing) start();
      else stop();
    },
    { immediate: true },
  );

  // intervalMs 变更重启
  watch(() => store.intervalMs, () => {
    if (store.isPlaying) start();
  });

  // direction 变更重启(避免反向 tick 错位)
  watch(() => store.direction, () => {
    if (store.isPlaying) start();
  });

  function dispose(): void {
    stop();
  }

  onBeforeUnmount(dispose);
  return dispose;
}