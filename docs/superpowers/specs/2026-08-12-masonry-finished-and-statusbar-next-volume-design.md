# 瀑布流滚到底算读完 + 底栏下一卷 + StatusBar 布局优化

**日期**: 2026-08-12
**前置模块**: v0.1.0-module3.1.0-path-identity
**状态**: 设计阶段（待用户审查）

---

## 0. 背景与动机

当前瀑布流浏览与「已读」状态脱节：

1. **滚到底不算读完** — `useMasonryBrowsePosition.recordCurrentTop` 永远传 `finished=undefined`（spec §2.2.2 P0 约束：masonry 不能传 finished）。用户在瀑布流里从头滚到尾看完一本，`finished` 仍为 `false`，瀑布流/书库不显示「已读」徽章。`finished` 的唯一真值来源是 reader 翻末页（`reader.ts:108/227`）或右键菜单手动重置。

2. **下一卷按钮只在工具栏** — `FileBrowser.vue:710` 的 toolbar 按钮已实现完整逻辑（`onCrossNextVolume`：flushNow → findNextVolume → 双重陈旧校验 → navigate → toast），但瀑布流用户滚到底后想继续下一卷，得把视线移回顶部工具栏。

3. **底栏右侧空置 + 路径偏右** — `StatusBar.vue` 右段是 `<div class="w-0" />`，中段 `flex-1 text-center` 因左段占位实际视觉中心偏右。

本设计同时解决这三点：新增「滚到底算读完」路径、底栏右侧下一卷入口、顺手修底栏三段布局 + 跑马灯。

---

## 1. 范围

### 做

- **A. 瀑布流滚到底 + 停留 → 写 `finished=true`**（新增 finished 写入路径，与 reader 并存）
- **B. 底栏右侧「下一卷」入口**（复用 `onCrossNextVolume`，纯展示组件 StatusBar + 预查）
- **C. StatusBar 三段等宽布局**（修路径偏右）
- **D. 下一卷卷名 hover 跑马灯**（长名展开）

### 不做（YAGNI）

- ❌ 不动 reader 的 finished 写入逻辑（reader 末页仍是 finished 真值来源之一，与瀑布流并存）
- ❌ 不改 `mark_finished` 右键菜单重置流程（重置仍走 `RowContextMenu`）
- ❌ 不做瀑布流末尾「滑入提示条」（用户确认选底栏常驻方案，放弃滚入式）
- ❌ 不做 prev（上一卷）底栏入口（toolbar 也没有，保持对称缺口）
- ❌ 不加新 settings 开关（复用现有 `recordBrowsePosition` 开关控制 finished 写入，与浏览位置写入同开关）
- ❌ 不清理存量 progress 脏数据（page=-1 等历史问题，与本设计无关）

---

## 2. 功能 A：瀑布流滚到底算读完

### 2.1 核心判定基准（关键技术决策）

**放弃「顶部可见图 = 末图」判定，改用 DOM 滚动位置。**

原因：瀑布流多列布局，各列底部不齐。按 `canonicalImageNames` 排序的末图落在某一列底部，但滚到底时视口顶线（`topmostImage` 基准）压在倒数第 2~3 行，`topmostImage === 末图` 几乎永不成立。详见 brainstorming 对话验证（layoutMap 虽全量，但 topmostImage 是视口顶部图，非末图）。

**正确基准**：容器是否滚到内容底部（DOM 原生信号，与列数无关）：
```ts
const el = containerRef;
const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
```
`BOTTOM_THRESHOLD` = 一屏高（`viewportHeight`），允许用户「接近底部」即触发，不必精确到 1px（scrollHeight 在瀑布流尺寸渐进收敛时会跳动，留一屏余量更稳）。

### 2.2 触发条件

满足以下**全部**条件 → `saveProgress` 传 `finished=true`：

1. **`atBottom`**：`scrollTop + clientHeight >= scrollHeight - viewportHeight`
2. **停留确认**：`atBottom` 状态持续 ≥ `STABLE_MS`（默认 **1200ms**），防惯性滑过末尾误触发
3. **当前未 finished**：幂等跳过（避免重复 IPC；`lastBrowseProgress.finished` 已 true 时不写）
4. **`enabled` 为 true**：复用现有 `settings.recordBrowsePosition` 开关（与浏览位置写入同开关——关了记录进度就不该标 finished）
5. **`canonicalImageNames.length > 0`**：无图目录不触发（虽然无图目录不会进瀑布流，但防御）

