import { describe, it, expect } from 'vitest';
import zh from './zh-CN';
import en from './en-US';

/** 递归收集所有 leaf key path. */
function flatten(obj: unknown, prefix = ''): string[] {
  if (obj == null || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : flatten(v, prefix + k + '.'),
  );
}

describe('i18n key symmetry', () => {
  it('zh-CN and en-US have identical settings.* key paths', () => {
    const zhKeys = new Set(flatten(zh).filter((k) => k.startsWith('settings.')));
    const enKeys = new Set(flatten(en).filter((k) => k.startsWith('settings.')));
    expect([...zhKeys].sort()).toEqual([...enKeys].sort());
  });

  it('settings.* has at least 30 keys in both locales', () => {
    const zhKeys = flatten(zh).filter((k) => k.startsWith('settings.'));
    const enKeys = flatten(en).filter((k) => k.startsWith('settings.'));
    expect(zhKeys.length).toBeGreaterThanOrEqual(30);
    expect(enKeys.length).toBeGreaterThanOrEqual(30);
  });
});