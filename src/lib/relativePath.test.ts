/**
 * relativePath.test.ts — validateSourceRelativePath 纯函数测试
 *
 * 与 src-tauri/src/algorithm/path.rs::validate_source_relative 语义 1:1。
 * 改一边务必同步另一边。
 */
import { describe, it, expect } from 'vitest';
import { validateSourceRelativePath } from './relativePath';

describe('validateSourceRelativePath — 合法输入', () => {
  it('根目录空串合法, normalized 仍为空串', () => {
    const r = validateSourceRelativePath('');
    expect(r).toEqual({ ok: true, normalized: '' });
  });

  it('单段相对路径合法', () => {
    expect(validateSourceRelativePath('normal')).toEqual({ ok: true, normalized: 'normal' });
  });

  it('多段用 / 分隔合法, normalized 合并多余分隔符', () => {
    expect(validateSourceRelativePath('raw/竖版')).toEqual({ ok: true, normalized: 'raw/竖版' });
  });

  it('反斜杠统一为 /', () => {
    expect(validateSourceRelativePath('raw\\竖版')).toEqual({ ok: true, normalized: 'raw/竖版' });
  });

  it('混合斜杠 + 多余分隔符 normalize', () => {
    expect(validateSourceRelativePath('a//b\\\\c')).toEqual({ ok: true, normalized: 'a/b/c' });
  });

  it('尾部分隔符被 trim', () => {
    expect(validateSourceRelativePath('a/b/')).toEqual({ ok: true, normalized: 'a/b' });
  });
});

describe('validateSourceRelativePath — 拒绝绝对/盘符', () => {
  it('Windows 盘符路径拒绝 (F:)', () => {
    const r = validateSourceRelativePath('F:');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('drive');
  });

  it('Windows 盘符 + 路径拒绝 (F:/WallPaper)', () => {
    const r = validateSourceRelativePath('F:/WallPaper');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('drive');
  });

  it('Windows 盘符 + 反斜杠拒绝 (F:\\\\WallPaper)', () => {
    const r = validateSourceRelativePath('F:\\WallPaper');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('drive');
  });

  it('小写盘符也拒绝 (d:/x)', () => {
    const r = validateSourceRelativePath('d:/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('drive');
  });

  it('以 / 开头拒绝 (Unix 绝对路径)', () => {
    const r = validateSourceRelativePath('/etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('absolute');
  });

  it('以 \\\\ 开头拒绝 (Windows 绝对反斜杠)', () => {
    const r = validateSourceRelativePath('\\WallPaper');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('absolute');
  });
});

describe('validateSourceRelativePath — 拒绝 UNC', () => {
  it('UNC 路径 \\\\server\\share 拒绝', () => {
    const r = validateSourceRelativePath('\\\\server\\share');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unc');
  });

  it('UNC 路径 //server/share 拒绝', () => {
    const r = validateSourceRelativePath('//server/share');
    expect(r.ok).toBe(false);
    // //server 开头既是 absolute(//) 也算 unc; 实现按 unc 优先匹配
    if (!r.ok) expect(['absolute', 'unc']).toContain(r.reason);
  });
});

describe('validateSourceRelativePath — 拒绝 .. 遍历', () => {
  it('纯 .. 拒绝', () => {
    const r = validateSourceRelativePath('..');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dotdot');
  });

  it('../x 拒绝', () => {
    const r = validateSourceRelativePath('../x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dotdot');
  });

  it('a/../b 拒绝 (中间段 ..)', () => {
    const r = validateSourceRelativePath('a/../b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dotdot');
  });

  it('a/.. 拒绝 (末段 ..)', () => {
    const r = validateSourceRelativePath('a/..');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dotdot');
  });

  it('..b 合法 (.. 只是名字前缀, 不是整段)', () => {
    // '..b' 是合法文件名段, 不是父目录引用
    expect(validateSourceRelativePath('..b')).toEqual({ ok: true, normalized: '..b' });
  });

  it('a.. 合法 (.. 只是名字后缀)', () => {
    expect(validateSourceRelativePath('a..')).toEqual({ ok: true, normalized: 'a..' });
  });
});

describe('validateSourceRelativePath — 拒绝 NUL 字节', () => {
  it('含 \\0 拒绝', () => {
    const r = validateSourceRelativePath('a\0b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('nul');
  });
});

describe('validateSourceRelativePath — edge case', () => {
  it('单段含空格合法', () => {
    expect(validateSourceRelativePath('my folder')).toEqual({ ok: true, normalized: 'my folder' });
  });

  it('中文段合法', () => {
    expect(validateSourceRelativePath('raw/竖版')).toEqual({ ok: true, normalized: 'raw/竖版' });
  });

  it('多层嵌套合法', () => {
    expect(validateSourceRelativePath('a/b/c/d/e')).toEqual({ ok: true, normalized: 'a/b/c/d/e' });
  });

  it('仅分隔符 (///) 拒绝 (以 // 开头判 unc)', () => {
    // /// 前两字符是 //, 命中 unc 判定; 无论 unc 还是 absolute 都正确拒绝
    const r = validateSourceRelativePath('///');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['absolute', 'unc']).toContain(r.reason);
  });
});
