/**
 * findNextDirectory 测试
 * 给定(siblings, currentPath, direction) → 找到下一本/上一本或 null
 *
 * - siblings:按自然排序的目录 + 压缩包条目列表(directory/archive)
 * - currentPath:当前项的相对路径
 * - direction: 'next' / 'prev'
 * - 返回:sibling 路径或 null（无下一卷）
 *
 * 跳过空目录,但 archive 文件直接命中（不进入内部）
 */
import { describe, it, expect } from 'vitest';
import { findNextDirectory } from './findNextDirectory';

describe('findNextDirectory', () => {
  it('returns next directory for NEXT', () => {
    const siblings = ['vol1', 'vol2', 'vol3'];
    expect(findNextDirectory(siblings, 'vol1', 'next')).toBe('vol2');
    expect(findNextDirectory(siblings, 'vol2', 'next')).toBe('vol3');
  });

  it('returns null when at last and direction=next', () => {
    const siblings = ['vol1', 'vol2', 'vol3'];
    expect(findNextDirectory(siblings, 'vol3', 'next')).toBeNull();
  });

  it('returns prev directory for PREV', () => {
    const siblings = ['vol1', 'vol2', 'vol3'];
    expect(findNextDirectory(siblings, 'vol3', 'prev')).toBe('vol2');
    expect(findNextDirectory(siblings, 'vol2', 'prev')).toBe('vol1');
  });

  it('returns null when at first and direction=prev', () => {
    const siblings = ['vol1', 'vol2', 'vol3'];
    expect(findNextDirectory(siblings, 'vol1', 'prev')).toBeNull();
  });

  it('returns null when currentPath not found in siblings', () => {
    const siblings = ['vol1', 'vol2'];
    expect(findNextDirectory(siblings, 'vol99', 'next')).toBeNull();
  });

  it('handles archive entries (cbz / cbr / etc.)', () => {
    const siblings = ['page10.jpg', 'page11.jpg', 'vol2.cbz'];
    // vol2.cbz 是压缩包,直接当下一卷命中
    expect(findNextDirectory(siblings, 'page11.jpg', 'next')).toBe('vol2.cbz');
  });

  it('sorts with natural order (page2 < page10)', () => {
    const siblings = ['page10', 'page2', 'page20', 'page1'];
    // 自然排序后 page1, page2, page10, page20
    expect(findNextDirectory(siblings, 'page1', 'next')).toBe('page2');
    expect(findNextDirectory(siblings, 'page2', 'next')).toBe('page10');
  });

  it('returns null for empty siblings', () => {
    expect(findNextDirectory([], 'anything', 'next')).toBeNull();
    expect(findNextDirectory([], 'anything', 'prev')).toBeNull();
  });
});