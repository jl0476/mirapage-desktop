// useThemeSync — 同步 settings.themeMode → html.dark class
// system 模式跟随 prefers-color-scheme media query
import { watchEffect } from 'vue';
import { useSettingsStore } from '@/stores/settings';

export function useThemeSync(): void {
  const settings = useSettingsStore();
  watchEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const isDark =
      settings.themeMode === 'dark' ||
      (settings.themeMode === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', isDark);
  });
}
