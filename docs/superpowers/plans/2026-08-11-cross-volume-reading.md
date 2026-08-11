# 跨卷连续阅读 实现计划（v2）

> **面向 AI 代理的工作者:** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度。
>
> **v2 变更**（vs v1）：吸收设计审查报告 P0/P1 + 三轮架构精化。前置 Loader 抽取任务；删 Archive 伪代码；删虚假 filter；Loader 返回 Snapshot；toast props/emits；瀑布流用 lastFetchedPath；删 tag/push 任务（收尾由分支收尾流程决定）。

**目标：** 填实 `find_next_volume` stub，打通 reader（末页"再向下" / 9 宫格 / slideshow）与瀑布流（工具栏按钮）的跨卷连续阅读链路。**范围收窄为仅 Local 目录卷**。

**架构（三层 + route 唯一真值）：** 意图 → CrossVolumeController（决策+竞态）→ ReaderView 编排（navigateToVolume）→ route watch（唯一加载入口）→ useReaderBookLoader（返回不可变 Snapshot）。详见 [spec v2](../specs/2026-08-11-cross-volume-reading-design.md) §4。

**技术栈：** Rust（Tauri 2.x async command + `algorithm::natural_compare` + `algorithm::path::PathUtils`）+ Vue 3（Pinia + composables + Vitest/happy-dom）

**spec：** [`docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md`](../specs/2026-08-11-cross-volume-reading-design.md)

---

## 文件结构

### 创建
| 文件 | 职责 |
|---|---|
| `src/composables/useReaderBookLoader.ts` | 统一 Book Loader：`loadBookById`（读+算 Snapshot，不写 refs）+ `ensureBookId`（仅建立身份） |
| `src/composables/useReaderBookLoader.test.ts` | 表征测试（抽取自现有 loadBook）+ 新用例 |
| `src/composables/useCrossVolume.ts` | CrossVolumeController：状态机 + requestSeq + sameBookIdentity + trySave + clearPendingState/dismissManual |
| `src/composables/useCrossVolume.test.ts` | 状态机 + 竞态 + 陈旧 + 保存失败 + 模式矩阵 |
| `src/composables/useToast.ts` | 通用 toast 队列（单例，上限 1，1500ms 自动隐藏） |
| `src/composables/useToast.test.ts` | 单测 |
| `src/components/common/ToastHost.vue` | `<Teleport to="body">` 渲染 toast 队列 |
| `src/components/reader/ContinueNextVolumeToast.vue` | manual 底部胶囊（纯 props/emits，不调 useCrossVolume） |
| `src/components/reader/ContinueNextVolumeToast.test.ts` | props/emits 测试 |

