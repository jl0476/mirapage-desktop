# module3.1.0 竖条漫（Webtoon）阅读模式实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 落地 spec `docs/superpowers/specs/2026-08-17-reader-webtoon-design.md`——第三种阅读模式 webtoon（竖向连续滚动 + 自由缩放 + 自动滚动 + 进度/跨卷复用）。

**架构：** 新组件 `WebtoonViewer`（原生滚动 + 单列虚拟化 img strip，不用 OSD）+ 两个薄 composable（尺寸预读 / 进度记录）；ReaderScreen 三模式分支；输入映射 per-mode；零 Rust、零 DB 迁移。

**技术栈：** Vue 3 + Pinia + Vitest（happy-dom）；复用 `listImageDimensions` IPC、`useReaderHotkeys`/`useReaderWheel`、slideshow/crossVolume/settings stores。

**相对 spec 的实施偏差**（已定）：
1. **缩放实现**：spec 写 CSS `zoom` 属性；实施改为**显式宽度缩放**（strip 宽 = 基准宽 × zoom，img `width:100%` 高度自然跟随）——语义完全一致（锚点补偿公式同 spec §3），但走标准 CSS，规避非标准属性在 happy-dom/未来引擎的兼容风险。锚点数学抽纯函数可测。
2. **虚拟化**：spec 写「复用 useVirtualList 变高模式」；实施为 **~50 行单列专用窗口计算**（heights 前缀和 + 二分）——`useVirtualList` 是 MediaEntry/行高函数导向，masonry 当年也绕开自建；单列线性远比多列简单，独立实现更清晰。

**CRLF 警告**：`ReaderView.vue` / `tauri.ts` 等多数存量文件是 CRLF——多行编辑走 node 补丁脚本（`_wtN_patch.mjs` 模式，跑完即删）；新文件用 Write 直建。

---

## 文件结构

| 文件 | 变更 | 职责 |
|---|---|---|
| `src/lib/readerSettings.ts` + `.test.ts` | 修改 | ReadMode 枚举 + normalize |
| `src/stores/settings.ts` + `.test.ts` | 修改 | 扩既有 ReaderMode 加 webtoon（re-export readerSettings 类型）+ 三 webtoon 设置键 |
| `src/lib/webtoonLayout.ts` + `.test.ts` | 创建 | 纯函数：布局前缀和 / 窗口二分 / 顶部图 / 缩放锚点 / 自动滚动步进 |
| `src/composables/useWebtoonDimensions.ts` + `.test.ts` | 创建 | 图头渐进测量（估算占位 + 预读窗口批量 IPC） |
| `src/components/reader/WebtoonViewer.vue` + `.test.ts` | 创建 | 滚动容器 + 虚拟 strip + 缩放 + expose |
| `src/composables/useWebtoonProgress.ts` + `.test.ts` | 创建 | debounce 记录顶部图 + atBottom→finished |
| `src/views/ReaderView.vue` | 修改 | webtoon 分支接线（viewer ref / 进度恢复 / 自动滚动 rAF / 输入动作） |
| `src/components/reader/ReaderScreen.vue` | 修改 | mode 加 'webtoon' 分支 |
| `src/components/reader/ReaderMainMenu.vue` | 修改 | cycle 三态 + 重置缩放项 |
| `src/composables/useReaderWheel.ts` | 修改 | enabled 守卫（webtoon 不接管） |
| `src/components/settings/Settings.vue`（或对应 section 文件） | 修改 | 阅读模式下拉 + webtoon 子设置 |
| `src/locales/zh-CN.ts` / `en-US.ts` | 修改 | 新 key 双语 |
| `DESIGN.md` / `AGENTS.md` | 修改 | §16.5 移除 Webtoon 行 / §12 补小节 / 状态表 |

---

### 任务 1：ReadMode 枚举 + settings store

**文件：**
- 修改：`src/lib/readerSettings.ts`
- 修改：`src/stores/settings.ts`
- 测试：`src/lib/readerSettings.test.ts`、`src/stores/settings.test.ts`

- [ ] **步骤 1：写失败测试（readerSettings.test.ts 追加）**

```ts
import { ReadMode, normalizeReadMode, DEFAULT_READ_MODE } from './readerSettings';

describe('ReadMode（module3.1.0）', () => {
  it('DEFAULT_READ_MODE 是 single', () => {
    expect(DEFAULT_READ_MODE).toBe<ReadMode>('single');
  });
  it('normalizeReadMode 合法值透传', () => {
    expect(normalizeReadMode('webtoon')).toBe('webtoon');
    expect(normalizeReadMode('double')).toBe('double');
  });
  it('normalizeReadMode 非法值 fallback single', () => {
    expect(normalizeReadMode('rtl')).toBe('single');
    expect(normalizeReadMode('')).toBe('single');
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/lib/readerSettings.test.ts
```

预期：编译失败（`ReadMode` / `normalizeReadMode` 不存在）。

- [ ] **步骤 3：实现（readerSettings.ts）**

在 `ReadDirection` 定义后追加：

```ts
/** 阅读模式（module3.1.0：webtoon = 竖向连续滚动） */
export type ReadMode = 'single' | 'double' | 'webtoon';
export const DEFAULT_READ_MODE: ReadMode = 'single';

const VALID_READ_MODES: ReadonlySet<ReadMode> = new Set(['single', 'double', 'webtoon']);

/** 把 DB 读出的 reader_mode 值规范化为合法 ReadMode（老数据/非法值 fallback single）。 */
export function normalizeReadMode(v: string): ReadMode {
  return VALID_READ_MODES.has(v as ReadMode) ? (v as ReadMode) : DEFAULT_READ_MODE;
}
```

- [ ] **步骤 4：settings store（settings.ts，CRLF 用 node 补丁）——扩既有 ReaderMode，不新增模式 key（审查 P1-1）**

**背景**：settings.ts:21 已有 `type ReaderMode = 'single' | 'double'` + `readerDefaultMode` ref + `reader_default_mode` key + `cycleReaderMode()` 两态循环，ReaderView/主菜单/双页判断均消费它。**禁止另立 readMode/reader_mode 第二套状态**——扩既有链路：

(a) `readerSettings.ts`（任务 1 步骤 3 已建）成为类型单一真值源；settings.ts:21 本地 `export type ReaderMode` 改为 `export type { ReadMode as ReaderMode } from '@/lib/readerSettings'`（re-export 保既有 import 不动），`import { ReadMode, normalizeReadMode } from '@/lib/readerSettings'`。

(b) 加载映射既有 `['reader_default_mode', (v) => (readerDefaultMode.value = v as ReaderMode)]` 改为：

```ts
      ['reader_default_mode', (v) => (readerDefaultMode.value = normalizeReadMode(v as string))],
```

(c) `cycleReaderMode`（settings.ts:263-270）改三态循环：

```ts
  async function cycleReaderMode(): Promise<void> {
    const order: ReadMode[] = ['single', 'double', 'webtoon'];
    const next = order[(order.indexOf(readerDefaultMode.value) + 1) % order.length];
    log('[settings] cycleReaderMode →', next, '(was', readerDefaultMode.value, ')');
    store.$patch({ readerDefaultMode: next });
    await update('reader_default_mode', next);
    log('[settings] cycleReaderMode done, current=', readerDefaultMode.value);
  }
```

