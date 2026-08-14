# 单张缩略图生成状态与阶段进度设计

- **日期**：2026-08-14
- **模块**：v0.1.0-module3.0.11-thumbnail-per-image-progress
- **状态**：已修订（round-1：7 P1 + 1 P2；round-2：必修 1 + 建议 2；round-3：文档一致性 2 项，均已闭环，可实施）
- **依赖模块**：v0.1.0-module3.0.7-masonry-thumbnail-cache（缩略图生成管线）、v0.1.0-module3.0.8-thumbnail-polish（事件/日志骨架）
- **适用范围**：Local 数据源缩略图生成（与现有缩略图系统一致；Archive/SMB/WebDAV 接入时复用同一事件契约）

---

## 1. 背景

v0.1.0-module3.0.7 实现了按需缩略图缓存。前端单卡状态机（`src/lib/thumbnail.ts:173`）定义了 6 种 `ThumbnailState`，但实际运行时 `generating` 这个 kind **从未被设置**——`useMasonryThumbnails.ts` 的 `applyResults` 和事件回调都没有产生它，`MasonryThumbnail.vue:32` 的 `k === 'generating'` 是死分支。

后果：用户看到 spinner 一直转到 `cached`/`failed`，中间的 decode → resize → encode → write 全是黑盒。尤其 4K 大图 decode 耗时上百毫秒，用户无法判断「正在解码」还是「卡死」。

### 1.1 技术约束：百分比进度不可行

生成管线（`generator.rs:43`）的主要耗时在第 2 步 `image::load_from_memory`（decode 原图），它是**一次性阻塞调用**，image crate 不暴露逐行 decode 回调。因此平滑百分比进度条做不出来——decode 期间任何百分比都会卡住不动。

**可行的是阶段步进**：管线天然有 decode/resize/encode/write 4 个边界（每个边界已在打 log），把它从 log 变成发给前端的事件即可。这是本设计的进度粒度上限。

---

## 2. 目标与非目标

### 2.1 目标

1. 单张缩略图生成过程暴露 5 阶段（queued/decoding/resizing/encoding/writing）给前端。
2. masonry 卡片顶部居中显示阶段角标（无进度环，中心 `thumb-spinner` 已表达「进行中」），一眼可辨当前阶段。
3. 点击角标弹出 popover，显示阶段时间线 + 原图/输出尺寸；失败态显示错误 + 重试。
4. 全局开关控制 popover 是否弹出（默认开）；开关关闭时角标仍显示，作纯指示。
5. 完全 i18n 中英双语；阶段图标方案中英文零差异。
6. 性能影响可忽略（< 0.1%，见 §10）。

### 2.2 非目标

1. **不做百分比进度条**（技术不可行，见 §1.1）。
2. 不做全局队列进度（「生成中 3 / 排队 45」）——属另一独立功能，本模块只做单卡。
3. 不改 `generate_thumbnail` 的核心算法（decode/resize/encode 逻辑不动），只加阶段回调。
4. 不为 popover 引入定位依赖（floating-ui 等），手写 `getBoundingClientRect` 翻转。
5. `cache_key` 等诊断信息进日志不进 UI（遵循 AGENTS.md「用 logger 不靠 UI 调试」）。

---

## 3. 数据层设计（Rust）

### 3.1 阶段枚举

新增 `GenPhase` 枚举（`thumbnail/mod.rs` 或 `generator.rs`）：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GenPhase {
    Queued,    // 已入队，等 worker（不经过 generate_thumbnail，见 §3.4）
    Decoding,  // read_orientation + load_from_memory
    Resizing,  // apply_orientation + compute_output_size + thumbnail
    Encoding,  // webp encode
    Writing,   // write_atomic + flush
}
```

> **P1 修复（round-1）**：必须 derive `serde::Serialize` + `#[serde(rename_all = "lowercase")]`——序列化契约测试（plan 任务 1）直接 `serde_json::to_string(&GenPhase::Queued)`，漏 derive 无法编译。模式对齐现有 `Priority`（`mod.rs:67`，同为单词型枚举走 lowercase）。

前端镜像类型（`src/lib/thumbnail.ts`）：

```ts
export type ThumbnailPhase = 'queued' | 'decoding' | 'resizing' | 'encoding' | 'writing';
```

### 3.2 `GenerationJob` 加 `on_progress` 字段

