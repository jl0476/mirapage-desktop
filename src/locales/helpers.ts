/**
 * i18n helpers — locale-aware 数字 / 日期 / 文件大小格式化 + resolveSystemLocale
 *
 * 设计依据 DESIGn §5 Phase 6:
 * - 数字 / 日期 / 文件大小格式化（vue-i18n 内置 Intl 可用）
 * - 双语 i18n 完整性由 src/locales/locales.test.ts 保护
 *
 * 故意独立文件、不 import './index'——避免 vitest mock vue-i18n 时
 * index.ts 里的 createI18n() 被波及而崩溃。
 */

import type { SupportedLocale } from './index';

/** 把 navigator.language 或系统 locale 解析为 zh-CN / en-US */
export function resolveSystemLocale(systemLocale: string): SupportedLocale {
  if (systemLocale.toLowerCase().startsWith('zh')) return 'zh-CN';
  return 'en-US';
}

/** 二进制 1024 进制下的文件大小格式化（`0 B` / `1.50 KB` / `2.30 GB`） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

/** locale-aware 数字格式化（千位分隔符） */
export function formatNumber(
  n: number,
  locale: 'zh-CN' | 'en-US' | 'system',
): string {
  const resolved =
    locale === 'system'
      ? resolveSystemLocale(typeof navigator !== 'undefined' ? navigator.language : 'en-US')
      : locale;
  try {
    return new Intl.NumberFormat(resolved).format(n);
  } catch {
    return String(n);
  }
}

/** locale-aware 日期格式化（短格式：年/月/日） */
export function formatDate(
  epochMs: number,
  locale: 'zh-CN' | 'en-US' | 'system',
): string {
  const resolved =
    locale === 'system'
      ? resolveSystemLocale(typeof navigator !== 'undefined' ? navigator.language : 'en-US')
      : locale;
  try {
    return new Intl.DateTimeFormat(resolved, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/** locale-aware 日期+时间格式化 (年/月/日 时:分:秒). 文件浏览器列表用, 区分同一天内的修改 */
export function formatDateTime(
  epochMs: number,
  locale: 'zh-CN' | 'en-US' | 'system',
): string {
  const resolved =
    locale === 'system'
      ? resolveSystemLocale(typeof navigator !== 'undefined' ? navigator.language : 'en-US')
      : locale;
  try {
    return new Intl.DateTimeFormat(resolved, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
  }
}

// re-export SupportedLocale 给不通过 '@/locales' 而是 '@/locales/helpers' 引用的消费者
export type { SupportedLocale };