/**
 * 文件浏览器内搜索过滤 (对齐 Perfect Viewer SearchFilter.filter + Windows 资源管理器).
 * 仅当前目录非递归, 大小写不敏感子串匹配 entry.name.
 * 空 query 返回原数组引用 (不重建, 保持 Vue 列表 key 和滚动位置).
 */
import type { MediaEntry } from '@/lib/sourceDescriptor';

export function filterByQuery(entries: MediaEntry[], query: string): MediaEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}