(d) `currentScaleMode` 声明后加 webtoon 三设置 + 模式直设器（**不含模式 key**——`setReaderMode` 写既有 `reader_default_mode`，Settings 下拉用）：

```ts
  // module3.1.0: webtoon 设置（spec §1/§2/§4）
  const webtoonMaxWidth = ref(0);     // 0 = 不限宽；px
  const webtoonGap = ref(0);          // 0-24 px
  const webtoonScrollSpeed = ref(60); // px/s，10-300
  /** 模式直设（Settings 下拉用；写入既有 reader_default_mode key）。 */
  async function setReaderMode(mode: ReadMode): Promise<void> {
    readerDefaultMode.value = mode;
    await update('reader_default_mode', mode);
  }
  function setWebtoonMaxWidth(px: number): void {
    webtoonMaxWidth.value = Math.max(0, Math.round(px));
    void update('webtoon_max_width', String(webtoonMaxWidth.value));
  }
  function setWebtoonGap(px: number): void {
    webtoonGap.value = Math.min(24, Math.max(0, Math.round(px)));
    void update('webtoon_gap', String(webtoonGap.value));
  }
  function setWebtoonScrollSpeed(px: number): void {
    webtoonScrollSpeed.value = Math.min(300, Math.max(10, Math.round(px)));
    void update('webtoon_scroll_speed', String(webtoonScrollSpeed.value));
  }
```

return 对象加 `webtoonMaxWidth, webtoonGap, webtoonScrollSpeed, setReaderMode, setWebtoonMaxWidth, setWebtoonGap, setWebtoonScrollSpeed`（`readerDefaultMode`/`cycleReaderMode` 已在 return，不动）。（`update` 为该 store 既有的 settings 写入函数名——执行时以实际名为准。）

- [ ] **步骤 5：settings.test.ts 追加用例**

```ts
it('readerDefaultMode：webtoon 合法 + 非法 fallback single（module3.1.0）', async () => {
  const s = useSettingsStore();
  await s.setReaderMode('webtoon');
  expect(s.readerDefaultMode).toBe('webtoon');
  // 非法值经 normalizeReadMode fallback（映射数组行为，经 setReaderMode 类型层已挡，此处测加载层）
  expect(normalizeReadMode('bogus')).toBe('single');
});

it('cycleReaderMode：三态循环 single→double→webtoon→single（module3.1.0）', async () => {
  const s = useSettingsStore();
  await s.setReaderMode('single');
  await s.cycleReaderMode();
  expect(s.readerDefaultMode).toBe('double');
  await s.cycleReaderMode();
  expect(s.readerDefaultMode).toBe('webtoon');
  await s.cycleReaderMode();
  expect(s.readerDefaultMode).toBe('single');
});
```

- [ ] **步骤 6：运行验证通过 + Commit**

```bash
npx vitest run src/lib/readerSettings.test.ts src/stores/settings.test.ts
git add src/lib/readerSettings.ts src/lib/readerSettings.test.ts src/stores/settings.ts src/stores/settings.test.ts
git commit -m "feat(reader): 既有 ReaderMode 扩 webtoon（cycle 三态 + normalize）+ webtoon 三设置键（任务 1/8）"
```

---

### 任务 2：webtoonLayout 纯函数库

**文件：**
- 创建：`src/lib/webtoonLayout.ts`、`src/lib/webtoonLayout.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import {
  computeLayout, visibleWindow, topVisibleIndex, clampZoom, anchoredScroll, autoScrollDelta,
} from './webtoonLayout';

describe('webtoonLayout（module3.1.0）', () => {
  const measured = new Map([
    ['a.jpg', { width: 1000, height: 2000 }],
    ['b.jpg', { width: 1000, height: 3000 }],
  ]);
  // c.jpg 未测量 → 估算 3:4（宽 1000 → 高 1000*4/3 ≈ 1333.33）

  it('computeLayout：实测用宽高比、未测量用 3:4 估算、tops 为前缀和', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(l.heights[0]).toBe(1000);            // 500 * 2000/1000
    expect(l.heights[1]).toBe(1500);            // 500 * 3000/1000
    expect(l.heights[2]).toBeCloseTo(666.667, 1); // 500 * 4/3
    expect(l.tops[0]).toBe(0);
    expect(l.tops[1]).toBe(1000);
    expect(l.tops[2]).toBe(2500);
    expect(l.totalHeight).toBeCloseTo(3166.667, 1);
  });

  it('computeLayout：gap 计入相邻项', () => {
    const l = computeLayout(['a.jpg', 'b.jpg'], measured, 500, 10);
    expect(l.tops[1]).toBe(1010);
  });

  it('visibleWindow：视口 ±2.5 屏二分窗口', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    // 3 张全高 3166；scrollTop=0 viewport=1000 → 覆盖全部
    expect(visibleWindow(l, 0, 1000)).toEqual({ start: 0, end: 3 });
  });

  it('visibleWindow：中部滚动只含命中条目', () => {
    const names = ['a.jpg', 'b.jpg', 'c.jpg'];
    const l = computeLayout(names, measured, 500, 0);
    // 视口 1px + 0 屏余量：scrollTop=1000（b 顶部）只含 b
    const w = visibleWindow(l, 1000, 1, 0);
    expect(w.start).toBe(1);
    expect(w.end).toBe(2);
  });

  it('topVisibleIndex：首个底边超过 scrollTop 的条目', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(topVisibleIndex(l, 0)).toBe(0);
    expect(topVisibleIndex(l, 1000)).toBe(1);
    expect(topVisibleIndex(l, 999)).toBe(0);
  });

  it('clampZoom：1-4 clamp + 两位小数', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2.34)).toBe(2.34);
    expect(clampZoom(5)).toBe(4);
  });

  it('anchoredScroll：缩放后鼠标下内容点不动', () => {
    // scrollTop=1000, clientY=500, 1x→2x：内容点 Y=1500 → 新 scrollTop=1500*2-500=2500
    expect(anchoredScroll(1000, 500, 1, 2)).toBe(2500);
    // 2x→1x 回去
    expect(anchoredScroll(2500, 500, 2, 1)).toBe(1000);
  });

  it('autoScrollDelta：speed × factor × dt', () => {
    expect(autoScrollDelta(60, 1, 1000)).toBeCloseTo(60);
    expect(autoScrollDelta(60, 2, 500)).toBeCloseTo(60);
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/lib/webtoonLayout.test.ts
```

预期：模块不存在。

- [ ] **步骤 3：实现（src/lib/webtoonLayout.ts，新建）**

