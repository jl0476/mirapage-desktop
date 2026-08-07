import { describe, it, expect } from 'vitest';
import { imageDimensions } from './imageHeader';

// 与 Rust algorithm/image_header.rs 测试字节流一致
function makeJpeg(w: number, h: number): Uint8Array {
  const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...'JFIF\x00'.split('').map(c => c.charCodeAt(0)), 0x01, 0x02, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0x00];
  // 注：最后一个 0x00 是 pad，对齐 Rust make_jpeg 的 "pad to 14-byte payload so length=16 is consistent"。
  // APP0 length=16 包含 length 字段自身 2B，所以 payload 须 14B；JFIF\x00(5) + density(8) = 13，需补 1B。
  // 不补的话 parser 会跳过 length=16 后落在 SOF0 payload 上（非 0xff 字节），扫不到 SOF0 marker。
  b.push(0xff, 0xc0, 0x00, 0x11, 0x08);
  b.push((h >> 8) & 0xff, h & 0xff); // height BE
  b.push((w >> 8) & 0xff, w & 0xff); // width BE
  b.push(0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  return new Uint8Array(b);
}

describe('imageHeader', () => {
  it('解析 JPEG 尺寸', () => {
    const dim = imageDimensions(makeJpeg(800, 600))!;
    expect(dim.width).toBe(800);
    expect(dim.height).toBe(600);
  });

  it('非图片返回 null', () => {
    expect(imageDimensions(new Uint8Array([0, 0, 0]))).toBeNull();
  });

  it('PNG 解析', () => {
    const b = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x07, 0x80, // width 1920
      0x00, 0x00, 0x04, 0x38, // height 1080
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    const dim = imageDimensions(b)!;
    expect(dim.width).toBe(1920);
    expect(dim.height).toBe(1080);
  });

  it('GIF 解析', () => {
    const b = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xC8, 0x00, 0x96, 0x00]); // GIF89a, w=200 LE, h=150 LE
    const dim = imageDimensions(b)!;
    expect(dim.width).toBe(200);
    expect(dim.height).toBe(150);
  });
});
