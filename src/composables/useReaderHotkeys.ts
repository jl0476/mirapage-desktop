/**
 * useReaderHotkeys — 阅读器全局键盘绑定
 *
 * v0.1.0-reader-review-fix: 移除 window 上的 mousedown listener.
 *  - 原 onMousedown 在 window 上监听所有 mousedown → 按鼠标位置派发 prev/next,
 *    与 9 宫格 useReaderTouchZones + 顶栏/底栏按钮 click 冲突 (用户报告:
 *    点击 btn-mode 后变成下一页).
 *  - 鼠标位置派发逻辑与 9 宫格重复 (9 宫格已接管屏幕分区点击).
 *  - 仅保留 keyboard + wheel (后者由 useReaderWheel 在容器内独立处理).
 *
 * - onMounted 注册 window.addEventListener('keydown')
 * - 通过 resolveHotkey(event, defaultKeyBindings, ctx) → ReaderCommand
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
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter, type Router } from 'vue-router';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { resolveHotkey, defaultKeyBindings, type ReaderCommand } from '@/lib/inputBindings';

function dispatch(store: ReturnType<typeof useReaderStore>, router: Router, cmd: ReaderCommand): void {
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
    case 'folderNext':
    case 'folderPrev':
      // TODO(Phase 5/Phase 2 扩展): 接到对应实现
      break;
  }
}

export function useReaderHotkeys(): void {
  const store = useReaderStore();
  // v0.1.0-module3.0.3-hotfix6: 在 setup 阶段捕获 router (有 Vue inject 上下文),
  // 传入 dispatch. 之前在 dispatch 内调 useRouter() 在 window listener 上下文执行,
  // 拿不到 inject → router undefined → Escape 静默 no-op.
  const router = useRouter();

  function onKeydown(e: KeyboardEvent): void {
    const cmd = resolveHotkey(e, defaultKeyBindings);
    if (cmd) dispatch(store, router, cmd);
  }

  onMounted(() => {
    // v0.1.0-module3.0.2-hotfix6 (H12): 删 wheel listener
    // useReaderWheel 已接管 wheel 翻页 (containerRef 范围, 节流 250ms).
    // 老代码 wheel 同时挂 window (热键 dispatch) + containerRef (useReaderWheel),
    // 一次滚动触发 2 次 nextPage (从 spread 0 → spread 2, 单页模式跳 2 张).
    //
    // v0.1.0-reader-review-fix: 删 mousedown listener.
    // 与 9 宫格 click + chrome 按钮 click 冲突 (见上方注释).
    window.addEventListener('keydown', onKeydown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
  });
}