```ts
/**
 * webtoonLayout.ts — 竖条漫布局纯函数（module3.1.0，spec §2）
 *
 * 无 Vue / DOM 依赖，可独立 vitest。单列线性布局：
 * heights[i] 由实测宽高比或 3:4 估算推导；tops 前缀和支撑窗口二分。
 */

/** 未测量图片的估算宽高比（宽:高 = 3:4，与瀑布流 fallback 一致） */
export const ESTIMATED_RATIO = 3 / 4;

export interface WebtoonLayout {
  names: string[];
  heights: number[];
  /** tops[i] = 第 i 张顶部 y（含前序 gap） */
  tops: number[];
  totalHeight: number;
}

export function computeLayout(
  names: readonly string[],
  measured: ReadonlyMap<string, { width: number; height: number }>,
  stripWidth: number,
  gap: number,
): WebtoonLayout {
  const heights = names.map((n) => {
    const m = measured.get(n);
    if (m && m.width > 0 && m.height > 0) return (stripWidth * m.height) / m.width;
    return stripWidth / ESTIMATED_RATIO;
  });
  const tops: number[] = new Array(names.length);
  let acc = 0;
  for (let i = 0; i < names.length; i++) {
    tops[i] = acc;
    acc += heights[i] + (i < names.length - 1 ? gap : 0);
  }
  return { names: [...names], heights, tops, totalHeight: acc };
}

/** 可见窗口 [start, end)：覆盖 [scrollTop - screens×viewport, scrollTop + (1+screens)×viewport]。二分。 */
export function visibleWindow(
  l: WebtoonLayout,
  scrollTop: number,
  viewportHeight: number,
  screens = 2.5,
): { start: number; end: number } {
  const lo = scrollTop - screens * viewportHeight;
  const hi = scrollTop + (1 + screens) * viewportHeight;
  // start：首个 (top + height) > lo
  let s = 0, e = l.names.length;
  while (s < e) {
    const mid = (s + e) >> 1;
    if (l.tops[mid] + l.heights[mid] > lo) e = mid; else s = mid + 1;
  }
  const start = s;
  // end：首个 top > hi
  let s2 = start, e2 = l.names.length;
  while (s2 < e2) {
    const mid = (s2 + e2) >> 1;
    if (l.tops[mid] > hi) e2 = mid; else s2 = mid + 1;
  }
  return { start, end: Math.max(s2, start) };
}

/** 顶部可见条目：首个底边超过 scrollTop 的索引（相交优先语义的单列简化）。 */
export function topVisibleIndex(l: WebtoonLayout, scrollTop: number): number {
  for (let i = 0; i < l.names.length; i++) {
    if (l.tops[i] + l.heights[i] > scrollTop + 1) return i;
  }
  return Math.max(0, l.names.length - 1);
}

/** 缩放 clamp：1.0-4.0，两位小数。 */
export function clampZoom(z: number): number {
  return Math.min(4, Math.max(1, Math.round(z * 100) / 100));
}

/** 锚点缩放：保持 (scrollTop + clientY) 处的内容点缩放后仍在 clientY（spec §3 公式）。 */
export function anchoredScroll(scrollTop: number, clientY: number, oldZ: number, newZ: number): number {
  return (scrollTop + clientY) * (newZ / oldZ) - clientY;
}

/** 自动滚动单步位移（px）：speed(px/s) × factor × dt(ms)。 */
export function autoScrollDelta(speed: number, factor: number, dt: number): number {
  return (speed * factor * dt) / 1000;
}
```

- [ ] **步骤 4：运行验证通过 + Commit**

```bash
npx vitest run src/lib/webtoonLayout.test.ts
git add src/lib/webtoonLayout.ts src/lib/webtoonLayout.test.ts
git commit -m "feat(webtoon): 布局纯函数库（前缀和/窗口二分/缩放锚点/滚动步进）（任务 2/8）"
```

---

### 任务 3：useWebtoonDimensions 渐进测量

**文件：**
- 创建：`src/composables/useWebtoonDimensions.ts`、`src/composables/useWebtoonDimensions.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { ref } from 'vue';
import { useWebtoonDimensions } from './useWebtoonDimensions';
import { listImageDimensions } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listImageDimensions: vi.fn() };
});

describe('useWebtoonDimensions（module3.1.0）', () => {
  function mk(relPath = '') {
    return useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['a.jpg', 'b.jpg', 'c.jpg']),
      ref(relPath),
    );
  }

  it('ensureRange：拼 relPath 前缀请求 fullPath，响应反查 name 回填（审查 P1-3）', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'comics/vol01/a.jpg', width: 1000, height: 2000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const d = mk('comics/vol01');
    await d.ensureRange(0, 2);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'R:\\c' },
      ['comics/vol01/a.jpg', 'comics/vol01/b.jpg'],   // fullPaths，非裸名
    );
    // measuredMap 以 name 为 key（layout 消费）
    expect(d.measuredMap.value.get('a.jpg')).toEqual({ width: 1000, height: 2000 });
    // 二次同范围：已请求过的不再发 IPC
    await d.ensureRange(0, 2);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledTimes(1);
  });

  it('relPath=""（书在根）：裸名直传', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'a.jpg', width: 100, height: 200 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const d = mk('');
    await d.ensureRange(0, 1);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledWith(
      expect.anything(), ['a.jpg'],
    );
  });

  it('跨卷（relPath 变化）：requested/measuredMap 清空，同名图重新测量', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'vol1/001.jpg', width: 1000, height: 2000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const relPath = ref('vol1');
    const d = useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['001.jpg']),
      relPath,
    );
    await d.ensureRange(0, 1);
    expect(d.measuredMap.value.size).toBe(1);
    // 跨卷 → relPath 变 → 清空
    relPath.value = 'vol2';
    await Promise.resolve(); // watch flush
    expect(d.measuredMap.value.size).toBe(0);
    // 同名 001.jpg 重新请求（requested 已清）
    vi.mocked(listImageDimensions).mockClear();
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'vol2/001.jpg', width: 800, height: 3000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    await d.ensureRange(0, 1);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledTimes(1);
    expect(d.measuredMap.value.get('001.jpg')).toEqual({ width: 800, height: 3000 });
  });

  it('IPC 失败静默（估算占位兜底，measuredMap 不写入失败项）', async () => {
    vi.mocked(listImageDimensions).mockRejectedValue(new Error('io'));
    const d = mk();
    await d.ensureRange(0, 1); // 不抛
    expect(d.measuredMap.value.size).toBe(0);
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/composables/useWebtoonDimensions.test.ts
```

预期：模块不存在。

- [ ] **步骤 3：实现（新建）**

```ts
/**
 * useWebtoonDimensions.ts — webtoon 图头渐进测量（module3.1.0，spec §2.2）
 *
 * 复用 listImageDimensions IPC（3.0.6 图头解析）；按窗口批量、按名去重；
 * 失败静默（调用方 layout 对未测量项用 3:4 估算占位）。
 * 不共享 masonry composable：单列薄实现，避免反向耦合。
 */
import { ref, type Ref } from 'vue';
import { listImageDimensions, type SourceDescriptor } from '@/lib/tauri';
import { log } from '@/lib/logger';

export function useWebtoonDimensions(
  descriptor: Ref<SourceDescriptor>,
  names: Ref<readonly string[]>,
) {
  const measuredMap = ref(new Map<string, { width: number; height: number }>());
  const requested = new Set<string>();
  let inFlight: Promise<void> | null = null;

  async function ensureRange(start: number, end: number): Promise<void> {
    const batch: string[] = [];
    for (let i = Math.max(0, start); i < Math.min(end, names.value.length); i++) {
      const n = names.value[i];
      if (!requested.has(n)) {
        requested.add(n);
        batch.push(n);
      }
    }
    if (batch.length === 0) return;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = (async () => {
      try {
        // IPC 需要 source-relative 完整路径（审查 P1-3）：拼 relPath 前缀（MasonryView:406-417 同款）
        const fullPaths = batch.map((n) =>
          relPath.value ? PathUtils.join(relPath.value, n) : n);
        const dims = await listImageDimensions(descriptor.value, fullPaths);
        const next = new Map(measuredMap.value);
        for (const d of dims) {
          if (d.width <= 0 || d.height <= 0) continue;
          // 响应 path 是 fullPath → 反查回 name 作 key（layout 以 name 消费）
          const name = fullNameToName.get(d.path) ?? d.path;
          next.set(name, { width: d.width, height: d.height });
        }
        measuredMap.value = next;
      } catch (e) {
        log('[webtoon] listImageDimensions failed', e);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  // 换书/跨卷（relPath 或 descriptor 变化）：清空 requested + measuredMap
  // ——跨卷同名 001.jpg 若不清会复用前一卷尺寸（审查 P1-3）
  watch([relPath, descriptor], () => {
    requested.clear();
    fullNameToName.clear();
    measuredMap.value = new Map();
  });

  return { measuredMap, ensureRange };
}
```

