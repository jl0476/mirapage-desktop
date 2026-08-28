# 缩略图调度器 Clone+Drop 误杀 actor 修复计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 `0154ecc`（bug⑤ 热修"clear/request 命令搬 spawn_blocking"）引入的回归——`SchedulerHandle` 的 `Clone + Drop(发 Shutdown)` 组合导致每次 `request_thumbnails` / `clear_thumbnail_cache` 命令结束时临时 clone 析构就把调度器 actor 关掉，前端瀑布流全部卡片永久卡 `generating`。

**架构：** 删除 `SchedulerHandle` 的 `impl Drop` 与 `Command::Shutdown` 变体（含 run() 的 match 臂）。actor 本就持有自身 tx 克隆，`recv()` 永不返回 `None`，单例 service 活到进程退出——`0154ecc` 之前全进程只有一个 handle，Drop 只在退出时触发；删除后行为等价，且任何临时 clone 的析构不再有副作用。配一个回归测试锁定"clone 丢弃后 actor 必须存活"。

**技术栈：** Rust（tokio mpsc/oneshot actor）、Vitest 无关（前端零改动）、CDP 实机验证。

---

## 1. 背景：根因与证据链（2026-08-28 实机 CDP 取证）

### 1.1 症状

- dev 实例（`0154ecc` + 前端 WIP）进入 `D:/Wallpaper/normal`（224 项）瀑布流：列表加载正常、masonry 挂载正常，但**所有缩略图卡片永久停在「排队」/「写入」态**，DOM 0 个 `<img>`。
- CDP 读 `MasonryView.setupState.thumbStateMap`：72 项全部 `kind: 'generating'`，0 cached / 0 original / 0 failed。

### 1.2 根因代码

`src-tauri/src/thumbnail/scheduler.rs`：

```rust
/// 调度器句柄。drop 时发送 Shutdown。
#[derive(Clone)]                       // ← scheduler.rs:169
pub struct SchedulerHandle { tx: mpsc::UnboundedSender<Command> }

impl Drop for SchedulerHandle {        // ← scheduler.rs:239-243
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}
```

`0154ecc` 为让命令拿到 `'static` service 给 `ThumbnailService` 加了 `#[derive(Clone)]`（`service.rs:458`），命令侧随即出现临时 clone：

```rust
// src-tauri/src/commands/thumbnails.rs:43（request_thumbnails）
let svc = service.inner().clone();
let results = tokio::task::spawn_blocking(move || svc.request(...)).await;  // svc 在此析构
// src-tauri/src/commands/thumbnails.rs:143（clear_thumbnail_cache）同款
```

**Rust 语义：`#[derive(Clone)]` + 自定义 `Drop` 意味着每个 clone 析构都触发 Drop**——命令返回时临时 clone 析构 → `Shutdown` 进 unbounded 队列 → actor `break` 退出 → `pending`（~70）+ `inflight`（2）持有的全部 72 个 reply sender 一次性丢弃。service.rs:457 注释"浅克隆共享同一底层"对 channel 成立，但 Drop 按**句柄实例**触发，不按底层存亡。

### 1.3 证据链（全部实测）

1. **日志时间线**（main.log，本地时间 17:40:37）：
   - `:37.497` flushRequest → `:37.501` `request_thumbnails enter`（72 项，epoch=2）
   - `:37.546` `request_thumbnails done`——此刻命令返回，clone 析构，`Shutdown` 入队（排在尚未消费的 Submit 之后）
   - actor 按 FIFO 继续消费已入队 Submit：`ENQUEUE` 日志持续到 `:37.574`（共 72 条全部处理）
   - 撞上 `Shutdown` → actor 退出 → **72 条 `spawn_completion channel closed` 风暴**（`:37.574-591`）
2. **2 个在跑 worker 不受影响跑完并写盘**（`result=CACHED`），但 `Completed` 事件发进死 channel 被吞——所以连"第一批出图"都没有；其余 ~70 个任务死在 pending，无任何 `scheduler start worker`。
3. **活性探针**：从页面 invoke `notify_thumbnail_epoch(99)` → 命令层日志出现、actor 层 `scheduler new_epoch` 日志**未出现**——actor 死亡实锤。之后所有新请求 `tx.send` 失败被 `let _ =` 吞掉，reply 当场丢弃，前端永远等不到结果。
4. **排除项**：后台 stderr 无 panic（env_logger 行持续捕获中）；无 `cancel_all` / 后续 `new_epoch` 日志；`RemoteFetchActor` 同批加 Clone 但**没有** Drop impl，安全；与 RDP/softbuffer、WebView2、bug④ 均无关——纯逻辑 bug。
5. **前端 WIP（`useMasonryThumbnails.ts` applyResults 事务化）与本 bug 无关**。

