// isMasonryImage——masonry 图片卡统一判定（2026-08-27 混排占位，审查 P1）。
// 类型标记优先于扩展名：目录可合法命名为 cover.jpg；归档即使扩展名像图片也不是图片卡。
import { describe, it, expect } from 'vitest';
import { isMasonryImage } from './mime';

describe('isMasonryImage', () => {
  const e = (over: Partial<{ name: string; isDirectory: boolean; isArchive: boolean }>) => ({
    name: 'a.jpg', isDirectory: false, isArchive: false, ...over,
  });

  it('普通图片文件 → true', () => {
    expect(isMasonryImage(e({}))).toBe(true);
    expect(isMasonryImage(e({ name: 'page_01.PNG' }))).toBe(true);
  });

  it('目录命名 cover.jpg → false（类型标记优先，防送尺寸/缩略图队列）', () => {
    expect(isMasonryImage(e({ name: 'cover.jpg', isDirectory: true }))).toBe(false);
  });

  it('归档条目 → false（isArchive 防御；cbz 扩展名本就非图片）', () => {
    expect(isMasonryImage(e({ name: 'book.cbz', isArchive: true }))).toBe(false);
    expect(isMasonryImage(e({ name: 'weird.jpg', isArchive: true }))).toBe(false);
  });

  it('非图片普通文件 → false', () => {
    expect(isMasonryImage(e({ name: 'Thumbs.db' }))).toBe(false);
    expect(isMasonryImage(e({ name: 'notes.txt' }))).toBe(false);
  });
});
