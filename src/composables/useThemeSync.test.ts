import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from '@/stores/settings';
import { useThemeSync } from './useThemeSync';

function mountWithTheme(setup: () => void) {
  return mount(defineComponent({
    setup() { setup(); return () => h('div'); },
  }));
}

function stubMatchMedia(matchesDark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matchesDark && q.includes('dark'),
    media: q, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('useThemeSync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.documentElement.className = '';
    stubMatchMedia(false);
  });

  it('themeMode=dark adds html.dark class', async () => {
    mountWithTheme(() => {
      const s = useSettingsStore();
      s.themeMode = 'dark';
      useThemeSync();
    });
    await nextTick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('themeMode=light removes html.dark class', async () => {
    document.documentElement.classList.add('dark');
    mountWithTheme(() => {
      const s = useSettingsStore();
      s.themeMode = 'light';
      useThemeSync();
    });
    await nextTick();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('themeMode=system follows prefers-color-scheme media query', async () => {
    stubMatchMedia(true);
    mountWithTheme(() => {
      const s = useSettingsStore();
      s.themeMode = 'system';
      useThemeSync();
    });
    await nextTick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});