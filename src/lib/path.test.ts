/**
 * PathUtils TS 镜像测试
 * 语义与 `src-tauri/src/algorithm/path.rs:1:1`
 *
 * - segments: 按 `/` 或 `\` 切段，去空段
 * - normalize: 合并多余分隔符
 * - join: base + segment（空 base 返回 segment）
 * - parent: 移除最后一段
 * - crumbs: [root_label, ""] 开头，然后每段累积路径
 */
import { describe, it, expect } from 'vitest';
import { PathUtils } from './path';

describe('PathUtils.segments', () => {
  it('splits forward-slash paths', () => {
    expect(PathUtils.segments('a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('splits back-slash paths', () => {
    expect(PathUtils.segments('a\\b\\c')).toEqual(['a', 'b', 'c']);
  });

  it('ignores leading and trailing slashes', () => {
    expect(PathUtils.segments('/a/b/')).toEqual(['a', 'b']);
  });

  it('returns empty for empty input', () => {
    expect(PathUtils.segments('')).toEqual([]);
  });

  it('filters empty segments between slashes', () => {
    expect(PathUtils.segments('a//b///c')).toEqual(['a', 'b', 'c']);
  });
});

describe('PathUtils.normalize', () => {
  it('joins segments with single slash', () => {
    expect(PathUtils.normalize('a//b\\\\c')).toBe('a/b/c');
  });

  it('returns empty for empty input', () => {
    expect(PathUtils.normalize('')).toBe('');
  });

  it('returns empty for whitespace-only segments', () => {
    expect(PathUtils.normalize('//')).toBe('');
  });
});

describe('PathUtils.join', () => {
  it('joins base and segment', () => {
    expect(PathUtils.join('a/b', 'c/d')).toBe('a/b/c/d');
  });

  it('normalizes leading slashes on segment', () => {
    expect(PathUtils.join('a/b', '/c/d')).toBe('a/b/c/d');
  });

  it('returns segment when base is empty', () => {
    expect(PathUtils.join('', 'a')).toBe('a');
  });

  it('returns base when segment is empty', () => {
    expect(PathUtils.join('a/b', '')).toBe('a/b');
  });
});

describe('PathUtils.parent', () => {
  it('removes last segment for multi-segment path', () => {
    expect(PathUtils.parent('a/b/c')).toBe('a/b');
  });

  it('returns empty for single segment', () => {
    expect(PathUtils.parent('a')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(PathUtils.parent('')).toBe('');
  });
});

describe('PathUtils.crumbs', () => {
  it('builds breadcrumb list with root first', () => {
    const c = PathUtils.crumbs('Root', 'docs/comics');
    // 根 + 2 segments = 3 elements
    expect(c).toHaveLength(3);
    // (rootLabel, "")
    expect(c[0]).toEqual({ label: 'Root', path: '' });
    // (segment, accumulated_path)
    expect(c[1]).toEqual({ label: 'docs', path: 'docs' });
    expect(c[2]).toEqual({ label: 'comics', path: 'docs/comics' });
  });

  it('handles empty path returning just root', () => {
    const c = PathUtils.crumbs('Home', '');
    expect(c).toEqual([{ label: 'Home', path: '' }]);
  });

  it('normalizes back-slash separators in breadcrumb paths', () => {
    const c = PathUtils.crumbs('Root', 'a\\b/c');
    // 根 + 3 segments (a, b, c) = 4 elements
    expect(c).toHaveLength(4);
    expect(c[1].path).toBe('a');
    expect(c[2].path).toBe('a/b');
    expect(c[3].path).toBe('a/b/c');
  });
});
