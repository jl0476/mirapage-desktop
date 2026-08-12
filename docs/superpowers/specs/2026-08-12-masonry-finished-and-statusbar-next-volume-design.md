# 瀑布流滚到底算读完 + 底栏下一卷 + StatusBar 布局优化

**日期**: 2026-08-12（2026-08-13 修订 v2：代码审查 P0×2 + P1×3 + P2×2；v3：审查 P1×2 + P2×1）
**前置模块**: v0.1.0-module3.1.0-path-identity
**状态**: 设计阶段（待用户审查 v3）

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

**正确基准**：容器是否滚到内容底部（DOM 原生信号，与列数无关），但**必须防短目录误判**（审查 P1-b）：
```ts
const el = containerRef;
const sh = el.scrollHeight, ch = el.clientHeight, st = el.scrollTop;
const BOTTOM_THRESHOLD_PX = 64;   // 固定小阈值:接近真实底部
// 长目录:贴底(64px 余量);短目录(<2 屏):必须用户实际滚动过(st>0)且贴底
const nearBottom = st + ch >= sh - BOTTOM_THRESHOLD_PX;
const shortDir = sh < 2 * ch;
const atBottom = nearBottom && (!shortDir || st > 0);
```

**为什么不用「一屏阈值」**：审查指出 `scrollTop + clientHeight >= scrollHeight - viewportHeight` 在短目录（如 8 张图、总高 1 屏多）下，用户**在顶部**（`scrollTop=0`）就满足 `0 + 800 >= 1400 - 800 → 800 >= 600 → true`，进目录停留即误标 finished。短目录约束 `!shortDir || st > 0` 保证：内容 <2 屏时必须用户**实际向下滚过**（`scrollTop > 0`）才算——在顶部不动不触发。

**64px 固定阈值的理由**：scrollHeight 在尺寸渐进收敛时跳动的余量，由 STABLE_MS 停留确认时间窗兜底（跳动会在 1200ms 内稳定），不需要一屏那么大的 px 余量。64px ≈ 半行卡片高，语义是「最后一行已基本可见」。

> **atBottom 作为可注入 Ref**：MasonryView 计算 `atBottom` computed（含短目录约束）传入 composable。测试用 `ref(false)` 手动翻转，不依赖 DOM（§7.1 A-T11）。

### 2.2 触发条件

满足以下**全部**条件 → `saveProgress` 传 `finished=true`：

1. **`atBottom`**：§2.1 定义（贴底 64px + 短目录须 `scrollTop>0`）
2. **停留确认**：`atBottom` 状态持续 ≥ `STABLE_MS`（默认 **1200ms**），防惯性滑过末尾误触发
3. **当前未 finished**：幂等跳过（避免重复 IPC；见 §2.7 缓存单调性，不能依赖会被覆盖的本地缓存——改用 `recordCurrentTop` 入口读 DB 真值或单调保留的缓存）
4. **`enabled` 为 true**：`recordCurrentTop` **入口**守卫 `if (!params.enabled.value) return;`（不仅是 watcher 层）。复用现有 `settings.recordBrowsePosition` 开关——关了记录进度就不该标 finished。`flushNow`（跨卷前 flush）也走同一入口，故 enabled=false 时 flush 也不写。
5. **`canonicalImageNames.length > 0`**：无图目录不触发（虽然无图目录不会进瀑布流，但防御）

> **审查 P1-2 修复**：`recordCurrentTop` 入口必须显式检查 `params.enabled.value`。现有实现只在 watcher 层（`enableWatcher/disableWatcher`）控制 `scheduleRecord`，但 `flushNow` 绕过 watcher 直接调 `recordCurrentTop`，导致 enabled=false 时跨卷前 flush 仍写普通进度。入口守卫是唯一可靠保证，watcher 层保留为优化（减少不必要的 schedule）。

### 2.3 停留确认机制（状态机）

**不是「连续 N 次落在同一图」**（那是单列思维，且现有 scroll watcher 在用户停下后不再触发，计数永远卡住），而是**定时器 + 时间窗口**。

#### 问题：scroll watcher 不持续触发

现有 `enableWatcher`（`useMasonryBrowsePosition.ts:247`）监听 `[scrollTop, entries.length]` 变化。用户滚到底后**完全不动**，watcher 不再 fire，`recordCurrentTop` 不再被调。若只在 watcher 回调里记 `bottomSince`，`stableMs` 永远停在 ~0，A-T1 物理上无法成立。

