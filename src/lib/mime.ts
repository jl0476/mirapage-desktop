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