签名与上文配套改为（`relPath` = 书的 root 相对路径，ReaderView 从 reader store 的当前卷身份传入）：

```ts
export function useWebtoonDimensions(
  descriptor: Ref<SourceDescriptor>,
  names: Ref<readonly string[]>,
  relPath: Ref<string>,
) {
  const measuredMap = ref(new Map<string, { width: number; height: number }>());
  const requested = new Set<string>();
  const fullNameToName = new Map<string, string>(); // IPC fullPath → name 反查表
  let inFlight: Promise<void> | null = null;

  async function ensureRange(start: number, end: number): Promise<void> {
    const batch: string[] = [];
    for (let i = Math.max(0, start); i < Math.min(end, names.value.length); i++) {
      const n = names.value[i];
      if (!requested.has(n)) {
        requested.add(n);
        const full = relPath.value ? PathUtils.join(relPath.value, n) : n;
        fullNameToName.set(full, n);
        batch.push(n);
      }
    }
    // ……（后半段同上：fullPaths 映射 + 反查回填 + watch 清空）
  }
  // ……
}
```

import 补：`import { watch } from 'vue';`（与 ref 合并）、`import { PathUtils } from '@/lib/path';`。

（`ImageDim` 的字段名以 `tauri.ts` 实际定义为准——若为 `path/width/height` 之外的命名，同步调整测试与实现。）

- [ ] **步骤 4：运行验证通过 + Commit**

```bash
npx vitest run src/composables/useWebtoonDimensions.test.ts
git add src/composables/useWebtoonDimensions.ts src/composables/useWebtoonDimensions.test.ts
git commit -m "feat(webtoon): 图头渐进测量 composable（批量去重+失败静默）（任务 3/8）"
```

---

### 任务 4：WebtoonViewer 组件

**文件：**
- 创建：`src/components/reader/WebtoonViewer.vue`、`src/components/reader/WebtoonViewer.test.ts`

- [ ] **步骤 1：写失败测试（组件测，happy-dom 无真实布局——只断言挂载结构/类名/expose 值与源码守卫）**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { readFileSync } from 'node:fs';
import WebtoonViewer from './WebtoonViewer.vue';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listImageDimensions: vi.fn(async () => []) };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': {} } });

const URLS = ['asset://a.jpg', 'asset://b.jpg', 'asset://c.jpg'];
const NAMES = ['a.jpg', 'b.jpg', 'c.jpg'];

function mountViewer(extra: Record<string, unknown> = {}) {
  return mount(WebtoonViewer, {
    props: { urls: URLS, names: NAMES, descriptor: { type: 'local', rootPath: 'R:\\c' }, relPath: '' },
    global: { plugins: [i18n] },
    ...extra,
  });
}

describe('WebtoonViewer（module3.1.0）', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('挂载滚动容器 + strip + 窗口内 img（decoding=async）', async () => {
    const w = mountViewer();
    await flushPromises();
    expect(w.find('.webtoon-scroll').exists()).toBe(true);
    const imgs = w.findAll('.webtoon-item img');
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].attributes('decoding')).toBe('async');
    expect(imgs[0].attributes('src')).toBe('asset://a.jpg');
  });

  it('getTopVisibleImage：scrollTop=0 → 首图', async () => {
    const w = mountViewer();
    await flushPromises();
    expect(w.vm.getTopVisibleImage()).toBe('a.jpg');
  });

  it('setZoom clamp 1-4 + zoom ref 可读', async () => {
    const w = mountViewer();
    await flushPromises();
    w.vm.setZoom(9);
    expect(w.vm.zoom.value).toBe(4);
    w.vm.setZoom(0.2);
    expect(w.vm.zoom.value).toBe(1);
  });

  it('autoScrollStep：正 dt 增 scrollTop（mock 元素属性）', async () => {
    const w = mountViewer();
    await flushPromises();
    const el = w.find('.webtoon-scroll').element as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 10000 });
    w.vm.autoScrollStep(1000, 60, 1);
    expect(el.scrollTop).toBe(60);
  });

  it('emit scroll-past-bottom：wheel deltaY>0 且 atBottom', async () => {
    const w = mountViewer();
    await flushPromises();
    const el = w.find('.webtoon-scroll');
    Object.defineProperty(el.element, 'scrollTop', { value: 999999, writable: true });
    Object.defineProperty(el.element, 'clientHeight', { value: 100 });
    Object.defineProperty(el.element, 'scrollHeight', { value: 1000 });
    await el.trigger('wheel', { deltaY: 120 });
    expect(w.emitted('scroll-past-bottom')).toBeTruthy();
  });

  it('源码守卫：窗口外 v-if 卸载（非 v-show）、无 loading=lazy、Ctrl 滚轮 preventDefault', () => {
    const src = readFileSync('src/components/reader/WebtoonViewer.vue', 'utf-8');
    expect(src).toContain('v-for="it in windowItems"');
    expect(src).not.toContain('v-show');
    expect(src).not.toContain('loading="lazy"');
    expect(src).toMatch(/wheel\.prevent/);
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/components/reader/WebtoonViewer.test.ts
```

预期：组件不存在。

- [ ] **步骤 3：实现（新建 WebtoonViewer.vue）**

```vue
<script setup lang="ts">
/**
 * WebtoonViewer.vue — 竖条漫连续滚动视图（module3.1.0，spec §2-§4）
 *
 * 原生滚动容器 + 单列虚拟化 img strip（窗口外 v-if 卸载释放解码内存）。
 * 缩放 = strip 显式宽度 ×zoom（img width:100% 高度自然跟随，标准 CSS）。
 * Ctrl+滚轮锚点缩放 / 双击 1.0↔上次非 1 值；atBottom 响应式（scrollTop 参与）。
 */
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
import {
  anchoredScroll, autoScrollDelta, clampZoom, computeLayout, topVisibleIndex, visibleWindow,
} from '@/lib/webtoonLayout';
import { useWebtoonDimensions } from '@/composables/useWebtoonDimensions';

const props = withDefaults(defineProps<{
  /** 与 names 平行的 asset URL 列表（ReaderView convertFileSrc 产物） */
  urls: string[];
  names: string[];
  descriptor: SourceDescriptor;
  /** 书的 root 相对路径（图头 IPC 拼 fullPath 用，审查 P1-3；根书传 ''） */
  relPath: string;
  /** 0 = 不限宽 */
  maxWidth?: number;
  gap?: number;
}>(), { maxWidth: 0, gap: 0 });

const emit = defineEmits<{
  (e: 'scroll-past-bottom'): void;
  (e: 'scroll'): void;
  (e: 'wheel-delta', deltaY: number): void;
}>();

const scrollEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const zoom = ref(1);
let lastNonUnityZoom = 2;

const { measuredMap, ensureRange } = useWebtoonDimensions(
  computed(() => props.descriptor),
  computed(() => props.names),
  computed(() => props.relPath),
);

/** 容器内容宽（zoom 后）：基准 = min(容器宽, maxWidth||容器宽) */
const baseWidth = computed(() => {
  const cw = viewportHeight.value > 0 ? containerWidth.value : 800;
  return props.maxWidth > 0 ? Math.min(cw, props.maxWidth) : cw;
});
const containerWidth = ref(800);

const layout = computed(() =>
  computeLayout(props.names, measuredMap.value, baseWidth.value * zoom.value, props.gap * zoom.value));

const windowRange = computed(() => visibleWindow(layout.value, scrollTop.value, viewportHeight.value));

const windowItems = computed(() => {
  const { start, end } = windowRange.value;
  const out: { name: string; url: string; top: number; height: number }[] = [];
  for (let i = start; i < end && i < props.names.length; i++) {
    out.push({
      name: props.names[i],
      url: props.urls[i],
      top: layout.value.tops[i],
      height: layout.value.heights[i],
    });
  }
  return out;
});

/** atBottom：scrollTop 参与判定（防 3.0.13 masonry atBottom stale 复辙） */
const atBottom = computed(() => {
  const el = scrollEl.value;
  if (!el) return false;
  return scrollTop.value + viewportHeight.value >= layout.value.totalHeight - 4;
});

function getTopVisibleImage(): string | null {
  const i = topVisibleIndex(layout.value, scrollTop.value);
  return props.names[i] ?? null;
}

/** 渐进校正滚动到指定图：立即跳估算位 + measuredMap 变化最多校正 5 次 / 3s */
function scrollToImage(name: string): void {
  const target = () => {
    const i = props.names.indexOf(name);
    return i >= 0 ? layout.value.tops[i] : -1;
  };
  let y = target();
  if (y < 0 || !scrollEl.value) return;
  scrollEl.value.scrollTop = y;
  let corrections = 0;
  const stopAt = Date.now() + 3000;
  const un = watch(measuredMap, () => {
    if (corrections >= 5 || Date.now() > stopAt) { un(); return; }
    const ny = target();
    if (ny >= 0 && ny !== y) {
      y = ny;
      corrections++;
      if (scrollEl.value) scrollEl.value.scrollTop = y;
    }
    if (corrections >= 5) un();
  });
}

function setZoom(z: number, anchorY?: number): void {
  const nz = clampZoom(z);
  if (nz === zoom.value) return;
  const el = scrollEl.value;
  if (el && anchorY !== undefined) {
    el.scrollTop = anchoredScroll(el.scrollTop, anchorY, zoom.value, nz);
  }
  zoom.value = nz;
  if (nz !== 1) lastNonUnityZoom = nz;
}

/** Ctrl+滚轮锚点缩放（step 10%）；普通滚轮不拦截（原生滚动）+ 底部越滚观察 + 临时变速通知 */
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(zoom.value * dir, e.clientY - (scrollEl.value?.getBoundingClientRect().top ?? 0));
    return;
  }
  // 普通滚轮：通知 ReaderView（自动滚动临时变速用，spec §4）
  emit('wheel-delta', e.deltaY);
  if (e.deltaY > 0 && atBottom.value) emitScrollPastBottom();
}

