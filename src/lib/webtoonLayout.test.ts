import { describe, it, expect } from 'vitest';
import {
  computeLayout,
  visibleWindow,
  topVisibleIndex,
  clampZoom,
  anchoredScroll,
  autoScrollDelta,
  captureAnchor,
  restoreAnchor,
} from './webtoonLayout';

describe('webtoonLayout（module3.1.0）', () => {
  const measured = new Map([
    ['a.jpg', { width: 1000, height: 2000 }],
    ['b.jpg', { width: 1000, height: 3000 }],
  ]);

  it('computeLayout：实测用宽高比、未测量用 3:4 估算、tops 为前缀和', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(l.heights[0]).toBe(1000);
    expect(l.heights[1]).toBe(1500);
    expect(l.heights[2]).toBeCloseTo(666.667, 1);
    expect(l.tops).toEqual([0, 1000, 2500]);
    expect(l.totalHeight).toBeCloseTo(3166.667, 1);
  });

  it('computeLayout：gap 计入相邻项', () => {
    expect(computeLayout(['a.jpg', 'b.jpg'], measured, 500, 10).tops[1]).toBe(1010);
  });

  it('computeLayout：空列表返回空布局', () => {
    expect(computeLayout([], measured, 500, 10)).toEqual({ names: [], heights: [], tops: [], totalHeight: 0 });
  });

  it('visibleWindow：视口 ±2.5 屏二分窗口', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(visibleWindow(l, 0, 1000)).toEqual({ start: 0, end: 3 });
  });

  it('visibleWindow：中部滚动只含命中条目', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(visibleWindow(l, 1000, 1, 0)).toEqual({ start: 1, end: 2 });
  });

  it('visibleWindow：空布局返回空窗口', () => {
    expect(visibleWindow(computeLayout([], measured, 500, 0), 0, 100)).toEqual({ start: 0, end: 0 });
  });

  it('topVisibleIndex：首个底边超过 scrollTop 的条目', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(topVisibleIndex(l, 0)).toBe(0);
    expect(topVisibleIndex(l, 1000)).toBe(1);
    expect(topVisibleIndex(l, 999)).toBe(0);
  });

  it('topVisibleIndex：空布局安全返回 0', () => {
    expect(topVisibleIndex(computeLayout([], measured, 500, 0), 0)).toBe(0);
  });

  it('captureAnchor/restoreAnchor：上方条目高度校正后视口锚定', () => {
    const l1 = computeLayout(['a.jpg', 'b.jpg'], new Map([['a.jpg', { width: 1000, height: 1000 }]]), 500, 0);
    const anchor = captureAnchor(l1, 750);
    expect(anchor).toEqual({ index: 1, ratio: 0.375 });
    const l2 = computeLayout(['a.jpg', 'b.jpg'], new Map([
      ['a.jpg', { width: 1000, height: 2000 }],
      ['b.jpg', { width: 1000, height: 1333.34 }],
    ]), 500, 0);
    expect(restoreAnchor(l2, anchor)).toBeCloseTo(1000 + 666.67 * 0.375, 1);
    expect(restoreAnchor(l2, { index: 9, ratio: 0 })).toBeNull();
  });

  it('captureAnchor：空布局返回 null，restoreAnchor 接受 null', () => {
    const l = computeLayout([], measured, 500, 0);
    expect(captureAnchor(l, 0)).toBeNull();
    expect(restoreAnchor(l, null)).toBeNull();
  });

  it('clampZoom：1-4 clamp + 两位小数', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2.345)).toBe(2.35);
    expect(clampZoom(5)).toBe(4);
  });

  it('anchoredScroll：缩放后鼠标下内容点不动', () => {
    expect(anchoredScroll(1000, 500, 1, 2)).toBe(2500);
    expect(anchoredScroll(2500, 500, 2, 1)).toBe(1000);
  });

  it('autoScrollDelta：speed × factor × dt', () => {
    expect(autoScrollDelta(60, 1, 1000)).toBeCloseTo(60);
    expect(autoScrollDelta(60, 2, 500)).toBeCloseTo(60);
  });
});
