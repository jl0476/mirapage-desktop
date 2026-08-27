// Mime 工具
// 与 Rust `algorithm::mime` 语义一致

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif']);
const ARCHIVE_EXTS = new Set(['cbz', 'cbr', 'zip', 'rar', '7z']);

export function extensionOf(name: string): string | null {
  const lastDot = name.lastIndexOf('.');
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastDot === -1 || lastDot < lastSlash) return null;
  return name.slice(lastDot + 1).toLowerCase();
}

export function isImage(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== null && IMAGE_EXTS.has(ext);
}

export function isArchive(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== null && ARCHIVE_EXTS.has(ext);
}

/** masonry 图片卡统一判定（2026-08-27 混排占位，审查 P1）：类型标记优先于扩展名。
 *  目录可合法命名为 cover.jpg——仅按扩展名会把它送进尺寸/缩略图队列并渲染 spinner。
 *  对齐 useMasonryBrowsePosition/useReaderActions 的 !isDirectory && isImage 既有语义，
 *  补 !isArchive 防御（结构上可能存在图片扩展名 + isArchive 的条目）。 */
export function isMasonryImage(e: { name: string; isDirectory: boolean; isArchive: boolean }): boolean {
  return !e.isDirectory && !e.isArchive && isImage(e.name);
}

export function mimeFromName(name: string): string | null {
  const ext = extensionOf(name);
  if (!ext) return null;
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    default:
      return null;
  }
}

/**
 * 把 MIME 字符串 (e.g. 'image/jpeg') 归类到大类 (e.g. 'image').
 * 用于 details 视图 Type 列的 i18n 翻译键生成.
 *
 *   getMimeCategory('image/jpeg')  → 'image'
 *   getMimeCategory('video/mp4')  → 'video'
 *   getMimeCategory('audio/mp3')  → 'audio'
 *   getMimeCategory('text/plain')  → 'text'
 *   getMimeCategory('application/x')  → 'application'
 *   getMimeCategory(null)         → null
 */
export function getMimeCategory(mime: string | null): string | null {
  if (!mime) return null;
  const slash = mime.indexOf('/');
  return slash === -1 ? null : mime.slice(0, slash);
}