/** 底部越滚节流 800ms（spec §6） */
let lastBottomEmit = 0;
function emitScrollPastBottom(): void {
  const now = Date.now();
  if (now - lastBottomEmit < 800) return;
  lastBottomEmit = now;
  emit('scroll-past-bottom');
}

function onDblclick(e: MouseEvent): void {
  const anchor = e.clientY - (scrollEl.value?.getBoundingClientRect().top ?? 0);
  if (zoom.value === 1) setZoom(lastNonUnityZoom, anchor);
  else setZoom(1, anchor);
}

/** 自动滚动单步（ReaderView rAF 驱动）；factor=滚轮临时变速（2s 回落由 ReaderView 管） */
function autoScrollStep(dt: number, speed: number, factor: number): void {
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + autoScrollDelta(speed, factor, dt));
}

let ro: ResizeObserver | null = null;
function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
  containerWidth.value = el.clientWidth;
  emit('scroll'); // ReaderView 节流更新顶部图/页码/atBottom
}
function syncGeometry(): void { onScroll(); }

onMounted(() => {
  onScroll();
  ro = new ResizeObserver(() => syncGeometry());
  if (scrollEl.value) ro.observe(scrollEl.value);
  void ensureRange(windowRange.value.start, windowRange.value.end);
});
onUnmounted(() => { ro?.disconnect(); ro = null; });

// 窗口移动 → 预读图头
watch(windowRange, (r) => { void ensureRange(r.start, r.end); });

defineExpose({
  scrollToImage, getTopVisibleImage,
  atBottom: atBottom as Ref<boolean>,
  setZoom, zoom, autoScrollStep,
  scrollEl, // ReaderView scrollScreen（键盘滚屏）用
});
</script>

<template>
  <div
    ref="scrollEl"
    class="webtoon-scroll"
    @scroll.passive="onScroll"
    @wheel.prevent="onWheel"
    @dblclick="onDblclick"
  >
    <div
      class="webtoon-strip"
      :style="{ width: (baseWidth * zoom) + 'px', height: layout.totalHeight + 'px' }"
    >
      <div
        v-for="it in windowItems"
        :key="it.name"
        class="webtoon-item"
        :style="{ position: 'absolute', top: it.top + 'px', left: 0, width: '100%', height: it.height + 'px' }"
      >
        <img :src="it.url" :alt="it.name" decoding="async" draggable="false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.webtoon-scroll {
  height: 100%;
  overflow: auto; /* 纵横双向（zoom>1 时横向可达） */
  background: var(--color-bg);
}
.webtoon-strip {
  position: relative;
  margin: 0 auto; /* maxWidth 限宽居中 */
}
.webtoon-item img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
```

注意两点（执行时按真实环境校准）：
- `@wheel.prevent` 会对普通滚轮也 preventDefault——**不行**，普通滚轮必须放行原生滚动。改为 `@wheel="onWheel"`（非 passive 默认可调 preventDefault），函数内仅 Ctrl 分支 `e.preventDefault()`。同步修正测试源码守卫的 `wheel\.prevent` 断言为 `@wheel="onWheel"`。
- happy-dom 无 ResizeObserver 时空实现兜底：`if (typeof ResizeObserver === 'undefined') ro = null;`。

- [ ] **步骤 4：运行验证通过**

```bash
npx vitest run src/components/reader/WebtoonViewer.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add src/components/reader/WebtoonViewer.vue src/components/reader/WebtoonViewer.test.ts
git commit -m "feat(webtoon): WebtoonViewer 滚动容器（虚拟窗口/锚点缩放/底部越滚/渐进定位）（任务 4/8）"
```

---

### 任务 5：useWebtoonProgress（记录 + finished）

**文件：**
- 创建：`src/composables/useWebtoonProgress.ts`、`src/composables/useWebtoonProgress.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { ref } from 'vue';
import { useWebtoonProgress } from './useWebtoonProgress';
import { saveProgress, markFinished } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, saveProgress: vi.fn(), markFinished: vi.fn() };
});

