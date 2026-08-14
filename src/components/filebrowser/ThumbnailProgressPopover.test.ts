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

  // 时间格式 + 口径（用户实测反馈：1485226ms 反人类 + decoding 显示含排队总时长误导）
  it('耗时不显示裸毫秒：分钟级显示 Xm Ys，秒级显示 X.Xs', () => {
    const w = mount(ThumbnailProgressPopover, {
      props: mkProps({ state: gen('decoding', { decoding: 2000 }) }),
      global: { plugins: [i18n] },
    });
    const text = w.text();
    // 不允许 4 位以上数字直接跟 ms（裸毫秒）
    expect(text).not.toMatch(/\d{4,}ms/);
    // 顶部/时间线有秒级格式（X.Xs 或 Xm Ys）
    expect(text).toMatch(/\d+(?:\.\d+)?s|\d+m \d+s/);
  });

  it('decoding 顶部已用时不显示含排队的总时长（当前阶段净耗时口径）', () => {
    // startedAt 5 分钟前（含排队），但 decoding 2 秒前才开始
    // generationStartedAt = Date.now() - 2000，timings.decoding = 0
    const state = {
      kind: 'generating' as const, cacheKey: 'ck', phase: 'decoding' as const,
      startedAt: Date.now() - 5 * 60 * 1000,
      generationStartedAt: Date.now() - 2000,
      timings: { decoding: 0 },
    };
    const w = mount(ThumbnailProgressPopover, {
      props: mkProps({ state }),
      global: { plugins: [i18n] },
    });
    const headline = w.find('.pop-state.cur').text();
    // 顶部应该是 ~2s（当前阶段净耗时），不是 ~5 分钟（含排队）
    expect(headline).not.toMatch(/\d+m \d+s/);
    expect(headline).toMatch(/\d+(?:\.\d+)?s/);
    // 排队时长在时间线 queued 行单独显示（~5 分钟）
    expect(w.text()).toMatch(/\d+m \d+s/);
  });

  it('渲染根元素（position: fixed 容器）', () => {
    const pop = mount(ThumbnailProgressPopover, { props: mkProps(), global: { plugins: [i18n] }, attachTo: document.body });
    expect(pop.find('[data-test="thumb-popover"]').exists()).toBe(true);
    pop.unmount();
  });
});
