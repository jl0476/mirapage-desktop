<script setup lang="ts">
/**
 * ContinueNextVolumeToast.vue — 跨卷连续阅读 manual 模式底部胶囊
 *
 * 设计约束 (P0-2 / P1-5):
 * - **绝不调 useCrossVolume()** — 父级 ReaderView 是 useCrossVolume 单实例所有者
 *   (如果组件自己调, 会拿到第二份 pendingCrossVolume, 胶囊不显示)
 * - 纯 props/emits — 所有数据从 props 进入, 所有动作经 emits 出
 *
 * 样式复用 SlideshowToast.vue (bg-surface/90 backdrop-blur-xl rounded-full),
 * Teleport to="body" 跳出 reader 容器 z-index, z-[1100] 与 ReaderMainMenu 同级。
 * pointer-events-none 容器 + 按钮 pointer-events-auto 防误拦截 OSD canvas。
 * role="dialog" + aria-live="polite" 屏幕阅读器可达。
 */
import { useI18n } from 'vue-i18n';
import type { NextVolumeTarget } from '@/composables/useReaderBookLoader';

defineProps<{
  /** 父级 crossVolume.pendingCrossVolume.value, null 时不渲染 */
  target: NextVolumeTarget | null;
  /** navigating 期间禁用跳转按钮 */
  loading?: boolean;
}>();

defineEmits<{
  /** 父级 crossVolume.confirmManual() */
  (e: 'jump'): void;
  /** 父级 crossVolume.dismissManual() */
  (e: 'close'): void;
}>();

const { t } = useI18n();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="target"
      class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
             bg-surface/90 backdrop-blur-xl rounded-full
             px-4 py-2 flex items-center gap-3
             text-sm text-white shadow-xl pointer-events-none"
      data-test="cross-volume-toast"
      role="dialog"
      aria-live="polite"
    >
      <span>{{ t('reader.crossVolume.continuePrompt', { title: target.title }) }}</span>
      <button
        type="button"
        :disabled="loading"
        class="pointer-events-auto px-2 py-1 rounded text-xs
               text-accent hover:bg-surface-light transition-colors
               disabled:opacity-50 disabled:cursor-not-allowed"
        data-test="cross-volume-jump"
        @click="$emit('jump')"
      >
        {{ t('reader.crossVolume.jump') }}
      </button>
      <button
        type="button"
        class="pointer-events-auto px-2 py-1 rounded text-xs
               text-text-secondary hover:bg-surface-light hover:text-white transition-colors"
        data-test="cross-volume-close"
        :aria-label="t('reader.crossVolume.close')"
        @click="$emit('close')"
      >
        ✕
      </button>
    </div>
  </Teleport>
</template>