function setup(atBottom = ref(false)) {
  return useWebtoonProgress({
    bookId: ref(105),
    topImage: ref<string | null>('p001.jpg'),
    topIndex: ref(0),
    atBottom,
  });
}

describe('useWebtoonProgress（module3.1.0）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('顶部图变化 300ms debounce 后 saveProgress（readerMode=webtoon，image_name 第五参）', async () => {
    const p = setup();
    p.notifyTopChanged('p005.jpg', 4);
    expect(saveProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(310);
    // 签名 (bookId, page, readerMode, finished?, imageName?)——审查 P1-2 修正
    expect(saveProgress).toHaveBeenCalledWith(105, 4, 'webtoon', undefined, 'p005.jpg');
  });

  it('同图不重复写', async () => {
    const p = setup();
    p.notifyTopChanged('p001.jpg', 0);
    vi.advanceTimersByTime(310);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it('atBottom 持续 1.2s → markFinished(true) 一次', async () => {
    const atBottom = ref(false);
    setup(atBottom);
    atBottom.value = true;
    vi.advanceTimersByTime(1300);
    expect(markFinished).toHaveBeenCalledTimes(1);
    expect(markFinished).toHaveBeenCalledWith(105, true);
    // 持续 true 不重复
    vi.advanceTimersByTime(3000);
    expect(markFinished).toHaveBeenCalledTimes(1);
  });

  it('atBottom 短暂抖动（<1.2s 回 false）不标 finished', async () => {
    const atBottom = ref(false);
    setup(atBottom);
    atBottom.value = true;
    vi.advanceTimersByTime(600);
    atBottom.value = false;
    vi.advanceTimersByTime(2000);
    expect(markFinished).not.toHaveBeenCalled();
  });
});
```

（**tauri.ts 前置改动**：`saveProgress` 第三参类型 `readerMode: 'single' | 'double'` 扩为 `'single' | 'double' | 'webtoon'`（tauri.ts:405-411）——Rust 端 `save_progress` 的 `reader_mode` 是 String 直存 DB，无需改 Rust、无迁移。此改动放本任务步骤 3 一并提交。）

补充用例（审查 P1-4：bookId 变化自动 reset）：

```ts
  it('bookId 变化自动 reset：跨卷同名首图仍写进度 + 新卷可再标 finished', async () => {
    const bookId = ref(105);
    const atBottom = ref(false);
    const topImage = ref<string | null>('001.jpg');
    const p = useWebtoonProgress({ bookId, topImage, topIndex: ref(0), atBottom });
    // 卷 1 读完
    atBottom.value = true;
    vi.advanceTimersByTime(1300);
    expect(markFinished).toHaveBeenCalledTimes(1);
    // 跨卷 → bookId 变化 → auto reset
    bookId.value = 206;
    await Promise.resolve(); // watch flush
    // 新卷顶部又是同名 001.jpg —— lastImage 已被 reset，必须写进度
    p.notifyTopChanged('001.jpg', 0);
    vi.advanceTimersByTime(310);
    expect(saveProgress).toHaveBeenCalledWith(206, 0, 'webtoon', undefined, '001.jpg');
    // 新卷滚到底 → finishedMarked 已 reset，可再标
    atBottom.value = false;
    await Promise.resolve();
    atBottom.value = true;
    vi.advanceTimersByTime(1300);
    expect(markFinished).toHaveBeenCalledTimes(2);
    expect(markFinished).toHaveBeenLastCalledWith(206, true);
  });
```

- [ ] **步骤 2：验证失败 → 步骤 3：实现（新建）**

```ts
/**
 * useWebtoonProgress.ts — webtoon 进度记录（module3.1.0，spec §5）
 * 300ms debounce 记顶部可见图；atBottom 稳定 1.2s 标 finished（STABLE_MS 对齐瀑布流）。
 */
import { watch, type Ref } from 'vue';
import { saveProgress, markFinished } from '@/lib/tauri';
import { log } from '@/lib/logger';

const DEBOUNCE_MS = 300;
const STABLE_MS = 1200;

export function useWebtoonProgress(opts: {
  bookId: Ref<number | null>;
  topImage: Ref<string | null>;
  topIndex: Ref<number>;
  atBottom: Ref<boolean>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastImage: string | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let finishedMarked = false;

  function notifyTopChanged(image: string, index: number): void {
    if (image === lastImage) return;
    lastImage = image;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const bookId = opts.bookId.value;
      if (bookId === null) return;
      // 签名 (bookId, page, readerMode, finished?, imageName?)——finished=undefined 不动完成态
      saveProgress(bookId, index, 'webtoon', undefined, image)
        .catch((e) => log('[webtoon] saveProgress failed', e));
    }, DEBOUNCE_MS);
  }

  watch(opts.atBottom, (b) => {
    if (b) {
      if (stableTimer || finishedMarked) return;
      stableTimer = setTimeout(() => {
        stableTimer = null;
        const bookId = opts.bookId.value;
        if (bookId === null) return;
        finishedMarked = true;
        markFinished(bookId, true).catch((e) => log('[webtoon] markFinished failed', e));
      }, STABLE_MS);
    } else {
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    }
  });

  /** 换书自动重置（审查 P1-4）：跨卷后 finishedMarked 必须清（新卷可再标完），
   * lastImage 必须清（跨卷同名首图 001.jpg 不被去重吞掉）。不依赖调用方手动 reset。 */
  watch(opts.bookId, (nb, ob) => {
    if (ob !== null && nb !== ob) reset();
  });

  /** 手动重置（兜底，测试/特殊场景用） */
  function reset(): void {
    lastImage = null;
    finishedMarked = false;
    if (timer) clearTimeout(timer);
    if (stableTimer) clearTimeout(stableTimer);
    timer = stableTimer = null;
  }

  return { notifyTopChanged, reset };
}
```

- [ ] **步骤 4：验证通过 + Commit**

```bash
npx vitest run src/composables/useWebtoonProgress.test.ts
git add src/composables/useWebtoonProgress.ts src/composables/useWebtoonProgress.test.ts
git commit -m "feat(webtoon): 进度记录 composable（debounce 顶部图 + atBottom 标完）（任务 5/8）"
```

---

### 任务 6：ReaderView / ReaderScreen / 输入映射接线

**文件：**
- 修改：`src/components/reader/ReaderScreen.vue`（CRLF）
- 修改：`src/views/ReaderView.vue`（CRLF）
- 修改：`src/composables/useReaderWheel.ts`（CRLF）
- 修改：`src/composables/useReaderHotkeys.ts`（如需，CRLF）

- [ ] **步骤 1：ReaderScreen mode 扩展**

(a) `mode?: 'single' | 'double'` 类型改 `mode?: 'single' | 'double' | 'webtoon'`（props interface + 默认值处）。
(b) viewer 切换 computed（`props.mode === 'single' ? ... : ...` 处）加 webtoon 分支：webtoon 时不取 OSD viewerRef（`scaleViewerRef` 置 null，useReaderScale 不作用）。
(c) 模板 `v-if` 链：single 分支 / double 分支后加：

```vue
    <WebtoonViewer
      v-else-if="mode === 'webtoon'"
      ref="webtoonRef"
      :urls="pageUrls"
      :names="pageNames"
      :descriptor="descriptor"
      :rel-path="relPath"
      :max-width="webtoonMaxWidth"
      :gap="webtoonGap"
      @scroll="onViewerScroll"
      @wheel-delta="$emit('wheel-delta', $event)"
      @scroll-past-bottom="$emit('scroll-past-bottom')"
    />
