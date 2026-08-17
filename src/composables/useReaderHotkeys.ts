/**
 * useReaderHotkeys — 阅读器全局键盘绑定
 *
 * v0.1.0-reader-review-fix: 移除 window 上的 mousedown listener.
 *  - 原 onMousedown 在 window 上监听所有 mousedown → 按鼠标位置派发 prev/next,
 *    与顶栏/底栏按钮 click 冲突 (用户报告: 点击 btn-mode 后变成下一页).
 *  - 桌面端鼠标点击不承载翻页语义.
 *  - 仅保留 keyboard + wheel (后者由 useReaderWheel 在容器内独立处理).
 *
 * - onMounted 注册 window.addEventListener('keydown')
 * - 通过 resolveHotkey(event, defaultKeyBindings) → ReaderCommand
 * - 派发到 reader store action
 * - onBeforeUnmount 解绑所有 listener
 *
 * 依赖:
 * - src/lib/inputBindings.ts:resolveHotkey（DESIGn §14.1 纯函数映射）
 * - src/stores/reader.ts:useReaderStore（state machine）
 *
 * v0.1.0-module3.0.2-reader-polish (Cluster B #7):
 * - Escape → closeReader → router.back() (was: openMainMenu = store.toggleChrome)
 *
 * v0.1.0-module3.0.3-hotfix5:
 * - Escape 一律回文件浏览器 (router.push('/')), 不再 router.back().
 *   之前从 library/bookmarks 进 reader 时, Escape 会回到 library 不符合预期.
 *   useFileBrowserStore 的 savedNavigationContext 由 FileBrowser.onMounted 消费,
 *   恢复嵌套目录 (output/260715) 正确.
 *
 * 2026-08-12 跨卷任务 8 (P1-2 修复): 加 ReaderHotkeyActions 可选参数。
 *  - folderNext / folderPrev 之前是 // TODO no-op，本任务派发到 actions.nextVolume / prevVolume。
 *  - 保持向后兼容：actions 默认 {}，现有调用方（不传 actions）不受影响。
 *  - Alt+→ 跨卷由 ReaderView 注入 crossVolume.maybeContinue(true, 'next')。
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter, type Router } from 'vue-router';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { resolveHotkey, defaultKeyBindings, webtoonKeyBindings, type ReaderCommand } from '@/lib/inputBindings';

/**
 * 2026-08-12 跨卷任务 8: 跨卷相关 hotkey 命令的回调注入。
 * - nextVolume: Alt+→ (folderNext) 触发
 * - prevVolume: Alt+← (folderPrev) 触发（本版 UI 不接 prev，但保留 API 对齐 Android）
 * 字段可选；不传则该 hotkey 静默 no-op。
 */
export interface ReaderHotkeyActions {
  nextVolume?: () => void;
  prevVolume?: () => void;
  isWebtoon?: () => boolean;
  nextPage?: () => void;
  prevPage?: () => void;
  jumpFirst?: () => void;
  jumpLast?: () => void;
}

function dispatch(
  store: ReturnType<typeof useReaderStore>,
  router: Router,
  cmd: ReaderCommand,
  actions: ReaderHotkeyActions,
): void {
  const slideshow = useSlideshowStore();
  switch (cmd) {
    case 'nextPage':
      store.nextPage();
      slideshow.reset();
      break;
    case 'prevPage':
      store.prevPage();
      slideshow.reset();
      break;
    case 'toggleChrome':
      store.toggleChrome();
      break;
    case 'openMainMenu':
      store.toggleChrome(); // 单按钮可同时作 main menu 入口
      break;
    case 'jumpFirst':
      store.jumpToSpread(0);
      slideshow.reset();
      break;
    case 'jumpLast':
      store.jumpToSpread(store.spreads.length - 1);
      slideshow.reset();
      break;
    case 'slideshowToggle':
      slideshow.toggle();
      break;
    case 'closeReader':
      // v0.1.0-module3.0.3-hotfix5: Escape 一律回文件浏览器, 不再 router.back()
      // (router.back 在「library/bookmarks → reader」场景会回到 library, 用户期望
      // 一律回到 file browser). useFileBrowserStore 的 savedNavigationContext 会被
      // FileBrowser.onMounted 自动消费, 嵌套目录 (如 output/260715) 正确恢复.
      // useRouter 不存在 (单测 / SSR) 时容错 no-op
      if (router) {
        router.push('/');
      }
      break;
    case 'fitWidth':
    case 'openFileBrowser':
      // TODO(Phase 5/Phase 2 扩展): 接到对应实现
      break;
    case 'folderNext':
      // 2026-08-12 跨卷任务 8 (P1-2): 派发到 actions.nextVolume（force=true，不看模式）。
      actions.nextVolume?.();
      break;
    case 'folderPrev':
      // 2026-08-12 跨卷任务 8: prevVolume 暂未在 UI 触发（spec §1.2），保留 API 对齐 Android
      actions.prevVolume?.();
      break;
  }
}

export function useReaderHotkeys(actions: ReaderHotkeyActions = {}): void {
  const store = useReaderStore();
  // v0.1.0-module3.0.3-hotfix6: 在 setup 阶段捕获 router (有 Vue inject 上下文),
  // 传入 dispatch. 之前在 dispatch 内调 useRouter() 在 window listener 上下文执行,
  // 拿不到 inject → router undefined → Escape 静默 no-op.
  const router = useRouter();

  function onKeydown(e: KeyboardEvent): void {
    const wt = actions.isWebtoon?.() ?? false;
    const cmd = resolveHotkey(e, wt ? webtoonKeyBindings : defaultKeyBindings);
    if (!cmd) return;
    if (wt) {
      const overrides: Partial<Record<ReaderCommand, (() => void) | undefined>> = {
        nextPage: actions.nextPage,
        prevPage: actions.prevPage,
        jumpFirst: actions.jumpFirst,
        jumpLast: actions.jumpLast,
      };
      const override = overrides[cmd];
      if (override) {
        override();
        return;
      }
    }
    dispatch(store, router, cmd, actions);
  }

  onMounted(() => {
    // v0.1.0-module3.0.2-hotfix6 (H12): 删 wheel listener
    // useReaderWheel 已接管 wheel 翻页 (containerRef 范围, 节流 250ms).
    // 老代码 wheel 同时挂 window (热键 dispatch) + containerRef (useReaderWheel),
    // 一次滚动触发 2 次 nextPage (从 spread 0 → spread 2, 单页模式跳 2 张).
    //
    // v0.1.0-reader-review-fix: 删 mousedown listener.
    // 与 chrome 按钮 click 冲突 (见上方注释).
    window.addEventListener('keydown', onKeydown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
  });
}