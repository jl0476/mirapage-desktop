/**
 * PathUtils — TS 镜像
 * 语义与 `src-tauri/src/algorithm/path.rs:1:1`
 *
 * 桌面端**不**用 SAF，路径就是普通字符串（绝对路径）。
 * 这模块只做字符串切片/拼接/面包屑构建，不做 OS 调用。
 */

/** 面包屑中的一项：显示名 + 累积的规范化路径 */
export interface Crumb {
  label: string;
  path: string;
}

/** 把路径切成 segments（按 `/` 或 `\` 分隔），去空段 */
function segmentsImpl(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
}

/** 规范化路径：合并多余分隔符 */
function normalizeImpl(path: string): string {
  return segmentsImpl(path).join('/');
}

/** 拼接路径（base + segment） */
function joinImpl(base: string, segment: string): string {
  const normBase = normalizeImpl(base);
  const normSeg = normalizeImpl(segment);
  if (normBase.length === 0) return normSeg;
  if (normSeg.length === 0) return normBase;
  return `${normBase}/${normSeg}`;
}

/** 取父目录（移除最后一段；无父则返回空串） */
function parentImpl(path: string): string {
  const segs = segmentsImpl(path);
  if (segs.length <= 1) return '';
  return segs.slice(0, -1).join('/');
}

/** 面包屑（每段累计路径，第一项是根标签 + 空路径） */
function crumbsImpl(rootLabel: string, path: string): Crumb[] {
  const segs = segmentsImpl(path);
  const result: Crumb[] = [{ label: rootLabel, path: '' }];
  let acc = '';
  for (const seg of segs) {
    acc = acc.length === 0 ? seg : `${acc}/${seg}`;
    result.push({ label: seg, path: acc });
  }
  return result;
}

/** 命名空间导出（方便 `PathUtils.segments(...)` 调用），与 Rust `PathUtils` 镜像 */
export const PathUtils = {
  segments: segmentsImpl,
  normalize: normalizeImpl,
  join: joinImpl,
  parent: parentImpl,
  crumbs: crumbsImpl,
} as const;