`scheduler.rs:43` 的 `GenerationJob` 新增可选回调字段（**不**改 `GenerateFn` 签名，`GenerateFn = Arc<dyn Fn(GenerationJob) -> ...>` 不变）：

```rust
pub struct GenerationJob {
    // ... 现有字段不变 ...
    /// 阶段进度回调。None 时 generator 静默（测试用）。闭包内捕获 cache_key/ui_path/
    /// epoch/AppHandle，调 app.emit(EVENT_PROGRESS, ...)。第二参 u64 = generate 开始到
    /// 本阶段开始的累计毫秒（由 generate_thumbnail 内 t0 计算，见 §3.5 决策 B）。
    pub on_progress: Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>>,
}
```

`scheduler.rs` 的测试构造 `GenerationJob` 处补 `on_progress: None`。

> **P1 修复（round-1）**：`GenerationJob`（scheduler.rs:42）与 `QueuedTask`（:54，含 `job` 字段）现有 `#[derive(Debug, Clone)]`——`Arc<dyn Fn>` 不实现 `Debug`，加字段后两个 derive 都会编译失败。两处 derive 改为 `#[derive(Clone)]`（grep 确认 scheduler/service 无对这两类型的 `{:?}` 打印点；若实施时编译暴露使用点，改为手写 `Debug` impl 跳过 `on_progress` 字段）。

### 3.3 `generate_thumbnail` 加回调参数

`generator.rs:43` 的 `generate_thumbnail` 新增参数：

```rust
pub fn generate_thumbnail(
    mut req: GenerateRequest,
    on_progress: Option<&dyn Fn(GenPhase, u64)>,
) -> Result<GeneratedThumbnail, ThumbnailError>
```

在 4 个阶段边界调用（复用现有 `t0: Instant`）：

| 调用点（generator.rs 行号近似） | phase | 已有 log 行 |
|---|---|---|
| EXIF 读取前（紧接 `t0` log 后） | `Decoding` | 45 |
| `apply_orientation` 前（decode done log 后） | `Resizing` | 70 |
| `encode_webp` 前（resize done log 后） | `Encoding` | 105 |
| `write_atomic` 前（encode done log 后） | `Writing` | 126 |

调用形如 `if let Some(cb) = on_progress { cb(GenPhase::Decoding, t0.elapsed().as_millis()); }`（`t0` 是函数入口已有的 `Instant`）。第二参 u64 = 从 generate 开始到本阶段开始的累计毫秒，由 generator 内 `t0` 计算传入闭包（见 §3.5）。回调失败（emit 出错）**不得**传播——回调内部用 `let _ = app.emit(...)`，generator 不感知。

`generator.rs` 现有 6 个测试调用处补 `None` 参数。

### 3.4 新事件 `thumbnail://progress`

`service.rs` 新增常量与结构：

```rust
pub const EVENT_PROGRESS: &str = "thumbnail://progress";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub epoch: u64,
    pub cache_key: String,
    pub path: String,          // ui_path（entry.path，当前目录内相对）
    pub phase: String,         // "decoding" | "resizing" | "encoding" | "writing"
    pub elapsed_ms: u64,       // 从 generate 开始到本阶段开始的累计毫秒
}
```

### 3.5 service 构造 task 时注入 progress 闭包

`service.rs` `request()`（:432）与 `resubmit()`（:616）构造 `QueuedTask` 时，为每个 task 创建捕获身份的闭包，放进 `job.on_progress`。闭包签名 `Fn(GenPhase, u64)`——第二参 `elapsed_ms` 由 `generate_thumbnail` 内 `t0` 计算后传入（决策 §11.9：闭包无法访问 generate 内 `t0`，故 elapsed 由 generator 透传，精确反映「generate 实际开始后多久」，不受排队等待影响）：

```rust
let app = self.app.clone();
let ck = cache_key.clone();
let ui_path = item.path.clone();
let task_epoch = epoch;
let on_progress: Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>> = Some(Arc::new(move |phase, elapsed_ms| {
    let _ = app.emit(EVENT_PROGRESS, ProgressEvent {
        epoch: task_epoch,
        cache_key: ck.clone(),
        path: ui_path.clone(),
        phase: phase_str(phase),
        elapsed_ms,
    });
}));
```

