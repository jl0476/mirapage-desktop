// vue-i18n 配置

import { createI18n } from 'vue-i18n';
import zhCN from './zh-CN';
import enUS from './en-US';

export type SupportedLocale = 'zh-CN' | 'en-US' | 'system';

export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
});

/** 把系统 locale 解析为 zh-CN / en-US */
export function resolveSystemLocale(systemLocale: string): 'zh-CN' | 'en-US' {
  if (systemLocale.toLowerCase().startsWith('zh')) return 'zh-CN';
  return 'en-US';
}