```

新增 props：`pageNames: string[]`、`descriptor: SourceDescriptor`、`relPath: string`（书的 root 相对路径，ReaderView 从 reader store 当前卷身份取）、`webtoonMaxWidth: number`、`webtoonGap: number`；emit `scroll` / `wheel-delta` / `scroll-past-bottom`（透传）；`webtoonRef` defineExpose 转发（`getWebtoon(): 暴露类型 | null`）。import WebtoonViewer。

- [ ] **步骤 2：useReaderWheel enabled 守卫**

`UseReaderWheelOptions` 加：

```ts
  /** webtoon 模式下不接管滚轮（原生滚动；Ctrl 缩放由 viewer 处理）。module3.1.0 */
  enabled?: () => boolean;
```

`onWheel` 入口首行：

```ts
  if (opts.enabled && !opts.enabled()) return;
```

ReaderView 调用处传 `enabled: () => settingsStore.readerDefaultMode !== 'webtoon'`。

- [ ] **步骤 3：ReaderView webtoon 分支（node 补丁，锚点按实际代码）**

(a) script 顶部接 viewer 引用与状态：

```ts
const webtoonScreenRef = ref<InstanceType<typeof ReaderScreen> | null>(null);
const webtoonTopImage = ref<string | null>(null);
const webtoonTopIndex = ref(0);
const webtoonAtBottom = ref(false);
const isWebtoon = computed(() => settingsStore.readerDefaultMode === 'webtoon');
```

（ReaderScreen ref 现有名按实际；`webtoonTopImage/Index` 由 scroll watch 更新：）

```ts
// webtoon：顶部可见图 watch（节流 rAF）驱动页码与进度
let webtoonScrollDirty = false;
function markWebtoonScroll(): void {
  if (webtoonScrollDirty) return;
  webtoonScrollDirty = true;
  requestAnimationFrame(() => {
    webtoonScrollDirty = false;
    const v = webtoonScreenRef.value?.getWebtoon?.() ?? null;
    if (!v) return;
    const name = v.getTopVisibleImage();
    if (name) {
      webtoonTopImage.value = name;
      webtoonTopIndex.value = pageUrls.value.findIndex((_, i) => imageNames.value[i] === name);
    }
    webtoonAtBottom.value = v.atBottom.value;
  });
}
// 挂到 ReaderScreen 的 scroll 事件（ReaderScreen 转发 viewer scroll 或 ReaderView 直接 watch scrollTop——执行时取最小侵入方案：给 WebtoonViewer 加 scroll emit 转发）
```

（执行时给 WebtoonViewer `@scroll.passive` 里同时 `emit('scroll')`，ReaderScreen 透传，ReaderView 监听调 `markWebtoonScroll`。）

(b0) relPath 来源（审查 P1-3）：ReaderView 从 reader store 当前卷身份取 root 相对路径（`openBook` payload 的 relPath 字段——执行时以 `stores/reader.ts` 实际字段名为准，如 `currentRelPath`），const `webtoonRelPath = computed(() => readerStore.xxx ?? '')`，传给 ReaderScreen `:rel-path`。

(b) 进度 composable 接入（loadBook 成功后）：

```ts
const webtoonProgress = useWebtoonProgress({
  bookId: bookIdRef,           // 现有 bookId ref 名按实际
  topImage: webtoonTopImage,
  topIndex: webtoonTopIndex,
  atBottom: webtoonAtBottom,
});
watch(webtoonTopImage, (n) => { if (n) webtoonProgress.notifyTopChanged(n, webtoonTopIndex.value); });
```

恢复链（loadBook 完成后 isWebtoon 时）：

```ts
const at = route.query.at as string | undefined;
const target = at ?? (progress.image_name as string | null) ?? null;
const name = target && imageNames.value.includes(target)
  ? target
  : imageNames.value[progress.page ?? 0] ?? imageNames.value[0];
