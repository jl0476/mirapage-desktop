<script setup lang="ts">
/**
 * ToastHost.vue
 *
 * 通用 toast 渲染组件 — 与 useToast 单例配对。
 * 队列上限 1: 只渲染 toasts[0], 后者替换前者。
 *
 * 样式约定 (对齐 SlideshowToast.vue):
 * - 屏幕底部居中胶囊 (bottom-12 left-1/2 -translate-x-1/2)
 * - bg-surface/90 backdrop-blur-xl rounded-full (与 ReaderOverlay 轮播控制条同款 token)
 * - Teleport to="body" 跳出 reader 容器 z-index; z-[1100]
 * - pointer-events-none 不拦截 OSD canvas 点击穿透
 * - role="status" aria-live="polite" 屏幕阅读器友好
 * - data-test="toast-host" 测试钩子
 *
 * 用法: App.vue 顶层挂一次即可 (单例 ref 全局共享, 不需要多实例)。
 */
import { useToast } from '@/composables/useToast';

const { toasts } = useToast();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="toasts[0]"
      class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
             bg-surface/90 backdrop-blur-xl rounded-full
             px-3 py-1.5 flex items-center text-sm text-white shadow-xl
             pointer-events-none"
      data-test="toast-host"
      role="status"
      aria-live="polite"
    >
      <span>{{ toasts[0].message }}</span>
    </div>
  </Teleport>
</template>
