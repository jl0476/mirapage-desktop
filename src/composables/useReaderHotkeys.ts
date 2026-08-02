/**
 * useReaderHotkeys — 阅读器全局键盘 / 鼠标 / 滚轮绑定
 *
 * - onMounted 注册 window.addEventListener('keydown' | 'wheel' | 'mousedown')
 * - 通过 resolveHotkey(event, defaultKeyBindings, ctx) → ReaderCommand
 * - 派发到 reader store action
 * - onBeforeUnmount 解绑所有 listener
 *
 * 依赖:
 * - src/lib/inputBindings.ts:resolveHotkey（DESIGn §14.1 纯函数映射）
 * - src/stores/reader.ts:useReaderStore（state machine）
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { resolveHotkey, defaultKeyBindings, type ReaderCommand } from '@/lib/inputBindings';

function dispatch(store: ReturnType<typeof useReaderStore>, cmd: ReaderCommand): void {
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

  function onMousedown(e: MouseEvent): void {
    const cmd = resolveHotkey(e, defaultKeyBindings, {
      kind: 'mouse',
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (cmd) dispatch(store, cmd);
  }

  onMounted(() => {
    // v0.1.0-module3.0.2-hotfix6 (H12): 删 wheel listener
    // useReaderWheel 已接管 wheel 翻页 (containerRef 范围, 节流 250ms).
    // 老代码 wheel 同时挂 window (热键 dispatch) + containerRef (useReaderWheel),
    // 一次滚动触发 2 次 nextPage (从 spread 0 → spread 2, 单页模式跳 2 张).
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('mousedown', onMousedown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('mousedown', onMousedown);
  });
}