import { describe, it, expect } from 'vitest';
import { computeColWidth, layoutMasonry, type MasonryInput } from './useMasonryLayout';

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