### 1.4 为什么测试没抓住

scheduler 单测（`scheduler.rs` tests 模块）从未做"clone handle 后丢弃 clone"这个动作——`setup()` 返回的唯一 handle 活到测试结束，Drop 触发的 Shutdown 正好是测试收尾的优雅退出，语义完全正确。只有生产命令路径的临时 clone 才暴露组合缺陷。

### 1.5 影响面

- 受害命令：`request_thumbnails`、`clear_thumbnail_cache`（两处 `inner().clone()`）。
- 后果：**每次进入瀑布流（冷路径）第一个缩略图请求就会杀死调度器**；此后该进程内所有缩略图请求静默失效（卡片永久 spinner）。首次请求也已残废：已入队任务被 Shutdown 陪葬，2 个 in-flight 任务的结果事件丢失。
- 关联澄清：3.5.4 记录的 bug④（release 冷目录渲染冻结，WebView2 原生层）与本 bug **不同源**。`0154ecc`（17:22）之后若有"瀑布流卡住"类复现，需优先按本 bug 归因。

---

## 2. 方案选型

| 选项 | 做法 | 评估 |
|---|---|---|
| **A. 删除 Drop + Shutdown 变体（选定）** | actor 生命周期与进程一致；`recv()` 因 actor 自持 tx 永不 None，本来就没有第二条退出路径 | 最小改动（3 处删除 + 1 处注释）；行为与 `0154ecc` 之前等价（当时全进程唯一 handle 只在退出时触发 Drop）；单例 service 场景无泄漏顾虑——进程退出时 runtime 一并回收 |
| B. 引用计数守卫 | `Arc<AtomicUsize>` 计数，最后一个 handle drop 才发 Shutdown | 为"优雅退出"这个无人消费的能力引入状态与复杂度；YAGNI |
| C. 命令侧不 clone service | 回退 spawn_blocking 搬迁 | 治标；`0154ecc` 的 spawn_blocking 本身是正确加固（Db 同步 IO 不占 async worker），不应回退 |

选 A。注意删除 `Shutdown` 变体的原因：删 Drop 后无人构造该变体，dead code 警告会进 CI 日志；且留着会误导后来人以为存在优雅关闭路径。

---

## 3. 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/thumbnail/scheduler.rs` | 修改 | ① tests 模块新增回归测试 `clone_handle_drop_does_not_shutdown_actor`；② 删 `Command::Shutdown` 变体（:150）；③ 删 run() 的 `Command::Shutdown => break,` 臂（:267）；④ 删 `impl Drop for SchedulerHandle`（:239-243）；⑤ 更新 :168 doc 注释 |
| 其余全部文件 | 不动 | 前端零改动；service.rs / commands/ 零改动（两处 `inner().clone()` 随本修复自动安全） |

---

## 4. 任务分解

### 任务 1：回归测试（先红）

**文件：**
- 修改：`src-tauri/src/thumbnail/scheduler.rs`（tests 模块，建议插在 `on_progress_closure_is_passed_to_generate` 用例之后，:717 附近）

- [ ] **步骤 1：编写失败的测试**

```rust
/// 2026-08-28 实机 bug 回归守卫：request_thumbnails / clear_thumbnail_cache 命令尾的
/// 临时 service clone 析构，曾通过 SchedulerHandle::Drop 发 Shutdown 误杀调度器 actor
/// （72 任务 channel closed 风暴，前端瀑布流全部卡片永久卡 generating）。
/// 句柄必须可自由 Clone：任意 clone 的丢弃不得影响 actor 存活与后续调度。
#[tokio::test]
async fn clone_handle_drop_does_not_shutdown_actor() {
    let (handle, mut rx) = setup(SchedulerConfig {
        worker_limit: 1,
        memory_budget_mb: 1024,
        starvation_threshold: Duration::from_secs(60),
    });
    // 模拟 commands/thumbnails.rs:43 的 `let svc = service.inner().clone();` + 命令结束析构
    drop(handle.clone());
    // actor 必须存活：提交的任务仍要被调度到 generate 闭包
    let r = handle.submit(task("survivor", Priority::Visible, 1, 10));
    let (_job, reply) = recv_job(&mut rx).await;
    let _ = reply.send(Ok(ok_thumb()));
    assert!(matches!(r.await.unwrap(), Outcome::Cached(_)));
}
```

