/**
 * useReaderWheel.test.ts — 桌面端滚轮翻页
 */
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useReaderWheel } from './useReaderWheel';

function mountWithContainer() {
  const container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);
  return { container, wrapper: mount({ template: '<div />', attachTo: container }) };
}

describe('useReaderWheel', () => {
  it('滚轮向下 (deltaY > 0) 调 onNext', async () => {
    const { container } = mountWithContainer();
    const containerRef = ref<HTMLElement | null>(container);
    const onNext = vi.fn();
    const onPrev = vi.fn();
    mount({
      setup() { useReaderWheel({ containerRef, onNext, onPrev }); return () => null; },
    });
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('滚轮向上 (deltaY < 0) 调 onPrev', async () => {
    const { container } = mountWithContainer();
    const containerRef = ref<HTMLElement | null>(container);
    const onNext = vi.fn();
    const onPrev = vi.fn();
    mount({
      setup() { useReaderWheel({ containerRef, onNext, onPrev }); return () => null; },
    });
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('250ms 内多次滚轮只触发一次 (节流)', async () => {
    vi.useFakeTimers();
    const { container } = mountWithContainer();
    const containerRef = ref<HTMLElement | null>(container);
    const onNext = vi.fn();
    const onPrev = vi.fn();
    mount({
      setup() { useReaderWheel({ containerRef, onNext, onPrev }); return () => null; },
    });
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(100);
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(100);
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(onNext).toHaveBeenCalledTimes(1);
    // 超过 250ms 允许再触发
    vi.advanceTimersByTime(200);
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(onNext).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('disabled=true 时不触发回调', async () => {
    const { container } = mountWithContainer();
    const containerRef = ref<HTMLElement | null>(container);
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const disabled = ref(true);
    mount({
      setup() { useReaderWheel({ containerRef, onNext, onPrev, disabled }); return () => null; },
    });
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });
});