#### 解法：进入底部时调度 stableTimer

```
recordCurrentTop 入口逻辑（新增,在现有去重判定之前）:
  const atBottom = params.atBottom.value

  if (atBottom):
    if (bottomSince === null):
      bottomSince = Date.now()
      scheduleStableTimer()           // 调度 STABLE_MS 后的升级判定
      finishedNow = false             // 首次到底,先写普通进度
    else:
      stableMs = Date.now() - bottomSince
      finishedNow = stableMs >= STABLE_MS
  else:
    clearStableTimer()
    bottomSince = null
    finishedNow = false

  // finished 单调: 只传 true, 不传 false(详见 §2.7)
  const finishedParam = finishedNow ? true : undefined
  // ... saveProgress(bookId, page, 'single', finishedParam, imageName) ...

  // 升级写入失败/被拒(writeSeq 丢弃、ensureBookId 失败、bookId==null)的兜底:
  // 若仍在底部且尚未成功 finished,必须能再次调度确认,否则永久卡住。
  // 由 scheduleStableTimer 内部 "timer 引用为 null 才调度" 守护(见下方不变量)。
```

#### scheduleStableTimer / clearStableTimer（封装 + 置空语义）

```ts
function scheduleStableTimer(): void {
  if (stableTimer !== null) return;        // 已有在途 timer,不重复调度(不变量守护)
  stableTimer = setTimeout(() => {
    stableTimer = null;                     // ← 审查 P1-a:回调开始立即置空
    void recordCurrentTop();                // 重读 atBottom(bottomSince 非空分支)
  }, STABLE_MS);
}

function clearStableTimer(): void {
  if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
  bottomSince = null;                       // 连带清 bottomSince(不变量:timer≠null ⇒ bottomSince≠null)
}
```

**timer 回调置空的必要性（审查 P1-a）**：若回调不置空，升级写入因竞态被拒（`writeSeqAtEntry !== activeWriteSeq`）或失败（ensureBookId/bookId==null）后，`stableTimer` 引用仍在 → `scheduleStableTimer` 的 `if (stableTimer !== null) return` 守护使其不再调度 → 永久卡在「已到底、未 finished、无 timer」状态。

回调置空后，`recordCurrentTop` 在 `atBottom && bottomSince !== null` 分支重算 `finishedNow`；若本次仍因竞态/失败未成功 finished，需重新调度确认。**关键**：`recordCurrentTop` 的 saveProgress 之后（成功或失败），若 `atBottom && !已finished`，应再调 `scheduleStableTimer()`——但 `bottomSince` 已非 null，timer 已置空，`scheduleStableTimer` 会重新排上。这条「失败重试」由 `scheduleStableTimer` 的置空守护自然支撑。

#### stableTimer 生命周期不变量（审查 P2）

```
stableTimer !== null  ⇒  bottomSince !== null  ⇒  当前 atBottom = true
```

三段蕴含保证不会出现「timer 已执行但引用仍在」或「bottomSince 已清但 timer 还在」的半状态。所有改变 `atBottom` / `bottomSince` 的出口必须经 `clearStableTimer()`（它会连带清 bottomSince）。

#### 关键时序

1. 用户滚到底 → scroll watcher fire → `scheduleRecord`(300ms debounce) → `recordCurrentTop` 第 1 次：`atBottom=true`、`bottomSince=null` → 记 `bottomSince`、`scheduleStableTimer()`、本次写 `finished=undefined`（普通进度，Rust 保留旧 finished）
2. 用户保持不动 STABLE_MS → stableTimer 回调（置空 timer）触发 `recordCurrentTop` 第 2 次：`atBottom=true`、`bottomSince≠null`、`stableMs≥STABLE_MS` → `finishedNow=true` → 写 `finished=true`（升级，单调）
3. 用户离开底部 → scroll watcher fire → `scheduleRecord` → `recordCurrentTop`：`atBottom=false` → `clearStableTimer()`（清 timer + bottomSince）、`finishedNow=false` → 写 `finished=undefined`（保留，不降级）
4. **升级失败**（竞态/IPC 错误）→ saveProgress 后仍在底部且未 finished → `scheduleStableTimer()`（timer 已置空）重排 → STABLE_MS 后再试（审查 P1-a 失败重试用例）