全部复用现有测试基建（`setup` / `task` / `recv_job` / `ok_thumb`，scheduler.rs:638-692），无需新增 import。

- [ ] **步骤 2：运行测试验证失败（红）**

```bash
cd src-tauri
cargo test -j 2 clone_handle_drop_does_not_shutdown_actor
```

预期：FAIL。失败形态：`drop(handle.clone())` 发出的 `Shutdown` 先于 Submit 入队（unbounded FIFO），actor 处理完 Shutdown 即退出，`recv_job` 1s 超时 panic（`timeout waiting for job`）；或 `r.await.unwrap()` 因 reply sender 随死 channel 丢弃而 panic（`RecvError`）。两者皆为有效红灯。

### 任务 2：删除 Drop + Shutdown（转绿）

**文件：**
- 修改：`src-tauri/src/thumbnail/scheduler.rs`

- [ ] **步骤 1：删 `Command::Shutdown` 变体**

`scheduler.rs:150`，删除枚举最后一项：

```rust
    Completed {
        cache_key: String,
        epoch: u64,
        est_memory_mb: u32,
        result: Result<GeneratedThumbnail, ThumbnailError>,
    },
    Shutdown,          // ← 删除此行
}
```

- [ ] **步骤 2：删 run() 的 Shutdown match 臂**

`scheduler.rs:267`，删除：

```rust
            match cmd {
                Command::Shutdown => break,   // ← 删除此行
                Command::Submit { task, reply } => self.handle_submit(task, reply),
```

删变体与删臂需同 commit 完成，否则 `match cmd` 非穷尽编译失败。

- [ ] **步骤 3：删 `impl Drop for SchedulerHandle`**

`scheduler.rs:239-243`，整块删除：

```rust
impl Drop for SchedulerHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}
```

- [ ] **步骤 4：更新句柄 doc 注释**

`scheduler.rs:168`：

```rust
/// 调度器句柄。drop 时发送 Shutdown。
```

改为：

```rust
/// 调度器句柄。可自由 Clone（浅克隆共享同一 actor 与 channel）；actor 生命周期与
/// 进程一致（自持 tx，recv 永不返回 None）。禁止再加"drop 时关闭 actor"语义——
/// 2026-08-28 实机事故：命令侧临时 clone 析构误发 Shutdown 杀死 actor。
```

- [ ] **步骤 5：运行回归测试验证通过（绿）**

```bash
cargo test -j 2 clone_handle_drop_does_not_shutdown_actor
```

预期：PASS。

### 任务 3：全量测试与构建

- [ ] **步骤 1：scheduler + thumbnail 全量**

```bash
cargo test -j 2 thumbnail::
```

预期：全绿（审查方实测基线 130 项通过、0 失败；含既有 11 条 scheduler 老化/取消用例——它们不受影响：handle 活到测试结束，runtime drop 时 actor 一并回收，无跨测试泄漏）。

- [ ] **步骤 2：Rust 全量**

```bash
cargo test -j 2
```

预期：全绿（`0154ecc` 基线 616 lib + 8 + 4 集成 + 1 新增回归 = 617 lib）。

- [ ] **步骤 3：Commit（中文，直推 main，不打 tag——与 3.5.4 热修同模式）**

```bash
git add src-tauri/src/thumbnail/scheduler.rs
git commit -m "fix(thumbnail): SchedulerHandle Clone+Drop 组合误杀调度器 actor

- 0154ecc 给 ThumbnailService 加 Clone 后，request_thumbnails/clear 命令尾的
  临时 clone 析构触发 SchedulerHandle::Drop 发 Shutdown，actor 无声退出：
  pending+inflight 全部 reply sender 丢弃（实机 72 条 channel closed 风暴），
  前端瀑布流卡片永久卡 generating，后续请求 send 失败被静默吞掉
- 删 impl Drop 与 Command::Shutdown（含 run() match 臂）：actor 自持 tx，
  recv 永不 None，单例生命周期与进程一致，0154ecc 之前行为等价
- 回归测试 clone_handle_drop_does_not_shutdown_actor 锁定句柄可自由 Clone"
git push github main
```

