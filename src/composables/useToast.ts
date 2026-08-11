/**
 * useToast.ts
 *
 * 通用 toast 单例 composable (项目当前唯一)。
 * 模块级 ref + 单次定时器: 跨组件 / 跨路由共享同一个 toast 队列,
 * 新 push 替换旧 (队列上限 1), 1500ms 自动隐藏。
 *
 * 设计取舍:
 * - 队列上限 1 (而非 N): 跨卷 4 类提示 (无下一卷 / 已跳转 / 失败 / 进度保存失败)
 *   都不需要并发, "后者替换" 比 "按时间堆叠" 更符合 Xplorer / macOS 体验。
 * - 单例: 模块级 ref 而非 createInjectionState / provide/inject —
 *   跨视图跨路由都共享一份, 无需 Provider 包裹。
 * - any 例外: setTimeout 在 Node (Timeout) / happy-dom / 浏览器 (number) 返回类型不同,
 *   用 any 绕过 (与 SlideshowToast.vue:30 同款绕过, spec §13 明确允许)。
 */
import { ref } from 'vue';

export interface ToastItem {
  id: number;
  message: string;
}

const TOAST_DURATION_MS = 1500;

// 模块级单例 — 跨 useToast() 调用共享
const toasts = ref<ToastItem[]>([]);
let nextId = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let timerId: any = null;

export function useToast(): {
  toasts: typeof toasts;
  push: (message: string) => void;
  dismiss: () => void;
} {
  function push(message: string): void {
    const id = nextId++;
    // 队列上限 1: 后者替换
    toasts.value = [{ id, message }];
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      toasts.value = [];
      timerId = null;
    }, TOAST_DURATION_MS);
  }

  function dismiss(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    toasts.value = [];
  }

  return { toasts, push, dismiss };
}