### 2.3 停留确认机制

不是「连续 N 次落在同一图」（那是单列思维），而是**时间阈值**（滚到底是状态，不是事件）：

```
recordCurrentTop 入口逻辑（新增）:
  if atBottom:
    if bottomSince === null: bottomSince = Date.now()   // 首次进入底部
    stableMs = Date.now() - bottomSince
    finishedNow = stableMs >= STABLE_MS
  else:
    bottomSince = null                                   // 离开底部,重置
    finishedNow = false

  // finished 单调: 只传 true, 不传 false
  const finishedParam = finishedNow ? true : undefined
  await saveProgress(bookId, page, 'single', finishedParam, imageName)
```

- `undefined` → Rust `CASE WHEN ?5 IS NULL THEN progress.finished`，保留旧值（普通滚动不碰 finished）
- `true` → 升级为已读（不会误降级）
- **永不传 `false`** → 单调「只升不降」，与 reader 末页语义一致

### 2.4 数据流

```
用户滚动 → useVirtualList scrollTop 变化
  → useMasonryBrowsePosition.scheduleRecord (300ms debounce)
    → recordCurrentTop():
        新增 atBottom 计算（需 containerEl + viewportHeight）
        计算 finishedNow（bottomSince 时间窗口）
        saveProgress(bookId, page, 'single', finishedNow?true:undefined, imageName)
          → Rust save_progress_inner UPSERT
```

### 2.5 containerEl / viewportHeight 传递

`useMasonryBrowsePosition` 当前只有 `scrollTop: Ref<number>`，没有 DOM 元素。需要新增访问滚动容器实际尺寸的途径。

**方案**：`MasonryView` 把 `containerRef`（已有，`useVirtualList` 返回）的**只读 `atBottom` 派生 ref** 传给 composable，不传 DOM 元素本身（保持 composable 可单测、不依赖 DOM）：

```ts
// MasonryView.vue 新增
const atBottom = computed(() => {
  const el = containerRef.value;
  if (!el) return false;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - el.clientHeight;
});

// 传给 useMasonryBrowsePosition
useMasonryBrowsePosition({
  ...,
  atBottom,  // 新增 prop
});
```

> **注**：`useVirtualList` 已返回 `scrollTop`、`viewportHeight`（`MasonryView:59`）。但 `scrollHeight` 不在其中——它是 DOM 实时值（布局总高度 `layout.totalHeight` 与 `el.scrollHeight` 在 absolute 定位 + 容器 padding 下可能有 px 级差异）。用 `el.scrollHeight` 最准。`atBottom` computed 在 `containerRef.value` 就绪后计算，scroll 事件触发 `scrollTop.value` 更新 → `atBottom` 重算。

### 2.6 重置时机

`bottomSince` 在以下情况清 null（避免陈旧状态误触发）：
- `start()` / `stop()`（目录切换、组件卸载）
- `atBottom` 从 true 变 false（用户滚离底部）
- resize 冷却期内（`lastResizeAt` 生效期间）—— resize 会改变 scrollHeight，旧 bottomSince 失效

### 2.7 与 reader 的协调（不变量）

两条路径都写 `finished=true`，Rust UPSERT 保证幂等：
- reader 末页 → `true`
- 瀑布流滚到底 → `true`
- 任一先到 → 永久 true，另一路径再写 true 幂等
- `image_name` 各自更新自己的（瀑布流写顶部图，reader 写当前 spread 起始图），互不覆盖（都走 `COALESCE(excluded.image_name, progress.image_name)` 保留逻辑）
- **重置**：只有右键菜单 `markFinished(false)` 能降级，瀑布流/reader 都不能降级

### 2.8 不变量清单

