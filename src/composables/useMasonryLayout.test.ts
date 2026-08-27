import { describe, it, expect } from 'vitest';
import { ref, type Ref } from 'vue';
import {
  applyMeasuredBatch,
  captureMasonryViewportAnchor,
  computeColWidth,
  DEFAULT_ASPECT_RATIO,
  estimateHeight,
  layoutMasonry,
  mergeMeasured,
  restoreMasonryViewportAnchor,
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

describe('captureMasonryViewportAnchor / restoreMasonryViewportAnchor (resize 焦点漂移修复)', () => {
  function mkItem(path: string, top: number, height: number): MasonryItem {
    return { path, width: 100, height, top, left: 0, col: 0 };
  }

  it('重排后恢复同一图片及图片内相对位置', () => {
    // 旧 layout: 605.jpg 在 top=1000, height=400
    const oldLayout = new Map([
      ['605.jpg', mkItem('605.jpg', 1000, 400)],
    ]);
    // scrollTop=1300 → 进入 605.jpg 300/400 = 75%
    const anchor = captureMasonryViewportAnchor(
      oldLayout,
      [{ path: '605.jpg' }],
      1300,
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.path).toBe('605.jpg');
    expect(anchor!.ratio).toBeCloseTo(0.75);

    // 新 layout: 605.jpg 移到 top=5000, height 变 800（resize 后宽度变）
    const newLayout = new Map([
      ['605.jpg', mkItem('605.jpg', 5000, 800)],
    ]);
    expect(restoreMasonryViewportAnchor(anchor!, newLayout)).toBe(5600); // 5000 + 800*0.75
  });

  it('多张图跨顶线时选 top 最大（顶线下方紧邻的那张）', () => {
    // 模拟 3 列不同 top，scrollTop=150 同时穿过 a/b
    const layout = new Map([
      ['a.jpg', mkItem('a.jpg', 0, 200)],     // 跨顶线
      ['b.jpg', mkItem('b.jpg', 100, 200)],   // 跨顶线且 top 最大
      ['c.jpg', mkItem('c.jpg', 200, 200)],   // 不跨顶线（top == scrollTop）
    ]);
    const anchor = captureMasonryViewportAnchor(
      layout,
      [{ path: 'a.jpg' }, { path: 'b.jpg' }, { path: 'c.jpg' }],
      150,
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.path).toBe('b.jpg');
    expect(anchor!.ratio).toBeCloseTo(0.25); // (150-100)/200
  });

  it('锚点图不存在 → 返 null（让调用方走默认行为）', () => {
    const anchor = { path: 'gone.jpg', ratio: 0.5 };
    expect(restoreMasonryViewportAnchor(anchor, new Map())).toBeNull();
  });

  it('scrollTop 完全在图下方（视口下方无相交）→ 返 null', () => {
    const layout = new Map([
      ['a.jpg', mkItem('a.jpg', 0, 100)],
    ]);
    expect(captureMasonryViewportAnchor(layout, [{ path: 'a.jpg' }], 500)).toBeNull();
  });

  it('ratio 钳位到 [0, 1]（scrollTop 越界保护）', () => {
    // scrollTop 恰好等于 item.top 时 ratio=0
    const layout = new Map([
      ['a.jpg', mkItem('a.jpg', 100, 100)],
    ]);
    const a0 = captureMasonryViewportAnchor(layout, [{ path: 'a.jpg' }], 100);
    expect(a0!.ratio).toBe(0);
    // scrollTop 接近 item.bottom 时 ratio 接近 1
    const a1 = captureMasonryViewportAnchor(layout, [{ path: 'a.jpg' }], 199);
    expect(a1!.ratio).toBeCloseTo(0.99);
    // scrollTop 恰好等于 item.bottom 时（半开区间不包含），返 null（边界严格）
    const a2 = captureMasonryViewportAnchor(layout, [{ path: 'a.jpg' }], 200);
    expect(a2).toBeNull();
  });

  it('entry 在 layout 不存在 → 跳过（容错）', () => {
    const layout = new Map([
      ['a.jpg', mkItem('a.jpg', 0, 100)],
    ]);
    const anchor = captureMasonryViewportAnchor(
      layout,
      [{ path: 'b.jpg' }], // 不在 layout
      50,
    );
    expect(anchor).toBeNull();
  });
});

describe('useMasonryLayout composable (smoke)', () => {
  function mkEntry(path: string): MediaEntry {
    // name 借 .jpg 后缀过 isMasonryImage 判定（2026-08-27 混排布局）；path 保持裸名供断言
    return { name: `${path}.jpg`, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
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

import { selectPathsInPixelWindow } from './useMasonryLayout';

/** 手工构造 layout map（path -> {top, height, ...}），避免依赖 layoutMasonry 的列分配。 */
function layoutMap(items: { path: string; top: number; height: number }[]): Map<string, MasonryItem> {
  const m = new Map<string, MasonryItem>();
  for (const it of items) {
    m.set(it.path, { path: it.path, width: 100, height: it.height, top: it.top, left: 0, col: 0 });
  }
  return m;
}

describe('selectPathsInPixelWindow', () => {
  // 单列 5 个 item，每个高 100，top 0/100/200/300/400，视口高 100
  const items = [
    { path: 'a', top: 0, height: 100 },
    { path: 'b', top: 100, height: 100 },
    { path: 'c', top: 200, height: 100 },
    { path: 'd', top: 300, height: 100 },
    { path: 'e', top: 400, height: 100 },
  ];
  const entries = items.map((i) => ({ path: i.path }));

  it('视口在顶部：a 可见，b/c ahead，无 behind，d/e 视 ahead 范围而定', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 0, viewportHeight: 100, aheadScreens: 1, behindScreens: 0.5, idleScreens: 1,
    });
    // 视口 [0,100] -> a 可见
    expect(win.visible).toContain('a');
    expect(win.behind).toEqual([]); // 顶部无 behind
    // ahead [100,200] -> b（也可能 c 在边界）
    expect(win.ahead).toContain('b');
  });

  it('视口中段：b 可见，a behind，c/d ahead', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 100, viewportHeight: 100, aheadScreens: 1, behindScreens: 1, idleScreens: 1,
    });
    // 视口 [100,200] -> b 可见（b top100 height100 跨 [100,200]）
    expect(win.visible).toContain('b');
    // behind [0,100] -> a
    expect(win.behind).toContain('a');
    // ahead [200,300] -> c
    expect(win.ahead).toContain('c');
  });

  it('四组互斥：每个 path 最多出现在一组', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 100, viewportHeight: 100, aheadScreens: 2, behindScreens: 1, idleScreens: 2,
    });
    const all = [...win.visible, ...win.ahead, ...win.behind, ...win.idle];
    const set = new Set(all);
    expect(set.size).toBe(all.length); // 无重复
  });

  it('每组保持 entries 原顺序', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 0, viewportHeight: 100, aheadScreens: 3, behindScreens: 0.5, idleScreens: 0,
    });
    // ahead 应按 entries 顺序（b 在 c 前）
    const ai = win.ahead;
    if (ai.length >= 2) {
      expect(ai.indexOf('b')).toBeLessThan(ai.indexOf('c'));
    }
  });

  it('不规则高度：高 item 跨多区时归 visible（优先）', () => {
    const tall = [
      { path: 'big', top: 50, height: 500 }, // 跨视口+ahead
      { path: 'x', top: 600, height: 50 },
    ];
    const win = selectPathsInPixelWindow(layoutMap(tall), [{ path: 'big' }, { path: 'x' }], {
      scrollTop: 0, viewportHeight: 100, aheadScreens: 1, behindScreens: 0.5, idleScreens: 1,
    });
    expect(win.visible).toContain('big'); // 跨视口 -> visible 优先
  });

  it('scrollTop=0 时 behind 为空', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 0, viewportHeight: 100, aheadScreens: 1, behindScreens: 1, idleScreens: 1,
    });
    expect(win.behind).toEqual([]);
  });

  it('接近底部时 ahead/idle 为空', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 400, viewportHeight: 100, aheadScreens: 1, behindScreens: 1, idleScreens: 1,
    });
    // 视口 [400,500]，e(top400) 可见；下方无 item -> ahead/idle 空
    expect(win.visible).toContain('e');
    expect(win.ahead).toEqual([]);
    expect(win.idle).toEqual([]);
  });

  it('viewportHeight=0 不崩溃（窗口退化为空）', () => {
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 200, viewportHeight: 0, aheadScreens: 1, behindScreens: 1, idleScreens: 1,
    });
    // vh=0 时各屏范围高度均为 0 -> 全部退化为空，只要不崩溃即可
    expect(win.visible).toEqual([]);
  });

  it('0px gap：相邻 item 边界恰好相接不漏不重', () => {
    // a [0,100], b [100,200]：视口 [0,100]，a visible，b ahead（边界归 ahead，不重 visible）
    const win = selectPathsInPixelWindow(layoutMap(items), entries, {
      scrollTop: 0, viewportHeight: 100, aheadScreens: 1, behindScreens: 0, idleScreens: 0,
    });
    expect(win.visible).toContain('a');
    expect(win.visible).not.toContain('b');
    expect(win.ahead).toContain('b');
  });

  it('多列布局：不同列不同 top 都能被选到', () => {
    // 模拟 2 列：a/c 在 col0，b/d 在 col1，top 错开
    const multi = [
      { path: 'a', top: 0, height: 100 },
      { path: 'b', top: 0, height: 120 },
      { path: 'c', top: 100, height: 100 },
      { path: 'd', top: 120, height: 100 },
    ];
    const win = selectPathsInPixelWindow(layoutMap(multi), multi.map((m) => ({ path: m.path })), {
      scrollTop: 0, viewportHeight: 110, aheadScreens: 1, behindScreens: 0.5, idleScreens: 0,
    });
    // 视口 [0,110]：a[0,100] 和 b[0,120] 都相交
    expect(win.visible).toContain('a');
    expect(win.visible).toContain('b');
  });

  it('P1-4: thumbnailWindows 由 ahead/idle 设置参数驱动', () => {
    // 7 个 item 每个 100 高，视口 100。ahead=3 时 ahead 窗口覆盖更多 item。
    const mkE = (p: string): MediaEntry => ({ name: p, path: p, isDirectory: false, isArchive: false, size: 0 });
    const entries = ref<readonly MediaEntry[]>(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(mkE));
    // 用真实 layoutMasonry 造 layout（单列，各 100 高）
    const measured = ref(new Map<string, { width: number; height: number }>(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => [p, { width: 100, height: 100 }]),
    ));
    const mk = (ahead: number, idleGen: boolean) => {
      const { thumbnailWindows } = useMasonryLayout({
        entries, containerWidth: ref(100), containerHeight: ref(100),
        colCount: ref(1), hGap: ref(0), vGap: ref(0), scrollTop: ref(0), measuredMap: measured,
        thumbnailAheadScreens: ref(ahead),
        thumbnailIdleGeneration: ref(idleGen),
        thumbnailIdleScreens: ref(1),
      });
      return thumbnailWindows.value;
    };
    const small = mk(1, true);
    const large = mk(3, true);
    // ahead=3 比 ahead=1 覆盖更多 ahead 区 item
    expect(large.ahead.length).toBeGreaterThan(small.ahead.length);
    // 关闭 idle -> idle 为空
    const noIdle = mk(1, false);
    expect(noIdle.idle).toEqual([]);
  });
});

