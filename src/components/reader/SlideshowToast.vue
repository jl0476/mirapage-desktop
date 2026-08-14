<script setup lang="ts">
/**
 * SlideshowToast.vue — v0.1.0-module3.0.3
 *
 * 按 Space / 右键 / Overlay 按钮切换 slideshow 时, 在屏幕底部居中弹出一个胶囊,
 * 复用 ReaderOverlay 轮播控制条同款 token (bg-surface/90 backdrop-blur-xl rounded-full)。
 *
 * **触发源**: watch slideshow.isPlaying flip —— 与现有 watch(pendingNextVolume) 同款。
 * **时长**: 1500ms 后自动隐藏; 期间再次翻转则重置计时器。
 * **文案**: i18n key slideshow.statusStarted / slideshow.statusPaused (zh-CN + en-US)。
 * **图标**: Play / Pause SVG 11px (与 ReaderOverlay.vue:234-240 同步, 不抽常量 — Pause 用 2 <rect>)。
 *
 * **Teleport to="body"**: 跳出 reader 容器 z-index; z-[1100] 与 ReaderMainMenu 同级。
 * **pointer-events-none**: 不拦截 OSD canvas 的点击穿透。
 * **role="status" + aria-live="polite"**: 屏幕阅读器友好。
 */
import { onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSlideshowStore } from '@/stores/slideshow';

const slideshow = useSlideshowStore();
const { t } = useI18n();

const isVisible = ref(false);
/** toast 显示那一刻的 isPlaying 快照, 避免 store 翻回去时 UI 文案/图标跟随翻转 */
const currentIsPlaying = ref(false);

// setTimeout 在 Node / happy-dom / 浏览器返回类型不一致 (number / Timeout) — 用 any 绕过
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let timerId: any = null;

const TOAST_DURATION_MS = 1500;

function showToast(isPlaying: boolean): void {
  currentIsPlaying.value = isPlaying;
  isVisible.value = true;
  if (timerId !== null) clearTimeout(timerId);
  timerId = setTimeout(() => {
    isVisible.value = false;
    timerId = null;
  }, TOAST_DURATION_MS);
}

watch(() => slideshow.isPlaying, (next) => {
  showToast(next);
});

onUnmounted(() => {
  if (timerId !== null) clearTimeout(timerId);
  timerId = null;
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isVisible"
      class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
             bg-surface/90 backdrop-blur-xl rounded-full
             px-3 py-1.5 flex items-center gap-2 text-sm text-white shadow-xl
             pointer-events-none"
      data-test="slideshow-toast"
      role="status"
      aria-live="polite"
    >
      <svg v-if="currentIsPlaying" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
      <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 5v14l12-7z" />
      </svg>
      <span>{{ currentIsPlaying ? t('slideshow.statusStarted') : t('slideshow.statusPaused') }}</span>
    </div>
  </Teleport>
</template>