| # | 不变量 | 保证机制 |
|---|---|---|
| A1 | 瀑布流只写 `finished=true`，永不写 `false` | `finishedParam = finishedNow ? true : undefined` |
| A2 | 滚到底 + 停留 STABLE_MS 才写 | `bottomSince` 时间窗口 |
| A3 | 离开底部重置窗口 | `atBottom=false → bottomSince=null` |
| A4 | 目录切换/卸载重置窗口 | `start()`/`stop()` 清 `bottomSince` |
| A5 | resize 冷却期不写 finished | resize 期间 `scheduleRecord` 整体被丢弃（现有机制），finished 同样不写 |
| A6 | `recordBrowsePosition=false` 不写 finished | enabled watcher 控制 recordCurrentTop 入口（现有机制） |
| A7 | finished 已 true 不重复 IPC | 入口检查 `lastBrowseProgress.finished` 跳过 |
| A8 | atBottom 用 scrollHeight 不用 topmostImage | 绕过多列底部不齐的结构缺陷 |

---

## 3. 功能 B：底栏右侧「下一卷」入口

### 3.1 设计原则

**纯展示 + 点击组件**。StatusBar 不调 IPC、不调 store、不调 composable。所有逻辑（预查、跳转、toast）留在 FileBrowser.vue，StatusBar 只接收 props + emit `next-volume`。

### 3.2 StatusBar 新增 props（全部可选，默认不渲染右段）

```ts
interface Props {
  // ...现有: total, selectedCount, selectionSizeBytes, currentPath, itemsText
  /** 预查到的下一卷名; null=无下一卷(查完确定); undefined=未传入(不渲染右段,兼容旧调用) */
  nextVolumeTitle?: string | null;
  /** 预查中(防抖/在途),右段显示「…」或不渲染 */
  nextVolumeLoading?: boolean;
  /** 禁用点击: swapping 中 / 根目录 / 无 lastFetchedPath */
  nextVolumeDisabled?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  nextVolumeTitle: undefined,
  nextVolumeLoading: false,
  nextVolumeDisabled: false,
});

emit('next-volume');  // 点击「下一卷」
```

### 3.3 右段渲染逻辑

```
nextVolumeTitle === undefined     → 不渲染右段（兼容：FileBrowser 外的其他调用点）
nextVolumeLoading === true        → 右段「…」（灰，不可点）—— 防抖期/IPC 在途
nextVolumeTitle === null          → 「已是最后一卷」（灰，disabled=true）
nextVolumeTitle (非空 string)     → 「下一卷: vol.02 ▶」（accent hover，disabled=nextVolumeDisabled）
```

### 3.4 视觉（延续 §1.2 工具栏 token）

- 文案 `下一卷: {title}` + chevron 图标（复用 `ICON_NEXT_VOLUME` 或更简 `›`，14px）
- 默认 `text-text-muted`，hover `text-accent bg-surface-light`
- `cursor-pointer`，`px-2`，无 disabled 时 `tb-btn` 同款 transition
- 固定宽度容器（见功能 D 跑马灯）：右段整体 `max-w-[200px]`，卷名内层 truncate + hover 滚动

### 3.5 预查时机 + 防抖（FileBrowser.vue 负责）

`findNextVolume` 是 async IPC（`src/lib/tauri.ts:486`，返回 `NextVolumeResult | null`，含 `title`）。不能每次滚动/渲染都查。触发点：

- **`fb.lastFetchedPath` 变化**（进目录/切卷）→ debounce 300ms → `findNextVolume(descriptor, lastFetchedPath, 'next')` → `result?.title ?? null` 存到 `nextVolumeTitle`
- **`onCrossNextVolume` 成功跳转后** → 重新预查（换了卷，下一卷候选变了）
- **根目录 / 无 lastFetchedPath** → 不查，`nextVolumeDisabled=true`（与 toolbar 按钮同条件）

```ts
// FileBrowser.vue 新增
const nextVolumeTitle = ref<string | null | undefined>(undefined);
const nextVolumeLoading = ref(false);
let nextVolumeDebounce: ReturnType<typeof setTimeout> | null = null;

async function prefetchNextVolume() {
  const path = fb.lastFetchedPath;
  const root = masonryDescriptor.value.rootPath;
  if (!path || !root) { nextVolumeTitle.value = undefined; return; }
  nextVolumeLoading.value = true;
  try {
    const result = await findNextVolume(masonryDescriptor.value, path, 'next');
    // 陈旧校验：路径没变才采纳
    if (fb.lastFetchedPath !== path || masonryDescriptor.value.rootPath !== root) return;
    nextVolumeTitle.value = result?.title ?? null;
  } catch (e) {
    log('[FileBrowser] prefetchNextVolume failed', e);
    nextVolumeTitle.value = null;  // 出错当无下一卷处理（灰显示）
  } finally {
    nextVolumeLoading.value = false;
  }
}

watch(() => fb.lastFetchedPath, () => {
  if (nextVolumeDebounce) clearTimeout(nextVolumeDebounce);
  nextVolumeTitle.value = undefined;  // 切目录先清，防显示旧卷名
  nextVolumeDebounce = setTimeout(() => void prefetchNextVolume(), 300);
});
```

