/**
 * 输入绑定——键盘/鼠标/滚轮到 ReaderCommand 的纯函数映射
 *
 * 设计与 DESIGn §14.1 + §15.3 + §15.4 严格对齐。
 * 默认键位与 MiraPage Android 1:1,可由设置覆盖。
 *
 * 为什么纯函数？
 * - 单测友好（无 DOM 副作用）
 * - 同一映射可被 useReaderHotkeys composable + SettingsView 的"录制键位" UI 共用
 */
export type ReaderCommand =
  | 'nextPage'
  | 'prevPage'
  | 'openMainMenu'
  | 'toggleChrome'
  | 'jumpFirst'
  | 'jumpLast'
  | 'fitWidth'
  | 'openFileBrowser'
  | 'folderNext'
  | 'folderPrev'
  | 'slideshowToggle';

export interface KeyBindings {
  nextPage: string[];
  prevPage: string[];
  openMainMenu: string[];
  toggleChrome: string[];
  jumpFirst: string[];
  jumpLast: string[];
  fitWidth: string[];
  openFileBrowser: string[];
  folderNext: string[];
  folderPrev: string[];
  slideshowToggle: string[];
}

/**
 * 默认键位（与 Android TouchScheme 映射一致；macOS / Win / Linux 通用）
 * 详见 DESIGn §15.9 完整映射表
 */
export const defaultKeyBindings: KeyBindings = {
  nextPage: ['ArrowRight', 'PageDown'],
  prevPage: ['ArrowLeft', 'PageUp'],
  openMainMenu: ['Escape', 'm'],
  toggleChrome: ['c', 'Ctrl+h'],
  jumpFirst: ['Home'],
  jumpLast: ['End'],
  fitWidth: ['w'],
  openFileBrowser: ['b'],
  folderNext: ['Alt+ArrowRight'],
  folderPrev: ['Alt+ArrowLeft'],
  slideshowToggle: [' ', 'p', 'F5'],
};

/** 把 KeyboardEvent 归一化为 "Ctrl+Alt+Shift+key" 字符串（与 bindings key 比对） */
function normalizeKey(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && event.key.length > 1) parts.push('Shift');
  parts.push(event.key);
  return parts.join('+');
}

/** 字母键大小写不敏感: "c" == "C" */
function matchesKey(binding: string, key: string): boolean {
  return binding.toLowerCase() === key.toLowerCase();
}

/** 在某个 action 的所有绑定里查找与 keyboard key 匹配的 */
function findKeyboardCommand(
  key: string,
  bindings: KeyBindings,
): ReaderCommand | null {
  const lower = key.toLowerCase();
  const commands = Object.keys(bindings) as Array<keyof KeyBindings>;
  for (const cmd of commands) {
    for (const b of bindings[cmd]) {
      // 修饰键格式 "Ctrl+h" 需要精确比对 ctrl 状态
      if (b.includes('+')) {
        if (b.toLowerCase() === lower) return cmd as ReaderCommand;
      } else {
        // 无修饰键 binding → 仅比对单字符键名
        if (matchesKey(b, key)) return cmd as ReaderCommand;
      }
    }
  }
  return null;
}

/** 把 mouse event + 视口尺寸映射到 3×3 区域 → 命令 */
function mouseRegionCommand(
  ev: MouseEvent,
  width: number,
  height: number,
): ReaderCommand | null {
  if (ev.button !== 0) return null; // 仅左键
  const x = ev.clientX / Math.max(1, width);
  const y = ev.clientY / Math.max(1, height);
  // 顶 1/3 → openFileBrowser
  if (y < 1 / 3) {
    return x < 1 / 3 ? 'prevPage' : x > 2 / 3 ? 'nextPage' : 'openFileBrowser';
  }
  // 底 1/3 → openMainMenu (与 Android 一致)
  if (y > 2 / 3) {
    return x < 1 / 3 ? 'prevPage' : x > 2 / 3 ? 'nextPage' : 'openMainMenu';
  }
  // 中 1/3 → openMainMenu（中心点击）
  return x < 1 / 3 ? 'prevPage' : x > 2 / 3 ? 'nextPage' : 'openMainMenu';
}

/** resolveHotkey 输入上下文 */
export type InputContext =
  | { kind: 'keyboard' }
  | { kind: 'mouse'; width: number; height: number }
  | { kind: 'wheel' };

/**
 * 把任意输入事件解析为 ReaderCommand
 * @param event  KeyboardEvent / MouseEvent / WheelEvent
 * @param bindings 当前键位绑定
 * @param ctx 事件类型 + 视口尺寸（仅 mouse 需要）
 */
export function resolveHotkey(
  event: KeyboardEvent | MouseEvent | WheelEvent,
  bindings: KeyBindings,
  ctx?: InputContext,
): ReaderCommand | null {
  if ('deltaY' in (event as WheelEvent)) {
    const w = event as WheelEvent;
    if (w.deltaY > 0) return 'nextPage';
    if (w.deltaY < 0) return 'prevPage';
    return null;
  }
  if ('clientX' in (event as MouseEvent) && ctx?.kind === 'mouse') {
    return mouseRegionCommand(event as MouseEvent, ctx.width, ctx.height);
  }
  if ('key' in (event as KeyboardEvent)) {
    const key = normalizeKey(event as KeyboardEvent);
    return findKeyboardCommand(key, bindings);
  }
  return null;
}
