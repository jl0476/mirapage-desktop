// ThumbnailProgressPopover.test.ts — 生成详情浮层（module3.0.11 任务 7）
// 覆盖：5 步时间线 + 当前阶段高亮 + 字段渲染 + 失败态（snapshot 时间线/无 snapshot 省略）
// + 重试 emit。定位纯函数在 lib/thumbnailPosition.test.ts 独立测。
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ThumbnailProgressPopover from './ThumbnailProgressPopover.vue';
import type { ThumbnailProgressSnapshot, ThumbnailState } from '@/lib/thumbnail';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function gen(
  phase: 'queued' | 'decoding' | 'resizing' | 'encoding' | 'writing' = 'decoding',
  timings: Record<string, number> = {},
): ThumbnailState {
  return { kind: 'generating', cacheKey: 'ck', phase, startedAt: Date.now() - 2100, timings };
}
function failed(): ThumbnailState {
  return { kind: 'failed', cacheKey: 'ck', retryable: true, message: 'decode failed: boom' };
}
function mkProps(overrides: Record<string, unknown> = {}) {
  return {
    state: gen(),
    fileName: 'IMG_0421.jpg',
    sourceWidth: 4000,
    sourceHeight: 3000,
    sourceBytes: 4_400_000,
    anchorRect: { left: 100, top: 50, width: 18, height: 14 },
    ...overrides,
  };
}

describe('ThumbnailProgressPopover.vue', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('generating 渲染 5 步时间线 + 当前阶段高亮 + 已用时 + 原图字段', () => {
    const w = mount(ThumbnailProgressPopover, {
      props: mkProps({ state: gen('decoding', { decoding: 2000 }) }),
      global: { plugins: [i18n] },
    });
    const steps = w.findAll('.tl-step');
    expect(steps.length).toBe(5);
    expect(w.find('.tl-step.cur').text()).toContain('解码中');
    expect(w.text()).toContain('4000×3000');
    expect(w.text()).toContain('4.20 MB'); // formatBytes 两位小数
  });

  it('generating 不渲染失败/重试区', () => {
    const w = mount(ThumbnailProgressPopover, { props: mkProps(), global: { plugins: [i18n] } });
    expect(w.find('.err-msg').exists()).toBe(false);
    expect(w.find('.retry-btn').exists()).toBe(false);
  });

  it('failed 渲染错误信息 + 重试按钮 emit retry', async () => {
    const w = mount(ThumbnailProgressPopover, { props: mkProps({ state: failed() }), global: { plugins: [i18n] } });
    expect(w.find('.err-msg').text()).toContain('decode failed');
    await w.find('.retry-btn').trigger('click');
    expect(w.emitted('retry')).toBeTruthy();
  });

  // round-1 P1-6：失败时间线数据源 = snapshot
  it('failed 带 snapshot 渲染 5 步时间线（卡住步骤 error 标记）', () => {
    const snap: ThumbnailProgressSnapshot = {
      phase: 'resizing',
      timings: { decoding: 2, resizing: 30 },
      startedAt: Date.now() - 5000,
    };
    const w = mount(ThumbnailProgressPopover, {
      props: mkProps({ state: failed(), snapshot: snap }),
      global: { plugins: [i18n] },
    });
    const steps = w.findAll('.tl-step');
    expect(steps.length).toBe(5);
    expect(w.find('.tl-step.fail').text()).toContain('缩放中'); // 卡在 resizing
    expect(w.find('.err-msg').exists()).toBe(true);
  });

  it('failed 无 snapshot 省略时间线区块（保留错误信息 + 重试）', () => {
    const w = mount(ThumbnailProgressPopover, { props: mkProps({ state: failed() }), global: { plugins: [i18n] } });
    expect(w.findAll('.tl-step').length).toBe(0);
    expect(w.find('.err-msg').exists()).toBe(true);
    expect(w.find('.retry-btn').exists()).toBe(true);
  });

  it('渲染根元素（position: fixed 容器）', () => {
    const pop = mount(ThumbnailProgressPopover, { props: mkProps(), global: { plugins: [i18n] }, attachTo: document.body });
    expect(pop.find('[data-test="thumb-popover"]').exists()).toBe(true);
    pop.unmount();
  });
});
