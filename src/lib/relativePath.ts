/**
 * relativePath.ts — source-relative path 校验器（纯函数）
 *
 * 语义与 `src-tauri/src/algorithm/path.rs::validate_source_relative` 1:1。
 * 改一边务必同步另一边（CLAUDE.md §3.5 算法双实现）。
 *
 * 目录身份模型：DirectoryIdentity = SourceDescriptor + sourceRelativePath。
 * 绝对路径只允许出现在 SourceDescriptor.rootPath；
 * currentPath / lastFetchedPath / browse_history.rel_path / library.absolute_path
 * (语义即 sourceRelPath) / shortcut.rel_path / thumbnail_cache.rel_path
 * 一律必须是相对 root 的路径，根目录以空串 '' 表示。
 *
 * 校验规则（拒绝即返回 { ok: false, reason }）：
 *   - nul:          含 NUL 字节 (\0)
 *   - unc:          UNC 路径 (\\server 或 //server 开头)
 *   - drive:        Windows 盘符 (^[A-Za-z]:)
 *   - absolute:     以 / 或 \ 开头的单分隔符绝对路径
 *   - dotdot:       任一段 === '..'（父目录引用，禁止遍历）
 *   - empty-segment: 保留位（当前实现靠 normalize 吸收，不会触发；留作未来严格模式）
 *
 * 接受：'' / 'a' / 'a/b' / 'a\\b'（持久化前统一为 /）。
 * 成功返回 { ok: true, normalized }，normalized 为 / 分隔、去多余分隔符的规范串。
 */
import { PathUtils } from './path';

export type RelPathReason =
  | 'empty-segment'
  | 'absolute'
  | 'drive'
  | 'unc'
  | 'dotdot'
  | 'nul';

export type RelPathValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: RelPathReason };

// Windows 盘符前缀：F: / c: 等（大小写不限），紧跟冒号。
// 注意：仅匹配"段首盘符"，普通文件名含冒号（罕见）不在拒绝范围。
const DRIVE_RE = /^[A-Za-z]:/;

// UNC 前缀：两个分隔符开头（\\server 或 //server）。
function isUncLike(input: string): boolean {
  return /^(\\\\|\/\/)/.test(input);
}

/**
 * 校验并标准化 source-relative path。根目录 '' 合法。
 * 非 string 输入（防御性）按 nul 类非法处理 —— 返回 absolute。
 * （调用方应保证传 string；此处不抛，保持纯函数 + 可测。）
 */
export function validateSourceRelativePath(input: string): RelPathValidation {
  // 1. NUL 字节（字节级最早检查）
  if (input.includes('\0')) {
    return { ok: false, reason: 'nul' };
  }

  // 2. UNC（双分隔符开头，优先于单分隔符 absolute）
  if (isUncLike(input)) {
    return { ok: false, reason: 'unc' };
  }

  // 3. Windows 盘符
  if (DRIVE_RE.test(input)) {
    return { ok: false, reason: 'drive' };
  }

  // 4. 单分隔符开头的绝对路径（/x 或 \x，但已排除 \\ 双分隔符 UNC）
  if (input.startsWith('/') || input.startsWith('\\')) {
    return { ok: false, reason: 'absolute' };
  }

  // 5. 切段，查 .. 遍历
  //    PathUtils.segments 会把 \\ → /、split、filter 空段，
  //    所以空串 / 多余分隔符都会被吸收，不触发 empty-segment。
  const segs = PathUtils.segments(input);
  if (segs.some((s) => s === '..')) {
    return { ok: false, reason: 'dotdot' };
  }

  // 6. 通过 → normalized 为 / join
  return { ok: true, normalized: segs.join('/') };
}

/**
 * 便捷封装：校验通过返回 normalized，否则返回 null。
 * 调用方拿到 null 自行决定（log + 不写库 / 不发 IPC）。
 */
export function normalizeSourceRelativePath(input: string): string | null {
  const r = validateSourceRelativePath(input);
  return r.ok ? r.normalized : null;
}