#### stableTimer 的清理出口（必须全覆盖）

`stableTimer` 在以下 **5 个出口**都要 `clearTimeout`，漏一处则漏写或写陈旧：

| 出口 | 位置 | 原因 |
|---|---|---|
| 离开底部（atBottom false） | `recordCurrentTop` else 分支 | 用户滚走了，停留中断 |
| `start()` 重置 | `start()` 开头 | 目录切换，旧 timer 失效 |
| `stop()` | `stop()` 开头 | 卸载/切目录 |
| `disableWatcher()` | `disableWatcher()` 内 | enabled=false，停止记录 |
| resize 冷却触发 | `scheduleRecord` resize 分支 / colWidth watcher | scrollHeight 变了，旧底部判定失效 |

封装 `clearStableTimer()` helper 统一清理（同时清 timer + 置 `bottomSince=null`），所有出口调它。

#### 与现有 writeSeq / seqAtEntry 防覆盖的关系

`stableTimer` 触发的第 2 次 `recordCurrentTop` 与 scroll watcher 触发的并发时，复用现有 `seqAtEntry !== activeStartSeq` / `writeSeqAtEntry !== activeWriteSeq` 防覆盖。`start()`/`stop()` 自增 `activeStartSeq` 会让在途的 stableTimer 回调进入即 return（`seqAtEntry !== activeStartSeq`）。无需额外防护。

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

`bottomSince` 和 `stableTimer` 在以下情况清理（避免陈旧状态误触发）：
- `start()` / `stop()`（目录切换、组件卸载）—— 调 `clearStableTimer()`
- `atBottom` 从 true 变 false（用户滚离底部）—— `recordCurrentTop` else 分支调 `clearStableTimer()`
- `disableWatcher()`（enabled=false）—— 调 `clearStableTimer()`
- resize 冷却期内（`lastResizeAt` 生效期间）—— resize 会改变 scrollHeight，旧 `bottomSince` 失效，`scheduleRecord` 的 resize 分支调 `clearStableTimer()`

### 2.7 与 reader 的协调 + 缓存单调性（不变量）

#### finished 字段协调

两条路径都写 `finished=true`，Rust UPSERT 保证幂等：
- reader 末页 → `true`
- 瀑布流滚到底 → `true`
- 任一先到 → 永久 true，另一路径再写 true 幂等
- `image_name` 各自更新自己的（瀑布流写顶部图，reader 写当前 spread 起始图），互不覆盖（都走 `COALESCE(excluded.image_name, progress.image_name)` 保留逻辑）
- **重置**：只有右键菜单 `markFinished(false)` 能降级，瀑布流/reader 都不能降级

#### 前端缓存 `lastBrowseProgress.finished` 必须单调（审查 P1-1 修复）

**问题**：现有 `recordCurrentTop`（`useMasonryBrowsePosition.ts:217-224`）写入分支硬编码 `finished: false`：
```ts
lastBrowseProgress.value = { ..., finished: false };  // ← 无论 DB 真值
```
若 reader 已写 `finished=true`，瀑布流滚动到另一张图写普通进度（`finished=undefined`，DB 正确保留 true），但前端缓存被覆盖成 `false` → A7 幂等跳过失效，可能重复 IPC、错误判断状态。

**修复**：写入分支的缓存 finished 必须镜像 DB 的单调语义：
```ts
lastBrowseProgress.value = {
  ...,
  // 单调或保留：本次升级为 true 则 true；否则保留上次的 finished（DB 那边 COALESCE 也保留了）
  finished: finishedNow || lastBrowseProgress.value?.finished || false,
};
```
这样缓存与 DB 一致：只升不降，reader 写的 true 不会被瀑布流普通滚动覆盖回 false。

> **幂等跳过依据（A7）**：`recordCurrentTop` 入口判断「当前已 finished 则跳过」必须读这个**单调保留后的缓存**（或入口先查一次 `getProgress`），不能读会被 `false` 覆盖的旧缓存。

### 2.8 不变量清单

