/**
 * useLocaleSync composable 测试
 * - 启动时把 settings.locale 同步到 vue-i18n locale
 * - settings.locale 变时,vue-i18n locale 立即跟随(无须重启)
 * - 'system' 时用 resolveSystemLocale('zh*' → 'zh-CN',其他 → 'en-US')
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref, type Ref } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { useLocaleSync, _internal } from './useLocaleSync';

/**
 * 单例 locale ref 实现:测试与 useLocaleSync 内部共享同一个 ref,
 * 避免 mock useI18n() 每次返回新实例导致不同 ref。
 */
const mockLocale: Ref<'zh-CN' | 'en-US'> = ref('en-US');

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: mockLocale }),
}));

describe('useLocaleSync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockLocale.value = 'en-US';
  });

  it('initially sets vue-i18n locale from settings.locale (zh-CN)', () => {
    const settings = useSettingsStore();
    settings.locale = 'zh-CN';
    const stop = useLocaleSync();
    expect(mockLocale.value).toBe('zh-CN');
    stop();
  });

  it('initially sets vue-i18n locale from settings.locale (en-US)', () => {
    const settings = useSettingsStore();
    settings.locale = 'en-US';
    const stop = useLocaleSync();
    expect(mockLocale.value).toBe('en-US');
    stop();
  });

  it("resolves 'system' via resolveSystemLocale zh* → 'zh-CN'", () => {
    const settings = useSettingsStore();
    settings.locale = 'system';
    _internal.systemLocaleFromNavigator = () => 'zh-CN';
    const stop = useLocaleSync();
    expect(mockLocale.value).toBe('zh-CN');
    stop();
  });

  it("resolves 'system' via resolveSystemLocale others → 'en-US'", () => {
    const settings = useSettingsStore();
    settings.locale = 'system';
    _internal.systemLocaleFromNavigator = () => 'ja-JP';
    const stop = useLocaleSync();
    expect(mockLocale.value).toBe('en-US');
    stop();
  });

  it('updates vue-i18n locale reactively when settings.locale changes', async () => {
    const settings = useSettingsStore();
    settings.locale = 'zh-CN';
    const stop = useLocaleSync();
    expect(mockLocale.value).toBe('zh-CN');
    settings.locale = 'en-US';
    await Promise.resolve();
    expect(mockLocale.value).toBe('en-US');
    stop();
  });

  it('stop() unsubscribes the watcher', async () => {
    const settings = useSettingsStore();
    settings.locale = 'zh-CN';
    const stop = useLocaleSync();
    expect(mockLocale.value).toBe('zh-CN');
    stop();
    settings.locale = 'en-US';
    await Promise.resolve();
    expect(mockLocale.value).toBe('zh-CN');
  });
});
