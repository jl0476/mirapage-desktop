/**
 * useLocaleSync — 同步 settings.locale → vue-i18n locale
 *
 * 用法:
 * ```ts
 * const stop = useLocaleSync();
 * onUnmounted(stop);
 * ```
 *
 * - 'system' 时通过 resolveSystemLocale 把 navigator.language 解析为 zh-CN/en-US
 * - watch settings.locale 变化 → 立即更新 vue-i18n locale(无须重启)
 * - 返回的 stop 函数解绑 watcher,组件卸载时调用
 */
import { onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import { resolveSystemLocale, type SupportedLocale } from '@/locales/helpers';

/** 测试钩子:允许 mock navigator.language */
export const _internal = {
  systemLocaleFromNavigator: (): string =>
    typeof navigator !== 'undefined' ? navigator.language : 'en-US',
};

export function useLocaleSync(): () => void {
  const settings = useSettingsStore();
  const { locale } = useI18n();

  function resolve(): SupportedLocale {
    if (settings.locale === 'system') {
      const resolved = resolveSystemLocale(_internal.systemLocaleFromNavigator());
      return resolved as SupportedLocale;
    }
    return settings.locale as SupportedLocale;
  }

  // 立即同步(用于启动)
  locale.value = resolve();

  // 跟踪变化
  const stopWatch = watch(
    () => settings.locale,
    () => {
      locale.value = resolve();
    },
  );

  function stop() {
    stopWatch();
  }

  onUnmounted(stop);
  return stop;
}