### 3.6 点击 → 复用 onCrossNextVolume

StatusBar emit `next-volume` → FileBrowser `@next-volume="onCrossNextVolume"`。**完全不新增跳转逻辑**，复用现有的 flushNow → findNextVolume → 双重陈旧校验 → navigate → toast（`FileBrowser.vue:547`）。

`onCrossNextVolume` 成功后调 `prefetchNextVolume()` 刷新右段（新卷的下一卷候选）。

### 3.7 与 toolbar 按钮的关系

两处入口并存，都调 `onCrossNextVolume`：
- toolbar 按钮（现有，`:714`）：`disabled="swapping || !fb.rootPath || !fb.lastFetchedPath"`，无预查，纯文字「下一卷」
- 底栏右段（新增）：带预查卷名 + 「已是最后一卷」状态，更信息丰富

**有意差异**（与 shortcut 独立页面同思路）：toolbar 是简洁触发器，底栏是带上下文的入口。不删 toolbar（用户已习惯顶部入口）。

---

## 4. 功能 C：StatusBar 三段等宽布局

### 4.1 现状问题

```
左(shrink-0 auto)  +  中(flex-1 text-center)  +  右(w-0)
```
右段零宽，中段占满「左段右边界 → footer 最右」，路径在这个大区域 `text-center` → 视觉中心 = footer 中心 + 左段宽度/2 → **偏右**。左段越宽偏越多。

### 4.2 改法：三段 flex-1

```html
<footer class="statusbar ... flex items-center ...">
  <!-- Left: flex-1, 左对齐 -->
  <div class="flex-1 flex items-center gap-3 min-w-0 justify-start">...</div>
  <!-- Center: flex-1, 居中 -->
  <div class="flex-1 flex items-center justify-center min-w-0 px-2">...</div>
  <!-- Right: flex-1, 右对齐 -->
  <div class="flex-1 flex items-center justify-end min-w-0">...</div>
</footer>
```

三段各占 1/3，路径 `text-center` 落在 footer 视觉正中。左段 items / 右段下一卷对称占位。

### 4.3 副作用：路径段缩窄

路径段从「~60%」缩到「1/3」。长路径更早 truncate。缓解：
- `truncate` + `:title="currentPath"`（hover 提示全名，现有）
- 1/3 宽度在常见 1280px 窗口约 400px，足够显示 `D:/comics/作者/作品名/vol01`

### 4.4 不变量

- 左段 `items + selected` 内容不变，只是从 `shrink-0` 改 `flex-1 justify-start`
- 中段路径 `truncate + title` 不变，宽度收窄
- 右段从 `w-0` → `flex-1 justify-end`，无下一卷时渲染空 div（保持三段对称，路径仍居中）

---

## 5. 功能 D：下一卷卷名 hover 跑马灯

### 5.1 触发

固定宽度容器 `max-w-[200px]`，卷名溢出时：默认 `truncate` 省略号，**hover 时**启动 CSS `animation: translateX` 滚动展开全文，离开停止。

### 5.2 实现（scoped CSS）

```css
/* 右段卷名容器 */
.next-volume-name {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  position: relative;
}
.next-volume-name span {
  display: inline-block;
}
/* hover 时滚动：从右往左平移，停在能看到结尾的位置 */
.next-volume-name:hover span {
  animation: marquee-scroll 4s linear forwards;
}
@keyframes marquee-scroll {
  /* 0% 起始; 100% 平移到 (容器宽 - 文本宽) 即左边界对齐文本结尾可见 */
  /* 具体 px 由 JS 测量后设 CSS 变量 --marquee-offset，或用 transform: translateX(-100%) + 容器滚动 */
}
```