| # | 不变量 | 保证机制 |
|---|---|---|
| A1 | 瀑布流只写 `finished=true`，永不写 `false` | `finishedParam = finishedNow ? true : undefined` |
| A2 | 滚到底 + 停留 STABLE_MS 才写 | `bottomSince` 时间窗口 + `stableTimer` 调度第 2 次 recordCurrentTop |
| A3 | 离开底部重置窗口 + 取消 timer | `atBottom=false → clearStableTimer() + bottomSince=null` |
| A4 | 目录切换/卸载重置窗口 + 取消 timer | `start()`/`stop()` 调 `clearStableTimer()` |
| A5 | resize 冷却期不写 finished | resize 期间 `scheduleRecord` 整体被丢弃（现有机制）+ 调 `clearStableTimer()`，finished 同样不写 |
| A6 | `recordBrowsePosition=false` 不写任何进度（含 finished） | `recordCurrentTop` **入口** `if (!params.enabled.value) return;`（审查 P1-2），watcher 层为优化 |
| A7 | finished 已 true 不重复 IPC | 入口检查单调保留后的 `lastBrowseProgress.finished`（§2.7），跳过 |
| A8 | atBottom 用 scrollHeight 不用 topmostImage | 绕过多列底部不齐的结构缺陷 |
| A9 | **复合去重：(path, finishedParam) 同时相同才跳过**（审查 P0-1） | 现有 `if (e.path === lastWrittenPath) return` 扩展为 `if (e.path === lastWrittenPath.value && finishedParam === lastWrittenFinishedParam.value) return` |

#### A9 详解：复合去重（审查 P0-1 核心修复）

**问题**：现有 `recordCurrentTop:196` `if (e.path === lastWrittenPath.value) return;` 只按 path 去重。滚到底流程里两次 recordCurrentTop 的 `e.path`（顶部图）相同：
- 第 1 次（刚到底）：`finishedParam=undefined` → 写普通进度 → 记 `lastWrittenPath=e.path`
- 第 2 次（stableTimer 触发，停留达标）：`e.path === lastWrittenPath` → **直接 return，finished=true 永远写不进去**

**修复**：去重维度扩展为 `(path, finishedParam)`：
```ts
// recordCurrentTop 入口,在 atBottom/finishedNow 计算之后,saveProgress 之前
if (e.path === lastWrittenPath.value && finishedParam === lastWrittenFinishedParam.value) {
  return;
}
// ... saveProgress ...
lastWrittenPath.value = e.path;
lastWrittenFinishedParam.value = finishedParam;  // 新增 ref,记录上次写入的 finishedParam
```
`finishedParam` 只可能 `undefined` 或 `true`（A1），所以同一张图最多写 2 次：第 1 次 `undefined`、第 2 次升级为 `true`，之后 `(path, true)` 重复才跳过（A7 幂等）。

`lastWrittenFinishedParam` 在 `start()`/`stop()` 随 `lastWrittenPath` 一起重置为 `null`。

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
nextVolumeTitle === undefined     → 右段渲染空 div（保持三段对称，路径仍居中；兼容旧调用点）
nextVolumeLoading === true        → 右段「…」（灰，不可点）—— 防抖期/IPC 在途
nextVolumeTitle === null          → 「已是最后一卷」（灰，disabled=true）
nextVolumeTitle (非空 string)     → 「下一卷: vol.02 ▶」（accent hover，disabled=nextVolumeDisabled）
```

> **切目录不闪烁**（视觉时序）：切目录时 `nextVolumeLoading` 立即置 true（debounce 排上时就置），`nextVolumeTitle` **不**清成 undefined（否则右段消失）。即切目录期间右段始终显示「…」（loading），查完更新为 title 或 null。这样右段从「上一卷名」→「…」→「新卷名」平滑过渡，不会闪空。
> `undefined` 只用于「StatusBar 调用方完全没传该 prop」的兼容场景（其他调用点），FileBrowser 内部不主动设 undefined。

### 3.3.1 nextVolumeDisabled 绑定（审查 P2-1）

FileBrowser 把以下状态绑定到 StatusBar，避免「显示可点击但上层守卫忽略」：

```vue
<StatusBar
  ...
  :next-volume-title="nextVolumeTitle"
  :next-volume-loading="nextVolumeLoading"
  :next-volume-disabled="swapping || !fb.rootPath || !fb.lastFetchedPath"
  @next-volume="onCrossNextVolume"
