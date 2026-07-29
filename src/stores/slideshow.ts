/**
 * Slideshow Pinia store
 * 状态(从 settings 加载,可实时更新):
 * - isPlaying:正在播放
 * - intervalMs:自动推进间隔(毫秒,≥1000)
 * - direction: 'forward' | 'backward'
 * - loop:末页是否循环回首页
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

  /** 从 settings 表加载(DESIGn §11 设置项) */
  async function load(): Promise<void> {
    const iv = await getSetting('slideshow_interval_ms');
    if (iv !== null) intervalMs.value = Number(iv);
    const loopSet = await getSetting('slideshow_loop');
    if (loopSet !== null) loop.value = loopSet === '1';
    const dir = await getSetting('slideshow_direction');
    if (dir !== null) direction.value = dir as SlideshowDirection;
  }

  /** 更新并持久化单个设置 */
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
    isPlaying.value = true;
  }

  function pause(): void {
    isPlaying.value = false;
  }

  function toggle(): void {
    isPlaying.value = !isPlaying.value;
  }

  return {
    isPlaying,
    intervalMs,
    direction,
    loop,
    load,
    updateIntervalMs,
    updateDirection,
    updateLoop,
    start,
    pause,
    toggle,
  };
});