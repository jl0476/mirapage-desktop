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
import { resolveHotkey, defaultKeyBindings, type ReaderCommand } from '@/lib/inputBindings';

function dispatch(store: ReturnType<typeof useReaderStore>, cmd: ReaderCommand): void {
  switch (cmd) {
    case 'nextPage':
      store.nextPage();
      break;
    case 'prevPage':
      store.prevPage();
      break;
    case 'toggleChrome':
      store.toggleChrome();
      break;
    case 'openMainMenu':
      store.toggleChrome(); // 单按钮可同时作 main menu 入口
      break;
    case 'jumpFirst':
      store.jumpToSpread(0);
      break;
    case 'jumpLast':
      store.jumpToSpread(store.spreads.length - 1);
      break;
    case 'fitWidth':
    case 'openFileBrowser':
    case 'folderNext':
    case 'folderPrev':
    case 'slideshowToggle':
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

  function onWheel(e: WheelEvent): void {
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
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('wheel', onWheel);
    window.addEventListener('mousedown', onMousedown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('mousedown', onMousedown);
  });
}