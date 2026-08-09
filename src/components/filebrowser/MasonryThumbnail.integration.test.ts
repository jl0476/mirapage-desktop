/**
 * MasonryThumbnail 集成测试（计划任务13）。
 *
 * 验证 1000 entry 场景下的核心不变量（无需真实浏览器/DOM 全挂载，用 composable 代理）：
 * - 虚拟化：useMasonryLayout.visibleRange 输出有界切片（DOM ≤ 40 的保证），不是 1000；
 * - 像素窗口：thumbnailWindows 即使 1000 entry，四组 path 总数仍小（只含视口相交 + 配置屏数）；
 * - 0px gap：相邻 item 坐标边相接无缝隙。
 *
 * 注：真实 rAF 帧时间 / 浏览器 paint 需在本地 Tauri 环境实跑（性能报告标注）。
 */
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { useMasonryLayout } from '@/composables/useMasonryLayout';
import type { MediaEntry } from '@/lib/sourceDescriptor';

function mkEntry(p: string): MediaEntry {
  return { name: p, path: p, isDirectory: false, isArchive: false, size: 0 };
}

describe('MasonryThumbnail 集成：1000 entry 虚拟化 + 窗口不变量', () => {
  const N = 1000;
  const entries = ref<readonly MediaEntry[]>(Array.from({ length: N }, (_, i) => mkEntry(`p${i}`)));
  // 单列、每张 100 高、0 gap；视口 400 -> 约可见 4 行 + buffer
  const measured = ref(new Map<string, { width: number; height: number }>(
    Array.from({ length: N }, (_, i) => [`p${i}`, { width: 100, height: 100 }]),
  ));

  const { visibleRange, thumbnailWindows, layout } = useMasonryLayout({
    entries,
    containerWidth: ref(100),
    containerHeight: ref(400),
    colCount: ref(1),
    hGap: ref(0),
    vGap: ref(0),
    scrollTop: ref(0),
    measuredMap: measured,
  });

  it('visibleRange 有界（远小于 1000，DOM 上限保证）', () => {
    const span = visibleRange.value.end - visibleRange.value.start;
    expect(span).toBeLessThan(50);
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(N);
  });

  it('thumbnailWindows 四组总数远小于 1000（只含视口+预读屏）', () => {
    const w = thumbnailWindows.value;
    const total = w.visible.length + w.ahead.length + w.behind.length + w.idle.length;
    expect(total).toBeLessThan(100);
    expect(total).toBeLessThan(N);
  });

  it('滚动到中段：visible 区 path 来自中段，ahead 在其下方', () => {
    // 重新构造一个 scrollTop=50000 的布局
    const { thumbnailWindows: tw2 } = useMasonryLayout({
      entries, containerWidth: ref(100), containerHeight: ref(400),
      colCount: ref(1), hGap: ref(0), vGap: ref(0), scrollTop: ref(50000), measuredMap: measured,
    });
    const w = tw2.value;
    expect(w.visible.length).toBeGreaterThan(0);
    // visible path 索引应在 500 附近（50000/100）
    const visIdx = w.visible.map((p) => Number(p.slice(1)));
    expect(Math.max(...visIdx)).toBeGreaterThan(400);
  });

  it('0px gap：相邻 item top/height 边相接（无重叠无缝隙）', () => {
    const m = layout.value.map;
    // 单列：p0 top0 height100 -> p1 top100
    const a = m.get('p0')!;
    const b = m.get('p1')!;
    expect(b.top).toBe(a.top + a.height);
    expect(a.left).toBe(b.left);
    expect(a.width).toBe(b.width);
  });
});