/>
```

- `swapping`：onCrossNextVolume 跳转中（复用现有 ref）
- `!fb.rootPath || !fb.lastFetchedPath`：根目录/未加载不能作「卷」起点（与 toolbar 按钮 `:718` 同条件）
- `nextVolumeLoading` 不并入 disabled（loading 时 StatusBar 自身按 §3.3 渲染「…」灰，不靠 disabled）

### 3.4 视觉（延续 §1.2 工具栏 token）

- 文案 `下一卷: {title}` + chevron 图标（复用 `ICON_NEXT_VOLUME` 或更简 `›`，14px）
- 默认 `text-text-muted`，hover `text-accent bg-surface-light`
- `cursor-pointer`，`px-2`，无 disabled 时 `tb-btn` 同款 transition
- 固定宽度容器（见功能 D 跑马灯）：右段整体 `max-w-[200px]`，卷名内层 truncate + hover 滚动

### 3.5 预查时机 + 防抖 + 请求序号（FileBrowser.vue 负责）

`findNextVolume` 是 async IPC（`src/lib/tauri.ts:486`，返回 `NextVolumeResult | null`，含 `title`）。不能每次滚动/渲染都查。触发点：

- **`fb.lastFetchedPath` 变化**（进目录/切卷）→ debounce 300ms → `findNextVolume` → `result?.title ?? null` 存到 `nextVolumeTitle`
- **`onCrossNextVolume` 成功跳转后** → 重新预查（换了卷，下一卷候选变了）
- **根目录 / 无 lastFetchedPath** → 不查，`nextVolumeDisabled=true`（与 toolbar 按钮同条件）

#### 请求序号防陈旧（审查 P1-3 核心）

**问题**：初版预查代码的陈旧校验只在 `try` 成功路径做（`if (path !== ...) return`），`catch` 无条件 `nextVolumeTitle.value = null`、`finally` 无条件 `nextVolumeLoading.value = false`。旧目录的请求晚返回并失败时，会把新目录的 loading 提前关掉、title 覆盖成「最后一卷」。

**修复**：模块级请求序号 `nextVolumeRequestSeq`，成功/失败/finally **三分支都校验**：

```ts
// FileBrowser.vue 新增
const nextVolumeTitle = ref<string | null | undefined>(undefined);
const nextVolumeLoading = ref(false);
let nextVolumeDebounce: ReturnType<typeof setTimeout> | null = null;
let nextVolumeRequestSeq = 0;

async function prefetchNextVolume() {
  const path = fb.lastFetchedPath;
  const root = masonryDescriptor.value.rootPath;
  if (!path || !root) { nextVolumeTitle.value = null; return; }
  const seq = ++nextVolumeRequestSeq;   // ← 本次请求的唯一序号
  nextVolumeLoading.value = true;
  try {
    const result = await findNextVolume(masonryDescriptor.value, path, 'next');
    if (seq !== nextVolumeRequestSeq) return;   // 成功路径:陈旧则丢弃
    nextVolumeTitle.value = result?.title ?? null;
  } catch (e) {
    if (seq !== nextVolumeRequestSeq) return;   // 失败路径:陈旧则丢弃(不覆盖新目录)
    log('[FileBrowser] prefetchNextVolume failed', e);
    nextVolumeTitle.value = null;
  } finally {
    if (seq === nextVolumeRequestSeq) {         // finally:仅当仍是最新请求才关 loading
      nextVolumeLoading.value = false;
    }
  }
}

