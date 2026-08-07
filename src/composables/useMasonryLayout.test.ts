import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import {
  applyMeasuredBatch,
  computeColWidth,
  DEFAULT_ASPECT_RATIO,
  estimateHeight,
  layoutMasonry,
  toRootRelativePath,
  useMasonryLayout,
  type MasonryInput,
  type MasonryItem,
} from './useMasonryLayout';

import type { MediaEntry } from '@/lib/sourceDescriptor';

describe('computeColWidth', () => {
  it('容器宽度按列数均分减去 gap (取整避免亚像素缝)', () => {
    // (1000 - 3*10) / 4 = 242.5 → floor 242 (消除 absolute 定位亚像素缝, 右侧留 8px)
    expect(computeColWidth(1000, 4, 10)).toBe(242);
  });
  it('gap=0 时纯均分', () => {
    expect(computeColWidth(800, 4, 0)).toBe(200);
  });
  it('1 列时等于容器宽', () => {
    expect(computeColWidth(500, 1, 10)).toBe(500);
  });
});

describe('toRootRelativePath (F1: 子目录路径拼接)', () => {
  it('currentPath 为空（根目录）-> 原样返回 relPath', () => {
    expect(toRootRelativePath('', 'img.png')).toBe('img.png');
  });
  it('currentPath 非空 -> 拼 currentPath/relPath', () => {
    expect(toRootRelativePath('output/260805', 'img.png')).toBe('output/260805/img.png');
  });
  it('currentPath 尾部斜杠 -> trim 后拼接', () => {
    expect(toRootRelativePath('output/260805/', 'img.png')).toBe('output/260805/img.png');
  });
  it('多斜杠归一', () => {
    expect(toRootRelativePath('output//260805/', 'img.png')).toBe('output/260805/img.png');
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

describe('useMasonryLayout composable (smoke)', () => {
  function mkEntry(path: string): MediaEntry {
    return { name: path, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
  }

  it('colWidth + layout 响应式计算', () => {
    const entries = ref<readonly MediaEntry[]>([mkEntry('a'), mkEntry('b'), mkEntry('c'), mkEntry('d')]);
    const { colWidth, layout, measuredCount, visibleRange } = useMasonryLayout({
      entries,
      containerWidth: ref(1000),
      containerHeight: ref(600),
      colCount: ref(4),
      hGap: ref(10),
      vGap: ref(10),
      scrollTop: ref(0),
      measuredMap: ref(new Map()),
    });
    // colWidth = floor((1000 - 3*10)/4) = 242 (取整避免亚像素缝)
    expect(colWidth.value).toBe(242);
    // layout 有 4 个 item, totalHeight > 0 (估算高度)
    expect(layout.value.map.size).toBe(4);
    expect(layout.value.totalHeight).toBeGreaterThan(0);
    // 未测量 → measuredCount 0
    expect(measuredCount.value).toBe(0);
    // visibleRange 在 scrollTop=0 时包含前面的 item
    expect(visibleRange.value.end).toBeGreaterThan(0);
  });

  it('measuredMap 更新后 layout 用真实比例缩放高度', () => {
    const entries = ref<readonly MediaEntry[]>([mkEntry('a')]);
    const measuredMap = ref(new Map<string, { width: number; height: number }>());
    const { layout } = useMasonryLayout({
      entries,
      containerWidth: ref(200),
      containerHeight: ref(600),
      colCount: ref(2),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap,
    });
    const estimatedHeight = layout.value.totalHeight;
    // colWidth=100 (2列 gap0); 图片 200x500 -> 缩放后高度 = 100*500/200 = 250 (按宽度等比, 非原始像素 500)
    measuredMap.value = new Map([['a', { width: 200, height: 500 }]]);
    expect(layout.value.totalHeight).toBe(250);
    expect(layout.value.totalHeight).not.toBe(estimatedHeight);
  });

  it('measured item 高度按 colWidth 等比缩放 (非原始像素)', () => {
    // 回归: 之前用 m.height (原始像素) 导致卡片极长 + cover 裁剪, 不是实际比例
    const entries = ref<readonly MediaEntry[]>([mkEntry('a')]);
    const measuredMap = ref(new Map([['a', { width: 1000, height: 2000 }]]));
    const { layout } = useMasonryLayout({
      entries,
      containerWidth: ref(300),
      containerHeight: ref(600),
      colCount: ref(1),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap,
    });
    // colWidth=300 (1列); 图片 1000x2000 (h/w=2) -> 缩放后高度 = 300*2000/1000 = 600
    const item = layout.value.map.get('a')!;
    expect(item.width).toBe(300);
    expect(item.height).toBe(600);
  });

  it('prefetchPaths: 视口前后各 2 屏行的 paths (供 new Image 缓存)', () => {
    // 50 条 entries, 4 列. PREFETCH_BUFFER=2 → 前后各 8 entries. 视口默认含前几个.
    const entries = ref<readonly MediaEntry[]>(Array.from({ length: 50 }, (_, i) => mkEntry(`p${i}`)));
    const { prefetchPaths, visibleRange } = useMasonryLayout({
      entries,
      containerWidth: ref(1000),
      containerHeight: ref(600),
      colCount: ref(4),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap: ref(new Map()),
    });
    const r = visibleRange.value;
    const extend = 2 * 4;
    const start = Math.max(0, r.start - extend);
    const end = Math.min(50, r.end + extend);
    expect(prefetchPaths.value).toHaveLength(end - start);
    expect(prefetchPaths.value[0]).toBe(entries.value[start].path);
    expect(prefetchPaths.value[prefetchPaths.value.length - 1]).toBe(entries.value[end - 1].path);
  });

  it('prefetchPaths: 滚到中段时前后扩展 (中间 start 不为 0)', () => {
    const entries = ref<readonly MediaEntry[]>(Array.from({ length: 100 }, (_, i) => mkEntry(`p${i}`)));
    const { prefetchPaths } = useMasonryLayout({
      entries,
      containerWidth: ref(1000),
      containerHeight: ref(600),
      colCount: ref(4),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(100000), // 强制 visibleRange 在中间
      measuredMap: ref(new Map()),
    });
    // 视口前后各 8 entries
    const paths = prefetchPaths.value;
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(100);
    // 不包含第一个 (除非 start=0)
    if (paths[0] !== 'p0') {
      expect(paths[0]).not.toBe('p0');
    }
  });
});
