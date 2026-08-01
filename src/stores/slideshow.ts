/**
 * Slideshow Pinia store — v0.1.0-module2.0 升级
 *
 * 状态 (settings 持久化):
 * - isPlaying:正在播放
 * - intervalMs:自动推进间隔(毫秒,≥1000)
 * - direction: 'forward' | 'backward'
 * - loop:末页是否循环回首页
 *
 * 运行时:
 * - start():开 setInterval 调 tick()
 * - pause():清 timer
 * - toggle():start/pause
 * - reset():翻页/点击时重置 timer (不影响 isPlaying)
 * - tick():在 start 设置的 timer 内被调 → 翻页;
 *           末页时 pause + 设置 pendingNextVolume flag (让 ReaderScreen watch 调跨卷)
 *
 * **不**直接调 reader store — 避免循环依赖.
 * 翻页用回调 + pendingNextVolume flag.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getSetting, setSetting } from '@/lib/tauri';

export type SlideshowDirection = 'forward' | 'backward';

export const useSlideshowStore = defineStore('slideshow', () => {
  const isPlaying = ref(false);
  const intervalMs = ref(3000);
  const direction = ref<SlideshowDirection>('forward');
  const loop = ref(true);

  // setInterval 在 Node 返回 Timeout, 在 happy-dom 返回 number. 实际仅用作 clearInterval target
  // 在 happy-dom / Node / 浏览器中 setInterval 返回值类型不一致 (number / Timeout)
  // 用 any 绕过
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let timerId: any = null;

  /** 末页触发跨卷后, ReaderScreen watch 此 ref → 调 find_next_volume IPC */
  const pendingNextVolume = ref(false);

  async function load(): Promise<void> {
    const iv = await getSetting('slideshow_interval_ms');
    if (iv !== null) intervalMs.value = Number(iv);
    const loopSet = await getSetting('slideshow_loop');
    if (loopSet !== null) loop.value = loopSet === '1';
    const dir = await getSetting('slideshow_direction');
    if (dir !== null) direction.value = dir as SlideshowDirection;
  }

  async function updateIntervalMs(ms: number): Promise<void> {
    const clamped = Math.max(1000, Math.min(30000, ms));
    intervalMs.value = clamped;
    await setSetting('slideshow_interval_ms', String(clamped));
  }

  async function updateDirection(dir: SlideshowDirection): Promise<void> {
    direction.value = dir;
    await setSetting('slideshow_direction', dir);
  }

  async function updateLoop(loopEnabled: boolean): Promise<void> {
    loop.value = loopEnabled;
    await setSetting('slideshow_loop', loopEnabled ? '1' : '0');
  }

  function start(): void {
    if (isPlaying.value) return;
    isPlaying.value = true;
    schedule();
  }

  function pause(): void {
    isPlaying.value = false;
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function toggle(): void {
    isPlaying.value ? pause() : start();
  }

  /** 用户操作 (翻页/点击/滚轮) 时调. 重置 timer 但不暂停. */
  function reset(): void {
    if (isPlaying.value) {
      if (timerId !== null) clearInterval(timerId);
      schedule();
    }
  }

  function schedule(): void {
    timerId = setInterval(tick, intervalMs.value);
  }

  /** 跨卷意图清空 (ReaderScreen 处理完后调) */
  function consumePendingNextVolume(): boolean {
    const v = pendingNextVolume.value;
    pendingNextVolume.value = false;
    return v;
  }

  /**
   * tick: 翻页 (回调), 末页触发跨卷意图.
   * @param onAdvance - 翻页回调 (ReaderScreen 注入: () => reader.nextPage())
   * @param onPrev - 倒序翻页 (供 direction='backward' 时)
   * @param atLast - 是否已到末页 (ReaderScreen 注入: () => reader.isAtLastSpread.value)
   */
  function tick(
    onAdvance: () => void,
    onPrev: () => void,
    atLast: () => boolean,
  ): void {
    if (atLast()) {
      pause();
      pendingNextVolume.value = true;
      return;
    }
    if (direction.value === 'backward') onPrev();
    else onAdvance();
  }

  return {
    isPlaying,
    intervalMs,
    direction,
    loop,
    pendingNextVolume,
    load,
    updateIntervalMs,
    updateDirection,
    updateLoop,
    start,
    pause,
    toggle,
    reset,
    tick,
    consumePendingNextVolume,
  };
});