watch(() => fb.lastFetchedPath, () => {
  if (nextVolumeDebounce) clearTimeout(nextVolumeDebounce);
  // 切目录立即置 loading(不设 undefined,右段显示「…」不闪空,见 §3.3)
  nextVolumeLoading.value = true;
  nextVolumeDebounce = setTimeout(() => void prefetchNextVolume(), 300);
});
```

**关键**：每次进入 `prefetchNextVolume` `++nextVolumeRequestSeq`，新请求自然作废旧请求（旧请求的 `seq !== nextVolumeRequestSeq` 永真）。三分支任何一处先返回，只要不是最新序号就静默 return，不碰 `nextVolumeTitle` / `nextVolumeLoading`。

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

### 7.1 功能 A（useMasonryBrowsePosition.test.ts 新增，**用 fake timers 验证时序**）

| # | 场景 | 预期 |
|---|---|---|
| A-T1 | 滚到底（atBottom=true）→ 停留 < STABLE_MS | 第 1 次 recordCurrentTop 写 `finished=undefined`；stableTimer 已调度但未到时不升级 |
| A-T2 | 滚到底 → 停留 ≥ STABLE_MS（推进 fake timer） | stableTimer 触发第 2 次 recordCurrentTop 写 `finished=true`（A9 复合去重放行：同 path 但 finishedParam 从 undefined→true） |
| A-T3 | 已 finished=true 再滚到底 | 入口 A7 检查单调缓存跳过，**不调 saveProgress** |
| A-T4 | 滚到底后离开（atBottom false） | clearStableTimer 取消在途 timer；saveProgress 传 `undefined`（不降级） |
| A-T5 | 滚到底→调度 stableTimer→中途离开→再回来 | 第 1 次离开清 timer；第 2 次到底重新记 bottomSince + 重调 stableTimer（重新计 STABLE_MS） |
| A-T6 | 目录切换（start 重置） | `bottomSince`/`stableTimer`/`lastWrittenPath`/`lastWrittenFinishedParam` 全清 |
| A-T7 | resize 冷却期内 atBottom | scheduleRecord 整体被丢弃 + clearStableTimer；不写 finished |
| A-T8 | resize 冷却期触发时已有 stableTimer 在途 | stableTimer 被取消（不漏写也不写陈旧） |
| A-T9 | `enabled=false`（recordBrowsePosition 关） | recordCurrentTop 入口 return（A6）；**flushNow 也走入口，enabled=false 时不写**（审查 P1-2） |
| A-T10 | reader 已写 finished=true，瀑布流滚到另一张普通图 | saveProgress 传 undefined（DB 保留 true）；**前端缓存 finished 仍为 true**（审查 P1-1，A7 基础） |
| A-T11 | 多列底部不齐（末图在某列底） | atBottom 用 scrollHeight 判定成立（A8），不依赖末图位置 |
| A-T12 | **短目录顶部不误判**（审查 P1-b）：`scrollTop=0` 且 `scrollHeight < 2*clientHeight` | atBottom=false（短目录须 `scrollTop>0`）；不调度 stableTimer、不写 finished |
| A-T13 | **短目录滚到底**：短目录用户向下滚（`scrollTop>0`）并贴底 | atBottom=true，正常走停留确认 → finished |
| A-T14 | **升级失败后能重试**（审查 P1-a）：第 2 次 recordCurrentTop 因 writeSeq 丢弃/IPC 失败未写成 finished | stableTimer 已置空 → 仍在底部时重新调度 → STABLE_MS 后再试，最终写成 finished |
| A-T15 | stableTimer 生命周期不变量（审查 P2）：`stableTimer≠null ⇒ bottomSince≠null ⇒ atBottom=true` | 任一上游状态变化（离开底部/start/stop/disableWatcher/resize）都经 clearStableTimer，无半状态 |

**测试实现要点**：
- `atBottom` 作为可注入的 `Ref<boolean>` 参数（测试用 `ref(false)` 手动翻转），不直接依赖 DOM。**A-T12/A-T13 的短目录约束在 MasonryView 的 atBottom computed 内**——composable 单测直接翻转 atBottom ref 即可（短目录逻辑由 MasonryView 单测覆盖，验 computed 输出）
- 用 `vi.useFakeTimers()` + `vi.advanceTimersByTime(STABLE_MS + 1)` 推进 stableTimer，验证第 2 次升级写入
- `saveProgress` mock 成 `vi.fn()`，断言第 N 次调用的第 4 参数（finished）为 `undefined` 或 `true`
- A-T3/A-T10 验证「不调 saveProgress」用 `expect(saveProgress).not.toHaveBeenCalled()` 或调用次数不变
- A-T14 验证 timer 置空 + 重调：mock saveProgress 第 2 次抛错，断言第 3 次仍被调（重试）

### 7.2 功能 B（FileBrowser.test.ts + StatusBar 单测新增）

| # | 场景 | 预期 |
|---|---|---|
| B-T1 | lastFetchedPath 变化 → debounce → findNextVolume 返回 title | nextVolumeTitle=该 title，StatusBar 右段显示 |
| B-T2 | findNextVolume 返回 null | nextVolumeTitle=null，右段「已是最后一卷」灰 |
| B-T3 | 切目录在途时又切（请求序号陈旧） | 旧 IPC 结果（成功/失败/finally 任一）丢弃，不覆盖新目录的 title/loading（审查 P1-3） |
| B-T4 | **旧请求晚返回且失败** | 不把新目录 title 覆盖成 null、不提前关 loading（审查 P1-3 核心用例） |
| B-T5 | 点击右段 → emit next-volume → onCrossNextVolume | 复用现有测试（flushNow+findNextVolume+navigate） |
| B-T6 | 跳转成功 → prefetchNextVolume 刷新 | 新卷的下一卷名更新到右段 |
| B-T7 | 根目录 / 无 lastFetchedPath | nextVolumeDisabled=true，右段灰（审查 P2-1 绑定） |
| B-T8 | StatusBar 不传 nextVolumeTitle（undefined） | 右段渲染空 div 保持三段对称（兼容旧调用点） |
| B-T9 | nextVolumeLoading=true | 右段「…」灰 |
| B-T10 | 切目录瞬间 | 右段不闪空：从旧卷名 → 「…」(loading) → 新卷名（§3.3 时序） |

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
| scrollHeight 在尺寸渐进收敛时跳动，atBottom 抖动 | 固定 64px 阈值；停留确认 STABLE_MS 时间窗过滤抖动（跳动 1200ms 内稳定） |
| **短目录顶部误判 finished**（审查 P1-b） | §2.1 短目录约束 `!shortDir \|\| scrollTop>0`，A-T12/A-T13 验证 |
| finished 误标（用户只是滚到底看了一眼没真读） | STABLE_MS=1200ms 停留阈值；可调；右键菜单仍可重置 |
| **stableTimer 回调不置空 → 升级失败后永久卡住**（审查 P1-a） | §2.3 回调首行 `stableTimer=null` + scheduleStableTimer 置空守护 + 失败重试，A-T14 验证 |
| **stableTimer 漏清理 → 漏写或写陈旧 finished**（审查 P0-2 衍生） | §2.3 列全 5 个清理出口（离开底部/start/stop/disableWatcher/resize），封装 `clearStableTimer()` 统一调；A-T5/A-T8/A-T15 验证 |
| **同图去重阻止 finished 升级**（审查 P0-1） | A9 复合去重 `(path, finishedParam)`，A-T2 验证同图第 2 次升级写入 |
| **前端缓存 finished 被普通滚动覆盖回 false**（审查 P1-1） | §2.7 缓存单调保留 `finishedNow \|\| lastBrowseProgress.finished \|\| false`，A-T10 验证 |
| **enabled=false 时 flushNow 仍写**（审查 P1-2） | recordCurrentTop 入口 `if (!enabled) return`，A-T9 验证 flushNow 也走入口 |
| **预取陈旧污染新目录**（审查 P1-3） | §3.5 请求序号三分支校验，B-T3/B-T4 验证 |
| 路径段缩到 1/3 太窄 | truncate + title hover 提示；常见路径长度够用；用户可调窗口宽度 |
| 预查 IPC 增加请求 | debounce 300ms + 仅 lastFetchedPath 变化触发；成本可控 |
| 跑马灯 JS 测量 scrollWidth 在 happy-dom 测不准 | 视觉测试仅验 class 存在，像素动画靠本地真机验证 |

---

## 11. 开放问题（实现时再定，不阻塞设计）

- `STABLE_MS` 最终值（1200ms 是建议，实现后本地实测可调 800~2000ms）
- `BOTTOM_THRESHOLD_PX` 固定 64px（v3 定案，取代 v2 的「一屏阈值」——短目录会误判）。实现后若发现 64px 在某些 DPI/卡片高度下太严或太松可微调，但**不可回到 viewportHeight 阈值**（短目录顶部误判 bug）
- 短目录阈值 `2 * clientHeight`（<2 屏视为短目录）是否合适——可实测调整，但必须有此约束防顶部误判
- 跑马灯滚动时长（建议按文本长度线性，4s 是默认）
- 是否给底栏下一卷加键盘快捷键（toolbar 的 Alt+→ 已覆盖 reader，底栏是否需要独立快捷键——YAGNI 暂不加）
