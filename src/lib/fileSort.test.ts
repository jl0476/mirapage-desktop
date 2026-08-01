/**
 * fileSort.test.ts — sortEntries 纯函数测试
 */
import { describe, it, expect } from 'vitest';
import { sortEntries } from './fileSort';
import type { MediaEntry } from './sourceDescriptor';

function mkEntry(name: string, opts: Partial<MediaEntry> = {}): MediaEntry {
  return {
    name,
    path: name,
    isDirectory: false,
    isArchive: false,
    size: 0,
    modifiedAt: 0,
    ...opts,
  };
}

describe('sortEntries — dir-first', () => {
  it('目录永远在文件前面（name 排序）', () => {
    const entries = [
      mkEntry('a.txt'),
      mkEntry('b-dir', { isDirectory: true }),
      mkEntry('c.txt'),
    ];
    const out = sortEntries(entries, 'name', true);
    expect(out.map((e) => e.name)).toEqual(['b-dir', 'a.txt', 'c.txt']);
  });

  it('ascending=false 仍保持 dir-first', () => {
    const entries = [
      mkEntry('a.txt'),
      mkEntry('b-dir', { isDirectory: true }),
      mkEntry('c.txt'),
    ];
    const out = sortEntries(entries, 'name', false);
    // dir-first 优先, 内部 reverse
    expect(out.map((e) => e.name)).toEqual(['b-dir', 'c.txt', 'a.txt']);
  });

  it('只有目录时跟普通排序一致', () => {
    const entries = [
      mkEntry('z', { isDirectory: true }),
      mkEntry('a', { isDirectory: true }),
    ];
    const out = sortEntries(entries, 'name', true);
    expect(out.map((e) => e.name)).toEqual(['a', 'z']);
  });
});

describe('sortEntries — name (自然排序)', () => {
  it('数字混合按数值排: 1 < 2 < 10', () => {
    const entries = [
      mkEntry('page10.png'),
      mkEntry('page2.png'),
      mkEntry('page1.png'),
    ];
    const out = sortEntries(entries, 'name', true);
    expect(out.map((e) => e.name)).toEqual(['page1.png', 'page2.png', 'page10.png']);
  });

  it('ascending=false 时倒序', () => {
    const entries = [mkEntry('a'), mkEntry('b'), mkEntry('c')];
    const out = sortEntries(entries, 'name', false);
    expect(out.map((e) => e.name)).toEqual(['c', 'b', 'a']);
  });
});

describe('sortEntries — modifiedAt', () => {
  it('按 modifiedAt 升序', () => {
    const entries = [
      mkEntry('new', { modifiedAt: 200 }),
      mkEntry('old', { modifiedAt: 100 }),
      mkEntry('mid', { modifiedAt: 150 }),
    ];
    const out = sortEntries(entries, 'modifiedAt', true);
    expect(out.map((e) => e.name)).toEqual(['old', 'mid', 'new']);
  });

  it('undefined modifiedAt 排到末尾', () => {
    const entries = [
      mkEntry('a', { modifiedAt: undefined }),
      mkEntry('b', { modifiedAt: 100 }),
    ];
    const out = sortEntries(entries, 'modifiedAt', true);
    expect(out.map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('sortEntries — size', () => {
  it('按 size 升序', () => {
    const entries = [
      mkEntry('big', { size: 1000 }),
      mkEntry('small', { size: 10 }),
      mkEntry('mid', { size: 100 }),
    ];
    const out = sortEntries(entries, 'size', true);
    expect(out.map((e) => e.name)).toEqual(['small', 'mid', 'big']);
  });

  it('directory 大小 0 排在文件前 (与 dir-first 一致)', () => {
    const entries = [
      mkEntry('big-file', { size: 1000 }),
      mkEntry('dir', { isDirectory: true, size: 0 }),
    ];
    const out = sortEntries(entries, 'size', true);
    expect(out.map((e) => e.name)).toEqual(['dir', 'big-file']);
  });
});

describe('sortEntries — empty / edge cases', () => {
  it('空数组返回空', () => {
    expect(sortEntries([], 'name', true)).toEqual([]);
  });

  it('单元素不破坏', () => {
    const entries = [mkEntry('only')];
    const out = sortEntries(entries, 'name', true);
    expect(out.map((e) => e.name)).toEqual(['only']);
  });
});
