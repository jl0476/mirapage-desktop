// thumbnailPosition.ts — popover 定位纯函数（module3.0.11）
// 优先级：右侧 → 左侧 → 下方 → 上方。水平溢出钳位。独立文件便于单测。

export type PopoverPlacement = 'right' | 'left' | 'bottom' | 'top';

export function positionFor(
  anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  viewport: { width: number; height: number },
  popSize: { width: number; height: number },
  gap = 8,
): { placement: PopoverPlacement; left: number; top: number } {
  const rightX = anchor.right + gap;
  const leftX = anchor.left - gap - popSize.width;
  // 1. 右侧优先
  if (rightX + popSize.width <= viewport.width) {
    return { placement: 'right', left: rightX, top: clampV(anchor.top, viewport, popSize) };
  }
  // 2. 左侧
  if (leftX >= 0) {
    return { placement: 'left', left: leftX, top: clampV(anchor.top, viewport, popSize) };
  }
  // 3. 下方（水平居中钳位）
  const centerX = clamp(anchor.left + anchor.width / 2 - popSize.width / 2, 0, viewport.width - popSize.width);
  if (anchor.bottom + gap + popSize.height <= viewport.height) {
    return { placement: 'bottom', left: centerX, top: anchor.bottom + gap };
  }
  // 4. 上方
  return { placement: 'top', left: centerX, top: Math.max(0, anchor.top - gap - popSize.height) };
}

function clampV(v: number, viewport: { height: number }, popSize: { height: number }): number {
  return clamp(v, 0, Math.max(0, viewport.height - popSize.height));
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