### 修改
| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/find_next_volume.rs` | stub → async 实现 + `pick_sibling` 纯函数（返回 entry）+ `NextVolumeResult`（无 is_archive） |
| `src/lib/tauri.ts` | `findNextVolume` 改返回 `NextVolumeResult \| null`（无 isArchive） |
| `src/stores/reader.ts` | 加 `sourceDescriptor`/`currentRelPath` state + `saveCurrentProgressNow()`（await 构造快照）+ `nextPage` atLast 回调 + `setOnAtLastNextAttempt` + `OpenBookPayload` 扩展 |
| `src/stores/reader.test.ts` | saveCurrentProgressNow / nextPage atLast / setOnAtLastNextAttempt 用例 |
| `src/views/ReaderView.vue` | route watch immediate（删 onMounted）+ loadRouteBook + commitBookSnapshot + retryCurrentBook + navigateToVolume + Controller 实例化 + 触发接线 + 卸载清理 |
| `src/views/ReaderView.test.ts` | loadRouteBook 去重/失败不保留旧卷/stale；commitBookSnapshot 原子 |
| `src/composables/useMasonryBrowsePosition.ts` | 加 `flushNow()` |
| `src/composables/useMasonryBrowsePosition.test.ts` | flushNow 用例 |
| `src/components/filebrowser/MasonryView.vue` | defineExpose 加 `flushBrowsePosition`（P1-1 转发链） |
| `src/components/filebrowser/FileList.vue` | 加 `masonryFlushNow` + defineExpose（P1-1 转发链） |
| `src/components/filebrowser/FileBrowser.vue` | 工具栏"下一卷"按钮（不绑 viewMode）+ onCrossNextVolume（lastFetchedPath） |
| `src/composables/useReaderHotkeys.ts` | 加 `ReaderHotkeyActions` 参数，folderNext 接 `actions.nextVolume`（P1-2） |
| `src/composables/useReaderHotkeys.test.ts` | actions 参数回归 |
| `src/locales/zh-CN.ts` + `en-US.ts` | 7 key |

### 不改
| 文件 | 原因 |
|---|---|
| `src/lib/findNextDirectory.ts` | **不加 filter 参数**（v2 删除虚假 filter，P1-5）。保持原签名。 |
| `src/lib/findNextDirectory.test.ts` | 现有用例不动 |

---

## 任务 0：抽取统一 useReaderBookLoader（前置，表征测试优先）

> **为什么前置**：P0-1 指出跨卷不能只调 `reader.openBook`（ReaderView 持有 pageUrls/imageNames/book/status 等 local ref）。必须先把现有 `ReaderView.loadBook()` 抽成可复用 Loader，返回不可变 Snapshot，首次开卷行为不变，跨卷才能安全复用。

**文件：**
- 创建：`src/composables/useReaderBookLoader.ts`
- 创建：`src/composables/useReaderBookLoader.test.ts`
- 修改：`src/views/ReaderView.vue`（loadBook 改调 loader + commitBookSnapshot）

**参考：** 现有 `ReaderView.loadBook`（`ReaderView.vue:181-313`）——这是要抽取的源逻辑。

- [ ] **步骤 1：写表征测试（先固定现有行为）**

`src/composables/useReaderBookLoader.test.ts`：mock `getBook`/`listDirectory`/`getProgress`，验证 `loadBookById(bookId)` 返回 `ReaderBookSnapshot`（含 book/descriptor/relPath/imageNames/pageUrls/spreads/initialSpreadIndex），**不写任何 ref / 不调 reader.openBook**。覆盖：
- 正常 Local 目录：返回 Snapshot，pageUrls 是 convertFileSrc URL（非文件名）。
- 非 Local descriptor：throw（收窄，message 含"非本地"）。
- filter 图片：排除 isDirectory / isArchive / 非图。
- 排序：directorySort per-folder override 命中 vs fallback settings。
- 智能恢复：explicitImageName 命中；progress.imageName 命中；progress.page fallback；progress.finished → 0；无 progress → 0。
- ensureBookId：createBook UPSERT 返回 id（mock createBook）。
- **`loadBookById(bookId, { explicitImageName })` 锁定起始图**（P1-3：任务 0 就要传 ?at，不能等任务 8）：传入 explicitImageName → initialSpreadIndex 对应该图所在 spread。

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run src/composables/useReaderBookLoader.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 useReaderBookLoader**

`src/composables/useReaderBookLoader.ts`：把 `ReaderView.loadBook` 的 IO+计算逻辑搬入，返回 `ReaderBookSnapshot`（spec §8）。关键：
- `loadBookById(bookId, opts?)`：getBook → 解析 descriptor（非 Local throw）→ listDirectory → filter 图片 → directorySort.resolve 排序 → imageNames + convertFileSrc pageUrls → spreads → resolveStart（explicit→imageName→page→0；finished→0）→ return Snapshot。**全程不写 refs，不调 reader.openBook**。
- `ensureBookId(target)`：`createBook(UPSERT)` 返回 id。**CreateBookArgs 最小映射见 spec §8**（sourceType='Local' / favorite=false / coverEntryPath/Name=null / pageCount=0；接受 createBook 对已存在行不更新封面/页数，不扩大范围）。
- 导出类型 `ReaderBookSnapshot` / `LoadBookOptions` / `NextVolumeTarget`（spec §7）。

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run src/composables/useReaderBookLoader.test.ts
```
预期：PASS。

- [ ] **步骤 5：ReaderView 接入 loader（首次开卷行为不变）**

`src/views/ReaderView.vue`：
- `loadBook()` 改为调 `loader.loadBookById(id, { explicitImageName: initialImageName.value ?? undefined })`（**P1-3：任务 0 就传 ?at，避免回归**；`initialImageName` 是现有 computed，读 `route.query.at`），结果经 `commitBookSnapshot(snapshot)` 提交（spec §11.1）。
- 加 `commitBookSnapshot` 函数（原子写 book/pageUrls/imageNames refs + reader.openBook + reader.imageNames）。
- **暂时保留 onMounted(loadBook)**（任务 8 才改 route watch immediate，避免本任务动太多）。
- 现有 `ReaderView.test.ts` 应全绿（行为不变，含 ?at 入口用例）。

- [ ] **步骤 6：全测 + type-check**

```bash
npm run type-check && npx vitest run src/views/ReaderView.test.ts src/composables/useReaderBookLoader.test.ts
```
预期：PASS（首次开卷行为不变，Loader 抽取纯重构）。

- [ ] **步骤 7：Commit**

```bash
git add src/composables/useReaderBookLoader.ts src/composables/useReaderBookLoader.test.ts src/views/ReaderView.vue
git commit -m "refactor(reader): 抽取 useReaderBookLoader (loadBook → Snapshot，首次开卷行为不变)"
```

