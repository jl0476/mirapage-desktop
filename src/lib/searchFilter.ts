/**
 * searchFilter.ts — 列表页通用搜索过滤纯函数
 *
 * 语义与 FileBrowser 内联搜索一致（v0.1.0-module3.0.3）：
 * 子串匹配、大小写不敏感、trim；空 query（含纯空白）不过滤。
 * 四个列表页（Shortcuts/Likes/Bookmarks/History）共用。
 */

/** query 为空/纯空白 → true（不过滤）；否则任一字段包含 query（大小写不敏感）→ true */
export function matchesAnyField(
  query: string,
  fields: (string | null | undefined)[],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f != null && f.toLowerCase().includes(q));
}
