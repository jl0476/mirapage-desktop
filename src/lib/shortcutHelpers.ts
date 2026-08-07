/**
 * shortcutHelpers — ShortcutItem 显示派生纯函数 (v0.1.0-module3.0.5)
 *
 * 复用点: ShortcutDropdown.vue / Shortcuts.vue 都需要从 ShortcutItem
 *   解码 descriptor → 拼完整路径 → 取 basename → fallback alias.
 * 抽到 lib/ 便于独立测试 + 避免 DRY 违规.
 *
 * Phase 1 只 Local: 非 Local descriptor 的 shortcut 解码返回 null
 * (Phase 7-8 SMB/WebDAV 实装后扩展).
 */
import type { ShortcutItem } from '@/lib/tauri';
import type { SourceDescriptor, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

/** 解码 shortcut 的 sourceDescriptorJson (失败或非 Local 返回 null) */
export function decodeLocalDescriptor(sc: ShortcutItem): SourceDescriptorLocal | null {
  try {
    const d = JSON.parse(sc.sourceDescriptorJson) as SourceDescriptor;
    if (d.type === 'local') return d;
    return null; // Phase 7-8 前 SMB/WebDAV 不可打开
  } catch {
    return null;
  }
}

/** shortcut 完整路径 (rootPath + relPath 拼接); 非 Local fallback 原始 JSON */
export function shortcutFullPath(sc: ShortcutItem): string {
  const d = decodeLocalDescriptor(sc);
  if (!d) return sc.sourceDescriptorJson;
  return d.rootPath + (sc.relPath ? '/' + sc.relPath : '');
}

/** 路径末段 (basename); 用正则兼容 / 和 \ 分隔 */
export function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 显示标签: alias 优先, 否则 fallback 完整路径的 basename */
export function shortcutDisplayLabel(sc: ShortcutItem): string {
  return sc.alias || pathBasename(shortcutFullPath(sc));
}
