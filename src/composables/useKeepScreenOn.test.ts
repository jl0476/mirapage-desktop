/**
 * useKeepScreenOn.test.ts — v0.1.0-module2.0
 */
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, keepScreenOn: vi.fn(async () => {}) };
});

import { keepScreenOn } from '@/lib/tauri';
import { useKeepScreenOn } from './useKeepScreenOn';

describe('useKeepScreenOn', () => {
  it('setup 立即调 keepScreenOn(true)', async () => {
    const enabled = ref(true);
    mount({ setup() { useKeepScreenOn(enabled); return () => null; } });
    await Promise.resolve();
    expect(keepScreenOn).toHaveBeenCalledWith(true);
  });

  it('ref 翻 false 调 keepScreenOn(false)', async () => {
    const enabled = ref(true);
    mount({ setup() { useKeepScreenOn(enabled); return () => null; } });
    await Promise.resolve();
    const before = (keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.length;
    enabled.value = false;
    await Promise.resolve();
    await Promise.resolve();
    expect((keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    expect((keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe(false);
  });

  it('unmount 时若 enabled.value=true 调 keepScreenOn(false)', async () => {
    const enabled = ref(true);
    const wrapper = mount({
      setup() { useKeepScreenOn(enabled); return () => null; },
    });
    await Promise.resolve();
    const before = (keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.length;
    wrapper.unmount();
    await Promise.resolve();
    expect((keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    expect((keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe(false);
  });

  it('unmount 时若 enabled.value=false 不调 keepScreenOn(false)', async () => {
    const enabled = ref(false);
    const wrapper = mount({
      setup() { useKeepScreenOn(enabled); return () => null; },
    });
    await Promise.resolve();
    const before = (keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.length;
    wrapper.unmount();
    await Promise.resolve();
    expect((keepScreenOn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });
});