`production_generate_fn`（service.rs）把 `job.on_progress` 透传给 `generate_thumbnail`：构造 `GenerateRequest` 时同步传 `job.on_progress.as_deref()`（`Arc<dyn Fn>` → `&dyn Fn`）。

### 3.6 emit 非阻塞、不持锁

progress 闭包在 `spawn_blocking` 线程内被调用（`scheduler.rs:442`）。`AppHandle::emit` 序列化 payload 后投递到内部 channel 立即返回，**不等待前端、不持 Db 锁、不等 IPC 往返**。与现有 `spawn_completion`（`service.rs:972`）同一模式。回调内**禁止**任何同步 IO / Db 锁。

### 3.7 queued 阶段事件

`queued`（已入队等 worker）不经过 `generate_thumbnail`，无回调点。前端在 `applyResults` 收到 IPC 返回 `status: 'queued'` 时直接 `setState(path, {kind:'generating', phase:'queued', ...})`（带 §4.2 cacheKey 顺序守卫），无需 Rust 事件。worker 取出任务进入 `Decoding` 时第一个 progress 事件到达，前端从 `queued` 切到 `decoding`。

---

## 4. 前端状态机扩展

### 4.1 `ThumbnailState` 扩展

`src/lib/thumbnail.ts:177` 的 `generating` kind 扩展字段：

```ts
| { kind: 'generating'; cacheKey: string; phase: ThumbnailPhase; startedAt: number; generationStartedAt?: number; timings: Partial<Record<ThumbnailPhase, number>> }
```

- `startedAt`：进入 generating 态的墙钟时间戳（queued 回包 / retry 预置时的 `Date.now()`）——**含排队等待**，popover 顶部「已用时」用它。
- `generationStartedAt`：首个 progress 事件应用时 `Date.now() - elapsedMs` 反推的 **generate 实际开始墙钟**——不含排队等待。阶段时长推算用它（P1 修复 round-1：若直接 `Date.now() - startedAt - timings[cur]`，排队时间会被算进 decoding 实时耗时）。反推是近似值（含事件投递延迟，毫秒级），UI 足够。
- `timings`：各阶段开始的累计毫秒（`elapsedMs`，generate 相对时间），由连续 progress 事件推算（见 §4.3）。

### 4.2 `useMasonryThumbnails` 处理

`applyResults`（:256）的 `case 'queued'` 改为（**cacheKey 顺序守卫**，P1 修复 round-1）：

```ts
case 'queued': {
  const prev = state.value.get(r.path);
  // 顺序守卫：Tauri 事件与 invoke 回包无先后保证。同一 cacheKey 的
  // progress / 完成事件先于本回包到达时，保留事件写入的状态——否则
  // (a) cached/failed 被降级回 generating → 永久 spinner（不再有事件来救）；
  // (b) progress 已推进的 phase 被重置回 queued。cacheKey 不同（列宽/质量
  // 变化后的重请求）则正常覆盖。
  const raced = prev && 'cacheKey' in prev && prev.cacheKey === (r.cacheKey ?? '');
  if (!raced) {
    setState(r.path, {
      kind: 'generating', cacheKey: r.cacheKey ?? '',
      phase: 'queued', startedAt: Date.now(), timings: {},
    });
  }
  // 消费先于回包缓冲的 progress 事件（decoding 已到但状态尚未建立）
  const buffered = pendingProgress.get(r.path);
  if (buffered && buffered.cacheKey === (r.cacheKey ?? '')) {
    pendingProgress.delete(r.path);
    applyProgressEvent(buffered);
  }
  // pathToCacheKey 更新不变
  break;
}
```

新增 progress 监听（与现有 `state` 事件监听并列，:301 模式）。progress 事件统一走 `applyProgressEvent`（直接到达与缓冲消费两条路径共用）：

