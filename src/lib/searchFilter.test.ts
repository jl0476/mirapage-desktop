import { describe, expect, it } from 'vitest';
import { matchesAnyField } from './searchFilter';

describe('matchesAnyField', () => {
  it('空 query 不过滤', () => {
    expect(matchesAnyField('', ['abc'])).toBe(true);
    expect(matchesAnyField('   ', ['abc'])).toBe(true);
  });

  it('子串匹配大小写不敏感', () => {
    expect(matchesAnyField('VOL', ['vol 1'])).toBe(true);
    expect(matchesAnyField('vol', ['VOL 1'])).toBe(true);
  });

  it('任一字段命中即保留', () => {
    expect(matchesAnyField('猫', [null, '黑白猫', undefined])).toBe(true);
  });

  it('全字段未命中过滤掉', () => {
    expect(matchesAnyField('zzz', ['abc', null])).toBe(false);
  });
});