describe('dimensionPrefetchPaths (像素窗口中心预读 — 修返回深处大片空白 bug)', () => {
  // v0.1.0-module3.0.8 fix: 旧 nextBatchPaths 用 measuredMap.size 当连续前缀起点，
  // reader 返回瀑布流深处时 measuredMap 清空 → 仍从 p0 读 → 视口附近的图永远拿不到
  // 真实尺寸 → 用偏纵向的 avgRatio 估算 → 横向图被估算成纵向高度 → 大片空白。
  // 新 dimensionPrefetchPaths 以 thumbnailWindows（visible+ahead+behind）为中心，
  // 过滤已测量，不依赖 measuredCount 连续前缀。
  function mkEntry(path: string): MediaEntry {
    // name 借 .jpg 后缀过 isMasonryImage 判定（2026-08-27 混排布局）；path 保持裸名供断言
    return { name: `${path}.jpg`, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
  }

  it('scrollTop 在深处 + measuredMap 空 → 返回视口附近 paths（不是开头 p0）', () => {
    // 100 张图单列，measuredMap 空（模拟 reader 返回后 MasonryView 重建）
    const entries = ref<readonly MediaEntry[]>(
      Array.from({ length: 100 }, (_, i) => mkEntry(`p${i}`)),
    );
    const { dimensionPrefetchPaths, thumbnailWindows } = useMasonryLayout({
      entries,
      containerWidth: ref(100),
      containerHeight: ref(200),
      colCount: ref(1),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(5000), // 深处（单列估算高度 ~133px/张 → 约第 37 张附近）
      measuredMap: ref(new Map()),
    });
    const paths = dimensionPrefetchPaths.value;
    expect(paths.length).toBeGreaterThan(0);
    // 核心断言：旧 bug 从 measuredCount(=0) slice 返回 p0-pN；新行为返回视口附近
    expect(paths).not.toContain('p0');
    expect(paths).not.toContain('p1');
    // 交叉验证：应与 thumbnailWindows 的 visible/ahead/behind 有交集
    const nearby = [
      ...thumbnailWindows.value.visible,
      ...thumbnailWindows.value.ahead,
      ...thumbnailWindows.value.behind,
    ];
    expect(paths.some((p) => nearby.includes(p))).toBe(true);
  });

  it('已测量的 path 被过滤掉（不重复请求）', () => {
    const entries = ref<readonly MediaEntry[]>(
      Array.from({ length: 20 }, (_, i) => mkEntry(`p${i}`)),
    );
    // p0-p9 已测量（视口在顶部，这些在窗口内但不该再请求）
    const measured = ref(
      new Map<string, { width: number; height: number }>(
        Array.from({ length: 10 }, (_, i) => [`p${i}`, { width: 100, height: 100 }]),
      ),
    );
    const { dimensionPrefetchPaths } = useMasonryLayout({
      entries,
      containerWidth: ref(100),
      containerHeight: ref(200),
      colCount: ref(1),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap: measured,
    });
    const paths = dimensionPrefetchPaths.value;
    for (let i = 0; i < 10; i++) {
      expect(paths).not.toContain(`p${i}`);
    }
  });

  it('视口在顶部 + 全未测量 → 返回开头 paths（正常情况不回归）', () => {
    const entries = ref<readonly MediaEntry[]>(
      Array.from({ length: 50 }, (_, i) => mkEntry(`p${i}`)),
    );
    const { dimensionPrefetchPaths } = useMasonryLayout({
      entries,
      containerWidth: ref(100),
      containerHeight: ref(200),
      colCount: ref(1),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap: ref(new Map()),
    });
    const paths = dimensionPrefetchPaths.value;
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toBe('p0');
  });

  it('截断到 batch 上限（防止一次请求过多尺寸）', () => {
    const entries = ref<readonly MediaEntry[]>(
      Array.from({ length: 500 }, (_, i) => mkEntry(`p${i}`)),
    );
    const { dimensionPrefetchPaths } = useMasonryLayout({
      entries,
      containerWidth: ref(100),
      containerHeight: ref(200),
      colCount: ref(1),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap: ref(new Map()),
    });
    // batch 上限存在（具体值由实现定，测试只验有上限，不超过 120）
    expect(dimensionPrefetchPaths.value.length).toBeLessThanOrEqual(120);
  });
});

// ─── mergeMeasured（缩略图 natural 尺寸喂布局，2026-08-27 实机诊断修复）───────
// 场景：WebDAV 远程目录缩略图缓存命中本地秒出，但真实尺寸要远程 header 请求——
// img 已加载（naturalWidth/Height 就是真实比例，缩略图保比例）却还在按 3:4 估算。
// img onload 把 natural 尺寸写入 measuredMap：已测量（header 真值/先到者）不覆盖。

describe('mergeMeasured', () => {
  it('空 map 新增条目，返回新 Map 引用（响应式替换）', () => {
    const existing = new Map<string, { width: number; height: number }>();
    const next = mergeMeasured(existing, 'a.jpg', { width: 512, height: 288 });
    expect(next.get('a.jpg')).toEqual({ width: 512, height: 288 });
    // 必须返回新引用触发 ref 更新；原 map 不被突变
    expect(next).not.toBe(existing);
    expect(existing.has('a.jpg')).toBe(false);
  });

  it('已有条目不覆盖（header 真值/先到者获胜），返回原引用', () => {
    const existing = new Map([['a.jpg', { width: 3840, height: 2160 }]]);
    const next = mergeMeasured(existing, 'a.jpg', { width: 512, height: 288 });
    // 保持先到值；无变化返回原引用，避免无谓 layout 重算
    expect(next.get('a.jpg')).toEqual({ width: 3840, height: 2160 });
    expect(next).toBe(existing);
  });

  it('其他条目保留', () => {
    const existing = new Map([['b.jpg', { width: 100, height: 50 }]]);
    const next = mergeMeasured(existing, 'a.jpg', { width: 512, height: 288 });
    expect(next.get('b.jpg')).toEqual({ width: 100, height: 50 });
    expect(next.get('a.jpg')).toEqual({ width: 512, height: 288 });
  });
});

// ─── 混排占位（2026-08-27 方案 B）：非图片条目固定 16:9 高占位 ──────────────
// 布局含全部 entries（占位卡参与瀑布流），非图片不查 measuredMap（固定高），
// dimensionPrefetchPaths 只喂 masonry 图片（isMasonryImage——cover.jpg 目录不算）。
// 自建 factory（现有 mkEntry 是其他 describe 局部函数且固定 isDirectory:false）。
describe('useMasonryLayout 混排占位', () => {
  function mkMix(
    path: string,
    over: Partial<{ isDirectory: boolean; isArchive: boolean }> = {},
  ): MediaEntry {
    return { name: path, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0, ...over };
  }

  const MIX = (): Ref<readonly MediaEntry[]> => ref([
    mkMix('Thumbs.db'),               // 非图片文件（自然排序最前——实机空洞元凶）
    mkMix('cover.jpg', { isDirectory: true }),  // 目录命名像图片（审查 P1：类型标记优先）
    mkMix('sub', { isDirectory: true }),        // 子目录
    mkMix('book.cbz', { isArchive: true }),     // 归档
    mkMix('a.jpg'),                   // 真图片
  ]);

  function mountLayout(entries: Ref<readonly MediaEntry[]>, measured: Map<string, { width: number; height: number }>) {
    return useMasonryLayout({
      entries,
      containerWidth: ref(1000),
      containerHeight: ref(800),
      colCount: ref(4),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap: ref(measured),
    });
  }

  it('布局 map 含全部 entries（非图片占位卡参与瀑布流，无空洞）', () => {
    const { layout } = mountLayout(MIX(), new Map([['a.jpg', { width: 3840, height: 2160 }]]));
    expect(layout.value.map.size).toBe(5);
    expect(layout.value.map.get('Thumbs.db')).toBeTruthy();
    expect(layout.value.map.get('cover.jpg')).toBeTruthy();
    expect(layout.value.map.get('sub')).toBeTruthy();
    expect(layout.value.map.get('book.cbz')).toBeTruthy();
  });

  it('非图片固定 16:9 高（colWidth×9/16），不查 measuredMap；图片用测量高', () => {
    // measured 故意放 3:4 竖图：avgRatio 被拉向 0.75 → 估算高 333，
    // 与占位高 141 拉开差距——证明非图片不参与 avgRatio 估算（撞值假绿防线）
    const measured = new Map([['a.jpg', { width: 1000, height: 1333 }]]);
    const { layout, colWidth } = mountLayout(MIX(), measured);
    const cw = colWidth.value; // (1000 - 0) / 4 = 250
    const ph = Math.round((cw * 9) / 16); // ≈141
    expect(layout.value.map.get('Thumbs.db')!.height).toBe(ph);
    expect(layout.value.map.get('cover.jpg')!.height).toBe(ph);
    expect(layout.value.map.get('sub')!.height).toBe(ph);
    expect(layout.value.map.get('book.cbz')!.height).toBe(ph);
    // 图片：250 × 1333/1000 = 333.25 → round 333
    expect(layout.value.map.get('a.jpg')!.height).toBe(Math.round((cw * 1333) / 1000));
  });

  it('dimensionPrefetchPaths 不含非图片（cover.jpg 目录也不含——isMasonryImage）', () => {
    const { dimensionPrefetchPaths } = mountLayout(MIX(), new Map());
    const paths = dimensionPrefetchPaths.value;
    expect(paths).toContain('a.jpg');
    expect(paths).not.toContain('Thumbs.db');
    expect(paths).not.toContain('cover.jpg');
    expect(paths).not.toContain('sub');
    expect(paths).not.toContain('book.cbz');
  });

  it('thumbnailWindows 保持含非图片（useArchiveWindowPrefetch 靠它拿 is_archive 条目）', () => {
    const { thumbnailWindows } = mountLayout(MIX(), new Map());
    const all = [...thumbnailWindows.value.visible, ...thumbnailWindows.value.ahead, ...thumbnailWindows.value.behind, ...thumbnailWindows.value.idle];
    expect(all).toContain('book.cbz');
  });
});
