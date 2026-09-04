# webtoon 假底部防御 + 布局抽搐取证探针 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 封死 webtoon 阅读器「布局塌陷 → atBottom 假阳性 → 误标已读完 + auto 跨卷误跳」的故障链（2026-09-02 实机事故，260901/book137），布好常驻低噪声取证探针，并顺手收掉「改窗口宽度导致阅读位置瞬移」的独立 UX 缺陷。

**架构：** 防御核心是给 `WebtoonViewer.atBottom` 加布局健全性守卫（纯函数 `isLayoutDegenerate`：无内容或**容器 clientWidth** 低于 120px 视为塌陷——基准是容器宽度而非 strip 宽度，用户配置 `webtoonMaxWidth` 压窄 strip 属合法偏好不算塌陷；塌陷时 atBottom 恒 false），在 computed 单点收口，自动覆盖 `onNext` 底部跨卷 / 滚轮 `emitBottom` / `useWebtoonProgress` 稳定计时器三个消费方。宽度锚定复用现有 `captureAnchor`/`restoreAnchor`：`onScroll` 在提交新 `containerWidth` **之前**按旧布局捕锚点，patch 后恢复 scrollTop 并同步 `scrollTop.value` ref（与 3.0.8 masonry resize 锚定同思路）。取证探针分两层：组件层记录塌陷进入/恢复、atBottom 翻转、scroll-past-bottom 三类事件的结构化快照；布局层用滑动窗口 `ResizeBurstDetector` 纯类检测 reader 根元素的 resize 风暴（1s 内 ≥8 次 rAF 通过即报一次，5s 冷却防刷屏）。

**技术栈：** Vue 3 + Vitest + happy-dom；纯函数放 `src/lib/`（项目规约，可独立 vitest）；日志走 `src/lib/logger.ts` 的 `log()`（落 main.log）。

**背景（事故摘要，供工作者理解判定语义）：**
- 2026-09-02 23:09 用户在 webtoon 模式阅读 3736 图目录，阅读位置 39%（image 1474/3736）。
- 23:09:00 起约 2.5 秒内 reader 根元素 ResizeObserver 连续触发 40+ 次（`useReaderScale` 60ms 节流后仍有 40 条日志），随后整个应用窗口白屏约 2 分钟（light 主题背景色），无任何用户操作。
- 23:11:02 用户滚动滚轮，`isAtBottom()` 返回 true（假底部）→ `scroll-past-bottom` → `continueToNextVolume=auto` 直接跳卷 → 跳卷前兜底 `markFinished(bookId, true)` 误标已读完 → 跳进下一卷 260817。
- 已排除：测量重置（`useWebtoonDimensions` 只增不清）、names 清空（store 无变更）、幻灯片 tick（webtoon 被 mode-aware 守卫短路）。白屏 = 布局塌陷后只剩 light 主题背景色；chrome 隐藏 = 无鼠标移动无 hover。
- 塌陷机制推断：容器宽度被挤压 → `baseWidth = containerWidth`（`WebtoonViewer.vue:16`）→ 全部 item 高度 ∝ strip 宽度 → `totalHeight` 塌缩 → 浏览器把 scrollTop 钳位到（塌缩后的）底部 → `atBottom = scrollTop + viewportHeight >= totalHeight - 4` 假阳性。宽度趋近 0 时 `baseWidth` 有 800 兜底（正常布局），**0 < w < 120 的「小而非零」区间最危险**——守卫正是封这一段。

