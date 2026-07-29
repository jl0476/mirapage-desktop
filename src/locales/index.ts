// vue-i18n 配置 + SupportedLocale 类型
// resolveSystemLocale 与格式化 helper 拆到 ./helpers.ts（避免被 vue-i18n mock 影响）

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

export { resolveSystemLocale } from './helpers';