### 任务 4：实机验证（CDP）

- [ ] **步骤 1：重启 dev 实例**

```bash
taskkill //F //IM mirapage-desktop.exe
# 等待后台任务退出后重新拉起（带 9222，见 docs/tauri-devtools-debugging.md Step 2）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri:dev
```

- [ ] **步骤 2：进瀑布流并断言恢复**

恢复导航到 `D:/Wallpaper/normal`，切 masonry 视图，等待数秒后 CDP 断言（`Runtime.evaluate`，从 `.masonry-container` 上溯 MasonryView）：

```js
(() => {
  const el = document.querySelector(".masonry-container");
  let comp = el.__vueParentComponent;
  while (comp && comp.type?.__name !== "MasonryView") comp = comp.parent;
  const m = comp.setupState.thumbStateMap;
  const kinds = {};
  for (const [, v] of m) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
  return JSON.stringify({
    kinds,
    imgs: el.querySelectorAll("img").length,
  });
})()
```

预期：`kinds` 中 `cached`/`original` 等可直接显示的正常终态随时间持续增长（policy 允许小图原图直显，`original` 不算失败），且 `imgs > 0`；无永久 `generating` 停滞（滚动后新窗口卡片同样转化）。

- [ ] **步骤 3：日志断言**

`main.log` 尾部：`request_thumbnails done` 之后**持续出现** `scheduler start worker` / `generate done` / `scheduler worker DONE`；全程**无** `spawn_completion channel closed`。二次进入目录（触发二次请求）同样健康——这是命令尾 clone 析构路径的直接回归覆盖。

### 任务 5（独立可选项）：前端 WIP 顺带修（归属用户的削峰系列）

不属于本 bug 修复，建议随 `useMasonryThumbnails.ts` 的 WIP 一起走、独立 commit。事务化后 `'queued'` 分支内 `applyProgressEvent(buffered)` 仍写 `state.value`（旧 Map），循环尾 `state.value = nextStates` 会覆盖循环内应用的 progress——只影响 raced 项的 phase 显示（卡片角标停留在较早阶段）。修法：把 `applyProgressEvent(buffered)` 的调用挪到尾部 `state.value = nextStates;` 赋值**之后**执行（buffered 事件本就该与批量结果应用后再合并），语义不变、丢失消除。

---

## 5. 验证清单（汇总）

| 验证项 | 命令/手段 | 通过标准 |
|---|---|---|
| 回归测试（修复前） | `cargo test -j 2 clone_handle_drop_does_not_shutdown_actor` | FAIL（timeout waiting for job 或 RecvError） |
| 回归测试（修复后） | 同上 | PASS |
| thumbnail 模块 | `cargo test -j 2 thumbnail::` | 全绿 |
| Rust 全量 | `cargo test -j 2` | 全绿，lib 616→617 |
| 实机瀑布流 | CDP 断言 thumbStateMap kinds + img 数 | cached/original 正常终态持续增长、imgs > 0、无停滞 |
| 实机日志 | main.log | 无 channel closed；done 后 worker 持续开工 |
| 二次请求回归 | 目录切出再切入 | 同上健康 |

## 6. 风险与备注

- **语义变化**：调度器不再有显式关闭路径。生产单例（service 由 `app.manage` 持有至退出）与 `#[tokio::test]`（runtime drop 时任务回收）均无泄漏；若未来引入"运行时重建 service"需求，届时再设计引用计数守卫（本计划选项 B），不在本次范围。
- **不修 `commands/thumbnails.rs`**：两处 `inner().clone()` 的 spawn_blocking 搬迁是 `0154ecc` 的正确加固，保留；本修复在句柄侧根除副作用。
- **前端零改动**：`thumbStateMap` 卡死是后端结果断供，前端状态机行为正确；用户 WIP 的事务化削峰方向正确，与本修复正交。
- **AGENTS.md 收尾**：修复验证通过后，在 3.5.4 行补记本回归（`0154ecc` 引入、当日修复），避免 bug④⑤ 归因混淆。