```ts
function applyProgressEvent(p: ThumbnailProgressEvent) {
  const prev = state.value.get(p.path);
  if (!prev || prev.kind !== 'generating' || prev.cacheKey !== p.cacheKey) return;
  if (p.phase === prev.phase) return; // 幂等：同阶段事件不重复应用
  const generationStartedAt = prev.generationStartedAt ?? (Date.now() - p.elapsedMs);
  const timings = { ...prev.timings, [p.phase]: p.elapsedMs };
  setState(p.path, { ...prev, phase: p.phase, generationStartedAt, timings });
  // 进度快照：failed 事件会整体覆盖 generating 态，快照保住时间线明细（§4.4）
  setSnapshot(p.path, { phase: p.phase, timings, startedAt: prev.startedAt, generationStartedAt });
}

let progressUnlisten: UnlistenFn | null = null;
let disposed = false; // round-2：listen() 异步——unmount 先于 .then(fn) 到达时防泄漏
void listen<ProgressEvent>('thumbnail://progress', (event) => {
  const p = event.payload;
  if (p.epoch !== epoch.value) return;  // epoch 过滤，同 state 事件
  const prev = state.value.get(p.path);
  if (prev?.kind === 'generating') {
    applyProgressEvent(p);
  } else if (!prev || prev.cacheKey !== p.cacheKey) {
    // 事件先于 queued 回包到达（或旧 cacheKey 残留）：缓冲，回包到达后消费。
    // prev 为同 cacheKey 终态（cached/failed 已先到）则丢弃——生成已结束。
    pendingProgress.set(p.path, p);
  }
}).then((fn) => {
  if (disposed) fn(); // 组件已卸载，立即解绑迟到的监听
  else progressUnlisten = fn;
})
  .catch((err) => { if (isTauriEnv()) log('[useMasonryThumbnails] listen(thumbnail://progress) failed (unexpected in Tauri env)', err); });
```

- `pendingProgress: Map<string, ThumbnailProgressEvent>`——回包竞态缓冲，每 path 只留最新。
- **unlisten 清理**（round-1 P1-5 + round-2）：progress 监听与现有 state 监听同模式——`.then` 保存 unlisten，`onBeforeUnmount` 里与 state 的 unlisten 一起调用（现有清理点 useMasonryThumbnails.ts:414），且**先立 `disposed = true`**——`listen()` 是异步的，unmount 先于 `.then(fn)` 到达时 cleanup 已跑完、迟到的 unlisten 会泄漏，故 `.then` 内检查 disposed，已卸载则立即 `fn()`。漏存 unlisten 会在切目录/重挂载后累积监听器 + 重复状态更新。既有 state 监听同款迟到问题不在本模块修（手术边界）。
- `bumpEpoch()` 同时清空 `pendingProgress` 与 `progressSnapshots`（旧目录缓冲/快照不再有效）。
- `happy-dom` 防御（`isTauriEnv()`）与 `.catch` 模式复用现有 `state` 事件监听。

### 4.3 阶段时长推算

`timings[phase]` = 该阶段开始的累计 elapsed_ms（来自 `ProgressEvent.elapsedMs`，generate 相对时间）。popover 渲染时：

- **queued 阶段时长**（排队等待）= `generationStartedAt - startedAt`；`generationStartedAt` 未到时 = `Date.now() - startedAt`（实时跳动）。
- 已完成阶段 X 的时长 = `timings[nextPhase] - timings[X]`（nextPhase 是 X 之后的第一个已记录阶段）。
- **当前进行阶段的时长 = `Date.now() - generationStartedAt - timings[currentPhase]`**——必须用 `generationStartedAt`（generate 实际开始墙钟），不能用 `startedAt`（含排队，P1 修复 round-1）。
- popover 顶部「已用时」= `Date.now() - startedAt`（自请求起，**含排队**，与阶段时长口径不同是有意的）。

### 4.4 进度快照（失败态时间线）

`thumbnail://state` 的 `failed` 事件把 generating 态整体替换为 `{kind:'failed',...}`（useMasonryThumbnails.ts:334 现状），`phase/timings/startedAt` 随之丢失——而 popover 失败分支要展示「卡在哪一步」的时间线（§6.3）。composable 维护独立快照（P1 修复 round-1）：

```ts
const progressSnapshots = shallowRef<Map<string, {
  phase: ThumbnailPhase;                        // 卡住的阶段
  timings: Partial<Record<ThumbnailPhase, number>>;
  startedAt: number;
  generationStartedAt?: number;
}>>(new Map());
```

- `applyProgressEvent` 每次推进时写入（`setSnapshot` 复用 setState 的「new Map 整体替换」模式保响应性）。
- `bumpEpoch()` 清空；`retry`/`regenerate` 预置 generating 时删除该 path 的旧快照（旧快照不喂给新一轮失败态）。
- 通过 composable return 暴露 `progressSnapshots`；`MasonryView` 传给 popover `:snapshot="progressSnapshots.get(path)"`。
- popover 失败分支用快照渲染时间线：快照 `phase` = 卡住步骤（error 标记），之前步骤 ✓ + 时长，之后步骤灰；**无快照**（未经生成即失败，如 `applyResults` 直接 failed）则不渲染时间线。

