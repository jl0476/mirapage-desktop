/**
 * 纯格式化函数（无 locale 依赖；locale 相关的日期时间在 locales/helpers.ts）。
 */

/** 本地时间戳 yyyyMMdd_HHmmss（导出文件名用，对齐 Android 命名）。 */
export function formatExportTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function browseHistoryExportFileName(now: Date = new Date()): string {
  return `browse_history_${formatExportTimestamp(now)}.json`;
}
