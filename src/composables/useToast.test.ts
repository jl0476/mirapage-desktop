/**
 * useToast.test.ts
 *
 * 通用 toast 单例 composable:
 * - push 显示 1 项 (队列上限 1, 后者替换)
 * - 1500ms 自动隐藏
 * - dismiss 立即清空
 *
 * 单例状态: 模块级 ref, 跨调用共享。beforeEach 必须先 dismiss() + clearAllTimers(),
 * 否则上一测试遗留的 timer/queue 会污染下一测试。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToast } from './useToast';

describe('useToast', () => {
  beforeEach(() => {
    // 防单例跨测试污染: 先清 queue (会同步调 setTimeout 失败 — 没关系, 用 clearAllTimers 兜底)
    const { dismiss } = useToast();
    dismiss();
    vi.clearAllTimers();
  });

  it('push 后 toasts 出现 1 项且 message 正确', () => {
    const { toasts, push } = useToast();
    push('hello');
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.message).toBe('hello');
  });

  it('1500ms 后自动隐藏', () => {
    vi.useFakeTimers();
    const { toasts, push } = useToast();
    push('hello');
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(toasts.value).toHaveLength(0);
    vi.useRealTimers();
  });

  it('不到 1500ms 不自动隐藏', () => {
    vi.useFakeTimers();
    const { toasts, push } = useToast();
    push('hello');
    vi.advanceTimersByTime(1499);
    expect(toasts.value).toHaveLength(1);
    vi.useRealTimers();
  });

  it('队列上限 1: 连续 push 两次仍只 1 项, message 是第二次的', () => {
    const { toasts, push } = useToast();
    push('first');
    push('second');
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.message).toBe('second');
  });

  it('连续 push 重置 1500ms 计时器 (不立即清空)', () => {
    vi.useFakeTimers();
    const { toasts, push } = useToast();
    push('first');
    vi.advanceTimersByTime(1000);
    push('second');
    // 此时距第一次 push 已 1000ms, 距第二次 push 0ms
    vi.advanceTimersByTime(1499);
    expect(toasts.value).toHaveLength(1); // 计时器已重置
    vi.advanceTimersByTime(1);
    expect(toasts.value).toHaveLength(0); // 累计 1500ms 后清空
    vi.useRealTimers();
  });

  it('dismiss 立即清空', () => {
    const { toasts, push, dismiss } = useToast();
    push('hello');
    expect(toasts.value).toHaveLength(1);
    dismiss();
    expect(toasts.value).toHaveLength(0);
  });

  it('单例状态: 两次 useToast() 共享同一 queue', () => {
    const a = useToast();
    const b = useToast();
    a.push('shared');
    expect(b.toasts.value).toHaveLength(1);
    expect(b.toasts.value[0]?.message).toBe('shared');
  });
});