**不做清单：**
- 塌陷态的可见 UI 提示（「布局异常」横幅）——本期不做，探针先行取证，等触发源定位后一并设计。
- 布局抽搐根因修复——静态分析无法定位（无用户操作），依赖探针在下次复现时抓快照。
- 260901 的误标数据——已于事故会话手工修复（`mark_finished(137, false)`），无需迁移。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/lib/webtoonLayout.ts` | 修改 | 新增 `MIN_VIEWPORT_WIDTH` 常量 + `isLayoutDegenerate` 纯函数（守卫判定语义的唯一权威，基准=容器 clientWidth） |
| `src/lib/webtoonLayout.test.ts` | 修改 | 追加 `isLayoutDegenerate` 用例 |
| `src/components/reader/WebtoonViewer.vue` | 修改 | ① `atBottom` computed 接守卫；② 宽度变化锚定恢复 scrollTop；③ 塌陷进入/恢复、atBottom 翻转、scroll-past-bottom 三类探针日志 |
| `src/components/reader/WebtoonViewer.test.ts` | 修改 | 守卫用例（塌陷 false / 正常到底 true / 空 names false）+ 探针日志断言 |
| `src/lib/resizeBurstDetector.ts` | 创建 | 滑动窗口 resize 风暴检测纯类（threshold/windowMs/cooldownMs 可配） |
| `src/lib/resizeBurstDetector.test.ts` | 创建 | 检测器全行为用例 |
| `src/composables/useReaderScale.ts` | 修改 | `onResize` 的 rAF 回调里接检测器，爆发时输出容器/窗口尺寸快照 |
| `src/composables/useReaderScale.test.ts` | 修改 | 风暴 → 日志一次的接线用例（复用现有 MockRO 模式） |

---

### 任务 1：`isLayoutDegenerate` 纯函数

**文件：**
- 修改：`src/lib/webtoonLayout.ts`（文件末尾追加）
- 测试：`src/lib/webtoonLayout.test.ts`（文件末尾追加 describe 块）

- [ ] **步骤 1：编写失败的测试**

在 `src/lib/webtoonLayout.test.ts` 顶部 import 行的 `{ ... }` 里追加 `isLayoutDegenerate`，然后在文件末尾追加：

```ts
describe('isLayoutDegenerate（2026-09-02 假底部防御）', () => {
  it('无内容（namesLength=0）→ 塌陷', () => {
    expect(isLayoutDegenerate(0, 800)).toBe(true);
  });

  it('容器宽度低于 120 下限 → 塌陷（含事故区间 0<w<120；宽度 0 有 800 兜底但元素不可见，同样判塌陷）', () => {
    expect(isLayoutDegenerate(3736, 0)).toBe(true);
    expect(isLayoutDegenerate(3736, 3)).toBe(true);
    expect(isLayoutDegenerate(3736, 119.9)).toBe(true);
  });

  it('容器正常 → 非塌陷；判定基准是容器宽度不是 strip 宽度（webtoonMaxWidth=50 压窄 strip 不算塌陷）', () => {
    expect(isLayoutDegenerate(3736, 800)).toBe(false);
    expect(isLayoutDegenerate(1, 480)).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/lib/webtoonLayout.test.ts`
预期：FAIL，报 `isLayoutDegenerate` 未导出（import 为 undefined，3 个用例红）。

- [ ] **步骤 3：编写最少实现**

在 `src/lib/webtoonLayout.ts` 文件末尾追加：

```ts
/** 容器宽度低于此值视为布局塌陷（2026-09-02 实机事故：容器宽度被挤压后 totalHeight
 * 随宽度塌缩，scrollTop 被钳位到底 → atBottom 假阳性 → 误标完成 + auto 跨卷误跳）。 */
export const MIN_VIEWPORT_WIDTH = 120;

/** 布局塌陷判定：无内容，或容器实际宽度低于可读下限（此时 atBottom 语义不可信，必须恒 false）。
 * 判定基准是容器 clientWidth 而非 strip 宽度——用户配置 webtoonMaxWidth 把 strip 压窄是合法
 * 偏好，布局语义仍自洽（totalHeight ∝ strip 宽度，scrollTop 钳位即真底部）；阅读器最小窗宽
 * 480px，正常容器不会落入塌陷区间。容器宽度恰为 0 时组件有 800 兜底，但元素不可见，同按塌陷处理。 */
export function isLayoutDegenerate(namesLength: number, viewportWidth: number): boolean {
  return namesLength === 0 || viewportWidth < MIN_VIEWPORT_WIDTH;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/lib/webtoonLayout.test.ts`
预期：PASS（含既有全部用例，本文件基线只增不减）。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/webtoonLayout.ts src/lib/webtoonLayout.test.ts
git commit -m "feat(webtoon): isLayoutDegenerate 纯函数——布局塌陷判定（假底部防御第一步）"
```

---

### 任务 2：`WebtoonViewer.atBottom` 接守卫

**文件：**
- 修改：`src/components/reader/WebtoonViewer.vue:24-25`（import 行 + atBottom computed）
- 测试：`src/components/reader/WebtoonViewer.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/components/reader/WebtoonViewer.test.ts` 的 `describe` 内（现有 `'isAtBottom() 是 getter 且初始未到底'` 用例之后）追加三个用例。同时把顶部 import 的 `WebtoonViewer` 下方补一行 `import { log } from '@/lib/logger';` 之前先确认：本任务不涉及 logger，跳过。直接追加用例：

```ts
it('布局塌陷（容器宽度 < 120）时 isAtBottom 恒 false（2026-09-02 假底部防御）', async () => {
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 50, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 100000, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  expect(w.vm.isAtBottom()).toBe(false);
});

it('正常宽度下滚到底 isAtBottom true（守卫不误伤）', async () => {
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  // 3 张未测量图 × (800 ÷ 3/4) = 3200；scrollTop 2600 + vh 600 ≥ 3200 - 4 → 真底部
  Object.defineProperty(el, 'scrollTop', { value: 2600, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  expect(w.vm.isAtBottom()).toBe(true);
});

it('names 为空时 isAtBottom false（塌陷防御第二分支）', async () => {
  const w = mountViewer({ names: [], urls: [] }); await flushPromises();
  expect(w.vm.isAtBottom()).toBe(false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/reader/WebtoonViewer.test.ts`
预期：第 1、3 用例 FAIL（塌陷态 `scrollTop 100000 + 600 ≥ totalHeight(200) - 4` 为 true；空 names 时 `0 + 0 ≥ -4` 为 true），第 2 用例 PASS（现行为本就 true）。

- [ ] **步骤 3：编写最少实现**

`src/components/reader/WebtoonViewer.vue` 修改两处。

import 行（第 4 行）改为：

```ts
import { autoScrollDelta, captureAnchor, clampZoom, computeLayout, isLayoutDegenerate, restoreAnchor, topVisibleIndex, visibleWindow } from '@/lib/webtoonLayout';
```

`atBottom` computed（第 25 行）改为（新增 `stripWidth` computed 紧贴 `baseWidth` 之后、第 16 行末尾）：

```ts
const baseWidth = computed(() => { const w = containerWidth.value > 0 ? containerWidth.value : 800; return props.maxWidth > 0 ? Math.min(w, props.maxWidth) : w; });
const stripWidth = computed(() => baseWidth.value * zoom.value);
```

```ts
const atBottom = computed(() => {
  const el = scrollEl.value;
  if (!el) return false;
  // 2026-09-02 假底部防御：容器宽度被挤压（含 0 走 800 兜底的不可见态）时 totalHeight 随
  // 宽度塌缩、scrollTop 被钳位到底，位置语义已不可信——恒 false，封死误标完成 + auto 跨卷误跳。
  // 基准是容器 clientWidth 而非 stripWidth：webtoonMaxWidth 压窄 strip 是合法配置不算塌陷。
  if (isLayoutDegenerate(props.names.length, containerWidth.value)) return false;
  return scrollTop.value + viewportHeight.value >= layout.value.totalHeight - 4;
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/reader/WebtoonViewer.test.ts`
预期：PASS（含既有全部用例——「初始未到底」不受影响，守卫只收紧不放宽）。

- [ ] **步骤 5：Commit**

```bash
git add src/components/reader/WebtoonViewer.vue src/components/reader/WebtoonViewer.test.ts
git commit -m "fix(webtoon): atBottom 布局塌陷守卫——封死假底部→误标完成→auto 误跳卷故障链"
```

---

### 任务 3：WebtoonViewer 取证探针（塌陷 / atBottom 翻转 / scroll-past-bottom）

**文件：**
- 修改：`src/components/reader/WebtoonViewer.vue`（script setup 内，任务 2 改动的紧邻区域）
- 测试：`src/components/reader/WebtoonViewer.test.ts`

- [ ] **步骤 1：编写失败的测试**

`src/components/reader/WebtoonViewer.test.ts` 顶部（现有 `vi.mock('@/lib/tauri', ...)` 之后）追加 logger mock：

```ts
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
```

import 区追加：

```ts
import { log } from '@/lib/logger';
```

`describe` 内追加用例：

```ts
it('探针：进入布局塌陷时输出结构化快照日志', async () => {
  vi.mocked(log).mockClear();
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 50, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  const hit = vi.mocked(log).mock.calls.filter((c) => c[0] === '[webtoon] layout degenerate');
  expect(hit.length).toBeGreaterThanOrEqual(1);
  const payload = hit.at(-1)![1] as Record<string, unknown>;
  expect(payload).toMatchObject({ names: 3, stripWidth: 50 });
});

it('探针：atBottom 翻转 true 时输出快照', async () => {
  vi.mocked(log).mockClear();
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 2600, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  const hit = vi.mocked(log).mock.calls.filter((c) => c[0] === '[webtoon] atBottom flip');
  expect(hit.length).toBeGreaterThanOrEqual(1);
  expect((hit.at(-1)![1] as Record<string, unknown>).value).toBe(true);
});

it('探针：真底部滚轮下滚输出 scroll-past-bottom 快照（800ms 节流内只记一条）', async () => {
  vi.mocked(log).mockClear();
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 2600, writable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  w.find('.webtoon-scroll').trigger('wheel', { deltaY: 120 }); await flushPromises();
  const hit = vi.mocked(log).mock.calls.filter((c) => c[0] === '[webtoon] scroll-past-bottom');
  expect(hit.length).toBe(1);
  expect(hit[0]![1]).toMatchObject({ scrollTop: 2600, names: 3 });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/reader/WebtoonViewer.test.ts`
预期：三个探针用例 FAIL（log 无调用），其余全绿。

- [ ] **步骤 3：编写最少实现**

`src/components/reader/WebtoonViewer.vue`：

import 区（第 2 行 vue import 之后）追加：

```ts
import { log } from '@/lib/logger';
```

在任务 2 的 `atBottom` computed 之后追加（`getTopVisibleImage` 之前）：

```ts
// ── 取证探针（2026-09-02 事故）：常驻低噪声，只在状态翻转时落一条结构化快照到 main.log ──
function probeSnapshot(): Record<string, unknown> {
  return {
    scrollTop: Math.round(scrollTop.value),
    viewportHeight: Math.round(viewportHeight.value),
    clientWidth: scrollEl.value?.clientWidth ?? null,
    clientHeight: scrollEl.value?.clientHeight ?? null,
    stripWidth: Math.round(stripWidth.value),
    totalHeight: Math.round(layout.value.totalHeight),
    zoom: zoom.value,
    names: props.names.length,
    windowRange: windowRange.value,
  };
}
const degenerate = computed(() => isLayoutDegenerate(props.names.length, containerWidth.value));
watch(degenerate, (value) => { log('[webtoon] layout degenerate', { value, ...probeSnapshot() }); });
watch(atBottom, (value, previous) => { log('[webtoon] atBottom flip', { value, previous, ...probeSnapshot() }); });
```

`emitBottom`（第 42 行）改为：

```ts
let lastBottom = 0; function emitBottom() { const n = Date.now(); if (n - lastBottom >= 800) { lastBottom = n; log('[webtoon] scroll-past-bottom', probeSnapshot()); emit('scroll-past-bottom'); } }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/reader/WebtoonViewer.test.ts`
预期：PASS 全绿。注意 `log` 经 `@/lib/logger` mock 后不再触发 `invoke('log_to_file')`，测试环境无副作用。

- [ ] **步骤 5：Commit**

```bash
git add src/components/reader/WebtoonViewer.vue src/components/reader/WebtoonViewer.test.ts
git commit -m "feat(webtoon): 取证探针——塌陷/atBottom 翻转/scroll-past-bottom 结构化快照落 main.log"
```

---

### 任务 4：宽度变化锚定恢复 scrollTop（收「改宽度瞬移」UX 缺陷）

**文件：**
- 修改：`src/components/reader/WebtoonViewer.vue`（`onScroll` 第 45 行 + 新增 watch）
- 测试：`src/components/reader/WebtoonViewer.test.ts`

**背景：** strip 全部 item 高度 ∝ strip 宽度（`computeLayout`），宽度变化时 tops/totalHeight 整体缩放而 `scrollTop` 是绝对像素不缩放——同一 scrollTop 落到不同的图（变窄=后跳，变宽=前跳），极端时被钳位到底部。现有锚点补偿只覆盖测量批次（`measuredMap` watch）与缩放（`setZoom` 的 `pendingZoomAnchor`），宽度路径无补偿。本任务与 masonry 3.0.8 的 resize 锚定同思路：按「顶图索引 + 视口在图内比例」恢复。

**时序要点：** 锚点必须在旧布局上捕获——`layout` computed 依赖 `containerWidth`，任何 watcher 里读到的都已是新布局；唯一能拿到旧布局的位置是 `onScroll` 内、`containerWidth.value` 赋值**之前**。恢复用 `flush: 'post'` watch（DOM patch 后设 scrollTop），与现有 `measuredMap` watch（第 22 行）同模式。缩放不改 `clientWidth`，不会与 `setZoom` 的锚点补偿双重生效。

- [ ] **步骤 1：编写失败的测试**

`src/components/reader/WebtoonViewer.test.ts` 的 `describe` 内追加：

```ts
it('宽度变化按顶图锚定恢复 scrollTop（变窄不瞬移）', async () => {
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 1000, writable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  // 变窄：800 → 400。旧布局（宽 800，图高 1066.67）下 scrollTop 1000 = 第 0 图内 ratio 0.9375；
  // 新布局（宽 400，图高 533.33）应恢复到 533.33 × 0.9375 = 500，而不是留在 1000（跳到第 1 图）
  Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  expect(Math.abs(el.scrollTop - 500)).toBeLessThan(1);
});

it('塌陷宽度（< 120）不执行锚点恢复（不写入垃圾 scrollTop）', async () => {
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 1000, writable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  Object.defineProperty(el, 'clientWidth', { value: 50, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  expect(el.scrollTop).toBe(1000);
});

it('仅高度变化（宽度不变）不触发锚定', async () => {
  const w = mountViewer(); await flushPromises();
  const el = w.find('.webtoon-scroll').element as HTMLElement;
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 1000, writable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  Object.defineProperty(el, 'clientHeight', { value: 900, configurable: true });
  w.find('.webtoon-scroll').trigger('scroll'); await flushPromises();
  expect(el.scrollTop).toBe(1000);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/reader/WebtoonViewer.test.ts`
预期：第 1 用例 FAIL（scrollTop 仍是 1000，瞬移到第 1 图），第 2、3 用例 PASS（现行为本就不恢复）。

- [ ] **步骤 3：编写最少实现**

`src/components/reader/WebtoonViewer.vue`：

`onScroll`（第 45 行）改为：

```ts
function onScroll() { const el = scrollEl.value; if (!el) return; scrollTop.value = el.scrollTop; viewportHeight.value = el.clientHeight;
  // 宽度变化：strip 等比缩放而 scrollTop 不缩——在旧布局上捕锚点（layout computed 读到的仍是
  // 旧 containerWidth），patch 后按「顶图 + 比例」恢复，收「改宽度瞬移」（masonry 3.0.8 同思路）。
  if (el.clientWidth !== containerWidth.value) {
    pendingWidthAnchor = isLayoutDegenerate(props.names.length, containerWidth.value) ? null : captureAnchor(layout.value, el.scrollTop);
    containerWidth.value = el.clientWidth;
  }
  emit('scroll'); }
```

在现有 `measuredMap` watch（第 22 行）之后追加：

```ts
let pendingWidthAnchor: ReturnType<typeof captureAnchor> = null;
watch(containerWidth, () => {
  if (!pendingWidthAnchor) return;
  const anchor = pendingWidthAnchor; pendingWidthAnchor = null;
  if (degenerate.value) return; // 塌陷态布局不可信，丢弃锚点不写入垃圾 scrollTop
  const y = restoreAnchor(layout.value, anchor);
  if (y !== null && scrollEl.value && Math.abs(y - scrollEl.value.scrollTop) > .5) {
    scrollEl.value.scrollTop = y;
    scrollTop.value = y; // 同步 ref：atBottom/进度/探针都读 scrollTop.value，不等异步 scroll 事件回填
  }
}, { flush: 'post' });
```

注意：`degenerate` computed 在任务 3 定义；本任务若先于任务 3 执行，需把 `const degenerate = computed(() => isLayoutDegenerate(props.names.length, containerWidth.value));` 一并带入（建议按任务顺序执行，天然满足）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/reader/WebtoonViewer.test.ts`
预期：PASS 全绿。

- [ ] **步骤 5：Commit**

```bash
git add src/components/reader/WebtoonViewer.vue src/components/reader/WebtoonViewer.test.ts
git commit -m "fix(webtoon): 宽度变化按顶图锚定恢复 scrollTop——收改宽度瞬移缺陷"
```

---

### 任务 5：`ResizeBurstDetector` 纯类

**文件：**
- 创建：`src/lib/resizeBurstDetector.ts`
- 测试：`src/lib/resizeBurstDetector.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/lib/resizeBurstDetector.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { ResizeBurstDetector } from './resizeBurstDetector';

describe('ResizeBurstDetector（2026-09-02 布局抽搐取证）', () => {
  it('窗口内未达 threshold → 不报', () => {
    const d = new ResizeBurstDetector(3, 1000, 5000);
    expect(d.record(0)).toBe(false);
    expect(d.record(10)).toBe(false);
  });

  it('窗口内第 threshold 次达到 → 报 true 并清空窗口', () => {
    const d = new ResizeBurstDetector(3, 1000, 5000);
    expect(d.record(0)).toBe(false);
    expect(d.record(10)).toBe(false);
    expect(d.record(20)).toBe(true); // 第 3 次 record，times.length 达到 threshold=3
  });

  it('cooldown 期内再爆发不重复报', () => {
    const d = new ResizeBurstDetector(3, 1000, 5000);
    expect(d.record(0)).toBe(false);
    expect(d.record(10)).toBe(false);
    expect(d.record(20)).toBe(true); // 触发，lastLoggedAt=20，窗口清空
    expect(d.record(30)).toBe(false);
    expect(d.record(40)).toBe(false);
    expect(d.record(50)).toBe(false); // 第 50ms 时窗口内再次达 3 个，但 50-20 < cooldown 5000
    expect(d.record(60)).toBe(false);
  });

  it('cooldown 过期后再爆发 → 再报', () => {
    const d = new ResizeBurstDetector(3, 1000, 5000);
    expect(d.record(0)).toBe(false);
    expect(d.record(10)).toBe(false);
    expect(d.record(20)).toBe(true);
    expect(d.record(6000)).toBe(false); // 旧窗口已清空，重新计数
    expect(d.record(6010)).toBe(false);
    expect(d.record(6020)).toBe(true); // 6020 - lastLoggedAt(20) ≥ cooldown 5000
  });

  it('窗口外旧样本过期，不累计', () => {
    const d = new ResizeBurstDetector(3, 1000, 5000);
    d.record(0); d.record(10);
    expect(d.record(2000)).toBe(false); // 0/10 已滑出 1000ms 窗口，窗口内只有 1 个样本
  });

  it('默认构造可用（threshold=8, windowMs=1000, cooldownMs=5000）', () => {
    const d = new ResizeBurstDetector();
    for (let i = 0; i < 7; i += 1) expect(d.record(i * 100)).toBe(false);
    expect(d.record(700)).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/lib/resizeBurstDetector.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现**

创建 `src/lib/resizeBurstDetector.ts`：

```ts
/**
 * resize 事件风暴检测（2026-09-02 事故取证：reader 根元素 0.9s 内 40+ 次 RO 触发，
 * 伴随整窗白屏与 webtoon 假底部）。滑动窗口计数，达 threshold 报一次，cooldown 防刷屏。
 * 时间由调用方注入（Date.now()），纯逻辑可独立测试。
 */
export class ResizeBurstDetector {
  private times: number[] = [];
  private lastLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly threshold: number = 8,
    private readonly windowMs: number = 1000,
    private readonly cooldownMs: number = 5000,
  ) {}

  /** 记录一次触发；返回 true 表示此刻应输出一次爆发日志。 */
  record(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    this.times.push(now);
    if (this.times.length >= this.threshold && now - this.lastLoggedAt >= this.cooldownMs) {
      this.lastLoggedAt = now;
      this.times = [];
      return true;
    }
    return false;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/lib/resizeBurstDetector.test.ts`
预期：6 用例 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/resizeBurstDetector.ts src/lib/resizeBurstDetector.test.ts
git commit -m "feat(lib): ResizeBurstDetector 滑动窗口风暴检测纯类"
```

---

### 任务 6：`useReaderScale` 接风暴检测 + 日志

**文件：**
- 修改：`src/composables/useReaderScale.ts`（import 区 + `onResize` 函数，第 159-177 行区域）
- 测试：`src/composables/useReaderScale.test.ts`

- [ ] **步骤 1：编写失败的测试**

`src/composables/useReaderScale.test.ts` 顶部（现有 `vi.stubGlobal` 出现之前的 mock 区）追加：

```ts
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
```

import 区追加：

```ts
import { log } from '@/lib/logger';
```

`describe` 内末尾（现有 ResizeObserver 用例之后）追加：

```ts
it('resize 风暴（1s 内 8 次通过节流）输出一次 burst 日志（2026-09-02 取证探针）', async () => {
  vi.mocked(log).mockClear();
  const viewer = makeViewer();
  const viewerRef = ref<OSDViewerLike | null>(viewer);
  const modeRef: ModeRef = ref('fit-screen');
  let roCallback: (() => void) | null = null;
  class MockRO {
    constructor(cb: () => void) { roCallback = cb; }
    observe(_target: HTMLElement) {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', MockRO);
  const triggerResize = (): void => { (roCallback as (() => void) | null)?.(); };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const cRef = ref<HTMLElement | null>(null);
  const Host = defineComponent({
    setup() {
      useReaderScale({ viewerRef, mode: modeRef, containerRef: cRef });
      return () => h('div', { ref: cRef });
    },
  });
  const w = mount(Host);
  await w.vm.$nextTick();

  // 10 次触发、每次间隔 80ms（> RESIZE_MIN_INTERVAL_MS 60，保证每次都走 rAF 回调）
  for (let i = 0; i < 10; i += 1) { triggerResize(); await sleep(80); }

  const hits = vi.mocked(log).mock.calls.filter((c) => c[0] === '[useReaderScale] resize burst');
  expect(hits.length).toBe(1);
  expect(hits[0]![1]).toMatchObject({ mode: 'fit-screen' });

  w.unmount();
  vi.unstubAllGlobals();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/useReaderScale.test.ts`
预期：新用例 FAIL（log 零调用），既有用例全绿。

- [ ] **步骤 3：编写最少实现**

`src/composables/useReaderScale.ts`：

import 区追加：

```ts
import { ResizeBurstDetector } from '@/lib/resizeBurstDetector';
import { log } from '@/lib/logger';
```

`onResize`（第 160 行起）改为——rAF 回调顶部插入检测，其余节流逻辑原样保留：

```ts
  const resizeBurst = new ResizeBurstDetector();
  function onResize(): void {
    if (rafId !== null) return;  // 已有 pending frame, 等下一帧
    rafId = requestAnimationFrame(() => {
      rafId = null;
      // 2026-09-02 取证探针：rAF 通过次数即节流后真实布局事件频次，
      // 1s 内 ≥8 次 = 布局抽搐（正常拖窗口 60ms 间隔下也会命中，靠快照内容区分）。
      if (resizeBurst.record(Date.now())) {
        const el = opts.containerRef.value;
        log('[useReaderScale] resize burst', {
          clientWidth: el?.clientWidth ?? null,
          clientHeight: el?.clientHeight ?? null,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          mode: opts.mode.value,
        });
      }
      const now = Date.now();
      const elapsed = now - lastApplyAt;
      if (elapsed < RESIZE_MIN_INTERVAL_MS) {
        // 距上次太近, 延后到剩余间隔后 apply (防 OSD fitBounds 重算掉帧)
        setTimeout(() => {
          lastApplyAt = Date.now();
          applyScale(opts.mode.value);
        }, RESIZE_MIN_INTERVAL_MS - elapsed);
      } else {
        lastApplyAt = now;
        applyScale(opts.mode.value);
      }
    });
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/composables/useReaderScale.test.ts`
预期：PASS 全绿。注意 10 次触发间隔 80ms > 60ms 最低间隔，每次都即时 apply，不产生 setTimeout 延后路径的跨用例定时器残留（`w.unmount()` 后既有 setTimeout 也已全部到期）。

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useReaderScale.ts src/composables/useReaderScale.test.ts
git commit -m "feat(reader): useReaderScale 接 ResizeBurstDetector——布局抽搐取证日志"
```

---

### 任务 7：全量验证 + 文档挂账

**文件：**
- 修改：`DESIGN.md`（§16.2 遗留打磨项，追加一条观察挂账）
- 修改：`AGENTS.md`（「当前状态」表追加 hotfix 行，含误标数据修复记录）

- [ ] **步骤 1：全量前端测试 + 类型检查**

```bash
npm run type-check && npm test -- --run
```
预期：type-check 0 error；测试全绿，总数相对当前基线净增（任务 1 +3、任务 2 +3、任务 3 +3、任务 4 +3、任务 5 +6、任务 6 +1 = +19）。

- [ ] **步骤 2：本地实机冒烟（调试实例已带 9222，CDP 驱动）**

`npm run tauri:dev`（带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）后验证三件事：
1. 正常阅读：进任一大图目录 webtoon 阅读，滚动到底停留 1.2s → 仍能正常标完成（守卫不误伤，main.log 出现 `atBottom flip value=true`）。
2. 塌陷日志：CDP `evaluate_script` 把 `.webtoon-scroll` 的 `clientWidth` defineProperty 成 50 并触发 scroll → main.log 出现 `[webtoon] layout degenerate value=true`。
3. 恢复日志：恢复真实尺寸再触发 scroll → `layout degenerate value=false`。

- [ ] **步骤 3：DESIGN.md §16.2 追加挂账**

在「### 16.2 遗留打磨项」小节末尾追加：

```markdown
- **webtoon 布局抽搐根因**（2026-09-02 事故）：reader 根元素无交互下 RO 风暴（0.9s 40+ 次）+ 整窗白屏 2 分钟 + atBottom 假阳性 → 误标完成 + auto 跨卷误跳。防御已落地（isLayoutDegenerate 守卫 + 塌陷/atBottom 翻转/scroll-past-bottom/resize burst 四类探针日志）；**触发源待探针在下次复现时抓取**（main.log 关键字 `layout degenerate` / `resize burst` / `atBottom flip`）。
```

- [ ] **步骤 4：AGENTS.md 状态表追加行**

「当前状态」表按 3.5.x 序号追加一行（打前查占号），记录：事故链、守卫、探针、260901 误标手工修复（`mark_finished(137, false)`，进度行保留）、测试基线变化。

- [ ] **步骤 5：Commit + push**

```bash
git add DESIGN.md AGENTS.md
git commit -m "docs: webtoon 假底部防御与取证探针交付记录 + 布局抽搐根因挂账"
git push github main
```

---

## 自检记录

1. **规格覆盖度**：守卫（任务 1+2）、三类组件探针（任务 3）、宽度锚定（任务 4）、风暴检测（任务 5+6）、验证与挂账（任务 7）——用户拍板的两项高价值交付 + 追加的宽度瞬移收口全覆盖；不做清单已声明 UI 提示与根因修复不在本期。
2. **占位符扫描**：所有代码步骤含完整代码，无 TODO/待定。
3. **类型一致性**：`isLayoutDegenerate(namesLength: number, viewportWidth: number)` 在任务 2/3/4 的调用点一致（传 `containerWidth.value`，判定基准=容器宽度，与 `webtoonMaxWidth` 解耦）；`stripWidth` computed 在任务 2 定义、仅任务 3 snapshot 复用（探针快照字段，非判定输入）；`degenerate` computed 在任务 3 定义、任务 4 恢复分支复用（计划已注明依赖任务顺序）；`captureAnchor`/`restoreAnchor` 为 `webtoonLayout.ts:106/117` 既有导出，任务 4 直接复用；任务 4 恢复分支同时写 `scrollEl.scrollTop` 与 `scrollTop.value`（atBottom/进度/探针零陈旧窗口）；`ResizeBurstDetector.record(now: number): boolean` 签名在任务 6 调用点一致（threshold=3 时第 3 次 record 触发，测试与实现语义对齐）；探针日志前缀 `'[webtoon] layout degenerate'` / `'[webtoon] atBottom flip'` / `'[webtoon] scroll-past-bottom'` / `'[useReaderScale] resize burst'` 在实现与测试断言两侧逐字一致。
