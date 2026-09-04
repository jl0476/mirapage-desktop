# 瀑布流测量批次 scrollTop 锚定补偿 实现计划（rev4）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 兑现 DESIGN §16.2 G 项——测量批次（header 预读 / 缩略图 onload）到达时按 viewport anchor 补偿 scrollTop，消除瀑布流滚动跳屏（2026-09-03 实机探针：4 秒 8 跳、每次内容位移 300-526px）。

**架构：** 新增 `commitMeasuredMap(next)` 单一提交口（MasonryView 内），两条测量提交路径（`onRowMeasured` / `triggerDimensionPrefetch`）收口到它。批内首次提交按**批前 layout** 捕锚（严格版 `captureMasonryViewportAnchor` + 顶线落所有列 gap 时的 loose 变体——按**最大下边缘**取最近上方图），`nextTick` 后按新 layout 恢复 scrollTop。**批次状态全闭包化（rev3 P1-2）**：anchor/key/seq 捕获进回调局部变量，回调先验 seq 再动共享态（仅 `measurePending`）——旧批次回调无法偷清新批次；目录切换 watcher 只 `measureSeq+=1; measurePending=false`。**resize 让位（rev3 P2-3）**：`resizeAnchor` 活跃期间测量提交不捕自己的锚，改为复用 resize 锚重触发一次 `restoreResizeAnchor`——单一恢复源，不搞两套锚互踩。

**技术栈：** Vue 3 + Vitest + happy-dom；纯前端零 Rust 零 i18n 改动。

**背景（实锤数据，2026-09-03 CDP 探针）：**
- 根因：`applyMeasuredBatch`（`useMasonryLayout.ts:152`，视口上方高度差累加）**零调用方**——3.0.6 E1 里程碑简化接线后遗留；`MasonryView.vue:491` 注释自认「视口补偿属后续独立模块（DESIGN §16.2 G 项）」。
- 两条裸提交路径：`onRowMeasured`（`MasonryView.vue:449`，缩略图 onload natural 尺寸）与 `triggerDimensionPrefetch`（`MasonryView.vue:481` 附近，header 预读批）。
- 放大条件：260901/260817 目录是 856×1920 竖屏截图，真实高度比 3:4 估算高 ~68%，每批测量把视口上方内容下推 300-526px；位移来源含列重排（探针实测 -164px 反向）——锚定法覆盖非线性 top 变化。

**rev3 变更（2026-09-04 二轮复审采纳，均经代码核实）**：① 修两处必败用例——loose 纯函数「scrollTop=0→null」错（严格捕获命中 a.jpg ratio 0），改空 layout 判 null；空 layout 组件用例 `rows[0]` 必崩（`visibleItems` 逐 entry 查 `layout.value.map`（`MasonryView.vue:517-525`），空 map 无行渲染），改 header deferred 驱动；② 批次状态闭包化 + 新增「旧批失效→新批创建→旧回调不清新批」判别用例；③ resize 让位规则 + 同 tick 判别用例；④ loose 改按**最大下边缘**选最近上方图（最大 top 在多列会锚到更远的卡）+ 判别用例；⑤ 探针 v3——静止判定改用户输入事件（wheel/pointerdown/keydown/touchstart），程序写 scrollTop 不重置窗口（否则欠补偿被隐藏）；锚点卡消失记 `anchorLost` 不静默换锚。

**rev4 变更（2026-09-04 三轮复审采纳）**：① **提交先于 nextTick 注册**——rev3 先 `nextTick` 后写 `measuredMap`，无 pending flush 时 nextTick 挂已 resolved Promise，恢复回调会跑在 measuredMap 触发的 flush（含目录 watcher/prop 更新）**之前**——切目录守卫用例实际空转。改为先写 `measuredMap`（触发 flush）再注册 `nextTick`（挂该 flush 之后），恢复真正发生在布局重算与失效判定之后；② **目录切换同步失效 resize 锚**——rev3 的 resize 让位分支不查 guardKey，目录 watcher 只动 measure 标量：resize 后 150ms 内切目录，新目录测量会复用旧目录 resize 锚命中同名文件。目录 watcher 追加 `resizeSeq += 1; resizeAnchor = null;` 清 `resizeEndTimer`，并新增「resize 活跃→切目录→新目录同名测量→不恢复」判别用例；③ **探针 v4 累计漂移**——rev3 每帧更新基线会把 5px×N 的累计欠补偿漏掉；静止期保留**最初** anchorTop 记 `maxAbsDrift`，验收明确 `maxAbsDrift ≤ 8 && anchorLost.length === 0`。

**rev4 补丁（2026-09-04 四轮复审采纳，⑤ 经五轮复审修正）**：④ **prefetchPathsMock 响应化**——该 mock 是普通对象（`MasonryView.test.ts:130`），mocked computed 读它不建响应依赖，挂载后改 `.current` watcher 永不触发——两个 header 测试必败。改 ref 背衬 + `.current` shim（同 fakeLayoutMap 模式；普通顶层 `ref` 即可，`vi.hoisted` 内引用静态导入会在 ESM 绑定初始化前 TDZ 报错）；⑤ **resize 开始失效 pending 测量批**——「单一恢复源」原只证了正向（resize 活跃→测量让位），反向（测量 pending→resize 开始）下测量回调不查 resizeAnchor 会先行写入。RO 回调在 `beginResizeAnchor()` 后追加 `measureSeq += 1; measurePending = false;`，并补反向时序判别用例（scrollTop 写次数 = 1 锁定单一写入者）。