---

## 5. 角标设计

### 5.1 视觉

- 位置：卡片**顶部居中**（`top: 0` 边缘，水平居中），半圆/胶囊形贴顶。
- 内容：**阶段图标 + 短文字**（如"⟳ 解码"），**无进度环**（中心 `thumb-spinner` 已表达「进行中」，见 `MasonryThumbnail.vue:99`）。文字用 i18n `thumbnail.phase.{queued|decoding|resizing|encoding|writing}` 的短词，与 popover 时间线同源。
- 图标（内嵌 SVG path，遵循 AGENTS.md「不用 lucide 包」）：
  - `queued`：沙漏/三点
  - `decoding`：向下箭头入框（图像下载意象）
  - `resizing`：双向缩放箭头
  - `encoding`：方框包裹（编码意象）
  - `writing`：保存/磁盘
- 尺寸：约 **auto 宽**（图标 + 短文字 + 内边距，约 50-64px）× 14px 胶囊，`bg: accent/0.92`，`color: #fff`，与现有 `masonry-badge`（左上 reading/finished）风格一致但不占同位（左上 vs 顶中）。
- **failed 错误角标**（round-2）：同位置同尺寸，error 色（`rgb(248 113 113 / 0.92)`）+ 感叹号三角图标 + "失败"短文字，复用 `.phase-badge.fail` 样式；是失败态 popover 的**唯一主动入口**（卡片中央的错误区保留 retry 按钮，职责不变）。

### 5.2 显示时机

`generating` 态显示阶段角标；**`failed` 态显示错误角标**（round-2 必修：同位置 error 色胶囊 + 感叹号图标，点击同样弹 popover——否则用户未在失败前打开 popover 时，失败时间线与 popover 内重试永远不可达）。`cached`/`original`（显图）、`undefined`（尚未进入窗口）**不显角标**。`queued` 阶段显沙漏图标（区分「排队」与「正在解码」）。

### 5.3 渲染位置

`MasonryThumbnail.vue` 当前渲染 spinner + img + failed。角标加在 `.masonry-thumb` 容器顶部居中。由于 `MasonryThumbnail` 不直接知道 entry/状态切换入口，角标点击事件需向上 emit。

### 5.4 点击入口

