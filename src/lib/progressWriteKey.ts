/**
 * progressWriteKey — progress 写入去重的稳定 key（spec A9 + 审查 P2 v7）。
 *
 * 用 JSON.stringify 结构化序列化，避免字符串拼接分隔符碰撞
 * （descriptor JSON 或 Windows/UNC 路径可能含 `|` 等字符）。
 *
 * 语义：同一 (descriptor, relPath, imageName, finished) 组合 → 同一 key。
 * finished 用 `?? null` 归一化（undefined 与 null 视为同一「普通进度」语义）。
 *
 * 纯函数, 无 Vue/Tauri 依赖, 可独立单测。
 */
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

export function progressWriteKey(
  descriptor: SourceDescriptor,
  relPath: string,
  imageName: string,
  finished: boolean | undefined,
): string {
  return JSON.stringify([descriptor, relPath, imageName, finished ?? null]);
}
