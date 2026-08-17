/**
 * 输入绑定——键盘/滚轮到 ReaderCommand 的纯函数映射
 *
 * 设计与 DESIGn §14.1 + §15.4 严格对齐。
 * 默认键位与 MiraPage Android 1:1,可由设置覆盖。
 *
 * 为什么纯函数？
 * - 单测友好（无 DOM 副作用）
 * - 同一映射可被 useReaderHotkeys composable + SettingsView 的"录制键位" UI 共用
 *
 * v0.1.0-module3.0.2-reader-polish (Cluster B #7):
 * - Escape 从 openMainMenu 移到 closeReader (返回文件浏览器, router.back)
 * - openMainMenu 仅保留 'm' (不再被 ESC 触发)
 * v0.1.0-module3.0.12: 鼠标 3×3 分区映射随 9 宫格功能移除,只保留键盘/滚轮。
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
  | 'slideshowToggle'
  | 'closeReader';

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
  closeReader: string[];
}

/**
 * 默认键位（与 Android 键位语义一致；macOS / Win / Linux 通用）
 * 详见 DESIGn §15.9 完整映射表
 *
 * v0.1.0-module3.0.2-reader-polish:
 * - Escape 改映射 closeReader (was: openMainMenu)
 * - m 仍 openMainMenu
 */
export const defaultKeyBindings: KeyBindings = {
  nextPage: ['ArrowRight', 'PageDown'],
  prevPage: ['ArrowLeft', 'PageUp'],
  openMainMenu: ['m'],
  toggleChrome: ['c', 'Ctrl+h'],
  jumpFirst: ['Home'],
  jumpLast: ['End'],
  fitWidth: ['w'],
  openFileBrowser: ['b'],
  folderNext: ['Alt+ArrowRight'],
  folderPrev: ['Alt+ArrowLeft'],
  slideshowToggle: [' ', 'p', 'F5'],
  closeReader: ['Escape'],
};
export const webtoonKeyBindings: KeyBindings = {
  ...defaultKeyBindings,
  prevPage: ['PageUp', 'ArrowUp'],
  nextPage: ['PageDown', 'ArrowDown'],
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

/**
 * 把任意输入事件解析为 ReaderCommand
 * @param event  KeyboardEvent / WheelEvent
 * @param bindings 当前键位绑定
 */
export function resolveHotkey(
  event: KeyboardEvent | MouseEvent | WheelEvent,
  bindings: KeyBindings,
): ReaderCommand | null {
  if ('deltaY' in (event as WheelEvent)) {
    const w = event as WheelEvent;
    if (w.deltaY > 0) return 'nextPage';
    if (w.deltaY < 0) return 'prevPage';
    return null;
  }
  if ('key' in (event as KeyboardEvent)) {
    const key = normalizeKey(event as KeyboardEvent);
    return findKeyboardCommand(key, bindings);
  }
  return null;
}