角标 `@click.stop`（阻止冒泡到 `MasonryRow` 的 row-click 选中）→ emit `show-progress` **携带角标 DOM 元素**（`e.currentTarget`）→ `MasonryRow` 补上 `entry` 转发 → `MasonryView` 用该元素的 `getBoundingClientRect()` 定位（P2 修复 round-1：**不走 `querySelector('[data-path="..."]')`**——路径含 `"` / `\` 等字符会注入选择器语法抛错；元素直传零转义负担）。受全局开关控制（§7）：开关关时角标 `cursor: default`、不 emit。

---

## 6. Popover 设计

### 6.1 组件

新增 `src/components/filebrowser/ThumbnailProgressPopover.vue`。由 `MasonryView` 持有单个实例（同时只展示一张图的详情），通过 `anchorPath`（角标所属 entry.path）定位。

### 6.2 定位策略

相对**角标**定位，优先级：**右侧 → 左侧 → 下方 → 上方**。

```
const RECT = popover.getBoundingClientRect();
const GAP = 8;
// 1. 右侧：popover.left = anchorRect.right + GAP
// 2. 若 right 溢出视口 → 左侧：popover.right = anchorRect.left - GAP
// 3. 若 left 也溢出 → 下方：popover.top = anchorRect.bottom + GAP，水平居中钳位
// 4. 若 bottom 溢出 → 上方：popover.bottom = anchorRect.top - GAP
```

用 `position: fixed` + `getBoundingClientRect`，滚动/resize 时重算（`useVirtualList` 的 scroll watcher 触发）。不引依赖。

> **P1 修复（round-1）**：`positionFor` 需要 `right/bottom`，但跨组件传递的 `anchorRect` 只含 `{left, top, width, height}`——popover 内 `reposition()` 补算 `right = left + width`、`bottom = top + height` 后再喂 `positionFor`（线格式保持 4 字段最小）。
>
> **P2 修复（round-1）**：滚动重算用 popoverState 存储的**角标元素引用**直接 `getBoundingClientRect()`（元素直传链见 §5.4）；虚拟滚动把卡片移出 DOM 后 `rect.width === 0` → 自动关闭 popover。

### 6.3 字段（选项 2，砍 cache_key）

**生成中态**：
- 文件名（标题）
- 当前阶段名 + 总耗时（`Date.now() - startedAt`，实时）
- 阶段时间线：5 步（queued/decoding/resizing/encoding/writing），每步 `● 完成(绿) / ● 当前(accent, 转动点) / ○ 未到(灰)` + 时长（§4.3 推算）
- 原图：`宽×高 · MB`（`measuredMap` 的 header 尺寸 + `entry.size`）
- 输出：`宽×高 · KB`（`ThumbnailState.cached` 的 width/height；generating 中显 `—`）

**失败态**：
- 文件名
- 错误信息（`ThumbnailState.failed.message`，`errorKind` 映射友好文案）
- 阶段时间线（卡在哪步，之前步骤✓）——数据源是 `progressSnapshots.get(path)`（§4.4，P1 修复 round-1：failed 事件覆盖 generating 态后 phase/timings 已丢，必须靠独立快照）；无快照时省略时间线区块
- 重试按钮（调 `useMasonryThumbnails.retry(path)`，与卡片 retry 按钮等效）

> 失败态实际触发条件（用户反馈从未遇到）：异常 JPEG 变体、损坏文件头、WebP/AVIF/HEIC 等未充分测试格式、IO 错误。链路通（`Outcome::Failed` → emit `state:"failed"`），常见 JPEG/PNG/GIF/BMP 稳定故未触发。失败态作兜底保留。
>
> **可达入口（round-2 必修）**：失败态 popover 通过 §5.2 的**错误角标**打开——不能只依赖"失败前已打开"（popover 对已打开的卡片会随 failed 事件继续展示，但事后无法再打开，时间线与重试按钮不可达）。

### 6.4 关闭

点 popover 外部（`mousedown` outside；**必须实现**，P2 修复 round-1——document mousedown 监听，target 不在 popover 根内且不在 `.phase-badge` 上时关闭；角标点击留给 click 处理器做 toggle）/ ESC / 切目录 / 角标再点切换（同 path toggle 关闭）。`anchorPath` 置 null 即关闭。监听器在 onMounted 挂、onUnmounted 解绑。

### 6.5 多选

多选时角标仍各自显示；popover 只追踪 `anchorPath` 单张。多选不阻止弹 popover。

---

## 7. 全局开关

### 7.1 设置项

- DB key：`thumbnail_detail_popover`（settings 表 key-value，**无需 migration**）
- 默认值：`true`（开）
- 位置：`src/components/settings/ThumbnailCacheSettings.vue` 加一行 `BooleanRow`
- settings store：`src/stores/settings.ts` 加 `thumbnailDetailPopover` ref + persist

### 7.2 行为

- 开：点击角标弹 popover（默认）
- 关：角标仍显示阶段（纯指示），`cursor: default`，点击无反应

实现契约（round-3）：开关值**以 prop 下传**——`MasonryView` 读 `settingsStore.thumbnailDetailPopover` → `MasonryRow` 透传 → `MasonryThumbnail` 的 `badgeInteractive` prop；角标 `<button :disabled="!badgeInteractive">`（disabled 天然 `cursor: default` 且不派发用户点击），`onBadgeClick` 内再加 `if (!badgeInteractive) return;` 守卫（happy-dom / 程序化 dispatchEvent 会绕过 disabled 派发，双保险）。`MasonryView.openProgressPopover` 的 `if (!settingsStore.thumbnailDetailPopover) return;` 保留为第二道防线。**不能只在 View 层忽略事件**——按钮仍手型可点，误导性可供性。

---

## 8. i18n

`src/locales/zh-CN.ts` + `en-US.ts` 同步新增（遵循 AGENTS.md §2 namespace）：

| key | zh-CN | en-US |
|---|---|---|
| `thumbnail.phase.queued` | 排队中 | Queued |
| `thumbnail.phase.decoding` | 解码中 | Decoding |
| `thumbnail.phase.resizing` | 缩放中 | Resizing |
| `thumbnail.phase.encoding` | 编码中 | Encoding |
| `thumbnail.phase.writing` | 写入中 | Writing |
| `thumbnail.popover.title` | 缩略图生成 | Thumbnail generation |
| `thumbnail.popover.elapsed` | 已用时 {ms}ms | Elapsed {ms}ms |
| `thumbnail.popover.sourceImage` | 原图 | Source |
| `thumbnail.popover.output` | 输出 | Output |
| `thumbnail.popover.retry` | 重新生成 | Regenerate |
| `thumbnail.popover.failed` | 生成失败 | Generation failed |
| `settings.thumbnail.detailPopover` | 点击角标显示生成详情 | Show generation details on badge click |

namespace 用 `thumbnail.*`（与 `fileBrowser.thumbnailRetry` 区分，新增独立 namespace）。每 key 双语必须同时存在（AGENTS.md §2.3）。

---

## 9. 测试策略

### 9.1 Rust

- `generator.rs`：现有 6 测试补 `None` 参数；新增 2 测试——传入记录型闭包，断言 4 阶段按序触发（Decoding→Resizing→Encoding→Writing）。
- `scheduler.rs`：现有测试构造 `GenerationJob` 补 `on_progress: None`；新增 1 测试——`on_progress: Some(record_fn)` 验证闭包被透传到 generate。
- `service.rs`：新增集成测试——mock generate 闭包在阶段边界调 on_progress，断言 `EVENT_PROGRESS` 事件 payload（epoch/cache_key/path/phase/elapsed_ms）正确；epoch mismatch 时前端过滤（前端测覆盖）。

### 9.2 前端

- `useMasonryThumbnails.test.ts`：progress 事件处理 + epoch 过滤 + timings 推算 + 非 generating 态忽略；**竞态双例（round-1）**——progress 事件先于 queued 回包（缓冲消费，phase 不丢）、state 事件 cached/failed 先于 queued 回包（不降级覆盖，无永久 spinner）；**unmount 解绑两个监听**（state + progress 的 unlisten 均被调用）；**失败后快照保留**（`progressSnapshots` 不被 failed 覆盖）；`generationStartedAt` 反推设置。
- `MasonryThumbnail.test.ts`：角标按 phase 渲染对应图标；非 generating 态无角标；`queued` 显沙漏；**failed 显错误角标且点击 emit（round-2 必修：失败详情可达）**；show-progress emit 携带角标元素；**badgeInteractive=false → disabled、点击不 emit（round-3）**。
- `ThumbnailProgressPopover.test.ts`：定位 fallback（右→左→下→上，用 mock boundingRect）；字段渲染；**失败态用快照渲染时间线（卡住步骤 error 标记）/ 无快照省略时间线**；失败态重试按钮 emit；关闭（外部点击/ESC）。
- `MasonryView.test.ts`（round-1）：外部 mousedown 关闭；角标再点 toggle 关闭；**特殊路径（含引号/反斜杠）不走 querySelector 直接弹 popover**。
- `settings`：`thumbnailDetailPopover` 读写 + 角标点击守卫。

---

## 10. 性能影响

| 项 | 量级 | 说明 |
|---|---|---|
| generate 主路径 | 零增加 | decode/resize/encode 逻辑不动，只多 4 次回调调用（纳秒） |
| `app.emit()` ×4/张 | 微秒–亚毫秒 | 非阻塞投递，不持 Db 锁，不等 IPC 往返 |
| 前端事件量 | ×5 完成事件 | 时间分散在整条生成链路，不形成尖峰；单事件 epoch 过滤 + Map.set |
| 角标 DOM 更新 | ≤ worker_limit | 同时 generating 卡片 = worker_limit（2–16），每张切 ~4 次 |
| popover | 单卡片 | 仅追踪 anchorPath 一张 |

相对 decode 4K 图 100–300ms，新增开销 < 0.1%，用户无感。工程纪律：emit 非阻塞、回调 `let _ =`、闭包 `Send + Sync`、前端 epoch 过滤——均复用现有模式。

---

## 11. 决策记录

1. **进度粒度 = 5 阶段步进，非百分比**：decode 是 image crate 一次性阻塞调用，无逐行回调，百分比不可行（§1.1）。
2. **角标无进度环**：中心 `thumb-spinner` 已表达「进行中」，角标只负责阶段标识，避免双环视觉冗余（用户决策）。
3. **角标图标 + 短文字**（用户实测反馈 round-4）：纯图标辨识度不足（5 个相近 SVG 难分），加短文字标签（"解码"/"缩放"等）一眼可辨；popover 内完整时间线不变。
3. **角标顶部居中，非右上角**：左上已被 reading/finished badge 占用；顶部居中与 badge 不冲突（用户决策）。
4. **Popover 定位角标右侧优先**：用户指定；右侧不足自动翻转（右→左→下→上）。
5. **字段砍 cache_key**：普通用户不关心，进日志不进 UI（选项 2，AGENTS.md「用 logger 不靠 UI 调试」）。
6. **失败态保留 popover 重试**：与卡片 retry 等效但信息更全；失败罕见但兜底要有。
7. **全局开关默认开**：点击触发非自动弹，低打扰，让功能可发现。
8. **`on_progress` 放 `GenerationJob` 不改 `GenerateFn` 签名**：`GenerateFn` 是 scheduler 核心契约，改签名波及所有调用点与测试；放 job 字段影响最小。
9. **elapsed_ms 由 generate_thumbnail 传入闭包**（方案 B）：闭包无法访问 generate 内 `t0`，故回调签名 `Fn(GenPhase, u64)`，elapsed 精确反映 generate 实际开始后耗时，不受排队等待影响。
10. **queued 回包 cacheKey 顺序守卫 + progress 事件缓冲**（round-1 P1）：Tauri 事件通道与 invoke 回包无先后保证——快速完成时 `cached/failed` state 事件可先于 queued 回包到达，无条件写回 generating 会造成永久 spinner；progress 事件先于回包到达时缓冲到 `pendingProgress`，回包建立 generating 态后消费，decoding 阶段不丢。守卫键用 cacheKey（同 key 视为同一次请求的竞态；列宽/质量变化的重请求 key 不同，正常覆盖）。
11. **generationStartedAt 墙钟反推**（round-1 P1）：`startedAt`（含排队）与 `timings`（generate 相对时间）口径不同，当前阶段实时耗时 = `Date.now() - generationStartedAt - timings[cur]`，排队等待单列为 queued 阶段时长；popover 顶部「已用时」保留含排队口径（用户感知的是"从请求到现在"）。
12. **失败态进度快照独立 map**（round-1 P1）：failed state 事件整体覆盖 generating 态是既有行为（不动），`progressSnapshots` 按 path 保最后快照喂给 popover 失败时间线；epoch 清空 + retry 删除防陈旧。
13. **角标点击直传 DOM 元素 + popover 外点关闭**（round-1 P2）：emit `show-progress(el)` 链路避免 `querySelector` 拼接用户可控路径（特殊文件名注入选择器语法）；外部 mousedown 关闭跳过 `.phase-badge`（toggle 交给 click 处理器，避免 mousedown 先关 click 再开的抖动）。
14. **failed 态保留错误角标作为 popover 入口**（round-2 必修）：仅 generating 显角标时，用户未在失败前打开 popover 则失败时间线/重试永不可达；失败角标（error 色 + 感叹号）与阶段角标同位同交互，卡片中央错误区的 retry 按钮职责不变。外点判定用 `e.target instanceof Element`（SVG 元素不是 HTMLElement，误判会导致点角标内 SVG 时 popover 抖动）。
15. **progress 监听 disposed 守卫**（round-2）：`listen()` 异步——unmount 先于 `.then(fn)` 到达时 cleanup 已跑完、unlisten 后到即泄漏；`.then` 内检查 disposed 标志，已卸载则立即 `fn()`。既有 state 监听同模式问题**不在本模块修**（手术边界，留待后续统一）。

---

## 12. 实现顺序建议（供 writing-plans）

1. Rust 数据层：`GenPhase` + `GenerationJob.on_progress` + `generate_thumbnail` 回调参数 + `ProgressEvent` + service 注入闭包 + 测试。
2. 前端类型 + composable：`ThumbnailPhase` + `ThumbnailState.generating` 扩展 + `useMasonryThumbnails` progress 监听 + 测试。
3. 角标：`MasonryThumbnail` 角标渲染 + 阶段图标 + 点击 emit + 测试。
4. Popover：`ThumbnailProgressPopover` 组件 + 定位 fallback + 字段 + 失败态 + 关闭 + 测试。
5. 全局开关 + i18n + settings 接线 + 测试。
6. 收尾：type-check + 全测 + 本地 build。
