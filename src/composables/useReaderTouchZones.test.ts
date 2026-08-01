/**
 * useReaderTouchZones.test.ts — 9 宫格点击检测
 */
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useReaderTouchZones, DEFAULT_READER_ZONES, dispatchZoneAction } from './useReaderTouchZones';

function makeContainer() {
  const el = document.createElement('div');
  el.style.width = '300px';
  el.style.height = '300px';
  document.body.appendChild(el);
  // 默认 div 在 (0,0), 范围 0..1 比例正确
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300,
    width: 300, height: 300, toJSON: () => ({}),
  });
  return el;
}

function clickAt(el: HTMLElement, ratioX: number, ratioY: number) {
  const x = ratioX * 300;
  const y = ratioY * 300;
  el.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
}

describe('useReaderTouchZones — 9 宫格默认动作', () => {
  const cases: Array<[string, [number, number], string]> = [
    ['left-top corner (0.1, 0.1)',     [0.1, 0.1], 'first'],
    ['top-center (0.5, 0.1)',         [0.5, 0.1], 'open-menu'],
    ['right-top corner (0.9, 0.1)',    [0.9, 0.1], 'last'],
    ['middle-left (0.1, 0.5)',        [0.1, 0.5], 'prev'],
    ['center (0.5, 0.5)',             [0.5, 0.5], 'open-menu'],
    ['middle-right (0.9, 0.5)',       [0.9, 0.5], 'next'],
    ['left-bottom corner (0.1, 0.9)', [0.1, 0.9], 'prev-volume'],
    ['bottom-center (0.5, 0.9)',      [0.5, 0.9], 'toggle-slideshow'],
    ['right-bottom corner (0.9, 0.9)',[0.9, 0.9], 'next-volume'],
  ];

  for (const [desc, [rx, ry], expected] of cases) {
    it(`${desc} → ${expected}`, async () => {
      const el = makeContainer();
      const containerRef = ref<HTMLElement | null>(el);
      const onAction = vi.fn();
      mount({
        setup() { useReaderTouchZones({ containerRef, onAction }); return () => null; },
      });
      clickAt(el, rx, ry);
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledWith(expected);
    });
  }
});

describe('dispatchZoneAction', () => {
  it('open-menu → openMainMenu', () => {
    const ctx = {
      openMainMenu: vi.fn(), prevPage: vi.fn(), nextPage: vi.fn(),
      jumpToFirst: vi.fn(), jumpToLast: vi.fn(),
      toggleSlideshow: vi.fn(), prevVolume: vi.fn(), nextVolume: vi.fn(),
    };
    dispatchZoneAction('open-menu', ctx);
    expect(ctx.openMainMenu).toHaveBeenCalled();
  });

  it('prev → prevPage', () => {
    const ctx = {
      openMainMenu: vi.fn(), prevPage: vi.fn(), nextPage: vi.fn(),
      jumpToFirst: vi.fn(), jumpToLast: vi.fn(),
      toggleSlideshow: vi.fn(), prevVolume: vi.fn(), nextVolume: vi.fn(),
    };
    dispatchZoneAction('prev', ctx);
    expect(ctx.prevPage).toHaveBeenCalled();
  });

  it('last → jumpToLast', () => {
    const ctx = {
      openMainMenu: vi.fn(), prevPage: vi.fn(), nextPage: vi.fn(),
      jumpToFirst: vi.fn(), jumpToLast: vi.fn(),
      toggleSlideshow: vi.fn(), prevVolume: vi.fn(), nextVolume: vi.fn(),
    };
    dispatchZoneAction('last', ctx);
    expect(ctx.jumpToLast).toHaveBeenCalled();
  });
});

describe('DEFAULT_READER_ZONES — 9 区域映射', () => {
  it('9 个 key 全部定义', () => {
    expect(Object.keys(DEFAULT_READER_ZONES).sort()).toEqual(
      ['bl', 'bm', 'br', 'ml', 'mm', 'mr', 'tl', 'tm', 'tr'].sort(),
    );
  });
  it('中央 + 顶中 都映射 open-menu (稳定打开)', () => {
    expect((DEFAULT_READER_ZONES as unknown as Record<string, string>).mm).toBe('open-menu');
    expect((DEFAULT_READER_ZONES as unknown as Record<string, string>).tm).toBe('open-menu');
  });
});