---

## 任务 1：Rust `pick_sibling` 纯函数 + 单测

**文件：**
- 修改：`src-tauri/src/commands/find_next_volume.rs`（加纯函数 + `#[cfg(test)]` 模块）

**说明：** 纯函数返回 `Option<MediaEntry>`（**不返回索引**，P1-5 修复）。只保留 `is_directory`（收窄 Local 目录卷）。

- [ ] **步骤 1：编写失败的测试**

`find_next_volume.rs` 末尾加 `#[cfg(test)] mod tests`，覆盖（spec §17.1）：
- next/prev 取相邻；current 在首/末；current 不在 siblings（None）；空 siblings；natural sort（page2 在 page10 前）。

测试用 `pick_sibling(&siblings, "vol2", VolumeDirection::Next).map(|e| e.name.as_str())` 断言（返回 entry 非索引；direction 是 enum 非 &str，见任务 2 步骤 1）。`MediaEntry` 字段名以 `descriptor.rs:147` 为准（`modified_at` / `is_directory` 等）。

- [ ] **步骤 2：运行测试验证失败**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib pick_sibling -- --nocapture
```
预期：编译失败（`pick_sibling` 未定义）。

- [ ] **步骤 3：实现 `pick_sibling`**（spec §5.2 纯函数版）

只过滤 `is_directory`，按 natural_compare 排序，返回目标 entry 的克隆。direction 是 `VolumeDirection` enum（`Next` → pos+1，`Prev` → `checked_sub(1)?`；无 `_` fallback 分支，enum 已穷尽）。

- [ ] **步骤 4：运行测试验证通过**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib pick_sibling -- --nocapture
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/find_next_volume.rs
git commit -m "feat(cross-volume): pick_sibling 纯函数 + 单测 (返回 entry，仅 is_directory)"
```

---

## 任务 2：Rust `find_next_volume` command 实现

**文件：**
- 修改：`src-tauri/src/commands/find_next_volume.rs`（stub → async 实现 + `NextVolumeResult`）

**说明：** command 接 `MediaSourceFactory` State，async。**强类型 descriptor**（不操作 serde_json::Value，P1-5）。**仅 Local**（非 Local 返回明确错误，不静默 fallback）。`NextVolumeResult` **无 is_archive 字段**。**删除 filter 参数**（P1-3：reader/masonry 在仅 Local 目录卷下语义一致）。**direction 用强类型 enum**（P2：非法值反序列化边界报错，不静默当 next）。

