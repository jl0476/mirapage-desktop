// thumbnailPosition.test.ts — popover 定位纯函数（module3.0.11 任务 7）
// 优先级：右侧 → 左侧 → 下方 → 上方；水平溢出钳位。
import { describe, it, expect } from 'vitest';
import { positionFor } from './thumbnailPosition';

describe('thumbnailPosition.positionFor', () => {
  it('右侧有空间 → right（left = anchor.right + gap）', () => {
    const anchor = { right: 200, left: 100, top: 50, bottom: 70, width: 100, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('right');
    expect(p.left).toBe(208);
    expect(p.top).toBe(50);
  });
  it('右侧溢出 → left（left = anchor.left - gap - popW）', () => {
    const anchor = { right: 750, left: 650, top: 50, bottom: 70, width: 100, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('left');
    expect(p.left).toBe(650 - 8 - 200);
  });
  it('左右都溢出 → bottom（水平居中钳位）', () => {
    const anchor = { right: 790, left: 30, top: 50, bottom: 70, width: 760, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('bottom');
    expect(p.left).toBe(30 + 380 - 100);
  });
  it('上下左右都不足 → top', () => {
    const anchor = { right: 790, left: 30, top: 590, bottom: 610, width: 760, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('top');
    expect(p.top).toBe(590 - 8 - 120);
  });
});
