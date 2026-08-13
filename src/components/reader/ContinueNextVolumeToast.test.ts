/**
 * ContinueNextVolumeToast.vue 测试
 * 跨卷阅读 manual 模式底部胶囊 — 纯 props/emits 展示组件
 *
 * 关键约束 (P0-2 / P1-5):
 * - 组件绝不调 useCrossVolume() — 父级 ReaderView 是 useCrossVolume 单实例所有者
 * - 直接测 props/emits, 不注入 composable
 * - mock vue-i18n (t 返回可断言的 JSON.stringify)
 *
 * 用例:
 * - target=null → 不渲染
 * - target 有值 → 渲染 + 标题进入 continuePrompt 参数
 * - 点 jump → emit 'jump'
 * - 点 close → emit 'close'
 * - loading=true → jump 按钮 disabled
 * - a11y: role="dialog" + aria-live="polite"
 *
 * 注: Teleport to="body" — DOM 渲染到 document.body, 不在 wrapper 根, 用
 *     document.body.querySelector + .dispatchEvent(new MouseEvent) 触发点击
 *     (同 SlideshowToast.test.ts 模式)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { NextVolumeTarget } from '@/composables/useReaderBookLoader';

// mock vue-i18n: t 返回 JSON.stringify({k, params}) 便于断言 key + 参数
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (k: string, params?: Record<string, unknown>) => JSON.stringify({ k, params }),
  }),
}));

import ContinueNextVolumeToast from './ContinueNextVolumeToast.vue';

const TARGET: NextVolumeTarget = {
  descriptor: { type: 'local', rootPath: '/r' },
  relPath: 'v2',
  title: 'vol2',
};

function makeWrapper(props: Partial<{
  target: NextVolumeTarget | null;
  loading: boolean;
}> = {}) {
  return mount(ContinueNextVolumeToast, {
    props: { target: props.target ?? null, loading: props.loading ?? false },
    attachTo: document.body,
  });
}

function getToast(): HTMLElement | null {
  return document.body.querySelector('[data-test="cross-volume-toast"]');
}

function clickBySelector(selector: string): void {
  const el = document.body.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`element not found: ${selector}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('ContinueNextVolumeToast.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
  });

  it('target=null 不渲染胶囊', () => {
    makeWrapper({ target: null });
    expect(getToast()).toBeNull();
  });

  it('target 有值渲染胶囊 + 标题进入 continuePrompt 参数', () => {
    makeWrapper({ target: TARGET });
    const toast = getToast();
    expect(toast).not.toBeNull();
    // t 返回 JSON.stringify({k, params}) — 标题出现在 params.title
    expect(toast!.textContent).toContain('"k":"reader.crossVolume.continuePrompt"');
    expect(toast!.textContent).toContain('"title":"vol2"');
  });

  it('点 jump 按钮 emit "jump"', () => {
    const wrapper = makeWrapper({ target: TARGET });
    clickBySelector('[data-test="cross-volume-jump"]');
    expect(wrapper.emitted('jump')).toBeTruthy();
    expect(wrapper.emitted('jump')!.length).toBe(1);
  });

  it('点 close 按钮 emit "close"', () => {
    const wrapper = makeWrapper({ target: TARGET });
    clickBySelector('[data-test="cross-volume-close"]');
    expect(wrapper.emitted('close')).toBeTruthy();
    expect(wrapper.emitted('close')!.length).toBe(1);
  });

  it('loading=true jump 按钮 disabled, loading=false jump 按钮 enabled', () => {
    const wrapperLoading = makeWrapper({ target: TARGET, loading: true });
    const jumpBtn = document.body.querySelector('[data-test="cross-volume-jump"]') as HTMLButtonElement;
    expect(jumpBtn.disabled).toBe(true);
    // loading 状态点击不应该 emit (浏览器会阻止 disabled 按钮点击, 但 dispatchEvent 不会)
    // 这里只断言 disabled 属性, 不测点击 — 行为由浏览器负责
    expect(wrapperLoading.emitted('jump')).toBeFalsy();

    wrapperLoading.unmount();
    document.body.innerHTML = '';

    const wrapperIdle = makeWrapper({ target: TARGET, loading: false });
    const jumpBtnIdle = document.body.querySelector('[data-test="cross-volume-jump"]') as HTMLButtonElement;
    expect(jumpBtnIdle.disabled).toBe(false);
    // sanity: 两个独立 wrapper 都成功挂载
    expect(wrapperIdle.vm).toBeTruthy();
  });

  it('胶囊有 role="dialog" + aria-live="polite" 一致性 (a11y)', () => {
    makeWrapper({ target: TARGET });
    const toast = getToast();
    expect(toast).not.toBeNull();
    expect(toast!.getAttribute('role')).toBe('dialog');
    expect(toast!.getAttribute('aria-live')).toBe('polite');
  });
});