- [ ] **步骤 1：加 `NextVolumeResult` + `VolumeDirection` enum + 改 `FindNextVolumeArgs`**（spec §5.1）

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VolumeDirection { Next, Prev }   // P2：非法值反序列化报错

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNextVolumeArgs {
    pub descriptor: serde_json::Value,
    pub current_path: String,
    pub direction: VolumeDirection,
    // 无 filter（P1-3 删除）
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextVolumeResult {
    pub descriptor: serde_json::Value,
    pub rel_path: String,
    pub title: String,
    // 无 is_archive
}
```

- [ ] **步骤 2：实现 async command**（spec §5.2）

替换现有 stub。强类型解析 descriptor → match Local 取 root_path（非 Local 返回 `Err`）→ parent_path/segments → list_directory → `pick_sibling(&siblings, &current_basename, args.direction)`（direction 是 enum，非 &str）→ 构造 NextVolumeResult（同源 descriptor + rel_path）。

- [ ] **步骤 3：command 集成测试**（spec §17.1）

mock MediaSourceFactory 或 in-memory source，覆盖：Local 目录跨卷、越界 None、current 不存在、非 Local 返回明确错误。Windows/POSIX 分隔符各一例。

- [ ] **步骤 4：编译 + 测试验证**

```bash
cd src-tauri && cargo check --lib && cargo test -p mirapage-desktop-lib find_next_volume -- --nocapture
```
预期：编译通过；集成测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/find_next_volume.rs
git commit -m "feat(cross-volume): find_next_volume 替换 stub (async + factory + 仅 Local + NextVolumeResult)"
```

---

## 任务 3：前端 `findNextVolume` IPC 改返回类型

**文件：**
- 修改：`src/lib/tauri.ts`（`findNextVolume`）

- [ ] **步骤 1：改 `findNextVolume` + 加 `NextVolumeResult`**（spec §6.1）

```typescript
export interface NextVolumeResult {
  descriptor: SourceDescriptor;
  relPath: string;
  title: string;
  // 无 isArchive
}
// P1-3：删除 filter 参数
export async function findNextVolume(
  descriptor: SourceDescriptor, currentPath: string,
  direction: 'next' | 'prev',
): Promise<NextVolumeResult | null> { ... }
```

- [ ] **步骤 2：type-check**

```bash
npm run type-check
```
预期：无新错误（调用方在任务 5/8 修正）。

- [ ] **步骤 3：Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(cross-volume): findNextVolume IPC 改 NextVolumeResult (无 isArchive)"
```

---

## 任务 4：reader store 扩展

**文件：**
- 修改：`src/stores/reader.ts`
- 修改：`src/stores/reader.test.ts`

**说明：** `saveCurrentProgressNow`（P1-1：构造快照 await，不只 flush pending）；`nextPage` atLast 回调；`setOnAtLastNextAttempt`（卸载清理，不变量 11）；`sourceDescriptor`/`currentRelPath` state；`OpenBookPayload` 扩展。

- [ ] **步骤 1：加测试用例**（spec §17.2 reader store）

覆盖：saveCurrentProgressNow（有/无 pending debounce；首页未翻页；末页 finished=true；await saveProgress）；nextPage atLast 调 onAtLastNextAttempt 不翻页；非末页正常 ++；setOnAtLastNextAttempt(null) 清理。

- [ ] **步骤 2：运行测试验证失败** → `npx vitest run src/stores/reader.test.ts`

- [ ] **步骤 3：实现扩展**（spec §9）

- state `sourceDescriptor`/`currentRelPath`；`OpenBookPayload` 加可选 `sourceDescriptor?`/`currentRelPath?`；openBook 写入。
- `saveCurrentProgressNow()`：取消 debounce + 读 store 当前状态构造 PageChangeInfo + await saveProgress。
- `nextPage`：`isAtLastSpread` 时调 `onAtLastNextAttempt?.()` 不翻页；else ++。
- `setOnAtLastNextAttempt(fn|null)`。
- return 加全部新成员。

- [ ] **步骤 4：运行测试验证通过** → `npx vitest run src/stores/reader.test.ts`

- [ ] **步骤 5：Commit**

```bash
git add src/stores/reader.ts src/stores/reader.test.ts
git commit -m "feat(cross-volume): reader store 加 saveCurrentProgressNow + nextPage atLast 回调 + sourceDescriptor/currentRelPath"
```

---

## 任务 5：useCrossVolume — CrossVolumeController

**文件：**
- 创建：`src/composables/useCrossVolume.ts`
- 创建：`src/composables/useCrossVolume.test.ts`

**说明：** 状态机 `idle/resolving/awaiting-confirm/navigating`；requestSeq + sameBookIdentity 结构化校验；trySave 包裹（保存失败不进 navigate 失败分支，不变量 10）；clearPendingState（仅清数据+slideshow flag）vs dismissManual（toast close 专用，只在 awaiting-confirm 生效 + 推 seq）。全部依赖经 opts 注入（可独立单测）。

- [ ] **步骤 1：编写失败的测试**（spec §17.2 useCrossVolume）

注入 opts（mock findNextVolume + identity + navigateToVolume + saveCurrentProgressNow + pushToast + getContinueMode + pauseSlideshow + consumePendingNextVolume + **canStart**）。覆盖：
- maybeContinue(force=true) 直接 navigate（不看 mode）。
- **force=false + off → return + consumePendingNextVolume 调用一次 + findNextVolume 不调用 + navigateToVolume 不调用**（P0-1：off 在 find 前处理）。
- force=false + auto → navigateResolvedTarget。
- force=false + manual → 填 pendingCrossVolume + identityAtArm，phase=awaiting-confirm，不 navigate。
- **canStart()=false（加载期）→ maybeContinue 直接 return，findNextVolume 不调用**（P1-1：末页 flag / 9宫格 / Alt+→ 在 route Loader 未完成时都不发起跨卷）。**且 consumePendingNextVolume 调用一次**（边界：加载期 pendingNextVolume 已置位，消费它防止 flag 停留 true 导致后续跨卷意图丢失）。
- confirmManual：identity 未变 → navigate；identity 已变 → 丢弃。
- **confirmManual 双击守卫**（P1-2）：两次同步 confirmManual() → saveCurrentProgressNow/navigateToVolume 各只调用一次（第二次因 phase!=='awaiting-confirm' return）。
- dismissManual：只在 awaiting-confirm 生效 + 推 requestSeq（失效旧请求）+ settleIdle。
- **navigateResolvedTarget 失败路径 pending 清空**（P0-2 不变量）：identity 初校验失败 / 保存后二次校验失败 / navigateToVolume throw → 三种情况都 pendingCrossVolume===null + phase idle（用 settleIdle）。
- 陈旧请求：A 发起 find，期间切到 B（identity 变），A 晚返回 → 丢弃（不 navigate）+ pending 清空。
- 保存失败：trySaveCurrentProgress toast progressSaveFailed + **不进 navigate 失败分支**（navigateToVolume 仍调）。
- 用 deferred promise，测试末尾 resolve/reject（无悬挂任务，P1-5）。

- [ ] **步骤 2：运行测试验证失败** → `npx vitest run src/composables/useCrossVolume.test.ts`

- [ ] **步骤 3：实现 useCrossVolume**（spec §10）

签名 + 内部函数严格按 spec §10：maybeContinue（off 前置 + **canStart 入口守卫，P1-1**）/ confirmManual（**开头 phase 守卫防双击，P1-2**）/ navigateResolvedTarget（settleIdle 收口）/ trySaveCurrentProgress / clearPendingState / dismissManual / **settleIdle**（集中收口所有终止路径）。`sameBookIdentity` 从 spec §7 复制（结构化比较）。opts 含 canStart 注入。

- [ ] **步骤 4：运行测试验证通过** → `npx vitest run src/composables/useCrossVolume.test.ts`

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useCrossVolume.ts src/composables/useCrossVolume.test.ts
git commit -m "feat(cross-volume): useCrossVolume Controller (状态机 + 竞态 + trySave + clearPending/dismissManual)"
```

---

## 任务 6：useToast + ToastHost

**文件：**
- 创建：`src/composables/useToast.ts`
- 创建：`src/composables/useToast.test.ts`
- 创建：`src/components/common/ToastHost.vue`

- [ ] **步骤 1：编写失败的测试**（spec §17.2）

useToast：push 显示 + 1500ms 自动隐藏；队列上限 1（后者替换）；dismiss 清空。

- [ ] **步骤 2：运行验证失败** → `npx vitest run src/composables/useToast.test.ts`

- [ ] **步骤 3：实现 useToast**（单例 ref + setTimeout，`let timerId: any` 绕过 Node/happy-dom 类型差异）

- [ ] **步骤 4：实现 ToastHost.vue**（`<Teleport to="body">`，`role="status" aria-live="polite"`，`data-test="toast-host"`）

- [ ] **步骤 5：运行验证通过** → `npx vitest run src/composables/useToast.test.ts`

- [ ] **步骤 6：Commit**

```bash
git add src/composables/useToast.ts src/composables/useToast.test.ts src/components/common/ToastHost.vue
git commit -m "feat(toast): useToast composable + ToastHost 组件 (通用 toast)"
```

---

## 任务 7：ContinueNextVolumeToast（纯 props/emits）

**文件：**
- 创建：`src/components/reader/ContinueNextVolumeToast.vue`
- 创建：`src/components/reader/ContinueNextVolumeToast.test.ts`

**说明：** **不调 `useCrossVolume()`**（P0-2 修复）。纯 props/emits。

- [ ] **步骤 1：编写失败的测试**（spec §17.2，P1-5：直接测 props/emits，不注入 composable）

mount 时传 props，断言：target null → 不渲染；target 有值 → 显示标题；点 jump → emit jump；点 close → emit close；loading=true → jump button disabled。用 vue-i18n mock（`useI18n: () => ({ t: (k) => k })`）。

- [ ] **步骤 2：运行验证失败** → `npx vitest run src/components/reader/ContinueNextVolumeToast.test.ts`

- [ ] **步骤 3：实现组件**（spec §12，props target/loading，emits jump/close）

- [ ] **步骤 4：运行验证通过** → `npx vitest run src/components/reader/ContinueNextVolumeToast.test.ts`

- [ ] **步骤 5：Commit**

```bash
git add src/components/reader/ContinueNextVolumeToast.vue src/components/reader/ContinueNextVolumeToast.test.ts
git commit -m "feat(cross-volume): ContinueNextVolumeToast 胶囊 (纯 props/emits，不调 useCrossVolume)"
```

---

## 任务 8：ReaderView 编排层接线

**文件：**
- 修改：`src/views/ReaderView.vue`
- 修改：`src/views/ReaderView.test.ts`
- 修改：`src/composables/useReaderHotkeys.ts`（P1-2：加 `ReaderHotkeyActions` 参数，folderNext 接 actions.nextVolume）
- 修改：`src/composables/useReaderHotkeys.test.ts`（actions 参数回归）

**说明：** route watch immediate（删 onMounted，唯一入口，不变量 2）；loadRouteBook（去重看 phase=ready，不变量 3；失败不保留旧卷，不变量 1）；commitBookSnapshot（任务 0 已建，这里改 loadRouteBook 用它）；retryCurrentBook；navigateToVolume（ensureBookId+replace）；Controller 实例化（注入 8 个 opts：identity/navigateToVolume/saveCurrentProgressNow/pushToast/getContinueMode/pauseSlideshow/consumePendingNextVolume/canStart）；触发接线（末页 watch + 9宫格 zoneActions.nextVolume + Alt+→ 经扩展的 useReaderHotkeys）；卸载清理（setOnAtLastNextAttempt(null) + activeLoadSeq++ 使在途 Loader 失效）。

- [ ] **步骤 1：加 ReaderView 测试用例**（spec §17.2）

mock loader + router + route，覆盖：loadRouteBook 去重（同 bookId+ready 跳过）；失败不保留旧卷（closeBook+清 refs+error UI）；stale 丢弃（activeLoadSeq）；commitBookSnapshot 原子提交；retryCurrentBook 重置 lastLoadedBookId。

- [ ] **步骤 2：运行测试验证失败** → `npx vitest run src/views/ReaderView.test.ts`

- [ ] **步骤 3：实现编排层**（spec §11）

- 删 `onMounted(loadBook)` + `onNextVolume` 旧逻辑。
- 加 `lastLoadedBookId`/`bookLoadPhase`/`visibleReader`；**`let activeLoadSeq = 0`（非 const，非 ref，模板不消费；P0-3）**。
- `watch(() => Number(route.params.bookId), loadRouteBook, { immediate: true })`。
- `loadRouteBook`：去重（bookId===lastLoadedBookId && phase==='ready'）→ `seq = ++activeLoadSeq` → phase=loading/visibleReader=false → loader.loadBookById → `seq !== activeLoadSeq` 则 return（stale）→ commitBookSnapshot + ready 或 catch（closeBook+清 refs+error）。
- `navigateToVolume`：loader.ensureBookId → router.replace({params:{bookId}, query:{}})。
- Controller 实例化（注入 identity/navigateToVolume/saveCurrentProgressNow/pushToast/getContinueMode/pauseSlideshow/consumePendingNextVolume/**canStart**）。**currentIdentity（P1-1）：bookLoadPhase!=='ready' 或 reader.bookId!==Number(route.params.bookId) 时返回 null**（加载期/分裂期拒绝）。**canStart: () => bookLoadPhase.value === 'ready'**。
- `reader.setOnAtLastNextAttempt(() => { slideshow.pendingNextVolume = true; })`。
- `watch(() => slideshow.pendingNextVolume, v => v && crossVolume.maybeContinue(false,'next'))`。
- **9 宫格**：`zoneActions.nextVolume = () => void crossVolume.maybeContinue(true,'next')`（替换现有调 onNextVolume 的实现，ReaderView.vue:526）。
- **Alt+→（P1-2）**：`useReaderHotkeys({ nextVolume: () => void crossVolume.maybeContinue(true,'next') })`（useReaderHotkeys 扩展接受 actions，folderNext dispatch 调 actions.nextVolume，见 useReaderHotkeys.ts 修改）。
- 模板挂 `<ToastHost/>` + `<ContinueNextVolumeToast :target="crossVolume.pendingCrossVolume.value" :loading="crossVolume.phase.value==='navigating'" @jump="crossVolume.confirmManual()" @close="crossVolume.dismissManual()"/>`。
- onUnmounted：`reader.setOnAtLastNextAttempt(null)` + **`activeLoadSeq += 1`（P0-3：使在途 Loader 失效，卸载后不执行提交）** + `reader.saveCurrentProgressNow()` 兜底 + slideshow.pause + reader.closeBook。

- [ ] **步骤 4：运行 + type-check**

```bash
npm run type-check && npx vitest run src/views/ReaderView.test.ts
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/views/ReaderView.vue src/views/ReaderView.test.ts src/composables/useReaderHotkeys.ts src/composables/useReaderHotkeys.test.ts
git commit -m "feat(cross-volume): ReaderView 编排层 + useReaderHotkeys actions (route watch immediate + loadRouteBook + 9宫格/Alt 接线 + 卸载清理)"
```

---

## 任务 9：瀑布流跨卷（useMasonryBrowsePosition.flushNow + 工具栏按钮）

**文件：**
- 修改：`src/composables/useMasonryBrowsePosition.ts`（加 flushNow）
- 修改：`src/composables/useMasonryBrowsePosition.test.ts`
- 修改：`src/components/filebrowser/FileBrowser.vue`（按钮 + onCrossNextVolume）

**文件：**
- 修改：`src/composables/useMasonryBrowsePosition.ts`（加 flushNow）
- 修改：`src/composables/useMasonryBrowsePosition.test.ts`
- 修改：`src/components/filebrowser/MasonryView.vue`（P1-1：defineExpose 加 flushBrowsePosition）
- 修改：`src/components/filebrowser/FileList.vue`（P1-1：加 masonryFlushNow + defineExpose）
- 修改：`src/components/filebrowser/FileBrowser.vue`（按钮 + onCrossNextVolume 经 fileListRef.masonryFlushNow）

**说明：** 按钮**不绑 viewMode**（P1-3：details 回落后仍可达）；**disabled 不含 !hasImages**（P0-4：无图目录仍可点跳过，改为 `swapping || !fb.rootPath || !fb.lastFetchedPath`）；用 `lastFetchedPath`（P1-4，不用 currentPath）；结果落地前校验 lastFetchedPath === pathAtRequestStart。**flushNow 转发链**（P1-1）：FileBrowser 无法直接拿 MasonryView 内的 browsePosition，经现有 defineExpose 模式转发（FileBrowser → FileList → MasonryView）。

- [ ] **步骤 1：加 flushNow 测试** → useMasonryBrowsePosition.test.ts：flushNow 立即触发 recordCurrentTop 不等 300ms debounce。

- [ ] **步骤 2：运行验证失败** → `npx vitest run src/composables/useMasonryBrowsePosition.test.ts`

- [ ] **步骤 3：实现 flushNow**（spec §14.3：清 debounce + await recordCurrentTop）

- [ ] **步骤 3b：转发链（P1-1，spec §14.4）**
  - `MasonryView.vue`：defineExpose 加 `flushBrowsePosition: () => browsePosition.flushNow()`（现有 defineExpose 已暴露 browsePosition/jumpToLast 等，本次扩展）。
  - `FileList.vue`：加 `async function masonryFlushNow() { await masonryRef.value?.flushBrowsePosition(); }` + defineExpose 加 masonryFlushNow（现有已有 masonryRef + defineExpose 模式）。
  - `FileBrowser.vue`：onCrossNextVolume 内 `await fileListRef.value?.masonryFlushNow()`。

- [ ] **步骤 4：FileBrowser 工具栏加按钮**（spec §14.1，**不绑 viewMode**，`:disabled="swapping || !fb.rootPath || !fb.lastFetchedPath"`，与"↶ 跳到上次"同区）+ `onCrossNextVolume`（spec §14.2：fileListRef.masonryFlushNow → findNextVolume(descriptor, lastFetchedPath, 'next')（**无 filter 参数**，P1-3）→ 落地前校验 lastFetchedPath === pathAtRequestStart → fb.navigate）

- [ ] **步骤 5：type-check + 单测**

```bash
npm run type-check && npx vitest run src/composables/useMasonryBrowsePosition.test.ts src/components/filebrowser/FileBrowser.test.ts
```
FileBrowser.test.ts 若因新按钮失败，补 mock。

- [ ] **步骤 6：Commit**

```bash
git add src/composables/useMasonryBrowsePosition.ts src/composables/useMasonryBrowsePosition.test.ts src/components/filebrowser/MasonryView.vue src/components/filebrowser/FileList.vue src/components/filebrowser/FileBrowser.vue
git commit -m "feat(cross-volume): 瀑布流工具栏下一卷按钮 (不绑 viewMode + lastFetchedPath + flushNow 转发链)"
```

---

## 任务 10：i18n 7 key × 2 locale

**文件：**
- 修改：`src/locales/zh-CN.ts` + `en-US.ts`

- [ ] **步骤 1：加 key**（spec §16）

`reader.crossVolume.{none,jumped,failed,progressSaveFailed,continuePrompt,jump}` + `fileBrowser.nextVolume`。zh/en 对齐。

- [ ] **步骤 2：i18n 对齐测试**

```bash
npx vitest run src/locales/i18n-keys.test.ts src/locales/locales.test.ts
```
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(cross-volume): i18n 7 key × 2 locale"
```

---

## 任务 11：全测 + type-check + 本地 build + E2E

> **注：** tag/push 不在本任务。全部验证通过后，由分支收尾流程（finishing-a-development-branch skill）决定 commit/tag/push。

- [ ] **步骤 1：前端全测 + type-check**

```bash
npm run type-check && npm test -- --run
```
预期：type-check 无错；全测绿（新增 useReaderBookLoader + useCrossVolume + useToast + ContinueNextVolumeToast + reader store 扩展 + pick_sibling + find_next_volume 集成 + flushNow）。

- [ ] **步骤 2：Rust 测试**

```bash
cd src-tauri && cargo test --lib --no-fail-fast
```
预期：`pick_sibling` + `find_next_volume` 集成测试全绿。
**基线说明：** 现有 `algorithm/path::test_crumbs` + `source/webdav_impl::parse_propfind` 2 个已知失败与本功能无关（见 feature-matrix.md）。若本次改动导致**其他**测试失败，必须修复；上述 2 个允许保持现状，但需在 PR/commit 说明里记录精确测试名 + 失败原因 + 与本功能无关的证据。

- [ ] **步骤 3：本地 build portable（验证打包）**

```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"
```
预期：成功生成 portable exe。

- [ ] **步骤 4：E2E 手测清单**（spec §17.3，全部勾选）

- [ ] Local 目录跨卷：auto 末页再向下 → 自动跳下一目录
- [ ] manual 末页再向下 → 胶囊 → 点跳转 → 跳下一卷
- [ ] off 末页再向下 → 不跳
- [ ] 9 宫格 folder-next / Alt+→ → 即时跨
- [ ] 末页触发时机：倒数第二页 nextPage 翻到末页不触发；末页再向下才触发
- [ ] 跨卷后画面/标题/总页数/imageName/bookId/URL 全属新卷
- [ ] 跨卷后刷新仍打开新卷
- [ ] 跨卷后收藏/喜欢/书签作用于新卷
- [ ] manual 胶囊显示，关闭后不因旧请求重新出现
- [ ] 连续快速触发只加载一次
- [ ] 从 A 发起 find、切到 B、A 晚返回 → 结果丢弃
- [ ] 瀑布流从有图目录跳到无图目录后仍可继续下一卷
- [ ] 首页未翻页直接强制下一卷 → 当前进度仍保存
- [ ] 加载失败 → 显示新卷错误页，不停留旧卷
- [ ] 智能恢复：读过一半的卷 → 恢复 page；已读完 → 第 1 页

- [ ] **步骤 5：收尾 commit（不含 tag/push）**

```bash
git add -A
git commit -m "test(cross-volume): 全测 + type-check + 本地 build + E2E 手测通过"
```

后续 tag/push 由 finishing-a-development-branch skill 引导决定。

---

## 自检结果

**spec 覆盖度**（spec v2 各节 → 任务映射）：
- §5 Rust find_next_volume → 任务 1（pick_sibling）+ 任务 2（command）
- §6 IPC → 任务 3
- §8 useReaderBookLoader → 任务 0
- §9 reader store → 任务 4
- §10 useCrossVolume → 任务 5
- §11 ReaderView 编排 → 任务 8
- §12 ContinueNextVolumeToast → 任务 7
- §13 useToast/ToastHost → 任务 6
- §14 瀑布流 → 任务 9
- §16 i18n → 任务 10
- §17 测试 → 各任务 TDD + 任务 11 集成

**审查报告 §5 修改清单对照**：
- ✅ 任务 0 前置"抽取统一 Loader"（§5 实施计划第 1 条）
- ✅ 任务 2 删 Archive 伪代码（§5 第 2 条）
- ✅ 删 TS 虚假 filter（§5 第 3 条，文件结构"不改"栏明确）
- ✅ 任务 4 saveNow 返回 Promise + 构造快照（§5 第 4 条）
- ✅ 任务 5 不复制 list/sort/URL，改调 loader（§5 第 5 条）
- ✅ 任务 7 toast props/emits 不调 useCrossVolume（§5 第 6 条）
- ✅ 任务 8 route watch + 回调清理测试（§5 第 7 条）
- ✅ 任务 9 lastFetchedPath + details 回落按钮可达（§5 第 8 条）
- ✅ 任务 11 不预先接受 Rust 2 失败（§5 第 9 条，基线说明）
- ✅ tag/push 不进默认任务（§5 第 10 条，任务 11 注释 + 收尾 commit）

**v2 架构关键不变量落地检查**：
- route 唯一真值：任务 8 watch immediate + loadRouteBook
- 失败不保留旧卷：任务 8 loadRouteBook catch 分支
- 原子提交：任务 0 commitBookSnapshot
- Controller loading 覆盖 loader：任务 8 busy = phase!=='idle' || bookLoadPhase==='loading'
- pendingCrossVolume 只在 awaiting-confirm：任务 5 dismissManual/clearPendingState
- trySave 不进 navigate 失败分支：任务 5 trySaveCurrentProgress
- 卸载清理 setOnAtLastNextAttempt(null)：任务 8 onUnmounted

**占位符扫描**：无 TODO/待定。任务 0/8 的"grep 找接线点"是引导校对（现有代码字段名/回调点），非臆造。任务 2 集成测试 mock MediaSourceFactory 模式需参考现有 commands 测试，但 spec §17.1 已列覆盖点。

**类型一致性**：`ReaderBookSnapshot`/`NextVolumeTarget`/`LoadBookOptions`/`BookIdentity` 在 spec §7 定义，任务 0/5 实现，任务 8 消费，一致。`NextVolumeResult` Rust（无 is_archive）+ TS（无 isArchive）字节级一致。
