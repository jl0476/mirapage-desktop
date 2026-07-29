/**
 * findNextDirectory — 跨卷连续阅读算法(TS 镜像)
 *
 * 真实 Rust 实现见 `src-tauri/src/usecase/find_next_directory.rs`。
 * 本文件是同语义 1:1 镜像,用于前端视图层做"下一卷"UI 候选测试。
 *
 * 语义:
 * - 列表按自然排序(数字段长度优先,然后逐位)
 * - 找出 currentPath 在列表中的位置
 * - direction='next' 取下一项,'prev' 取前一项
 * - 返回该项字符串;越界返回 null
 */
import { naturalCompare } from './naturalSort';

export type Direction = 'next' | 'prev';

export function findNextDirectory(
  siblings: string[],
  currentPath: string,
  direction: Direction,
): string | null {
  if (siblings.length === 0) return null;
  // 自然排序(就地排)
  const sorted = [...siblings].sort((a, b) => naturalCompare(a, b));
  const idx = sorted.indexOf(currentPath);
  if (idx === -1) return null;
  const target = direction === 'next' ? idx + 1 : idx - 1;
  if (target < 0 || target >= sorted.length) return null;
  return sorted[target];
}
