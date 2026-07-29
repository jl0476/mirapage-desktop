/**
 * i18n 完整性 + locale helper 测试
 * - zh-CN 与 en-US key 树必须完全一致(否则部分文案会显示 fallback/空白)
 * - resolveSystemLocale: zh* 头 → 'zh-CN',其余 → 'en-US'
 * - formatBytes: B / KB / MB / GB / TB(2 位小数,1024 进制)
 */
import { describe, it, expect } from 'vitest';
import zhCN from './zh-CN';
import enUS from './en-US';
import { resolveSystemLocale, formatBytes, formatNumber, formatDate } from './helpers';

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object') return [prefix];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...collectKeys(v, next));
    } else {
      keys.push(next);
    }
  }
  return keys.sort();
}

describe('i18n key parity', () => {
  it('zh-CN and en-US have identical key trees', () => {
    const zhKeys = collectKeys(zhCN);
    const enKeys = collectKeys(enUS);
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    if (missingInEn.length || missingInZh.length) {
      throw new Error(
        `Key mismatch:\n` +
          `  missing in en-US: ${JSON.stringify(missingInEn)}\n` +
          `  missing in zh-CN: ${JSON.stringify(missingInZh)}`,
      );
    }
    expect(zhKeys.length).toBeGreaterThan(20); // 至少覆盖菜单 + 设置 + 阅读器基础
  });

  it('non-empty translation for every key (zh-CN)', () => {
    for (const key of collectKeys(zhCN)) {
      const val = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], zhCN);
      expect(typeof val, key).toBe('string');
      expect((val as string).length, key).toBeGreaterThan(0);
    }
  });
});

describe('resolveSystemLocale', () => {
  it('zh-cn → zh-CN', () => {
    expect(resolveSystemLocale('zh-CN')).toBe('zh-CN');
    expect(resolveSystemLocale('zh')).toBe('zh-CN');
    expect(resolveSystemLocale('zh-Hans')).toBe('zh-CN');
  });

  it('en-US 等其余 → en-US', () => {
    expect(resolveSystemLocale('en-US')).toBe('en-US');
    expect(resolveSystemLocale('en-GB')).toBe('en-US');
    expect(resolveSystemLocale('ja-JP')).toBe('en-US');
  });
});

describe('formatBytes (二进制 1024)', () => {
  it('formats bytes below 1KB as B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KB / MB / GB / TB', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
  });

  it('formats with 2 decimals for non-exact values', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1.5)).toBe('1.50 KB');
  });
});

describe('formatNumber (locale-aware)', () => {
  it('formats plain integer with thousands separators', () => {
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
    expect(formatNumber(1234567, 'zh-CN')).toMatch(/1,234,567|1.234.567|1 234 567/);
  });
});

describe('formatDate (locale-aware)', () => {
  it('formats epoch timestamp', () => {
    // 2026-01-15T00:00:00Z → "2026/01/15" (zh) 或 "01/15/2026" (en)
    const ts = Date.UTC(2026, 0, 15, 0, 0, 0);
    const z = formatDate(ts, 'zh-CN');
    const e = formatDate(ts, 'en-US');
    expect(z).toMatch(/2026/);
    expect(e).toMatch(/2026/);
    expect(z).not.toBe(e); // locale 至少不同
  });
});
