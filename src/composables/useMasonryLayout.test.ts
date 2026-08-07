import { describe, it, expect } from 'vitest';
import {
  applyMeasuredBatch,
  computeColWidth,
  DEFAULT_ASPECT_RATIO,
  estimateHeight,
  layoutMasonry,
  type MasonryInput,
  type MasonryItem,
} from './useMasonryLayout';

describe('computeColWidth', () => {
  it('容器宽度按列数均分减去 gap', () => {
    // (1000 - 3*10) / 4 = 242.5
    expect(computeColWidth(1000, 4, 10)).toBe((1000 - 30) / 4);
  });
  it('gap=0 时纯均分', () => {
    expect(computeColWidth(800, 4, 0)).toBe(200);
  });
  it('1 列时等于容器宽', () => {
    expect(computeColWidth(500, 1, 10)).toBe(500);
  });
});

describe('layoutMasonry (贪心放最短列)', () => {
  it('4 个等高 item 放 4 列 → 每列各 1 个, top=0', () => {
    const inputs: MasonryInput[] = Array.from({ length: 4 }, (_, i) => ({
      path: `p${i}`, width: 100, height: 100,
    }));
    const { map, totalHeight } = layoutMasonry(inputs, 4, 0, 0);
    expect(map.get('p0')!.col).toBe(0);
    expect(map.get('p0')!.top).toBe(0);
    expect(map.get('p1')!.col).toBe(1);
    expect(map.get('p2')!.col).toBe(2);
    expect(map.get('p3')!.col).toBe(3);
    expect(totalHeight).toBe(100);
  });

  it('高度不同 → 后续 item 放最短列', () => {
    const inputs: MasonryInput[] = [
      { path: 'a', width: 100, height: 200 }, // col0 top0 h200, colTops=[200,0]
      { path: 'b', width: 100, height: 100 }, // min=0 在 col1
    ];
    const { map } = layoutMasonry(inputs, 2, 0, 0);
    expect(map.get('a')!.col).toBe(0);
    expect(map.get('a')!.top).toBe(0);
    expect(map.get('b')!.col).toBe(1);
    expect(map.get('b')!.top).toBe(0);
  });

  it('totalHeight = 最长列 (含 vGap)', () => {
    const inputs: MasonryInput[] = [
      { path: 'a', width: 100, height: 300 }, // col0
      { path: 'b', width: 100, height: 100 }, // col1
    ];
    const { totalHeight } = layoutMasonry(inputs, 2, 0, 0);
    expect(totalHeight).toBe(300);
  });

  it('vGap 累加进 colTops', () => {
    // 2 列 vGap=10, a h=100 放 col0 → colTops=[110, 0]; b h=100 放 col1 → colTops=[110,110]
    const inputs: MasonryInput[] = [
      { path: 'a', width: 100, height: 100 },
      { path: 'b', width: 100, height: 100 },
    ];
    const { map, totalHeight } = layoutMasonry(inputs, 2, 0, 10);
    expect(map.get('a')!.top).toBe(0);
    expect(map.get('b')!.top).toBe(0);
    expect(totalHeight).toBe(110); // 100 + 10 vGap
  });

  it('空输入 → totalHeight 0, map 空', () => {
    const { map, totalHeight } = layoutMasonry([], 4, 0, 0);
    expect(map.size).toBe(0);
    expect(totalHeight).toBe(0);
  });

  it('left 按 col * (width + hGap) 计算', () => {
    const inputs: MasonryInput[] = [
      { path: 'a', width: 100, height: 100 },
      { path: 'b', width: 100, height: 100 },
      { path: 'c', width: 100, height: 100 },
    ];
    const { map } = layoutMasonry(inputs, 3, 20, 0);
    expect(map.get('a')!.left).toBe(0);       // col0
    expect(map.get('b')!.left).toBe(120);     // col1: 1*(100+20)
    expect(map.get('c')!.left).toBe(240);     // col2: 2*(100+20)
  });
});

describe('estimateHeight (未测量占位)', () => {
  it('按估算宽高比 + colWidth 算高度 (aspectRatio=w/h)', () => {
    // 3:4 即 w/h=0.75, colWidth=100 → height = 100/0.75 = 133.33
    expect(estimateHeight(100, 3 / 4)).toBeCloseTo(133.33, 1);
  });
  it('aspectRatio<=0 时 fallback 到 colWidth (防御)', () => {
    expect(estimateHeight(100, 0)).toBe(100);
  });
  it('DEFAULT_ASPECT_RATIO = 3/4', () => {
    expect(DEFAULT_ASPECT_RATIO).toBe(3 / 4);
  });
});

describe('applyMeasuredBatch (滚动锚定补偿)', () => {
  function mkItem(path: string, top: number, height: number): MasonryItem {
    return { path, width: 100, height, top, left: 0, col: 0 };
  }

  it('上方 item 高度变化 → 补偿正量', () => {
    // item.top=20 < scrollTop=50, oldH=100 newH=150 → delta=+50
    const compensation = applyMeasuredBatch({
      oldLayout: new Map([['a', mkItem('a', 20, 100)]]),
      scrollTop: 50,
      changedPaths: ['a'],
      oldHeights: { a: 100 },
      newHeights: { a: 150 },
    });
    expect(compensation).toBe(50);
  });

  it('item 在视口下方 (top > scrollTop) → 不补偿', () => {
    const compensation = applyMeasuredBatch({
      oldLayout: new Map([['a', mkItem('a', 500, 100)]]),
      scrollTop: 50,
      changedPaths: ['a'],
      oldHeights: { a: 100 },
      newHeights: { a: 150 },
    });
    expect(compensation).toBe(0);
  });

  it('多个上方 item → delta 累加', () => {
    const compensation = applyMeasuredBatch({
      oldLayout: new Map([
        ['a', mkItem('a', 10, 100)],
        ['b', mkItem('b', 30, 200)],
      ]),
      scrollTop: 500,
      changedPaths: ['a', 'b'],
      oldHeights: { a: 100, b: 200 },
      newHeights: { a: 120, b: 180 }, // a +20, b -20 → 净 0
    });
    expect(compensation).toBe(0);
  });

  it('changedPath 不在 layout → 跳过', () => {
    const compensation = applyMeasuredBatch({
      oldLayout: new Map(),
      scrollTop: 50,
      changedPaths: ['missing'],
      oldHeights: {},
      newHeights: {},
    });
    expect(compensation).toBe(0);
  });
});
