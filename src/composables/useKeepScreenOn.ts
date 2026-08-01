/**
 * useKeepScreenOn.ts — v0.1.0-module2.0 阅读器屏幕常亮 composable
 *
 * - 监听 enabled ref, 立即 (immediate) 调 keepScreenOn(value)
 * - onUnmounted: 若 enabled.value=true 主动释放 (调 false)
 * - **不**接受 containerRef: 屏幕常亮是全局 OS 调用, 与 DOM 范围无关
 *
 * Rust 端 (commands::keep_screen_on) 已分平台实现:
 * - Windows: SetThreadExecutionState(ES_DISPLAY_REQUIRED|ES_SYSTEM_REQUIRED)
 * - macOS / Linux: stub (Phase 9 跨平台分发时补)
 */
import { onUnmounted, watch, type Ref } from 'vue';
import { keepScreenOn } from '@/lib/tauri';
import { log } from '@/lib/logger';

export function useKeepScreenOn(enabled: Ref<boolean>): void {
  watch(
    enabled,
    async (v) => {
      try {
        await keepScreenOn(v);
      } catch (e) {
        log('[useKeepScreenOn] keepScreenOn failed', e);
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    if (enabled.value) {
      void keepScreenOn(false);
    }
  });
}