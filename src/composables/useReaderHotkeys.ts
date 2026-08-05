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
 * v0.1.0-module3.0.3-hotfix (Bug 2):
 * - Escape fallback push('/') 改为先 restoreNavigationContext 再 push,
 *   嵌套目录 (output/260715) 阅读后退回到 output 而非 rootPath.
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useReaderStore } from '@/stores/reader';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useSlideshowStore } from '@/stores/slideshow';
import { resolveHotkey, defaultKeyBindings, type ReaderCommand } from '@/lib/inputBindings';

function dispatch(store: ReturnType<typeof useReaderStore>, cmd: ReaderCommand): void {
  const slideshow = useSlideshowStore();
  const router = useRouter();
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
      // Cluster B #7: Escape → 返回上一个路由 (有 history 时) 或首页
      // useRouter 不存在 (单测 / SSR) 时容错 no-op
      if (router) {
        // 检查当前路由来源, 优先 back, 没有 history 时 push('/')
        const route = useRoute();
        // Vue Router 不暴露 history stack; 用 location 判断 (heuristic)
        // 直接 router.back() 在没有历史时根据 Vue Router 行为 fallback 到 '/'
        // (vue-router 4 在 memory history 下 back() 静默 no-op)
        // 安全起见: 先尝试 back, 然后判断 location 是否仍是 reader 路由
        const before = route.fullPath;
        router.back();
        // 给一个 tick 让 router 处理 (Vue Router 4 是 async-ish)
        setTimeout(() => {
          if (route.fullPath === before) {
            // 没有 history, push 首页. 嵌套目录时需先恢复 (rootPath, currentPath).
            const fb = useFileBrowserStore();
            void fb.restoreNavigationContext().then((restored) => {
              if (!restored && fb.rootPath) {
                void fb.refresh();
              }
              router.push('/');
            });
          }
        }, 0);
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

  function onKeydown(e: KeyboardEvent): void {
    const cmd = resolveHotkey(e, defaultKeyBindings);
    if (cmd) dispatch(store, cmd);
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