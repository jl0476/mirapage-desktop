import { describe, expect, it } from 'vitest';
import { bookmarkPageForImage, imageIndexForBookmark } from './bookmarkPage';

describe('bookmarkPageForImage', () => {
  it('按排序后的图片列表返回 0-based canonical image index', () => {
    expect(bookmarkPageForImage(['a.jpg', 'b.jpg'], 'b.jpg')).toBe(1);
  });
  it('找不到图片返回 null', () => {
    expect(bookmarkPageForImage(['a.jpg'], 'missing.jpg')).toBeNull();
  });
  it('image 位置保持 0-based 并钳制负数', () => {
    expect(imageIndexForBookmark(3, 'image', [{ start: 0 }])).toBe(3);
    expect(imageIndexForBookmark(-2, 'image', [])).toBe(0);
  });
  it('legacy spread 位置转换为对应 spread 的首图索引', () => {
    const spreads = [{ start: 0 }, { start: 2 }, { start: 4 }];
    expect(imageIndexForBookmark(1, 'spread', spreads)).toBe(2);
    expect(imageIndexForBookmark(99, 'spread', spreads)).toBe(0);
  });
});