> **实现注**：纯 CSS `translateX(-100%)` 会把文本完全推到容器外。精确做法是 JS 测量 `scrollWidth - clientWidth` 作为滚动距离，设成 CSS 变量 `--marquee-offset`。hover 时 `transform: translateX(calc(-1 * var(--marquee-offset)))` + `transition: transform 4s linear`。不溢出时（`scrollWidth <= clientWidth`）不触发（检测后不加 hover class）。

### 5.3 不变量

- 不溢出时 hover 无效果（不无意义滚动）
- 离开 hover 文本回到 truncate 状态（不留在滚动末位置）
- 不影响点击（hover 与 click 独立，整个右段可点）

---

## 6. 数据流总览

```
┌─ 功能 A (finished) ──────────────────────────────────────────┐
│ 滚动 → scrollTop → scheduleRecord (300ms debounce)           │
│   → recordCurrentTop:                                        │
│       atBottom (computed, el.scrollHeight)                   │
│       bottomSince 时间窗口 → finishedNow                     │
│       saveProgress(bookId, page, 'single', true|undefined,   │
│                     imageName)                               │
│         → Rust UPSERT (CASE WHEN ?5 IS NULL 保留 / ELSE 升级)│
└──────────────────────────────────────────────────────────────┘

┌─ 功能 B (底栏下一卷) ────────────────────────────────────────┐
│ lastFetchedPath 变化 → debounce 300ms                        │
│   → findNextVolume → nextVolumeTitle 缓存                     │
│ StatusBar 右段渲染 (title|null|loading|undefined)             │
│ 点击 → emit next-volume → onCrossNextVolume (复用)            │
│   → flushNow + findNextVolume + 陈旧校验 + navigate + toast   │
│   → prefetchNextVolume 刷新右段                              │
└──────────────────────────────────────────────────────────────┘

┌─ 功能 C/D (纯 CSS, StatusBar scoped) ─────────────────────────┐
│ 三段 flex-1 等宽 → 路径居中                                   │
│ 右段 max-w-[200px] + hover translateX → 跑马灯               │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. 测试矩阵

### 7.1 功能 A（useMasonryBrowsePosition.test.ts 新增）

| # | 场景 | 预期 |
|---|---|---|
| A-T1 | atBottom + 停留 ≥ STABLE_MS + 未 finished | saveProgress 传 `finished=true` |
| A-T2 | atBottom 但停留 < STABLE_MS | saveProgress 传 `finished=undefined`（不升级） |
| A-T3 | 滚离底部（atBottom false） | `bottomSince` 重置；saveProgress 传 `undefined` |
| A-T4 | 已 finished=true 再滚到底 | 不调 saveProgress（幂等跳过） |
| A-T5 | `enabled=false`（recordBrowsePosition 关） | 不写 finished（recordCurrentTop 入口被拦） |
| A-T6 | 目录切换（start 重置） | `bottomSince` 清 null |
| A-T7 | resize 冷却期内 atBottom | 不写 finished（scheduleRecord 整体丢弃） |
| A-T8 | 多列底部不齐（末图在某列底） | 用 atBottom(scrollHeight) 判定，不依赖末图位置 |

实现要点：`atBottom` 作为可注入的 `Ref<boolean>` 参数（测试传 mock ref），不直接依赖 DOM，保证 composable 可单测。

### 7.2 功能 B（FileBrowser.test.ts + StatusBar 单测新增）

| # | 场景 | 预期 |
|---|---|---|
| B-T1 | lastFetchedPath 变化 → debounce → findNextVolume 返回 title | nextVolumeTitle=该 title，StatusBar 右段显示 |
| B-T2 | findNextVolume 返回 null | nextVolumeTitle=null，右段「已是最后一卷」灰 |
| B-T3 | 切目录在途时又切（陈旧） | 旧 IPC 结果丢弃（路径校验），不显示旧卷名 |
| B-T4 | 点击右段 → emit next-volume → onCrossNextVolume | 复用现有测试（flushNow+findNextVolume+navigate） |
| B-T5 | 跳转成功 → prefetchNextVolume 刷新 | 新卷的下一卷名更新到右段 |
| B-T6 | 根目录 / 无 lastFetchedPath | nextVolumeDisabled=true，右段灰 |
| B-T7 | StatusBar 不传 nextVolumeTitle（undefined） | 右段不渲染（兼容旧调用点） |
| B-T8 | nextVolumeLoading=true | 右段「…」灰 |

### 7.3 功能 C/D（StatusBar 视觉，happy-dom 难测动画，主要验 DOM 结构）

| # | 场景 | 预期 |
|---|---|---|
| C-T1 | 三段都有内容 | footer 含 3 个 `flex-1` 子元素，中段 `justify-center` |
| C-T2 | 右段无下一卷（undefined） | 右段渲染空 div（保持 flex-1 对称） |
| D-T1 | 卷名短（不溢出） | 无 hover 滚动 class |
| D-T2 | 卷名长（溢出） | hover 时加滚动 class（验 class 存在即可，动画像素难测） |

### 7.4 现有用例回归

- `useMasonryBrowsePosition.test.ts` 现有用例（普通滚动写 image_name、flushNow、jumpToLast、enabled 开关、resize 冷却）必须全绿——功能 A 是**叠加**在现有 recordCurrentTop 上，不改变普通滚动行为（`finished=undefined` 分支与现状等价）。
- `FileBrowser.test.ts` 现有 `onCrossNextVolume` 4 用例（flushNow 转发、findNextVolume null、swapping 守卫、双重陈旧校验）必须全绿——功能 B 不改 onCrossNextVolume，只加 StatusBar 入口。
- i18n 双语：新增 `fileBrowser.statusBar.nextVolume` / `noNextVolume` / `nextVolumeLoading` 等 key，zh-CN + en-US 同步。

---

## 8. i18n 新增 key

```ts
// zh-CN.ts / en-US.ts fileBrowser.statusBar 下新增:
nextVolume: '下一卷: {title}' / 'Next: {title}'   // 带卷名占位
noNextVolume: '已是最后一卷' / 'Last volume'
nextVolumeLoading: '…' / '…'                       // 或用图标 spinner
```

> 注：`fileBrowser.nextVolume`（toolbar 用，无占位）已存在（`zh-CN.ts:172`），不冲突——底栏用 `fileBrowser.statusBar.nextVolume`（带 `{title}` 占位）。

---

## 9. 实现顺序建议（给 writing-plans）

1. **C 先行（纯 CSS，零风险）** — StatusBar 三段等宽，立即修路径偏右，独立可测。
2. **D 次之（纯 CSS）** — 跑马灯 scoped CSS + JS 测量，依赖右段容器存在（C 之后）。
3. **B 主体** — StatusBar props/emit + FileBrowser 预查 + 复用 onCrossNextVolume。
4. **A 最后（逻辑最重）** — useMasonryBrowsePosition atBottom + bottomSince + finished 单调写。

每步独立 commit + 测试，A/B/C/D 可拆成 4 个里程碑或合并为一个 tag（按 §5.1 模块约定）。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| scrollHeight 在尺寸渐进收敛时跳动，atBottom 抖动 | BOTTOM_THRESHOLD = 一屏高（viewportHeight），留余量；停留确认 STABLE_MS 进一步过滤抖动 |
| finished 误标（用户只是滚到底看了一眼没真读） | STABLE_MS=1200ms 停留阈值；可调；右键菜单仍可重置 |
| 路径段缩到 1/3 太窄 | truncate + title hover 提示；常见路径长度够用；用户可调窗口宽度 |
| 预查 IPC 增加请求 | debounce 300ms + 仅 lastFetchedPath 变化触发；成本可控 |
| 跑马灯 JS 测量 scrollWidth 在 happy-dom 测不准 | 视觉测试仅验 class 存在，像素动画靠本地真机验证 |

---

## 11. 开放问题（实现时再定，不阻塞设计）

- `STABLE_MS` 最终值（1200ms 是建议，实现后本地实测可调 800~2000ms）
- `BOTTOM_THRESHOLD` 用 `viewportHeight` 还是固定 px（建议 viewportHeight，跨分辨率自适应）
- 跑马灯滚动时长（建议按文本长度线性，4s 是默认）
- 是否给底栏下一卷加键盘快捷键（toolbar 的 Alt+→ 已覆盖 reader，底栏是否需要独立快捷键——YAGNI 暂不加）