**不做清单：**
- `applyMeasuredBatch` delta 累加法（被锚定法取代，删除）。
- resize 路径改用 loose 变体（严格版语义保持）。
- 测量到达期间的骨架占位动画优化。
- webtoon 宽度锚定（另一计划 `2026-09-02-webtoon-false-bottom-guard-and-probe.md` 任务 4）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/composables/useMasonryLayout.ts` | 修改 | ① `MasonryViewportAnchor` 加可选 `belowOffset` + restore 分流；② 新增 `captureMasonryViewportAnchorLoose`（max-bottom 选择）；③ 删孤儿 `applyMeasuredBatch` + `AnchorParams` |
| `src/composables/useMasonryLayout.test.ts` | 修改 | loose 用例 5 个（含 max-bottom 判别）+ 删 `applyMeasuredBatch` describe（4 用例） |
| `src/components/filebrowser/MasonryView.vue` | 修改 | `commitMeasuredMap`（闭包批次 + resize 让位）；两点接线；目录 watcher 失效钩子；491 行注记更新 |
| `src/components/filebrowser/MasonryView.test.ts` | 修改 | `fakeLayoutMap` 响应化；新 describe：主补偿 / header 批 / 批合并 / 切目录竞态 / 旧批不清新批 / 空锚（header 驱动）/ gap loose / resize 让位 / 接线断言 |

**锚点语义（核心约定）**：严格锚 = 穿过顶线的图 + `ratio∈[0,1]`；loose 锚 = 顶线无相交图时取**下边缘最大且 ≤ 顶线**的图 + `belowOffset`（顶线超出其下边缘的绝对距离）。restore：有 `belowOffset` → `item.top + item.height + belowOffset`；否则 `item.top + item.height * ratio`（现状）。ratio 语义表达不了「图下方超出」（随图长高按比例放大误差），故互斥字段——resize 严格路径 `belowOffset` 恒 undefined，**行为字节级不变**。

---

### 任务 1：loose 锚点纯函数（TDD 红→绿）

**文件：**
- 修改：`src/composables/useMasonryLayout.ts:172-220`（锚点区块）
- 测试：`src/composables/useMasonryLayout.test.ts`（锚点 describe 后追加）

- [ ] **步骤 1：编写失败的测试**

在 `describe('captureMasonryViewportAnchor / restoreMasonryViewportAnchor (resize 焦点漂移修复)')` 块之后追加（import 行加 `captureMasonryViewportAnchorLoose`）：

```ts
describe('captureMasonryViewportAnchorLoose (§16.2 G 测量锚定：顶线落 gap fallback)', () => {
  // 双列造数：col0 a(0,10)、col1 b(0,8)，顶线 15 落在两列内容之下——严格版返回 null 的位置
  const layout = new Map<string, MasonryItem>([
    ['a.jpg', { path: 'a.jpg', width: 100, height: 10, top: 0, left: 0, col: 0 }],
    ['b.jpg', { path: 'b.jpg', width: 100, height: 8, top: 0, left: 108, col: 1 }],
  ]);
  const entries = [{ path: 'a.jpg' }, { path: 'b.jpg' }];

  it('顶线无相交图 → fallback 下边缘最大的上方图 + belowOffset（绝对偏移）', () => {
    const anchor = captureMasonryViewportAnchorLoose(layout, entries, 15);
    expect(anchor).toEqual({ path: 'a.jpg', ratio: 1, belowOffset: 5 }); // a bottom=10（> b 的 8），超出 5
  });

  it('多列「top 最大」≠「下边缘最近」时按 max-bottom 选（rev3 P2-4 判别）', () => {
    // x：top 4 h1（bottom 5）；y：top 0 h9（bottom 9）——top-max 会错选 x，bottom-max 选 y
    const m = new Map<string, MasonryItem>([
      ['x.jpg', { path: 'x.jpg', width: 100, height: 1, top: 4, left: 0, col: 0 }],
      ['y.jpg', { path: 'y.jpg', width: 100, height: 9, top: 0, left: 108, col: 1 }],
    ]);
    const es = [{ path: 'x.jpg' }, { path: 'y.jpg' }];
    const anchor = captureMasonryViewportAnchorLoose(m, es, 15);
    expect(anchor).toEqual({ path: 'y.jpg', ratio: 1, belowOffset: 6 }); // bottom 9 距顶线 15 最近
  });

  it('有相交图时与严格版一致（belowOffset 不出现）', () => {
    const anchor = captureMasonryViewportAnchorLoose(layout, entries, 5); // 5 落在 a(0..10) 内
    expect(anchor).toEqual({ path: 'a.jpg', ratio: 0.5 });
  });

  it('restore：belowOffset 锚按「新下边缘 + 偏移」精确补偿（图自身长高不放大误差）', () => {
    const anchor = captureMasonryViewportAnchorLoose(layout, entries, 15)!;
    const grown = new Map(layout);
    grown.set('a.jpg', { ...layout.get('a.jpg')!, height: 22.4 }); // 10 → 22.4
    expect(restoreMasonryViewportAnchor(anchor, grown)).toBeCloseTo(27.4, 5); // 0+22.4+5
  });

  it('空 layout / 顶线上方无任何图 → null', () => {
    expect(captureMasonryViewportAnchorLoose(new Map(), [], 15)).toBeNull();
    // 注：scrollTop=0 且有图时严格捕获必命中首行（图从 top 0 开始），null 分支只在
    // 「上方无内容」时可达——空 layout 即该语义。
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/useMasonryLayout.test.ts`
预期：新 describe 5 用例 FAIL（函数未导出）。

- [ ] **步骤 3：编写最少实现**

`useMasonryLayout.ts` 三处改动。

`MasonryViewportAnchor` 接口加可选字段：

```ts
export interface MasonryViewportAnchor {
  path: string;
  ratio: number;
  /** loose 捕获专用：顶线在该图下边缘之下的超出距离（px）。与 ratio 互斥——
   * restore 见到此字段时忽略 ratio。严格路径（resize）恒不设置，行为不变。 */
  belowOffset?: number;
}
```

`restoreMasonryViewportAnchor` 返回前分流（`if (!item) return null;` 保持不变）：

```ts
  if (anchor.belowOffset !== undefined) return item.top + item.height + anchor.belowOffset;
  return item.top + item.height * anchor.ratio;
```

锚点区块末尾追加（**按最大下边缘选**，rev3 P2-4）：

```ts
/**
 * 测量锚定专用（§16.2 G）：顶线无相交图（落入所有列的纵向 gap / 短内容之下）时
 * fallback 到「下边缘最大且 ≤ 顶线」的图（多列下 top 最大 ≠ 下边缘最近，按 bottom 比），
 * 记 belowOffset（顶线超出其下边缘的绝对距离）——顶线上方内容长高时下边缘同幅下移，
 * 补偿语义与相交路径一致。上方无任何图返回 null。resize 路径仍用严格版。
 */
export function captureMasonryViewportAnchorLoose(
  layout: Map<string, MasonryItem>,
  entries: readonly { path: string }[],
  scrollTop: number,
): MasonryViewportAnchor | null {
  const strict = captureMasonryViewportAnchor(layout, entries, scrollTop);
  if (strict) return strict;
  let nearest: MasonryItem | null = null;
  let nearestBottom = -Infinity;
  for (const entry of entries) {
    const item = layout.get(entry.path);
    if (!item) continue;
    const bottom = item.top + item.height;
    if (bottom <= scrollTop && bottom > nearestBottom) { nearest = item; nearestBottom = bottom; }
  }
  if (!nearest) return null;
  return { path: nearest.path, ratio: 1, belowOffset: scrollTop - (nearest.top + nearest.height) };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/composables/useMasonryLayout.test.ts`
预期：PASS 全绿（既有 resize 锚用例不受影响）。

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useMasonryLayout.ts src/composables/useMasonryLayout.test.ts
git commit -m "feat(masonry): captureMasonryViewportAnchorLoose——顶线落 gap 的 loose 锚（max-bottom 选择 + belowOffset 语义，resize 严格路径不变）"
```

---

### 任务 2：`commitMeasuredMap`（闭包批次 + resize 让位）+ 主补偿行为（TDD 红→绿）

**文件：**
- 修改：`src/components/filebrowser/MasonryView.test.ts`（fakeLayoutMap 响应化 + 新 describe）
- 修改：`src/components/filebrowser/MasonryView.vue`

- [ ] **步骤 1：fakeLayoutMap / prefetchPathsMock 响应化**

现有 mock（`MasonryView.test.ts:118` 附近）：

```ts
/** 测试用 layout map：null 表示空（让 layout map 为空），Map 表示预填。 */
const fakeLayoutMap = { current: new Map<string, MasonryItem>() };
```

改为 ref 背衬 + `.current` shim（**既有用例赋值/读取零改动**，mocked `layout` computed 获得响应性）：

```ts
import { computed, nextTick, ref } from 'vue'; // 既有 vue import 行合并加 ref

/** 测试用 layout map：ref 背衬使 mocked layout computed 响应翻转（测量锚定用例需要
 * 在组件运行中把布局从「批前」翻到「批后」）；`.current` API 保持既有用例零改动。 */
const fakeLayoutMapRef = ref(new Map<string, MasonryItem>());
const fakeLayoutMap = {
  get current() { return fakeLayoutMapRef.value; },
  set current(m: Map<string, MasonryItem>) { fakeLayoutMapRef.value = m; },
};
```

**同一步骤**把 `prefetchPathsMock` 一并响应化（rev4 补丁④：普通对象不建响应依赖，挂载后改 `.current` 时 `watch(dimensionPrefetchPaths)` 永不触发，两个 header 测试必败）——现有定义（`MasonryView.test.ts:130`）：

```ts
const prefetchPathsMock = vi.hoisted(() => ({ current: [] as string[] }));
```

改为（rev4 补丁⑤修正：**普通顶层 `ref`，不用 `vi.hoisted`**——`vi.hoisted` 回调在 ESM import 绑定初始化前执行，引用静态导入的 `ref` 会 TDZ 报错；而 mock 工厂只是创建 computed 闭包、不解引用 `prefetchPathsMock`，真正的 `.current` 读取发生在组件挂载期，模块初始化早已完成——与 `fakeLayoutMapRef` 同款写法即可）：

```ts
const prefetchPathsRef = ref<string[]>([]);
const prefetchPathsMock = {
  get current() { return prefetchPathsRef.value; },
  set current(paths: string[]) { prefetchPathsRef.value = paths; },
};
```

既有 beforeEach 的 `prefetchPathsMock.current = []` 走 setter，行为不变。

- [ ] **步骤 2：编写失败的测试**

文件末尾追加 describe。**`MasonryRow` 已在 `MasonryView.test.ts:904` import（hoisted），复用不新增。**

```ts
// ─── §16.2 G 项兑现（2026-09-03 实机跳屏）— 测量批次 scrollTop 锚定补偿 ────────
// 机制：提交 measuredMap 前按批前 layout 捕「穿过顶线的图+ratio」，nextTick 后按新
// layout 恢复——视口内容钉住。单列口径造数保证数值可手算。
describe('MasonryView 测量批次锚定补偿 (§16.2 G)', () => {
  function col(items: { path: string; top: number; height: number }[]): Map<string, MasonryItem> {
    const m = new Map<string, MasonryItem>();
    for (const it of items) m.set(it.path, { path: it.path, col: 0, left: 0, top: it.top, height: it.height, width: 200 });
    return m;
  }
  function mountView() {
    return mount(MasonryView, {
      props: baseProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    prefetchPathsMock.current = [];
  });

  it('视口上方 item 长高（row-measured 单条）→ scrollTop 补偿到同图同 ratio', async () => {
    // 批前布局 v1：a.jpg top0 h100；b.jpg top100 h900（顶线 50 落在 a 内，ratio 0.5）
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });

    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 触发单条测量提交（同步）：锚点捕获自 v1（a.jpg, ratio .5）
    const rows = w.findAllComponents(MasonryRow);
    expect(rows.length).toBeGreaterThan(0);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 同步翻布局到 v2（模拟真实时序：measuredMap 提交 → layout 派生重算 → a.jpg 长高到 224）
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();

    // 锚定恢复：target = a.top + a.height × 0.5 = 112；未补偿则停留 50
    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：新用例 FAIL（scrollTop 停留 50），既有全绿（shim 兼容）。

- [ ] **步骤 4：编写最少实现**

`MasonryView.vue`。锚定 import 行追加 `captureMasonryViewportAnchorLoose`（其余锚定符号已被 resize 接线 import）。在 resize anchor 块（`scheduleResizeAnchorRelease` 之后、`let ro` 之前）追加：

```ts
// ── §16.2 G 项兑现（2026-09-03 实机跳屏）：测量批次到达的 scrollTop 锚定补偿 ──
// 根因：3:4 估算 vs 竖屏截图真实比（856×1920 高 ~68%）使每批测量把视口上方内容下推
// 300-500px（CDP 探针 4s/8 跳）。机制同 resize anchor（task-21）：批内首次提交按批前
// layout 捕锚（严格版 + loose fallback），布局重算后恢复——视口内容钉住；列重排
// （非线性 top 变化）也覆盖（delta 累加法不覆盖，applyMeasuredBatch 已删）。
// 批次状态闭包化：anchor/key/seq 捕进回调局部变量，回调先验 seq 再动共享态（仅
// measurePending）——旧批次回调不可能偷清新批次（rev3 P1-2）。
// 时序（rev4 P1-1）：必须先写 measuredMap 再注册 nextTick——Vue 无 pending flush 时
// nextTick 挂已 resolved Promise，先注册会让恢复跑在 measuredMap 触发的 flush（含目录
// watcher / prop 更新）之前，守卫空转。先写后挂，恢复才真正发生在布局重算与失效判定之后。
// resize 让位：resizeAnchor 活跃期间测量不捕自己的锚，复用 resize 锚重触发恢复——
// 单一恢复源，两套锚不互踩（rev3 P2-3；两者不变量一致但捕获时刻不同，后者不保证正确）。
let measureSeq = 0;
let measurePending = false;

function commitMeasuredMap(next: Map<string, { width: number; height: number }>): void {
  if (resizeAnchor) {
    measuredMap.value = next;
    void restoreResizeAnchor(resizeSeq);
    return;
  }
  if (measurePending) {
    measuredMap.value = next;
    return;
  }
  measurePending = true;
  const seq = ++measureSeq;
  const key = guardKey();
  const anchor = captureMasonryViewportAnchorLoose(
    layout.value.map,
    props.entries,
    containerRef.value?.scrollTop ?? scrollTop.value,
  );
  measuredMap.value = next; // 先触发 flush（布局失效 + watcher 排队）
  void nextTick(() => {     // 再挂该 flush 之后——恢复在重算与失效判定之后执行
    if (seq !== measureSeq) return; // 旧批次：不动共享状态（新批次可能已开启）
    measurePending = false;
    if (key !== guardKey() || !anchor || !containerRef.value) return;
    const target = restoreMasonryViewportAnchor(anchor, layout.value.map);
    if (target == null) return;
    const maxScrollTop = Math.max(0, layout.value.totalHeight - containerRef.value.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(target, maxScrollTop));
    if (Math.abs(nextScrollTop - containerRef.value.scrollTop) > 0.5) {
      containerRef.value.scrollTop = nextScrollTop;
      scrollTop.value = nextScrollTop;
    }
  });
}
```

目录切换 watcher（`watch(guardKey, ...)` 内，`measuredMap.value = new Map();` 之后）追加——同时失效**测量与 resize** 两套锚（rev4 P1-2：resize 让位分支不查 guardKey，若只清测量，resize 后 150ms 内切目录、新目录测量会复用旧目录 resize 锚命中同名文件）：

```ts
    // 测量锚定失效（§16.2 G）：seq 越过所有在途回调；pending 复位让新目录立即开新批
    measureSeq += 1;
    measurePending = false;
    // resize 锚一并失效（rev4 P1-2）：seq 使在途 restoreResizeAnchor 作废，锚与释放
    // 定时器同清——防旧目录 resize 锚经让位分支命中新目录同名文件
    resizeSeq += 1;
    resizeAnchor = null;
    if (resizeEndTimer) {
      clearTimeout(resizeEndTimer);
      resizeEndTimer = null;
    }
```

`onRowMeasured`（449 行）改为：

```ts
function onRowMeasured(entry: MediaEntry, width: number, height: number): void {
  const next = mergeMeasured(measuredMap.value, entry.path, { width, height });
  if (next !== measuredMap.value) {
    commitMeasuredMap(next as Map<string, { width: number; height: number }>);
  }
}
```

`triggerDimensionPrefetch` 内 `measuredMap.value = m; sourceDimsMap.value = sd;` 改为：

```ts
    commitMeasuredMap(m);
    sourceDimsMap.value = sd;
```

RO 回调（`onMounted` 内 `new ResizeObserver(() => {...})`，`beginResizeAnchor();` 调用之后）追加测量批让位（rev4 补丁⑤：反向时序「测量 pending → resize 开始」下，测量回调不查 resizeAnchor 会先行写入——resize 开始即失效 pending 测量批，单一恢复源双向成立）：

```ts
    // 测量批让位（§16.2 G）：resize 开始即失效 pending 测量批——单一恢复源的反向时序
    measureSeq += 1;
    measurePending = false;
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：PASS 全绿。

- [ ] **步骤 6：Commit**

```bash
git add src/components/filebrowser/MasonryView.vue src/components/filebrowser/MasonryView.test.ts
git commit -m "fix(masonry): 测量批次 scrollTop 锚定补偿——§16.2 G 兑现（闭包批次 + resize 让位 + loose 锚）"
```

---

### 任务 3：header 批路径行为测试（deferred promise）

**文件：**
- 修改：`src/components/filebrowser/MasonryView.test.ts`（同 describe 追加）

- [ ] **步骤 1：编写测试**

```ts
  it('header 批回包（listImageDimensions 异步）→ 同图同 ratio 补偿', async () => {
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    let resolveDims: (v: { path: string; width: number; height: number }[]) => void = () => {};
    vi.mocked(listImageDimensions).mockImplementationOnce(
      () => new Promise((r) => { resolveDims = r; }) as Promise<{ path: string; width: number; height: number }[]>,
    );
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 触发 header 预读（watch(dimensionPrefetchPaths) flush post）
    prefetchPathsMock.current = ['a.jpg'];
    await nextTick();

    // 回包到达：提交在微任务里发生——泵微任务直到 measuredMap 写入（提交=锚点已按 v1 捕获）
    resolveDims([{ path: 'vol02/a.jpg', width: 856, height: 1920 }]);
    for (let i = 0; i < 50 && !(layoutParams.current as { measuredMap: { value: Map<string, unknown> } }).measuredMap.value.has('a.jpg'); i++) {
      await Promise.resolve();
    }
    // 布局翻 v2（a.jpg 长高）——仍在 restore 的 nextTick 之前
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });
```

注意：`layoutParams` 是文件既有 hoisted 捕获，`params.measuredMap` 是组件传出 ref（`MasonryView.vue:181`）——泵观察点。回包 path 填 `vol02/a.jpg`（`toRootRelativePath(currentPath, 'a.jpg')` 的请求形态，实现按 `d.path` 反查 rel）。

- [ ] **步骤 2：运行测试**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：PASS。若 RED 排查：微任务泵是否跑完提交（`measuredMap.has` 观察点）；guardKey 是否误杀（本用例不切目录）。

- [ ] **步骤 3：Commit**

```bash
git add src/components/filebrowser/MasonryView.test.ts
git commit -m "test(masonry): header 批回包路径行为用例——deferred promise 卡真实时序"
```

---

### 任务 4：批合并 + 竞态判别用例（5 个）

**文件：**
- 修改：`src/components/filebrowser/MasonryView.test.ts`（同 describe 追加）

- [ ] **步骤 1：编写测试**

```ts
  it('同批多次提交共享首个锚点（不按批中布局重捕）', async () => {
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    const rows = w.findAllComponents(MasonryRow);
    // 提交 1（a）：捕获锚点自 v1（a.jpg, ratio .5）
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 翻布局 v2 后同批再提交 2（b）：若实现错误地在批中重捕（v2 + scrollTop 50 →
    // ratio 50/224 → 恢复 50 = 无补偿），正确则仍用首锚 → 恢复 112
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    rows[1].vm.$emit('row-measured', baseProps.entries[1], 856, 1920);
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('提交后、恢复前切目录且新目录有同名文件 → 不写 scrollTop（竞态守卫）', async () => {
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // 提交（锚 a.jpg@v1 入闭包），随后切目录：watcher 失效（seq 越过 + pending 复位）
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    await w.setProps({ currentPath: 'vol03' });
    // 新目录同名单图、更长（若无守卫，旧锚 a.jpg 命中 → scrollTop 被改写 112）
    fakeLayoutMap.current = col([{ path: 'a.jpg', top: 0, height: 224 }]);
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(50); // 守卫生效：恢复被丢弃
    w.unmount();
  });

  it('旧批失效 → 新批已开启 → 旧回调不清掉新批（闭包批次判别，rev3 P1-2）', async () => {
    const v1 = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    fakeLayoutMap.current = v1;
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 50;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    const rows = w.findAllComponents(MasonryRow);
    // 批 A（vol02）：闭包锚 {a, .5}
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 切目录 → 批 A 失效（seq 越过）；新目录同构布局，scrollTop 仍 50
    await w.setProps({ currentPath: 'vol03' });
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    // 批 B（vol03）：pending 已复位 → 开新批，闭包锚 {a, .5}
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 布局长高（a → 224）。若旧 A 回调先清共享锚再查 seq（共享态实现），B 无锚可恢复 → 50；
    // 闭包实现：A 的回调 seq 不符直接 return，B 恢复 → 112
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
  });

  it('resize 活跃 → 切目录 → 新目录同名文件测量 → 不恢复旧 scrollTop（rev4 P1-2 判别）', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    clearResizeCbs();
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 900 });
    containerEl.scrollTop = 50; // resize 锚捕获基线：{a, .5}
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    fireResize(); // resizeAnchor 活跃（150ms 释放窗内）
    // 切目录：watcher 失效测量 + resize 两套锚（rev4）；若无 resize 失效，新目录测量的
    // 让位分支会复用旧 resize 锚 {a,.5} → 恢复 112（错）
    await w.setProps({ currentPath: 'vol03' });
    fakeLayoutMap.current = col([{ path: 'a.jpg', top: 0, height: 224 }]); // 新目录同名更长
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    await nextTick();
    await nextTick();

    // 正确路径：resize 锚已失效 → 走测量自捕（v2 a 高 224，scrollTop 50 → ratio 50/224
    // → 恢复目标恰 50，无写）；旧锚未失效则 112
    expect(containerEl.scrollTop).toBe(50);
    w.unmount();
    vi.unstubAllGlobals();
  });

  it('测量批 pending → resize 开始 → 测量回调让位（写次数=1 锁单一写入者，rev4 补丁⑤判别）', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    clearResizeCbs();
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 900 });
    // scrollTop 用 get/set 背衬计数——两个恢复都经 containerEl.scrollTop 写入，次数即写入者数
    const backing = { v: 50, writes: 0 };
    Object.defineProperty(containerEl, 'scrollTop', {
      configurable: true,
      get: () => backing.v,
      set: (x: number) => { backing.v = x; backing.writes += 1; },
    });
    containerEl.dispatchEvent(new Event('scroll')); // 同步 useVirtualList scrollTop.value=50
    await nextTick();

    // 批 A（测量）：闭包锚 {a, .5}@v1（50 落在 a(0..100) 内）
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // 翻中间布局 v_mid（a h150）再开 resize——resize 锚自 v_mid 捕（{a, 1/3}），
    // 与测量锚不同值，确保两写入者的目标可区分
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 150 },
      { path: 'b.jpg', top: 150, height: 850 },
    ]);
    fireResize(); // RO：beginResizeAnchor({a,1/3}@v_mid) + 失效测量批（seq 越过）+ 调度 resize 恢复
    // 终布局 v2（a h224）
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    await nextTick();
    await nextTick();

    // 单一写入者：仅 resize 恢复（0 + 224×1/3 ≈ 74.67）；测量回调 seq 不符让位。
    // 若无 RO 失效：测量先写 112（其锚 .5×224）再被 resize 覆盖 → writes=2 → RED
    expect(backing.writes).toBe(1);
    expect(containerEl.scrollTop).toBeCloseTo(224 / 3, 5);
    w.unmount();
    vi.unstubAllGlobals();
  });
```

- [ ] **步骤 2：运行测试**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：五用例 PASS（闭包实现 + 双向让位在任务 2 内）。第三用例对「共享态 + 先清后查」必红；第四用例对「目录切换未失效 resize 锚」必红；第五用例对「resize 开始未失效测量批」必红（writes=2）——判别性回归锁。

- [ ] **步骤 3：Commit**

```bash
git add src/components/filebrowser/MasonryView.test.ts
git commit -m "test(masonry): 批合并首锚 + 切目录竞态 + 旧批不清新批 + resize 双向让位五重回归锁"
```

---

### 任务 5：边界用例 + resize 让位 + 接线断言

**文件：**
- 修改：`src/components/filebrowser/MasonryView.test.ts`（同 describe 追加）

- [ ] **步骤 1：编写测试**

```ts
  it('空 layout（无任何图）→ 不写 scrollTop（header 驱动，不经 MasonryRow）', async () => {
    // 空 map ⇒ visibleItems 逐项 map.get 落空 ⇒ 无行渲染——用 header 回包路径驱动提交
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    let resolveDims: (v: { path: string; width: number; height: number }[]) => void = () => {};
    vi.mocked(listImageDimensions).mockImplementationOnce(
      () => new Promise((r) => { resolveDims = r; }) as Promise<{ path: string; width: number; height: number }[]>,
    );
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 30;
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    prefetchPathsMock.current = ['a.jpg'];
    await nextTick();
    resolveDims([{ path: 'vol02/a.jpg', width: 856, height: 1920 }]);
    for (let i = 0; i < 50 && !(layoutParams.current as { measuredMap: { value: Map<string, unknown> } }).measuredMap.value.has('a.jpg'); i++) {
      await Promise.resolve();
    }
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(30); // loose/严格捕获均 null → 跳过恢复
    w.unmount();
  });

  it('顶线落入所有列 gap（无相交图）→ loose 锚按「下边缘+偏移」补偿', async () => {
    // 双列：col0 a(0,h10)、col1 b(0,h8)——单列造数无法产生 gap（列内连续）
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 200, height: 10, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 200, height: 8, top: 0, left: 208, col: 1 }],
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    containerEl.scrollTop = 15; // 顶线在两列内容之下（a 止于 10、b 止于 8）
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    // a.jpg 长高 10 → 22.4（真实时序翻布局）
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 200, height: 22.4, top: 0, left: 0, col: 0 }],
      ['b.jpg', { path: 'b.jpg', width: 200, height: 8, top: 0, left: 208, col: 1 }],
    ]);
    await nextTick();

    // loose：anchor={a, belowOffset:5} → target = 0+22.4+5 = 27.4；未补偿停留 15
    expect(containerEl.scrollTop).toBeCloseTo(27.4, 5);
    w.unmount();
  });

  it('resize 进行中测量提交让位——复用 resize 锚恢复（rev3 P2-3 判别）', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver); // 既有 FakeRO（clearResizeCbs 后复用）
    clearResizeCbs();
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 100 },
      { path: 'b.jpg', top: 100, height: 900 },
    ]);
    const w = mountView();
    await flushPromises();
    await nextTick();
    const containerEl = w.element.querySelector('.masonry-container') as HTMLElement;
    Object.defineProperty(containerEl, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(containerEl, 'clientWidth', { configurable: true, value: 900 });
    containerEl.scrollTop = 50; // resize 锚捕获基线：{a, .5}
    containerEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    fireResize(); // beginResizeAnchor 捕 {a,.5}@v1 + 调度 resize 恢复（nextTick）
    // 先翻布局 v2（a h224），再提交测量——若测量自捕锚（v2 + scrollTop 50 → ratio 50/224
    // → 恢复 50 = 无补偿），让位实现复用 resize 锚 {a,.5} → 112
    fakeLayoutMap.current = col([
      { path: 'a.jpg', top: 0, height: 224 },
      { path: 'b.jpg', top: 224, height: 776 },
    ]);
    const rows = w.findAllComponents(MasonryRow);
    rows[0].vm.$emit('row-measured', baseProps.entries[0], 856, 1920);
    await nextTick();
    await nextTick();

    expect(containerEl.scrollTop).toBe(112);
    w.unmount();
    vi.unstubAllGlobals();
  });

  it('两条测量提交路径均收口 commitMeasuredMap（接线断言）', () => {
    const source = readFileSync(new URL('./MasonryView.vue', import.meta.url), 'utf-8');
    const onRow = source.slice(source.indexOf('function onRowMeasured'));
    expect(onRow.slice(0, onRow.indexOf('function triggerDimensionPrefetch'))).toContain('commitMeasuredMap(');
    const prefetch = source.slice(source.indexOf('async function triggerDimensionPrefetch'));
    expect(prefetch.slice(0, prefetch.indexOf('watch('))).toContain('commitMeasuredMap(');
  });
```

（`readFileSync` 顶部无 import 则补 `import { readFileSync } from 'node:fs';`——既有「集成守卫」describe 在用，确认后复用。resize 让位用例注意：`fireResize`/`FakeResizeObserver`/`clearResizeCbs` 是文件既有基建（task-21 测试块），直接复用；`clientWidth` 初值来自 onMounted 的 `el.clientWidth || 1`（happy-dom 为 0→1），defineProperty 900 后 fire 即「宽度变化」。）

- [ ] **步骤 2：运行测试**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：四用例 PASS。resize 让位用例若 RED：检查 `commitMeasuredMap` 的 `if (resizeAnchor)` 分支（fireResize 后 `scheduleResizeAnchorRelease` 的 150ms 释放不会在用例时间窗内触发）。

- [ ] **步骤 3：Commit**

```bash
git add src/components/filebrowser/MasonryView.test.ts
git commit -m "test(masonry): 空锚（header 驱动）/ gap loose / resize 让位 / 双路径收口断言"
```

---

### 任务 6：删除孤儿 delta 补偿 + 注释/文档收口 + 全量验证 + E2E 复测（探针 v4）

**文件：**
- 修改：`src/composables/useMasonryLayout.ts`（删 `AnchorParams` + `applyMeasuredBatch`，约 142-164 行）
- 修改：`src/composables/useMasonryLayout.test.ts`（删 import 中 `applyMeasuredBatch,` + describe 块 126-179 行，4 用例）
- 修改：`src/components/filebrowser/MasonryView.vue`（triggerDimensionPrefetch 上方过时注记）
- 修改：`DESIGN.md` §16.2、`AGENTS.md` 状态表

- [ ] **步骤 1：删除孤儿函数与用例**

`useMasonryLayout.ts`：整体删除 `export interface AnchorParams {...}` 与 `export function applyMeasuredBatch(...)`（含 doc 注释）。锚点导出（`MasonryViewportAnchor` / `captureMasonryViewportAnchor` / `captureMasonryViewportAnchorLoose` / `restoreMasonryViewportAnchor`）**保留**。

`useMasonryLayout.test.ts`：import 行删 `applyMeasuredBatch,`；删除其 describe 整块。

- [ ] **步骤 2：更新 MasonryView 过时注记**

`triggerDimensionPrefetch` 块上方注释段中：

```ts
// 尺寸收敛期间的视觉跳动不在锚定覆盖范围内（resize anchor 只挂在 ResizeObserver 上）；
// 测量批次到达的渐进收敛是预期表现，视口补偿属后续独立模块（DESIGN §16.2 G 项）。
```

改为：

```ts
// 尺寸收敛期间的视口稳定由 commitMeasuredMap 锚定补偿保证（§16.2 G 项，2026-09-03）：
// 估算→真实的占位收敛仍会发生（卡片内部变高变矮），但视口顶线内容不再被推走。
```

- [ ] **步骤 3：全量验证**

```bash
npm run type-check && npm test -- --run
```
预期：type-check 0 error；全绿。用例数变化：+16（任务 1-5：5+1+1+5+4）−4（删除）净 +12，按当时实际基线记录。

- [ ] **步骤 4：实机 E2E 复测（探针 v4：用户输入判定静止 + 固定锚点初始基线累计漂移 + 锚丢失记录）**

**原理（rev4 P2 修正）**：程序写 scrollTop 是本修复的核心动作——不能用「scrollTop 变了」判定用户在滚（会把欠补偿重置窗口隐藏掉）。静止判定只认**用户输入事件**；静止期固定锚点卡，以**进入静止时的初始位置为基线**记累计漂移 `maxAbsDrift`（每帧更新基线会把 5px×N 的累计欠补偿漏掉）；锚点卡消失记 `anchorLost`（虚拟窗口回收/布局巨变），不静默换锚。

**验收条件：`maxAbsDrift ≤ 8 && anchorLost.length === 0`（三轮全过）。**

dev 实例（9222）进同一截图目录瀑布流，装探针：

```js
() => {
  const scroller = document.querySelector('.masonry-container');
  const strip = scroller.firstElementChild;
  const P = window.__idleProbe = { maxAbsDrift: 0, drifts: [], anchorLost: [], anchorPath: null, anchorTop: null, lastInputAt: 0 };
  const markInput = () => { P.lastInputAt = performance.now(); P.anchorPath = null; P.anchorTop = null; };
  // 静止判定只认用户输入：wheel / 指针按下（含滚动条拖拽）/ 键盘 / 触控。程序写 scrollTop 不重置。
  for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) {
    scroller.addEventListener(ev, markInput, { passive: true, capture: true });
  }
  const findCard = (path) => [...strip.children].find((c) => c.dataset && c.dataset.path === path) ?? null;
  const pickAnchor = () => { // 对齐 capture 语义：穿顶线取 top 最大；无相交取 bottom 最大（loose）
    let cross = null, crossTop = -Infinity, above = null, aboveB = -Infinity;
    for (const c of strip.children) {
      if (!c.dataset || !c.dataset.path) continue;
      const r = c.getBoundingClientRect();
      if (r.top <= 2 && r.bottom > 2 && r.top > crossTop) { cross = c; crossTop = r.top; }
      if (r.bottom <= 2 && r.bottom > aboveB) { above = c; aboveB = r.bottom; }
    }
    return cross ?? above;
  };
  const loop = () => {
    if (performance.now() - P.lastInputAt >= 150) {
      if (P.anchorPath !== null) {
        const c = findCard(P.anchorPath);
        if (!c) {
          P.anchorLost.push({ path: P.anchorPath.slice(-40), at: Math.round(performance.now()) });
          P.anchorPath = null; P.anchorTop = null;
        } else {
          // 基线不随帧更新：累计漂移对初始锚定位置计量（rev4）——连续多次小漂移也暴露
          const drift = c.getBoundingClientRect().top - P.anchorTop;
          P.maxAbsDrift = Math.max(P.maxAbsDrift, Math.abs(drift));
          if (Math.abs(drift) > 8) P.drifts.push({ path: P.anchorPath.slice(-40), driftPx: Math.round(drift), scrollTop: Math.round(scroller.scrollTop) });
        }
      }
      if (P.anchorPath === null) {
        const c = pickAnchor();
        if (c) { P.anchorPath = c.dataset.path; P.anchorTop = c.getBoundingClientRect().top; }
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'probe v4 on — 快滚 2-3 屏停手 3 秒 ×3 轮（期间勿动鼠标键盘），读 window.__idleProbe';
}
```

操作：快速滚 2-3 屏 → 停手 3 秒（批到达期，勿动输入设备）→ 重复 3 轮 → 读 `__idleProbe`。
判定：`maxAbsDrift ≤ 8`（欠补偿/多补偿在静止期对初始基线累计暴露）且 `anchorLost` 为空（锚点卡在顶线可见区，正常不应消失）。

- [ ] **步骤 5：文档收口 + Commit + push**

`DESIGN.md` §16.2「像素级 scrollTop 锚定补偿保留（avgRatio 全局漂移并入考量，观察守卫效果后另立项）」改为销账注记（已交付；锚定法覆盖列重排与 gap 位置；闭包批次 + resize 双向让位 + guardKey/seq 守卫；E2E 探针 v4 口径）。`AGENTS.md` 状态表追加一行。然后：

```bash
git add src/composables/useMasonryLayout.ts src/composables/useMasonryLayout.test.ts src/components/filebrowser/MasonryView.vue DESIGN.md AGENTS.md
git commit -m "chore(masonry): 删孤儿 applyMeasuredBatch + §16.2 G 项销账收口"
git push github main
```

---

## 自检记录

1. **规格覆盖度**：rev4 三轮复审 3 项——提交先于 nextTick 注册（任务 2 实现重排 + 注释说明 Vue 调度器语义；切目录守卫用例由空转变为真判别）✓；目录切换同步失效 resize 锚（任务 2 watcher 扩展 + 任务 4 第 4 用例）✓；探针 v4 累计漂移（任务 6 步骤 4，初始基线不随帧更新，验收 `maxAbsDrift ≤ 8 && anchorLost.length === 0`）✓。rev4 补丁（四轮复审）2 项——prefetchPathsMock 响应化（任务 2 步骤 1，header 两用例的触发前提）✓；resize 开始失效 pending 测量批（任务 2 RO 回调 + 任务 4 第 5 用例，scrollTop 写次数=1 锁单一写入者，「单一恢复源」双向闭环）✓。rev3 五项（必败用例/闭包批次/resize 让位/max-bottom/输入判静止）保持。
2. **占位符扫描**：全部代码步骤含完整代码，无 TODO/待定/笔误留白。
3. **类型一致性**：`MasonryViewportAnchor.belowOffset?` 扩展后 resize 严格路径（ratio-only 锚）经 restore 分流行为不变；`captureMasonryViewportAnchorLoose` 与严格版签名一致（max-bottom 语义）；`commitMeasuredMap` 引用的 `resizeAnchor`/`resizeSeq`/`restoreResizeAnchor` 为同组件作用域既有标识（task-21 块）；`MasonryItem` 造数字段（path/width/height/top/left/col）与接口（`useMasonryLayout.ts:15-22`）一致；测试 `fakeLayoutMap` shim 保持 `.current` API；`layoutParams.current.measuredMap` 泵观察点与组件传参（`MasonryView.vue:181`）一致；`fireResize`/`FakeResizeObserver`/`clearResizeCbs` 复用文件既有 hoisted 基建（task-21 测试块）。