nextTick(() => webtoonScreenRef.value?.getWebtoon()?.scrollToImage(name));
```

（progress 变量名/来源按 loadBook 现有逻辑；`getProgress` 已有调用。）

(c) 跨卷：`@scroll-past-bottom` → `void crossVolume.maybeContinue(false, 'next')`（manual/auto 档走现有链，off 忽略；Alt+→ force 全局现状不变）。

(d) 输入动作（webtoon 下重定义翻页语义，不动 useReaderHotkeys）：

```ts
// 现有 actions.nextPage/prevPage 构造处，按 isWebtoon 分流：
const scrollScreen = (dir: 1 | -1) => {
  const v = webtoonScreenRef.value?.getWebtoon?.();
  const el = v?.scrollEl ?? null; // WebtoonViewer expose scrollEl（任务 4 补 expose）
  if (!el) return;
  el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: 'auto' });
};
nextPage: () => { if (isWebtoon.value) { scrollScreen(1); onWebtoonBottomKeyPush(); } else { void nextSpread(); } },
prevPage: () => { if (isWebtoon.value) scrollScreen(-1); else void prevSpread(); },
jumpFirst: () => { if (isWebtoon.value) { /* scrollTop=0 */ } else { ... } },
jumpLast: () => { if (isWebtoon.value) { /* scrollTop=末 */ } else { ... } },
```

`onWebtoonBottomKeyPush`：`webtoonAtBottom.value` 时调 `maybeContinue(false,'next')`（与滚轮共用 800ms 节流——实现为 ReaderView 内单一 `requestCrossVolumeNext()` 函数）。WebtoonViewer 需补 expose `scrollEl: Ref<HTMLElement|null>`。

(e) 自动滚动 rAF（webtoon 语义的幻灯片）：

```ts
// slideshow isPlaying && isWebtoon → rAF 循环；滚轮临时 factor 2s 回落
const webtoonSpeedFactor = ref(1);
let lastWheelAt = 0;
let rafId: number | null = null;
let lastTs = 0;
function step(ts: number): void {
  if (!isWebtoon.value || !slideshow.isPlaying) { rafId = null; return; }
  const dt = lastTs ? Math.min(100, ts - lastTs) : 16;
  lastTs = ts;
  if (Date.now() - lastWheelAt > 2000) webtoonSpeedFactor.value = 1;
  webtoonScreenRef.value?.getWebtoon()?.autoScrollStep(dt, settingsStore.webtoonScrollSpeed, webtoonSpeedFactor.value);
  rafId = requestAnimationFrame(step);
}
watch(() => [isWebtoon.value, slideshow.isPlaying] as const, ([w, p]) => {
  if (w && p && rafId === null) { lastTs = 0; rafId = requestAnimationFrame(step); }
});
// 滚轮临时变速：WebtoonViewer 普通滚轮分支 emit('wheel-delta', deltaY)（任务 4 补），
// ReaderView 监听：lastWheelAt=Date.now(); webtoonSpeedFactor=clamp(webtoonSpeedFactor*(deltaY>0?1.2:1/1.2),0,3)
onUnmounted(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
```

（跨卷续播：新卷 ready 后 slideshow 续播链已有（3.0.13），rAF watch isPlaying 自动恢复——无需额外处理。）

(f) 模板：ReaderScreen 传 `:mode="isWebtoon ? 'webtoon' : (现有 mode 构造)"`（现有 doubleMode 判断处合并，webtoon 优先）+ `:page-names="imageNames"` + `:descriptor` + `:rel-path="webtoonRelPath"` + `:webtoon-max-width` + `:webtoon-gap` + `@scroll="markWebtoonScroll"` + `@wheel-delta="onWebtoonWheelDelta"` + `@scroll-past-bottom="requestCrossVolumeNext"`。页码 overlay：isWebtoon 时显示 `{{ (webtoonTopIndex>=0?webtoonTopIndex+1:1) }} / {{ total }}`。

- [ ] **步骤 4：测试 + 验证**

ReaderView.test.ts 追加 2 用例（mock ReaderScreen/webtoon 挂载链，断言 scroll-past-bottom → maybeContinue 调用、isWebtoon 下 nextPage 走 scrollScreen 不走 nextSpread）；ReaderScreen.test.ts 追加 webtoon 分支渲染 WebtoonViewer 用例（mock 组件）。

```bash
npx vitest run src/views/ReaderView.test.ts src/components/reader/ReaderScreen.test.ts src/components/reader/WebtoonViewer.test.ts
npm run type-check
```

- [ ] **步骤 5：Commit**

```bash
git add src/views/ReaderView.vue src/components/reader/ReaderScreen.vue src/composables/useReaderWheel.ts src/views/ReaderView.test.ts src/components/reader/ReaderScreen.test.ts
git commit -m "feat(webtoon): ReaderView/Screen 接线（三模式/进度恢复/跨卷/输入/自动滚动）（任务 6/8）"
```

---

### 任务 7：菜单 / Settings / i18n

**文件：**
- 修改：`src/components/reader/ReaderMainMenu.vue`（CRLF）
- 修改：`src/components/settings/Settings.vue` 或阅读器 section 文件（执行时定位）
- 修改：`src/locales/zh-CN.ts`、`en-US.ts`（CRLF）

- [ ] **步骤 1：ReaderMainMenu**

- cycle-mode 按钮文案/行为：现有 single↔double toggle 改三态 cycle（点击顺序 single→double→webtoon→single）。emit `cycle-mode` 语义不变，ReaderView 按当前值推进。
- 新增「重置缩放」按钮（仅 webtoon 且 zoom≠1 时可用）：emit `reset-zoom`，ReaderView 调 `getWebtoon()?.setZoom(1)`。
- i18n：`reader.menu.resetZoom` zh「重置缩放」/ en "Reset zoom"；模式名 `reader.mode.single/double/webtoon`（zh 单页/双页/条漫，en Single/Double/Webtoon）。

- [ ] **步骤 2：Settings 阅读器 section**

- 阅读模式行：下拉（复用项目 Dropdown 模式，选项三态）绑 `settingsStore.readerDefaultMode` / `setReaderMode`（既有 key reader_default_mode）。
- webtoon 子组（readerDefaultMode==='webtoon' 时显示）：限宽 `webtoonMaxWidth`（number input 0=不限）、间距 `webtoonGap`（slider 0-24）、滚动速度 `webtoonScrollSpeed`（slider 10-300）。
- RTL 方向行在 webtoon 时 disabled。
- i18n：`settings.reader.readMode` / `settings.reader.webtoon.maxWidth|gap|scrollSpeed`（zh：阅读模式/限宽（0 为不限）/图片间距/自动滚动速度）双语。

- [ ] **步骤 3：测试 + 验证 + Commit**

ReaderMainMenu.test（cycle 三态 + resetZoom 条件渲染）、Settings 相关既有测试同步；i18n 双语一致性自动覆盖。

```bash
npx vitest run src/components/reader/ReaderMainMenu.test.ts src/views/Settings.test.ts 2>/dev/null || npx vitest run src/components/reader/ReaderMainMenu.test.ts
npm run type-check
git add -A src/components src/views src/locales
git commit -m "feat(webtoon): 主菜单三态切换+重置缩放，Settings 阅读模式与 webtoon 子设置，i18n（任务 7/8）"
```

---

### 任务 8：实机验证 + 文档 + tag

- [ ] **步骤 1：全量验证**

```bash
npm run type-check && npm test -- --run && cd src-tauri && cargo test
```

预期：前端 946 → 约 975±（+25~35），Rust 321 不变 0 fail。

- [ ] **步骤 2：实机冒烟（devtools 流程 docs/tauri-devtools-debugging.md；需先关 portable 实例）**

清单：
1. 切 webtoon 模式：连续滚动、窗口卸载（滚动后 DOM 条目数恒定 ±窗口）、无缝拼接。
2. Ctrl+滚轮锚点缩放（鼠标下的内容不动）、双击 1↔2、zoom>1 横向滚动。
3. 顶部图页码随滚动更新；退出重进恢复到上次位置（image_name 链）。
4. 滚到底停 1.2s → finished 徽标；再向下滚 → 跨卷（manual 档 toast 确认）。
5. 自动滚动：播放/暂停、滚轮临时变速 2s 回落、滚到底自动停 + 跨卷续播。
6. Alt+→ force 跨卷照常；single/double 模式回归无变化。

- [ ] **步骤 3：性能实测（写入 `docs/superpowers/reports/2026-08-17-webtoon-performance.md`）**

devtools：200+ 张目录全程滚动 heap 曲线（验收：增长 ≤50MB 后平台期）；单次会话 >100ms 帧 ≤5 次；缩放连续操作无 >250ms 帧。

- [ ] **步骤 4：文档**

- `DESIGN.md`：§16.5 删「Webtoon 模式」行；§12 加 12.6 webtoon 小节（布局/缩放/滚动/进度/输入摘要 + 指向 spec）。
- `AGENTS.md`：状态表加 3.1.0 行（实测数字回填）；§0 阅读器交互规约加 0.6 webtoon 小节要点。

- [ ] **步骤 5：tag + push**

```bash
git tag v0.1.0-module3.1.0-reader-webtoon
git push github main
git push github v0.1.0-module3.1.0-reader-webtoon
```

推送后盯 CI（verify 含 cargo test）至全绿。

---

## 自检记录

- **规格覆盖度**：spec §1→任务 1/7；§2→任务 2/3/4；§3→任务 2（纯函数）/4（交互）；§4→任务 4（step）/6（rAF 驱动）；§5→任务 5/6；§6→任务 4（scroll-past-bottom）/6（输入分流 + wheel enabled）；§7→任务 6/7；§8→各任务测试 + 任务 8 实测；§9 风险→任务 4 注记（zoom 替代）+ 任务 8 兜底；§10→任务 8。无遗漏。
- **占位符扫描**：任务 6 的若干「按实际变量名」标注是对既有 CRLF 大文件的动态锚点指引（executing-plans 执行者需先读目标文件对齐命名），非缺设计——关键逻辑代码均已给出。
- **类型一致性**：`WebtoonLayout`/`visibleWindow`/`topVisibleIndex`/`clampZoom`/`anchoredScroll`/`autoScrollDelta`（任务 2 定义，任务 4 消费）；`getTopVisibleImage/scrollToImage/atBottom/setZoom/zoom/autoScrollStep`（任务 4 expose，任务 6 消费，任务 4 需补 `scrollEl`/`wheel-delta` 两项 expose/emit——已注明）；`notifyTopChanged/reset`（任务 5，任务 6 消费）。
