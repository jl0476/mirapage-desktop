// imageHeader.ts — TS 版图片 header 尺寸解析，与 Rust algorithm/image_header.rs 语义一致。
// 仅依赖 DataView，用于 masonry 布局的预估/回退（实际尺寸优先走 Rust IPC）。

export interface Dimensions {
  width: number;
  height: number;
}

export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  return parseJpeg(bytes) ?? parsePng(bytes) ?? parseGif(bytes) ?? parseBmp(bytes);
}

function parseJpeg(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    i += 2;
    // SOFn: C0..CF (不含 C4=DHT, C8=JPG, CC=DAC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // marker 后: [length(2)] [precision(1)] [height(2 BE)] [width(2 BE)]
      if (i + 7 <= bytes.length) {
        const height = dv.getUint16(i + 3);
        const width = dv.getUint16(i + 5);
        return { width, height };
      }
      return null;
    }
    // 其他 marker：读 length 跳过
    if (i + 1 < bytes.length) {
      i += dv.getUint16(i);
    } else {
      return null;
    }
  }
  return null;
}

function parsePng(bytes: Uint8Array): Dimensions | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((s, idx) => bytes[idx] !== s)) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null; // IHDR
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function parseGif(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 10) return null;
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint16(6, true);
  const height = dv.getUint16(8, true);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function parseBmp(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null; // BM
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(18, true);
  const height = Math.abs(dv.getInt32(22, true));
  if (width === 0 || height === 0) return null;
  return { width, height };
}