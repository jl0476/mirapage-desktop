import { describe, it, expect } from 'vitest';
import { filterByQuery } from './searchFilter';
import type { MediaEntry } from '@/lib/sourceDescriptor';

function mk(name: string, path = name): MediaEntry {
  return { name, path, isDirectory: !name.includes('.'), isArchive: false, size: 0, modifiedAt: 0 };
}

describe('filterByQuery', () => {
  const entries = [mk('abc.txt'), mk('ABC.md'), mk('report.pdf'), mk('notes'), mk('xyz')];

  it('空 query 返回原列表 (保持引用, 不重建)', () => {
    expect(filterByQuery(entries, '')).toBe(entries);
    expect(filterByQuery(entries, '   ')).toBe(entries);
  });

  it('大小写不敏感子串匹配', () => {
    const r = filterByQuery(entries, 'ABC');
    expect(r.map((e) => e.name)).toEqual(['abc.txt', 'ABC.md']);
  });

  it('无匹配返回空数组', () => {
    const r = filterByQuery(entries, 'zzz');
    expect(r).toEqual([]);
  });

  it('含目录和文件混合过滤', () => {
    const mixed = [mk('vola'), mk('volb.txt'), mk('volc')];
    const r = filterByQuery(mixed, 'vol');
    expect(r.length).toBe(3);
  });

  it('query 前后空白被 trim', () => {
    const r = filterByQuery(entries, '  abc  ');
    expect(r.map((e) => e.name)).toEqual(['abc.txt', 'ABC.md']);
  });
});
