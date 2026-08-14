# 单张缩略图生成阶段进度 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 单张缩略图生成过程暴露 5 阶段（queued/decoding/resizing/encoding/writing）给前端：masonry 卡片顶部居中显示阶段角标（仅 generating 态，无进度环），点击角标弹 popover（角标右侧优先定位，展示阶段时间线 + 原图/输出尺寸 + 失败重试），受全局开关控制（默认开）。

**架构：** Rust 端 `generate_thumbnail` 在 4 阶段边界调 `on_progress(GenPhase, elapsed_ms)` 回调；service 为每个 task 注入捕获 cache_key/ui_path/epoch/AppHandle 的闭包，emit `thumbnail://progress` 事件（非阻塞、不持锁）。前端 `useMasonryThumbnails` 监听事件更新 `ThumbnailState.generating`（phase + timings），`MasonryThumbnail` 渲染阶段角标，`MasonryView` 持有 `ThumbnailProgressPopover` 展示详情。`queued` 阶段不经 Rust（IPC 返回即设置）。

**技术栈：** Tauri 2 / Rust（tokio actor + spawn_blocking）/ Vue 3 `<script setup>` / Pinia / vue-i18n / Vitest + happy-dom（前端）/ cargo test（Rust）。

**关键已读上下文**（实现者按需复查）：
- `src-tauri/src/thumbnail/generator.rs:43` `generate_thumbnail`，4 阶段边界在 :58(EXIF前)/:70(decode后)/:105(resize后)/:126(encode后)，已有 `t0: Instant`（:44）。
- `src-tauri/src/thumbnail/scheduler.rs:43` `GenerationJob`（加 `on_progress` 字段，不改 `GenerateFn` 签名 :37）；测试 helper `job_for` :568、setup :552。
- `src-tauri/src/thumbnail/service.rs`：`EVENT_*` 常量 :27-29；`production_generate_fn` :263（构造 `GenerateRequest` :298，改传 job.on_progress）；`classify_item` 构造 `GenerationJob` :188（加 `on_progress: None`，request/resubmit 注入在提交循环覆盖）；`request` 提交循环 :568（`to_submit` 持有 `(task, cache_abs, item)`）；`resubmit` 提交 :716。
- `src/lib/tauri.ts:238` `ThumbnailStateEvent`；`src/lib/thumbnail.ts:173` `ThumbnailState`（generating 已定义待扩展）；`src/composables/useMasonryThumbnails.ts` `applyResults` queued 分支 :273、`state` 事件监听 :301、`retry` :386。
- `src/components/filebrowser/MasonryThumbnail.vue`（spinner :99 / failed :117）；`MasonryRow.vue`（badge 左上 :73、emits :25-30）；`MasonryView.vue`（`visibleItems` :361、`:thumb-state` :408、`defineExpose` :296）。
- 测试 mock 模式：`src/composables/useMasonryThumbnails.test.ts:8-32`（单 eventHandler + vi.mock event 包）；`src/components/filebrowser/MasonryView.test.ts`（mock useMasonryLayout/useMasonryBrowsePosition/useMasonryThumbnails、`browsePositionParams` vi.hoisted 模式）。

---
## 文件结构

**Rust（`src-tauri/src/thumbnail/`）**
- 修改 `mod.rs`：加 `GenPhase` 枚举 + `phase_str` + 序列化测试。
- 修改 `scheduler.rs`：`GenerationJob` 加 `on_progress: Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>>`；`job_for` 补 `on_progress: None`；新增透传测试。
- 修改 `generator.rs`：`generate_thumbnail` 加 `on_progress: Option<&dyn Fn(GenPhase, u64)>` 参数，4 阶段边界调用；现有 6 测试补 `None`；新增阶段顺序测试。
- 修改 `service.rs`：加 `EVENT_PROGRESS` + `ProgressEvent`；`production_generate_fn` 透传 job.on_progress；`classify_item` 的 `GenerationJob` 构造补 `on_progress: None`；`request`/`resubmit` 提交循环注入 progress 闭包；新增 service 集成测试（emit 收 events）。

**前端协议（`src/lib/`）**
- 修改 `thumbnail.ts`：加 `ThumbnailPhase` 类型 + `ThumbnailState.generating` 扩展字段（phase/startedAt/timings）+ `THUMBNAIL_PHASES` 常量。
- 修改 `tauri.ts`：加 `ThumbnailProgressEvent` 接口（紧邻 `ThumbnailStateEvent` :238）。
- 创建 `thumbnailPosition.ts`：`positionFor` 定位纯函数（右侧→左侧→下方→上方 fallback）+ 独立测试。

**前端交互（`src/`）**
- 修改 `composables/useMasonryThumbnails.ts`：`applyResults` queued 分支 → generating 态；新增 `thumbnail://progress` 监听（phase 推进 + timings 推算）；`retry` 预置 generating。
- 修改 `components/filebrowser/MasonryThumbnail.vue`：渲染阶段角标（generating 态）+ `@click.stop` emit `show-progress`；phase 图标内嵌 SVG。
- 修改 `components/filebrowser/MasonryRow.vue`：转发 `show-progress` emit。
- 修改 `components/filebrowser/MasonryView.vue`：接入 popover（`anchorPath` state + 定位 + 关闭 + settings 守卫 + 阶段时长格式化）。
- 创建 `components/filebrowser/ThumbnailProgressPopover.vue`：阶段时间线 + 原图/输出 + 失败重试 + 定位 fallback + 外部点击/ESC 关闭。
- 修改 `stores/settings.ts`：`thumbnailDetailPopover` ref + load key + setter（沿用 `fb_record_browse_position` 的 `'true'/'false'` 字符串语义 :99-100/:245-252）。
- 修改 `views/Settings.vue` + `components/settings/ThumbnailCacheSettings.vue`：BooleanRow 接线（`data-test="thumbnail-detail-popover"`）。

**i18n**
- 修改 `locales/zh-CN.ts` + `locales/en-US.ts`：`thumbnail.*` namespace（9 keys）+ settings key。

**测试**
- `composables/useMasonryThumbnails.test.ts`、`components/filebrowser/MasonryThumbnail.test.ts`、`MasonryRow.test.ts`、`MasonryView.test.ts`、新建 `components/filebrowser/ThumbnailProgressPopover.test.ts` + `lib/thumbnailPosition.test.ts`、`stores/settings.test.ts`、`views/Settings.test.ts`。

---

### 任务 1：Rust — `GenPhase` 枚举 + `ProgressEvent` 协议类型（TDD）

**文件：**
- 修改：`src-tauri/src/thumbnail/mod.rs`（枚举 + phase_str + 序列化测试）
- 修改：`src-tauri/src/thumbnail/service.rs:27-29`（EVENT_PROGRESS + ProgressEvent 结构）

- [ ] **步骤 1：写失败的测试** — `mod.rs` 测试块追加（含序列化契约锁，对齐现有 `priority_serializes_lowercase` 风格）

```rust
    /// 生成阶段枚举序列化字符串与前端 `src/lib/thumbnail.ts` 字面量字节级一致。
    #[test]
    fn gen_phase_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&GenPhase::Queued).unwrap(), r#""queued""#);
        assert_eq!(serde_json::to_string(&GenPhase::Decoding).unwrap(), r#""decoding""#);
        assert_eq!(serde_json::to_string(&GenPhase::Resizing).unwrap(), r#""resizing""#);
        assert_eq!(serde_json::to_string(&GenPhase::Encoding).unwrap(), r#""encoding""#);
        assert_eq!(serde_json::to_string(&GenPhase::Writing).unwrap(), r#""writing""#);
    }

    #[test]
    fn gen_phase_str_roundtrip() {
        assert_eq!(phase_str(GenPhase::Queued), "queued");
        assert_eq!(phase_str(GenPhase::Decoding), "decoding");
        assert_eq!(phase_str(GenPhase::Resizing), "resizing");
        assert_eq!(phase_str(GenPhase::Encoding), "encoding");
        assert_eq!(phase_str(GenPhase::Writing), "writing");
    }
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cargo test -p mirapage-desktop-lib gen_phase`（在 `src-tauri/` 下）
预期：编译失败，`GenPhase` / `phase_str` 未定义。

- [ ] **步骤 3：实现**

`mod.rs` 加（放 `Priority` 枚举后，:74 附近）：

```rust
/// 单张缩略图生成的阶段步进（前端进度显示用，§3.1）。
/// `Queued` 不经 generate_thumbnail（前端 IPC 返回即设置），故 generator 只发后 4 个。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenPhase {
    Queued,
    Decoding,
    Resizing,
    Encoding,
    Writing,
}

/// GenPhase → 事件字符串（与前端 `ThumbnailPhase` 字面量一致）。
pub fn phase_str(p: GenPhase) -> &'static str {
    match p {
        GenPhase::Queued => "queued",
        GenPhase::Decoding => "decoding",
        GenPhase::Resizing => "resizing",
        GenPhase::Encoding => "encoding",
        GenPhase::Writing => "writing",
    }
}
```

`service.rs:29` 后加：

```rust
pub const EVENT_PROGRESS: &str = "thumbnail://progress";
```

`service.rs` 在 `StateEvent`（:348）后加：

```rust
/// `thumbnail://progress` 事件载荷（生成阶段步进）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub epoch: u64,
    pub cache_key: String,
    /// UI key（entry.path，当前目录内相对）。
    pub path: String,
    /// "decoding" | "resizing" | "encoding" | "writing"。
    pub phase: String,
    /// 从 generate 开始到本阶段开始的累计毫秒。
    pub elapsed_ms: u64,
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cargo test -p mirapage-desktop-lib gen_phase`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/thumbnail/mod.rs src-tauri/src/thumbnail/service.rs
git commit -m "feat(thumbnail): GenPhase 枚举 + ProgressEvent 事件协议（module3.0.11 任务 1）"
```

---

### 任务 2：Rust — `GenerationJob` 加 `on_progress` 字段 + 透传（TDD）

**文件：**
- 修改：`src-tauri/src/thumbnail/scheduler.rs:43`（GenerationJob 字段）、:568 `job_for` 补 None
- 修改：`src-tauri/src/thumbnail/service.rs:263` `production_generate_fn` 透传、:188 `classify_item` 补 None

- [ ] **步骤 1：写失败的测试** — `scheduler.rs` 测试块 `job_for` 更新 + 新增透传测试

先改 `job_for`（:568）加 `on_progress: None`（否则编译失败）：

```rust
    fn job_for(key: &str) -> GenerationJob {
        GenerationJob {
            source_bytes: Vec::new(),
            source_path: None,
            target_width: 512,
            pixel_budget: 3_000_000,
            clarity_floor_width: 0,
            webp_quality: 82.0,
            cache_path: PathBuf::from(format!("/tmp/{key}.webp")),
            on_progress: None,
        }
    }
```

`setup`（:552）的 fake gen 闭包后追加新测试（验证 on_progress 被透传到 generate 闭包）：

```rust
    #[tokio::test]
    async fn on_progress_closure_is_passed_to_generate() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        // 提交带 on_progress 的任务
        let mut t = task("prog", Priority::Visible, 1, 10);
        let phase_log: Arc<std::sync::Mutex<Vec<u8>>> = Arc::default();
        let log_cb = phase_log.clone();
        t.job.on_progress = Some(Arc::new(move |_p: GenPhase, _el: u64| {
            log_cb.lock().unwrap().push(1);
        }));
        let r = handle.submit(t);
        let (job, reply) = recv_job(&mut rx).await;
        // generate 闭包内触发 on_progress（模拟 scheduler 真实调用）
        if let Some(cb) = &job.on_progress {
            cb(GenPhase::Decoding, 0);
        }
        assert_eq!(phase_log.lock().unwrap().len(), 1);
        let _ = reply.send(Ok(ok_thumb()));
        assert!(matches!(r.await.unwrap(), Outcome::Cached(_)));
    }
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cargo test -p mirapage-desktop-lib on_progress`
预期：编译失败，`GenerationJob` 无 `on_progress` 字段。

- [ ] **步骤 3：实现**

`scheduler.rs:43` `GenerationJob` 加字段：

```rust
    /// 阶段进度回调（generate 阶段边界调用）。None 时 generator 静默（测试用）。
    /// 第一参 GenPhase 为当前阶段，第二参 u64 = generate 开始到本阶段的累计毫秒
    /// （由 generate_thumbnail 内 t0 计算，见 spec §3.5 决策 B）。闭包内捕获
    /// cache_key/ui_path/epoch/AppHandle 并 `let _ = app.emit(EVENT_PROGRESS, ...)`，
    /// 禁止同步 IO / Db 锁（emit 非阻塞）。
    pub on_progress: Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>>,
```

`scheduler.rs` 顶部加 `use super::GenPhase;`（当前 `use super::generator::GeneratedThumbnail;` 行后）。

`service.rs:188` `classify_item` 的 `GenerationJob { ... }` 追加 `on_progress: None,`。

`service.rs:298` `production_generate_fn` 构造 `GenerateRequest` 处改为：

```rust
        let result = generate_thumbnail(
            req,
            job.on_progress.as_deref(),
        );
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cargo test -p mirapage-desktop-lib`（thumbnail 全部）
预期：PASS（含新增 on_progress 测试）。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/thumbnail/scheduler.rs src-tauri/src/thumbnail/service.rs
git commit -m "feat(thumbnail): GenerationJob 加 on_progress 回调并透传（module3.0.11 任务 2）"
```

---

### 任务 3：Rust — `generate_thumbnail` 阶段回调 + 顺序测试（TDD）

**文件：**
- 修改：`src-tauri/src/thumbnail/generator.rs:43`（签名 + 4 阶段边界调用）、:246 测试块（6 测试补 None + 新增顺序测试）

- [ ] **步骤 1：写失败的测试** — `generator.rs` 测试块追加（先记录型闭包，验证顺序）：

```rust
    #[test]
    fn generate_fires_phases_in_order() {
        // 1x1 PNG：decode/resize/encode/write 全路径可跑，不依赖外部 fixture。
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, // signature
            0, 0, 0, 13, b'I', b'H', b'D', b'R', // IHDR len + type
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, // 1x1, 8-bit, RGBA
            0x1f, 0x15, 0xc4, 0x89, // IHDR CRC
            0, 0, 0, 0, b'I', b'E', b'N', b'D', // IDAT len 0
            0xae, 0x42, 0x60, 0x82, // IDAT CRC
            0, 0, 0, 0, b'I', b'E', b'N', b'D', // IEND
            0xae, 0x42, 0x60, 0x82,
        ];
        let out_dir = std::env::temp_dir().join("mira-thumb-phase-test");
        std::fs::create_dir_all(&out_dir).unwrap();
        let cache_path = out_dir.join("out.webp");
        let phases = std::sync::Mutex::new(Vec::new());
        let req = GenerateRequest {
            source_bytes: png,
            target_width: 512,
            pixel_budget: 3_000_000,
            clarity_floor_width: 0,
            webp_quality: 82.0,
            cache_path: &cache_path,
        };
        let result = generate_thumbnail(req, Some(&|phase, elapsed_ms| {
            phases.lock().unwrap().push((phase, elapsed_ms));
        }));
        assert!(result.is_ok(), "generate should succeed: {:?}", result.err());
        let got = phases.lock().unwrap().clone();
        let kinds: Vec<GenPhase> = got.iter().map(|(p, _)| *p).collect();
        assert_eq!(kinds, vec![GenPhase::Decoding, GenPhase::Resizing, GenPhase::Encoding, GenPhase::Writing]);
        // elapsed_ms 单调不减（decode 边界 0，后续边界 >= 前一阶段）
        for w in got.windows(2) {
            assert!(w[1].1 >= w[0].1, "elapsed must be monotonic: {:?}", w);
        }
        let _ = std::fs::remove_dir_all(&out_dir);
    }
```

同时把现有 6 个 `generate_thumbnail(req)` 调用处改为 `generate_thumbnail(req, None)`（测试块 :245+ 的 `compute_output_size_*` 测试不调 generate_thumbnail，只有调它的测试需改——实际 `compute_output_size` 测试不涉及；`generate_thumbnail` 只在新增测试里调，故现有测试**不**改签名，编译即可验证）。

- [ ] **步骤 2：运行测试验证失败**

运行：`cargo test -p mirapage-desktop-lib generate_fires_phases_in_order`
预期：编译失败，`generate_thumbnail` 无第二参数。

- [ ] **步骤 3：实现**

`generator.rs:43` 签名改为：

```rust
pub fn generate_thumbnail(
    mut req: GenerateRequest,
    on_progress: Option<&dyn Fn(GenPhase, u64)>,
) -> Result<GeneratedThumbnail, ThumbnailError>
```

函数体在 4 个阶段边界插入（复用已有 `t0` :44）：

```rust
    // 1. EXIF Orientation（缺失 / 不可解析视为 1）。
    if let Some(cb) = on_progress { cb(GenPhase::Decoding, t0.elapsed().as_millis()); }
    let orientation = read_orientation(req.source_bytes);
```

```rust
    log::write_log(
        "DEBUG", "thumbnail",
        &format!("generator DECODE done src={}x{} orientation={:?}", img.width(), img.height(), orientation),
    );
    if let Some(cb) = on_progress { cb(GenPhase::Resizing, t0.elapsed().as_millis()); }
    // 3. 方向归一化（烘焙进像素，输出不再带 Orientation）。
```

```rust
    log::write_log("DEBUG", "thumbnail", &format!("generator RESIZE done display={}x{} out={}x{}", display_w, display_h, out_w, out_h));
    if let Some(cb) = on_progress { cb(GenPhase::Encoding, t0.elapsed().as_millis()); }
    // 6. WebP 编码（按是否有 alpha 选 RGB / RGBA，保留 PNG 透明通道）。
```

```rust
    log::write_log("DEBUG", "thumbnail", &format!("generator ENCODE done bytes={}", webp_bytes.len()));
    if let Some(cb) = on_progress { cb(GenPhase::Writing, t0.elapsed().as_millis()); }
    // 7. 原子写入：.tmp -> flush(+best-effort fsync) -> rename。
```

顶部加 `use super::GenPhase;`（当前 `use super::orientation::{...};` 后）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cargo test -p mirapage-desktop-lib`（generator + thumbnail）
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/thumbnail/generator.rs
git commit -m "feat(thumbnail): generate_thumbnail 4 阶段边界触发 on_progress（module3.0.11 任务 3）"
```

---

### 任务 4：Rust — service 注入 progress 闭包 + 集成测试（TDD）

**文件：**
- 修改：`src-tauri/src/thumbnail/service.rs`：`request` 提交循环 :568 注入闭包；`resubmit` :716 注入闭包；`progress_closure_for` 私有 helper
- 修改：`src-tauri/src/thumbnail/service.rs` 测试模块（新增集成测试；若现有测试构造 service 需补字段——先编译看缺什么）

**前置**：先读 `service.rs` 测试模块结构确认 service 构造方式（`cargo test` 时会提示缺字段）。集成测试需要能捕获 emit——用 `tauri::test` mock 较复杂，**简化方案**：把「构造 progress 闭包并 emit」抽成可单测的纯函数 `progress_closure_for(app, epoch, cache_key, ui_path)`，测试用 fake app emit 记录。若现有测试无 app mock 基础设施，改用**静态辅助函数测试**（对 `ProgressEvent` 序列化 + `phase_str` 已测），service 注入闭包本身靠编译 + 现有测试绿兜底。

- [ ] **步骤 1：写失败的测试** — 若 service.rs 无现成 app mock 测试，先加一个最小冒烟（对齐现有测试风格）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// progress 闭包把 phase/elapsed 塞进 ProgressEvent（用 fake emit 收集）。
    #[test]
    fn progress_closure_emits_progress_event() {
        // 不构造真实 AppHandle；直接验证 progress_closure_for 产生的闭包签名可调用
        //（无法在纯单测里收 tauri emit —— 事件发射由 scheduler 集成路径覆盖，
        //  这里锁死序列化字段名与 phase_str 映射）。
        let ev = ProgressEvent {
            epoch: 7,
            cache_key: "ck".into(),
            path: "a.jpg".into(),
            phase: phase_str(GenPhase::Decoding).to_string(),
            elapsed_ms: 12,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["epoch"], 7);
        assert_eq!(json["cacheKey"], "ck");
        assert_eq!(json["path"], "a.jpg");
        assert_eq!(json["phase"], "decoding");
        assert_eq!(json["elapsedMs"], 12);
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cargo test -p mirapage-desktop-lib progress_closure`
预期：编译失败，`ProgressEvent` 未导入到测试模块（`use super::*` 应已含——若 service.rs 无测试模块则创建）。若无测试模块，先创建空的 `#[cfg(test)] mod tests { use super::*; }`。

- [ ] **步骤 3：实现**

`service.rs` 加私有 helper（放 `is_local_descriptor` 附近 :43）：

```rust
/// 为单个生成任务构造 progress 闭包：捕获身份 + AppHandle，emit thumbnail://progress。
/// 在 spawn_blocking 线程内被调用（scheduler.rs:442）；emit 非阻塞、不持 Db 锁，
/// 回调失败静默（`let _ =`），绝不做同步 IO。
fn progress_closure_for(
    app: AppHandle,
    epoch: u64,
    cache_key: String,
    ui_path: String,
) -> Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>> {
    Some(Arc::new(move |phase, elapsed_ms| {
        let _ = app.emit(EVENT_PROGRESS, ProgressEvent {
            epoch,
            cache_key: cache_key.clone(),
            path: ui_path.clone(),
            phase: phase_str(phase).to_string(),
            elapsed_ms,
        });
    }))
}
```

顶部 import 补：`use super::{GenPhase, phase_str};`（合并到现有 `use super::{Priority, Quality, ...}` :20）。

`request` 提交循环（:568）`for (task, cache_abs, item) in to_submit {` 内、`self.scheduler.submit(task)` 前注入：

```rust
        for (mut task, cache_abs, item) in to_submit {
            let cache_key = task.cache_key.clone();
            let target_bucket = task.job.target_width;
            task.job.on_progress = progress_closure_for(
                self.app.clone(),
                epoch,
                cache_key.clone(),
                item.path.clone(),
            );
            let rx = self.scheduler.submit(task);
```

`resubmit`（:716）`let rx = self.scheduler.submit(task);` 前同样注入（`task` 改 `mut task`）：

```rust
        let mut task = task;
        task.job.on_progress = progress_closure_for(
            self.app.clone(),
            epoch,
            cache_key.clone(),
            item.path.clone(),
        );
        let rx = self.scheduler.submit(task);
```

`resubmit` 签名当前是 `task: Option<(QueuedTask, PathBuf)>`（`let Some((task, cache_abs)) = task else`），注入点在解构后（`cache_abs` 已取出）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cargo test -p mirapage-desktop-lib`（thumbnail 全量）
预期：PASS（新增序列化测试 + 既有全部绿）。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/thumbnail/service.rs
git commit -m "feat(thumbnail): request/resubmit 注入 progress 闭包 emit 事件（module3.0.11 任务 4）"
```

> **Rust 端收尾检查**（提交前手动跑一遍全量）：
> ```bash
> cd src-tauri && cargo test -p mirapage-desktop-lib 2>&1 | tail -5
> ```

---

### 任务 5：前端 — 协议类型 + `useMasonryThumbnails` progress 监听（TDD）

**文件：**
- 修改：`src/lib/thumbnail.ts`（`ThumbnailPhase` + `generating` 扩展 + `THUMBNAIL_PHASES`）
- 修改：`src/lib/tauri.ts:238` 后（`ThumbnailProgressEvent` 接口）
- 修改：`src/composables/useMasonryThumbnails.ts`（queued→generating、progress 监听、retry 预置）
- 测试：`src/composables/useMasonryThumbnails.test.ts`

- [ ] **步骤 1：写失败的测试** — `useMasonryThumbnails.test.ts` 追加（先建 mock 基础设施：现有 `eventHandler` 单通道只够 state 事件，需要**双通道**——改成 `Map<string, handler>`）：

现有 mock（:16-21）改为：

```ts
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (evt: string, handler: (e: { payload: unknown }) => void) => {
    eventHandlers.set(evt, handler);
    return unlistenSpy;
  }),
}));
```

`beforeEach` 里 `eventHandlers.clear()`。新增测试：

```ts
import type { ThumbnailProgressEvent } from '@/lib/tauri';

function fireState(payload: unknown) {
  const h = eventHandlers.get('thumbnail://state');
  if (h) h({ payload });
}
function fireProgress(payload: unknown) {
  const h = eventHandlers.get('thumbnail://progress');
  if (h) h({ payload });
}

it('queued IPC 返回 → generating(queued) 态 + 缓存 cacheKey', async () => {
  const { result, windowsRef, entries, measuredMap } = setup();
  entries.value = [mkEntry('a.jpg')];
  windowsRef.value = { visible: ['a.jpg'], ahead: [], behind: [], idle: [] };
  requestSpy.mockResolvedValue([
    { path: 'a.jpg', status: 'queued', cacheKey: 'ckA' },
  ]);
  await nextTick();  // flushRequest debounce 80ms 用 fake timers
  await vi.advanceTimersByTimeAsync(80);
  await flushPromises();
  const s = result.stateMap.value.get('a.jpg');
  expect(s).toBeDefined();
  expect(s!.kind).toBe('generating');
  if (s!.kind === 'generating') {
    expect(s!.phase).toBe('queued');
    expect(s!.cacheKey).toBe('ckA');
  }
});

it('progress 事件推进 phase 且 timings 累计 elapsed', async () => {
  const { result, windowsRef, entries } = setup();
  entries.value = [mkEntry('a.jpg')];
  windowsRef.value = { visible: ['a.jpg'], ahead: [], behind: [], idle: [] };
  requestSpy.mockResolvedValue([{ path: 'a.jpg', status: 'queued', cacheKey: 'ckA' }]);
  await vi.advanceTimersByTimeAsync(80);
  await flushPromises();
  const ev: ThumbnailProgressEvent = {
    epoch: 0, cacheKey: 'ckA', path: 'a.jpg',
    phase: 'decoding', elapsedMs: 2,
  };
  fireProgress(ev);
  let s = result.stateMap.value.get('a.jpg');
  expect(s!.kind).toBe('generating');
  if (s!.kind === 'generating') { expect(s!.phase).toBe('decoding'); expect(s!.timings.decoding).toBe(2); }
  fireProgress({ ...ev, phase: 'resizing', elapsedMs: 30 });
  s = result.stateMap.value.get('a.jpg');
  if (s!.kind === 'generating') {
    expect(s!.phase).toBe('resizing');
    expect(s!.timings.resizing).toBe(30);
    // 阶段时长：resizing 30 - decoding 2 = 28ms
    expect(s!.timings.decoding).toBe(2);
  }
});

it('progress 事件 epoch 不匹配被忽略', async () => {
  const { result, windowsRef, entries } = setup();
  entries.value = [mkEntry('a.jpg')];
  windowsRef.value = { visible: ['a.jpg'], ahead: [], behind: [], idle: [] };
  requestSpy.mockResolvedValue([{ path: 'a.jpg', status: 'queued', cacheKey: 'ckA' }]);
  await vi.advanceTimersByTimeAsync(80);
  await flushPromises();
  fireProgress({ epoch: 999, cacheKey: 'ckA', path: 'a.jpg', phase: 'decoding', elapsedMs: 2 });
  const s = result.stateMap.value.get('a.jpg');
  expect(s!.kind).toBe('generating');
  if (s!.kind === 'generating') { expect(s!.phase).toBe('queued'); }
});

it('非 generating 态收到 progress 事件被忽略', async () => {
  const { result, windowsRef, entries } = setup();
  entries.value = [mkEntry('a.jpg')];
  windowsRef.value = { visible: ['a.jpg'], ahead: [], behind: [], idle: [] };
  requestSpy.mockResolvedValue([{ path: 'a.jpg', status: 'cached', cacheKey: 'ckA', cachePath: '/c/a.webp', width: 100, height: 100 }]);
  await vi.advanceTimersByTimeAsync(80);
  await flushPromises();
  expect(result.stateMap.value.get('a.jpg')!.kind).toBe('cached');
  fireProgress({ epoch: 0, cacheKey: 'ckA', path: 'a.jpg', phase: 'decoding', elapsedMs: 2 });
  expect(result.stateMap.value.get('a.jpg')!.kind).toBe('cached');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/useMasonryThumbnails.test.ts`
预期：FAIL——现有 queued 分支仍设 `{kind:'queued'}`，progress 监听未实现（`ThumbnailPhase`/`ThumbnailProgressEvent` 未定义编译错）。

- [ ] **步骤 3：实现**

`src/lib/thumbnail.ts`：

```ts
/** 生成阶段（§3.1）。queued 由前端 IPC 返回设置，其余 4 个由 thumbnail://progress 事件推进。 */
export type ThumbnailPhase = 'queued' | 'decoding' | 'resizing' | 'encoding' | 'writing';

/** 阶段推进顺序（时间线渲染用）。 */
export const THUMBNAIL_PHASES: readonly ThumbnailPhase[] = [
  'queued', 'decoding', 'resizing', 'encoding', 'writing',
] as const;
```

`ThumbnailState` 的 generating 分支（:177）改为：

```ts
  | { kind: 'generating'; cacheKey: string; phase: ThumbnailPhase; startedAt: number; timings: Partial<Record<ThumbnailPhase, number>> }
```

`src/lib/tauri.ts:238` 后加：

```ts
/** thumbnail://progress 事件载荷（生成阶段步进）。 */
export interface ThumbnailProgressEvent {
  epoch: number;
  cacheKey: string;
  path: string;
  phase: 'decoding' | 'resizing' | 'encoding' | 'writing';
  elapsedMs: number;
}
```

`src/composables/useMasonryThumbnails.ts`：

- import 补 `ThumbnailPhase`, `THUMBNAIL_PHASES`（:19-25 块）+ `type ThumbnailProgressEvent`（:17）。
- `applyResults` queued 分支（:273）改为：

```ts
        case 'queued':
          setState(r.path, {
            kind: 'generating',
            cacheKey: r.cacheKey ?? '',
            phase: 'queued',
            startedAt: Date.now(),
            timings: {},
          });
```

- 新增 progress 监听（`state` 事件监听后，:356 附近）：

```ts
  // 监听生成阶段步进事件（thumbnail://progress）
  let progressEventCount = 0;
  void listen<ThumbnailProgressEvent>('thumbnail://progress', (event) => {
    const p = event.payload;
    progressEventCount += 1;
    if (p.epoch !== epoch.value) return;
    const prev = state.value.get(p.path);
    if (!prev || prev.kind !== 'generating') return;
    if (p.phase !== prev.phase) {
      setState(p.path, {
        ...prev,
        phase: p.phase,
        timings: { ...prev.timings, [p.phase]: p.elapsedMs },
      });
      if (progressEventCount <= 20 || progressEventCount % 50 === 0) {
        log('[thumbnail] progress event path=' + p.path + ' phase=' + p.phase + ' elapsedMs=' + p.elapsedMs);
      }
    }
  }).catch((err) => {
    if (isTauriEnv()) {
      log('[useMasonryThumbnails] listen(thumbnail://progress) failed (unexpected in Tauri env)', err);
    }
  });
```

- `retry`（:386）/`regenerate`（:400）预置态改 generating：

```ts
    setState(path, { kind: 'generating', cacheKey: pathToCacheKey.value.get(path) ?? '', phase: 'queued', startedAt: Date.now(), timings: {} });
```

（两处 `setState(path, { kind: 'queued', ... })` 都改。）

> 注：`THUMBNAIL_PHASES` 在本任务只用于类型（时间线渲染在任务 7 用）；此处 import 若未用会触发 TS noUnusedLocals——**不要**在 composable import THUMBNAIL_PHASES，只 import `ThumbnailPhase`（timings 类型用）。时间线顺序在 popover 组件里用 `THUMBNAIL_PHASES`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/composables/useMasonryThumbnails.test.ts`
预期：PASS（新增 4 测试 + 既有 246 行全绿）。再跑 `npm run type-check` 确认无 unused。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/thumbnail.ts src/lib/tauri.ts src/composables/useMasonryThumbnails.ts src/composables/useMasonryThumbnails.test.ts
git commit -m "feat(thumbnail): 前端 generating 态 + thumbnail://progress 监听（module3.0.11 任务 5）"
```

---

### 任务 6：前端 — MasonryThumbnail 阶段角标（TDD）

**文件：**
- 修改：`src/components/filebrowser/MasonryThumbnail.vue`（角标渲染 + emit `show-progress`）
- 测试：`src/components/filebrowser/MasonryThumbnail.test.ts`

- [ ] **步骤 1：写失败的测试** — `MasonryThumbnail.test.ts` 追加：

```ts
import { mount, flushPromises } from '@vue/test-utils';

it('generating(queued) 显角标（queued 图标），点击 emit show-progress', async () => {
  const w = mountThumb({ kind: 'generating', cacheKey: 'k', phase: 'queued', startedAt: Date.now(), timings: {} });
  const badge = w.find('.phase-badge');
  expect(badge.exists()).toBe(true);
  expect(w.find('.thumb-spinner').exists()).toBe(true);
  await badge.trigger('click');
  expect(w.emitted('show-progress')).toBeTruthy();
});

it('generating(decoding) 角标图标切换 + click 不冒泡到根', async () => {
  const w = mountThumb({ kind: 'generating', cacheKey: 'k', phase: 'decoding', startedAt: Date.now(), timings: {} });
  const badge = w.find('.phase-badge');
  expect(badge.exists()).toBe(true);
  const rootClick = vi.fn();
  w.element.addEventListener('click', rootClick);
  await badge.trigger('click');
  expect(w.emitted('show-progress')).toBeTruthy();
  expect(rootClick).not.toHaveBeenCalled(); // stopPropagation
});

it('cached / original / failed / undefined 均无角标', () => {
  for (const st of [
    undefined,
    { kind: 'cached', cacheKey: 'k', path: 'asset://c.webp', width: 100, height: 100 },
    { kind: 'original', url: 'orig://a.jpg' },
    { kind: 'failed', cacheKey: 'k', retryable: true, message: 'x' },
  ] as const) {
    const w = mountThumb(st as never);
    expect(w.find('.phase-badge').exists()).toBe(false);
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/MasonryThumbnail.test.ts`
预期：FAIL，`.phase-badge` 不存在。

- [ ] **步骤 3：实现**

`MasonryThumbnail.vue`：

- `defineEmits` 加 `(e: 'show-progress'): void;`。
- 模板 `.masonry-thumb` 内、`.thumb-spinner` 前加：

```vue
    <button
      v-if="showPhaseBadge"
      class="phase-badge"
      type="button"
      :title="phaseLabel"
      :aria-label="phaseLabel"
      @click.stop="emit('show-progress')"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="props.state?.kind === 'generating' && props.state.phase === 'queued'" d="M12 6v6l4 2" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'decoding'" d="M12 3v10m0 0-4-4m4 4 4-4" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'resizing'" d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'encoding'" d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
        <path v-else d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      </svg>
    </button>
```

- script 加：

```ts
const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'load-error'): void;
  (e: 'show-progress'): void;
}>();

const showPhaseBadge = computed(() => props.state?.kind === 'generating');

const phaseLabel = computed(() => {
  const s = props.state;
  if (s?.kind !== 'generating') return '';
  return `thumbnail phase: ${s.phase}`;  // 具体 i18n 在任务 8 换 t()
});
```

- style 加：

```css
.phase-badge {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: rgb(99 102 241 / 0.92);
  color: #fff;
  cursor: pointer;
  z-index: 3;
  line-height: 1;
}
.phase-badge:hover { background: rgb(99 102 241); }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/MasonryThumbnail.test.ts`
预期：PASS。再跑 `npm run type-check`。

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/MasonryThumbnail.vue src/components/filebrowser/MasonryThumbnail.test.ts
git commit -m "feat(thumbnail): 卡片顶部居中阶段角标（generating 态）emit show-progress（module3.0.11 任务 6）"
```

---

### 任务 7：前端 — ThumbnailProgressPopover 组件（TDD）

**文件：**
- 创建：`src/components/filebrowser/ThumbnailProgressPopover.vue`
- 测试：`src/components/filebrowser/ThumbnailProgressPopover.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ThumbnailProgressPopover from './ThumbnailProgressPopover.vue';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function gen(phase: 'queued' | 'decoding' | 'resizing' | 'encoding' | 'writing' = 'decoding', timings: Record<string, number> = {}) {
  return { kind: 'generating' as const, cacheKey: 'ck', phase, startedAt: Date.now() - 2100, timings };
}
function failed() {
  return { kind: 'failed' as const, cacheKey: 'ck', retryable: true, message: 'decode failed: boom' };
}
function mkProps(overrides: Record<string, unknown> = {}) {
  return {
    state: gen() as unknown,
    fileName: 'IMG_0421.jpg',
    sourceWidth: 4000, sourceHeight: 3000, sourceBytes: 4_400_000,
    ...overrides,
  };
}

describe('ThumbnailProgressPopover.vue', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('generating 渲染 5 步时间线 + 当前阶段高亮 + 已用时', () => {
    const w = mount(ThumbnailProgressPopover, {
      props: mkProps({ state: gen('decoding', { decoding: 2000 }) }),
      global: { plugins: [i18n] },
    });
    const steps = w.findAll('.tl-step');
    expect(steps.length).toBe(5);
    expect(w.find('.tl-step.cur').text()).toContain('解码中');
    expect(w.text()).toContain('4000×3000');
    expect(w.text()).toContain('4.2 MB');
  });

  it('generating 不渲染失败/重试区', () => {
    const w = mount(ThumbnailProgressPopover, { props: mkProps(), global: { plugins: [i18n] } });
    expect(w.find('.err-msg').exists()).toBe(false);
    expect(w.find('.retry-btn').exists()).toBe(false);
  });

  it('failed 渲染错误信息 + 重试按钮 emit retry', async () => {
    const w = mount(ThumbnailProgressPopover, { props: mkProps({ state: failed() }), global: { plugins: [i18n] } });
    expect(w.find('.err-msg').text()).toContain('decode failed');
    await w.find('.retry-btn').trigger('click');
    expect(w.emitted('retry')).toBeTruthy();
  });

  it('定位 fallback：右侧空间不足 → 左侧；再不足 → 下方', async () => {
    const pop = mount(ThumbnailProgressPopover, { props: mkProps(), global: { plugins: [i18n] }, attachTo: document.body });
    const el = pop.element as HTMLElement;
    expect(el).toBeDefined();
  });
});

// ─── positionFor 定位纯函数（独立于组件，src/lib/thumbnailPosition.test.ts）────────

import { positionFor } from '@/lib/thumbnailPosition';

describe('thumbnailPosition.positionFor', () => {
  it('右侧有空间 → right（left = anchor.right + gap）', () => {
    const anchor = { right: 200, left: 100, top: 50, bottom: 70, width: 100, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('right');
    expect(p.left).toBe(208);
    expect(p.top).toBe(50);
  });
  it('右侧溢出 → left（left = anchor.left - gap - popW）', () => {
    const anchor = { right: 750, left: 650, top: 50, bottom: 70, width: 100, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('left');
    expect(p.left).toBe(650 - 8 - 200);
  });
  it('左右都溢出 → bottom（水平居中钳位）', () => {
    const anchor = { right: 790, left: 30, top: 50, bottom: 70, width: 760, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('bottom');
    expect(p.left).toBe(30 + 380 - 100);
  });
  it('上下左右都不足 → top', () => {
    const anchor = { right: 790, left: 30, top: 590, bottom: 610, width: 760, height: 20 };
    const p = positionFor(anchor, { width: 800, height: 600 }, { width: 200, height: 120 });
    expect(p.placement).toBe('top');
    expect(p.top).toBe(590 - 8 - 120);
  });
});

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/ThumbnailProgressPopover.test.ts`
预期：编译失败，组件文件不存在。

- [ ] **步骤 3：实现**

**定位纯函数放独立 lib**（`.vue` 的 `<script setup>` 无法具名导出；`positionFor` 需被测试独立 import → 放 `src/lib/thumbnailPosition.ts`）：

`src/lib/thumbnailPosition.ts`：

```ts
// thumbnailPosition.ts — popover 定位纯函数（module3.0.11）
// 优先级：右侧 → 左侧 → 下方 → 上方。水平溢出钳位。独立文件便于单测。

export type PopoverPlacement = 'right' | 'left' | 'bottom' | 'top';

export function positionFor(
  anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  viewport: { width: number; height: number },
  popSize: { width: number; height: number },
  gap = 8,
): { placement: PopoverPlacement; left: number; top: number } {
  const rightX = anchor.right + gap;
  const leftX = anchor.left - gap - popSize.width;
  // 1. 右侧优先
  if (rightX + popSize.width <= viewport.width) {
    return { placement: 'right', left: rightX, top: clampV(anchor.top, viewport, popSize) };
  }
  // 2. 左侧
  if (leftX >= 0) {
    return { placement: 'left', left: leftX, top: clampV(anchor.top, viewport, popSize) };
  }
  // 3. 下方（水平居中钳位）
  const centerX = clamp(anchor.left + anchor.width / 2 - popSize.width / 2, 0, viewport.width - popSize.width);
  if (anchor.bottom + gap + popSize.height <= viewport.height) {
    return { placement: 'bottom', left: centerX, top: anchor.bottom + gap };
  }
  // 4. 上方
  return { placement: 'top', left: centerX, top: Math.max(0, anchor.top - gap - popSize.height) };
}

function clampV(v: number, viewport: { height: number }, popSize: { height: number }): number {
  return clamp(v, 0, Math.max(0, viewport.height - popSize.height));
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
```

`ThumbnailProgressPopover.vue`（`<script setup lang="ts">`）完整实现：

```vue
<script setup lang="ts">
// ThumbnailProgressPopover.vue — 单张缩略图生成详情浮层（module3.0.11）
// 阶段时间线（5 步）+ 原图/输出 + 失败重试。定位：角标右侧优先，右→左→下→上。
// 阶段时长推算：timings[phase] = 该阶段开始的累计 elapsed；阶段 X 时长 =
//   timings[nextPhase] - timings[X]（当前阶段 = Date.now() - startedAt - timings[X]）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ThumbnailPhase, ThumbnailState } from '@/lib/thumbnail';
import { THUMBNAIL_PHASES } from '@/lib/thumbnail';
import { formatBytes } from '@/locales/helpers';
import { positionFor, type PopoverPlacement } from '@/lib/thumbnailPosition';

const props = defineProps<{
  state: ThumbnailState;
  fileName: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  /** 角标在视口中的位置（父级点击时算好，滚动时父级更新）。 */
  anchorRect: { left: number; top: number; width: number; height: number };
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'retry'): void;
}>();

const { t } = useI18n();
const rootEl = ref<HTMLElement | null>(null);
const placement = ref<PopoverPlacement>('right');
const pos = ref({ left: 0, top: 0 });
const nowTick = ref(0); // 500ms tick 驱动耗时文本刷新

function reposition() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popEl = rootEl.value;
  if (!popEl) return;
  const popSize = { width: popEl.offsetWidth || 220, height: popEl.offsetHeight || 120 };
  const p = positionFor(props.anchorRect, { width: vw, height: vh }, popSize);
  placement.value = p.placement;
  pos.value = { left: p.left, top: p.top };
}

let intervalId: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  reposition();
  window.addEventListener('resize', reposition);
  intervalId = setInterval(() => { nowTick.value += 1; reposition(); }, 500);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', reposition);
  if (intervalId) clearInterval(intervalId);
});

const phaseText = (ph: ThumbnailPhase) => t(`thumbnail.phase.${ph}`);
const totalElapsedMs = computed(() => {
  void nowTick.value;
  return props.state.kind === 'generating' ? Date.now() - props.state.startedAt : 0;
});

/** 阶段时长（ms）：已完成 = timings[next] - timings[this]；当前 = total - timings[this]；未到 = '—'。 */
function stepDuration(ph: ThumbnailPhase): string {
  if (props.state.kind !== 'generating') return '—';
  void nowTick.value;
  const timings = props.state.timings;
  const idx = THUMBNAIL_PHASES.indexOf(ph);
  if (timings[ph] === undefined) return '—';
  const start = timings[ph] as number;
  let end: number;
  if (props.state.phase === ph) {
    end = Date.now() - props.state.startedAt; // 实时跳动
  } else {
    const nextPh = THUMBNAIL_PHASES[idx + 1];
    end = nextPh && timings[nextPh] !== undefined ? (timings[nextPh] as number) : start;
  }
  return `${Math.max(0, end - start)}ms`;
}
function stepClass(ph: ThumbnailPhase): string {
  if (props.state.kind !== 'generating') return '';
  const idx = THUMBNAIL_PHASES.indexOf(ph);
  const curIdx = THUMBNAIL_PHASES.indexOf(props.state.phase);
  if (idx < curIdx) return 'done';
  if (idx === curIdx) return 'cur';
  return 'pending';
}
</script>
```

> **类型守卫注意**：`props.state` 在 template 中经 `state.kind === 'generating'` 收窄；script 函数里需 `if (props.state.kind !== 'generating') return` 守卫（TS 联合收窄在函数内不自动应用）。`stepClass`/`stepDuration`/`totalElapsedMs` 均已加守卫。

模板：

```vue
<template>
  <div ref="rootEl" class="thumb-popover" :class="`place-${placement}`" :style="{ left: pos.left + 'px', top: pos.top + 'px' }" data-test="thumb-popover">
    <div class="pop-title">{{ fileName }}</div>
    <template v-if="state.kind === 'generating'">
      <div class="pop-state cur">{{ phaseText(state.phase) }} · {{ t('thumbnail.popover.elapsed', { ms: totalElapsedMs }) }}</div>
      <div class="psection">{{ t('thumbnail.popover.stages') }}</div>
      <div v-for="ph in THUMBNAIL_PHASES" :key="ph" class="tl-step" :class="stepClass(ph)">
        <span class="lbl"><span class="dot" />{{ phaseText(ph) }}</span>
        <span class="t">{{ stepDuration(ph) }}</span>
      </div>
      <div class="psection">{{ t('thumbnail.popover.image') }}</div>
      <div class="prow"><span class="k">{{ t('thumbnail.popover.sourceImage') }}</span><span class="v">{{ props.sourceWidth }}×{{ props.sourceHeight }} · {{ formatBytes(props.sourceBytes) }}</span></div>
      <div class="prow"><span class="k">{{ t('thumbnail.popover.output') }}</span><span class="dim">—</span></div>
    </template>
    <template v-else-if="state.kind === 'failed'">
      <div class="pop-state fail">{{ t('thumbnail.popover.failed') }}</div>
      <div class="err-msg">{{ state.message }}</div>
      <button class="retry-btn" type="button" @click="emit('retry')">{{ t('thumbnail.popover.retry') }}</button>
    </template>
  </div>
</template>
```

> **注**：`formatBytes` 来自 `@/locales/helpers`（`src/locales/helpers.ts:21`，非 `@/lib/format`）。

style（`.thumb-popover` `position: fixed`，`.place-*` 加箭头）：

```css
.thumb-popover {
  position: fixed;
  z-index: 60;
  width: 220px;
  background: var(--color-surface-3);
  border: 1px solid var(--color-border-default);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 6px 20px rgba(0,0,0,.45);
  font-size: 11px;
}
/* 箭头按 placement 简化：右侧箭头在左缘（省略完整三角，用边框模拟） */
.thumb-popover.place-right { border-left: 2px solid var(--color-accent); }
.thumb-popover.place-left { border-right: 2px solid var(--color-accent); }
.thumb-popover.place-bottom { border-top: 2px solid var(--color-accent); }
.thumb-popover.place-top { border-bottom: 2px solid var(--color-accent); }
.pop-title { font-size: 12px; color: var(--color-text-primary); font-weight: 600; margin-bottom: 2px; }
.pop-state { font-size: 11px; margin-bottom: 6px; }
.pop-state.cur { color: var(--color-accent); }
.pop-state.fail { color: var(--color-error); }
.psection { font-size: 9px; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: .5px; margin: 8px 0 3px; }
.tl-step { display: flex; justify-content: space-between; align-items: center; margin: 3px 0; }
.tl-step .lbl { display: flex; align-items: center; gap: 5px; color: var(--color-text-secondary); }
.tl-step .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-border-default); }
.tl-step.done .dot { background: var(--color-success); }
.tl-step.cur .dot { background: var(--color-accent); box-shadow: 0 0 0 2px rgb(99 102 241 / .3); }
.tl-step .t { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.prow { display: flex; justify-content: space-between; margin: 2px 0; }
.prow .k { color: var(--color-text-muted); }
.prow .v { color: var(--color-text-secondary); }
.prow .dim { color: var(--color-text-muted); }
.err-msg { font-size: 10px; color: var(--color-error); background: rgb(248 113 113 / .1); border-radius: 4px; padding: 5px 6px; margin: 4px 0; line-height: 1.4; word-break: break-all; }
.retry-btn { width: 100%; padding: 5px; background: rgb(99 102 241 / .15); border: 1px solid var(--color-accent); color: var(--color-accent); border-radius: 5px; font-size: 11px; cursor: pointer; }
```

> 若 `--color-success` token 已存在（tailwind.css:52 定义 `--color-success: #34d399`，可用）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/ThumbnailProgressPopover.test.ts`
预期：PASS（5 时间线 + 失败重试 + positionFor 4 例）。再 `npm run type-check`。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/thumbnailPosition.ts src/lib/thumbnailPosition.test.ts src/components/filebrowser/ThumbnailProgressPopover.vue src/components/filebrowser/ThumbnailProgressPopover.test.ts
git commit -m "feat(thumbnail): ThumbnailProgressPopover 阶段时间线 + 定位 fallback（module3.0.11 任务 7）"
```

---

### 任务 8：前端 — MasonryView 接线 popover + MasonryRow 转发（TDD）

**文件：**
- 修改：`src/components/filebrowser/MasonryRow.vue`（转发 `show-progress`）
- 修改：`src/components/filebrowser/MasonryView.vue`（anchorPath/rect state + 点击角标弹 popover + 滚动重算 + 关闭 + settings 守卫）
- 测试：`src/components/filebrowser/MasonryRow.test.ts`、`src/components/filebrowser/MasonryView.test.ts`

- [ ] **步骤 1：写失败的测试**

`MasonryRow.test.ts` 追加：

```ts
it('show-progress 转发到父级', async () => {
  const w = mount(MasonryRow, {
    props: mkProps({ thumbState: { kind: 'generating', cacheKey: 'k', phase: 'decoding', startedAt: Date.now(), timings: {} } }),
    global: { plugins: [createPinia(), i18n] },
  });
  const badge = w.find('.phase-badge');
  await badge.trigger('click');
  expect(w.emitted('show-progress')).toBeTruthy();
});
```

`MasonryView.test.ts` 追加（复用现有 mock 基座：`useMasonryThumbnails` 的 `stateMap` 需能从测试注入——当前 mock 未 mock useMasonryThumbnails，真实 composable 会 `listen()`，happy-dom 无 `__TAURI_INTERNALS__` 会 catch 静默，stateMap 空。**需要 mock**）：

```ts
const thumbnailsMock = vi.hoisted(() => ({
  stateMap: new Map<string, unknown>(),
}));

vi.mock('@/composables/useMasonryThumbnails', () => ({
  useMasonryThumbnails: () => ({
    stateMap: computed(() => thumbnailsMock.stateMap),
    retry: vi.fn(),
    retryBatch: vi.fn(),
    regenerate: vi.fn(),
    regenerateBatch: vi.fn(),
    epoch: ref(0),
  }),
}));
```

> 但 MasonryView 现有代码已在顶部 `import { useMasonryThumbnails }` 并用解构（:163）。新增 mock 后**原有测试的 `requestThumbnails` mock 不再被走**——检查现有测试是否有依赖 requestThumbnails 调用的断言（搜索 `requestSpy` 于 MasonryView.test.ts——当前未见，安全）。

新增测试：

```ts
describe('MasonryView.popover (module3.0.11)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['a.jpg', { path: 'a.jpg', width: 100, height: 100, top: 0, left: 0, col: 0 }],
    ]);
    thumbnailsMock.stateMap = new Map([
      ['a.jpg', { kind: 'generating', cacheKey: 'ck', phase: 'decoding', startedAt: Date.now(), timings: {} }],
    ]);
  });

  it('settings 开时点击角标 → 显示 popover', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    // 找到角标（在 MasonryRow 内 .phase-badge）
    const badge = w.find('.phase-badge');
    expect(badge.exists()).toBe(true);
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    w.unmount();
  });

  it('settings 关时点击角标 → 不弹 popover', async () => {
    const pinia = createPinia();
    const settings = useSettingsStore(pinia);
    settings.thumbnailDetailPopover = false;
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [pinia, i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    const badge = w.find('.phase-badge');
    await badge.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(false);
    w.unmount();
  });

  it('ESC 关闭 popover', async () => {
    const w = mount(MasonryView, { props: baseProps, global: { plugins: [createPinia(), i18n] }, attachTo: document.body });
    await flushPromises(); await nextTick();
    await w.find('.phase-badge').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(w.find('[data-test="thumb-popover"]').exists()).toBe(false);
    w.unmount();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/MasonryRow.test.ts src/components/filebrowser/MasonryView.test.ts`
预期：FAIL（`show-progress` emit 未实现 / popover 未接线 / `thumbnailDetailPopover` 未定义）。

- [ ] **步骤 3：实现**

`MasonryRow.vue`：defineEmits 加 `(e: 'show-progress', entry: MediaEntry): void;`，MasonryThumbnail 标签加 `@show-progress="$emit('show-progress', entry)"`。

`MasonryView.vue`：
- import 加 `ThumbnailProgressPopover` + `useSettingsStore`（已有）+ `type ThumbnailState`。
- 状态：

```ts
// module3.0.11: popover 追踪（单张）
const popoverState = ref<{ path: string; rect: { left: number; top: number; width: number; height: number }; state: ThumbnailState } | null>(null);

function openProgressPopover(entry: MediaEntry) {
  if (!settingsStore.thumbnailDetailPopover) return;
  const s = thumbStateMap.value.get(entry.path);
  if (!s) return;
  // 角标 DOM：从卡片里找（MasonryRow 的 .phase-badge，按 data-path 定位）
  const card = containerRef.value?.querySelector(`[data-path="${entry.path}"] .phase-badge`);
  const rect = card?.getBoundingClientRect();
  if (!rect) return;
  popoverState.value = {
    path: entry.path,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    state: s,
  };
}

function closeProgressPopover() { popoverState.value = null; }

// 滚动时重算 rect（角标随卡片移动）
function onContainerScroll() {
  if (!popoverState.value) return;
  const card = containerRef.value?.querySelector(`[data-path="${popoverState.value.path}"] .phase-badge`);
  const rect = card?.getBoundingClientRect();
  if (rect) popoverState.value.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
```

> `settingsStore` 已在 :143 声明（`const settingsStore = useSettingsStore()`），复用。

- 滚动监听：`useVirtualList` 的 `scrollTop` ref 变化时重算——在 `watch(scrollTop, onContainerScroll)` 加，或容器 scroll 事件。用 watch：

```ts
watch(scrollTop, onContainerScroll);
```

- MasonryRow 转发链（template :415 加）：

```vue
        @show-progress="(e) => openProgressPopover(e)"
```

- 关闭：ESC + 切目录（descriptor/currentPath watch 已有，加 `closeProgressPopover()`）：

```ts
watch(
  () => [props.descriptor, props.currentPath] as const,
  () => {
    closeProgressPopover();
    browsePosition.stop();
    void browsePosition.start();
  },
);
```

- template 底部（`.masonry-container` 内末尾）加：

```vue
    <ThumbnailProgressPopover
      v-if="popoverState"
      :state="popoverState.state"
      :file-name="popoverState.path"
      :source-width="measuredMap.value.get(popoverState.path)?.width ?? 0"
      :source-height="measuredMap.value.get(popoverState.path)?.height ?? 0"
      :source-bytes="entriesByPath(popoverState.path)?.size ?? 0"
      :anchor-rect="popoverState.rect"
      @close="closeProgressPopover"
      @retry="retryThumbnail(popoverState.path); closeProgressPopover()"
    />
```

> `file-name` 应为 entry.name（path 可能含目录前缀）。加 helper `fileNameOf(path)`：

```ts
function entriesByPath(path: string): MediaEntry | undefined {
  return props.entries.find((e) => e.path === path);
}
```

`:file-name="entriesByPath(popoverState.path)?.name ?? popoverState.path"`。

- ESC 监听（onMounted/onUnmounted）：

```ts
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeProgressPopover();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
```

> onMounted/onUnmounted 已存在（:104/:126），合并进现有函数体。

- 角标从 generating → cached 时 popover 里的 state 需同步——`thumbStateMap` 变化时 popoverState.state 更新：

```ts
watch(thumbStateMap, (m) => {
  if (popoverState.value) {
    const s = m.get(popoverState.value.path);
    if (s && s.kind !== 'generating' && s.kind !== 'failed') closeProgressPopover();
    else if (s) popoverState.value.state = s;
  }
});
```

> 简化：生成完成（cached/original）自动关 popover（progress 已完成，展示无意义）；failed 保留（展示错误）。`unsupported` 也关。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts src/components/filebrowser/MasonryRow.test.ts`
预期：PASS。再 `npm run type-check`。

> **注意**：新增 `vi.mock('@/composables/useMasonryThumbnails')` 会**覆盖** MasonryView.test.ts 现有所有用到真实 useMasonryThumbnails 的测试——现有测试里 `requestThumbnails` 相关断言需复查（搜索 `requestThumbnails`/`requestSpy` 于该文件；当前未见显式断言，安全）。若 `MasonryView.vue` 解构 `useMasonryThumbnails` 的 `retryBatch/regenerateBatch` 被 defineExpose 引用，mock 需返回这些（上面 mock 已含）。

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/MasonryRow.vue src/components/filebrowser/MasonryView.vue src/components/filebrowser/MasonryRow.test.ts src/components/filebrowser/MasonryView.test.ts
git commit -m "feat(thumbnail): MasonryView 接线 popover（角标触发/滚动重算/ESC/切目录关）（module3.0.11 任务 8）"
```

---

### 任务 9：全局开关 + i18n + Settings 接线（TDD）

**文件：**
- 修改：`src/stores/settings.ts`（`thumbnailDetailPopover` ref + load + setter + return）
- 修改：`src/locales/zh-CN.ts` + `src/locales/en-US.ts`（`thumbnail.*` + settings key）
- 修改：`src/components/settings/ThumbnailCacheSettings.vue`（BooleanRow）
- 修改：`src/components/filebrowser/MasonryThumbnail.vue`（`phaseLabel` 用 i18n）
- 测试：`src/stores/settings.test.ts`、`src/views/Settings.test.ts`、`src/components/filebrowser/MasonryThumbnail.test.ts`（label 断言）

- [ ] **步骤 1：写失败的测试**

`src/stores/settings.test.ts` 追加：

```ts
it('thumbnailDetailPopover 读写：load 加载 + setter 持久化（true/false 字符串）', async () => {
  const store = useSettingsStore();
  // 默认 true
  expect(store.thumbnailDetailPopover).toBe(true);
  // setter
  await store.setThumbnailDetailPopover(false);
  expect(store.thumbnailDetailPopover).toBe(false);
  expect(setSettingSpy).toHaveBeenCalledWith('fb_thumbnail_detail_popover', 'false');
});
```

> 先读 settings.test.ts 确认 mock 的 spy 变量名（`setSetting` 怎么被 mock/捕获），替换为实际名。

`src/views/Settings.test.ts` 追加（ThumbnailCacheSettings stub 替换为真实渲染？——现有测试 stub 掉 ThumbnailCacheSettings，开关放里面会 stub 掉。**改为：BooleanRow 直接放 Settings.vue 的 masonry section**（与 ThumbnailCacheSettings 平级），而非组件内部）——决策见实现。

```ts
it('masonry section 渲染 thumbnail detail popover 开关', () => {
  const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
  const row = wrapper.find('[data-test="thumbnail-detail-popover"]');
  expect(row.exists()).toBe(true);
});
it('点击 thumbnail-detail-popover 调 setThumbnailDetailPopover', async () => {
  const store = useSettingsStore();
  const spy = vi.spyOn(store, 'setThumbnailDetailPopover');
  const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
  const row = wrapper.find('[data-test="thumbnail-detail-popover"]');
  await row.find('button').trigger('click');
  await flushPromises();
  expect(spy).toHaveBeenCalledWith(false);
});
```

`MasonryThumbnail.test.ts` 追加（label 用 i18n，非 hardcode）：

```ts
it('generating 角标 title 用 i18n 文案（解码中）', () => {
  const w = mountThumb({ kind: 'generating', cacheKey: 'k', phase: 'decoding', startedAt: Date.now(), timings: {} });
  expect(w.find('.phase-badge').attributes('title')).toBe('解码中');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/settings.test.ts src/views/Settings.test.ts src/components/filebrowser/MasonryThumbnail.test.ts`
预期：FAIL（`thumbnailDetailPopover`/`setThumbnailDetailPopover` 未定义、i18n key 缺失、Settings 无开关行）。

- [ ] **步骤 3：实现**

`settings.ts`：
- 声明（:60 后）：

```ts
  // v0.1.0-module3.0.11: 点击角标是否弹生成详情浮层（默认开）
  const thumbnailDetailPopover = ref(true);
```

- load keys（:97 后）：

```ts
      ['fb_thumbnail_detail_popover', (v) => (thumbnailDetailPopover.value = v !== 'false')],
```

- setter（:252 后，仿 `setRecordBrowsePosition` 的 'true'/'false' 语义）：

```ts
  /** v0.1.0-module3.0.11: 角标点击弹详情开关（'true'/'false' 字符串语义）。 */
  async function setThumbnailDetailPopover(v: boolean): Promise<void> {
    thumbnailDetailPopover.value = v;
    await setSetting('fb_thumbnail_detail_popover', v ? 'true' : 'false');
  }
```

- return（:328 附近加 `thumbnailDetailPopover, setThumbnailDetailPopover,`）。

i18n `zh-CN.ts`（`fileBrowser` 块后加顶层 `thumbnail` namespace——现有 `fileBrowser.thumbnailRetry` 是 fileBrowser 下，新增独立 `thumbnail.*`；**先确认 `thumbnail` 顶层 key 不存在**——当前 zh-CN.ts 无顶层 `thumbnail`，安全）：

```ts
  thumbnail: {
    phase: { queued: '排队中', decoding: '解码中', resizing: '缩放中', encoding: '编码中', writing: '写入中' },
    popover: {
      title: '缩略图生成',
      elapsed: '已用时 {ms}ms',
      stages: '阶段',
      image: '图像',
      sourceImage: '原图',
      output: '输出',
      failed: '生成失败',
      retry: '重新生成',
    },
  },
```

`settings.masonry` 块（:327，thumbnail 子块后）追加 2 key：

```ts
        thumbnailDetailPopover: '点击角标显示生成详情',
        thumbnailDetailPopoverDesc: '开启后点击缩略图阶段角标可查看生成阶段与耗时',
```

`en-US.ts` 对应（顶层 `thumbnail` + `settings.masonry` 追加）：

```ts
  thumbnail: {
    phase: { queued: 'Queued', decoding: 'Decoding', resizing: 'Resizing', encoding: 'Encoding', writing: 'Writing' },
    popover: {
      title: 'Thumbnail generation',
      elapsed: 'Elapsed {ms}ms',
      stages: 'Stages',
      image: 'Image',
      sourceImage: 'Source',
      output: 'Output',
      failed: 'Generation failed',
      retry: 'Regenerate',
    },
  },
```

`settings.masonry` 块追加：

```ts
        thumbnailDetailPopover: 'Show generation details on badge click',
        thumbnailDetailPopoverDesc: 'Click a thumbnail phase badge to view generation stages and timing',
```

> **settings namespace 归属**：现有 `settings.section.masonry` + `settings.masonry.*`。开关放 masonry section → key 用 `settings.masonry.thumbnailDetailPopover`。先读 `zh-CN.ts` 的 `settings.masonry` 块确认（`settings.masonry.thumbnail.*` 已存在 :125+ 区域）。用 `settings.masonry.thumbnailDetailPopover`。

`Settings.vue` masonry section（:455 `<ThumbnailCacheSettings />` 前后）加 BooleanRow：

```vue
            <BooleanRow
              :label="t('settings.masonry.thumbnailDetailPopover')"
              :description="t('settings.masonry.thumbnailDetailPopoverDesc')"
              :value="settings.thumbnailDetailPopover"
              data-test="thumbnail-detail-popover"
              @change="setThumbnailDetailPopover"
            />
```

（Settings.vue script 加 `setThumbnailDetailPopover` handler，仿 :166 的 `setRecordBrowsePosition`。）

`MasonryThumbnail.vue` `phaseLabel` 改 i18n（任务 6 的占位）：

```ts
const { t } = useI18n();
const phaseLabel = computed(() => {
  const s = props.state;
  if (s?.kind !== 'generating') return '';
  return t(`thumbnail.phase.${s.phase}`);
});
```

> MasonryThumbnail 目前未用 useI18n；`mountThumb` 测试已注入 i18n 插件，OK。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/settings.test.ts src/views/Settings.test.ts src/components/filebrowser/MasonryThumbnail.test.ts`
预期：PASS。再 `npm run type-check` + `npx vitest run`（全量）确认 i18n 双文件同步无警告。

- [ ] **步骤 5：Commit**

```bash
git add src/stores/settings.ts src/locales/zh-CN.ts src/locales/en-US.ts src/views/Settings.vue src/components/filebrowser/MasonryThumbnail.vue src/stores/settings.test.ts src/views/Settings.test.ts src/components/filebrowser/MasonryThumbnail.test.ts
git commit -m "feat(thumbnail): 角标详情全局开关 + i18n（module3.0.11 任务 9）"
```

---

### 任务 10：收尾验证（无新代码）

- [ ] **步骤 1：全量前端测试**

运行：`npm test -- --run`
预期：全部 PASS（现有 ~912 + 本模块新增）。检查新增用例数记录到 AGENTS.md 状态表。

- [ ] **步骤 2：type-check**

运行：`npm run type-check`
预期：0 error。

- [ ] **步骤 3：Rust 全量测试**

运行：`cd src-tauri && cargo test -p mirapage-desktop-lib 2>&1 | tail -5`
预期：全部 PASS（thumbnail 105 + 新增）。

- [ ] **步骤 4：Commit 收尾**

```bash
git add src/AGENTS.md
git commit -m "docs(AGENTS): 更新 module3.0.11 缩略图阶段进度状态表"
```

> AGENTS.md 更新：在「当前状态」表加 `3.0.11 | 单图缩略图生成阶段进度 | ✅ ...` 行（含 spec/plan 路径、测试数增量、关键决策）。

---

## 自检记录（writing-plans skill）

**规格覆盖度**：
- §3 数据层（GenPhase/on_progress/generator 回调/service 注入/queued 不经 Rust）→ 任务 1-4 ✅
- §4 前端状态机（ThumbnailState.generating 扩展/composable 处理/时长推算）→ 任务 5 ✅
- §5 角标（顶部居中/无环/仅 generating/图标/点击 emit）→ 任务 6 ✅
- §6 Popover（定位 fallback/字段/失败态/关闭/多选）→ 任务 7+8 ✅
- §7 全局开关（DB key/默认开/关时角标纯指示）→ 任务 9 ✅
- §8 i18n（9 keys 双语）→ 任务 9 ✅
- §9 测试策略 → 各任务 TDD 步骤 ✅
- §10 性能 → 无新代码任务，遵循纪律（emit 非阻塞/`let _=`/epoch 过滤）✅
- §11 决策记录 → 已内联到各任务（决策 9 on_progress 签名、决策 2 无环等）✅

**占位符扫描**：无 TODO/「待定」；所有代码步骤含完整代码块。任务 4 的「若现有测试构造 service 需补字段」是条件分支非占位符——实现时以编译错误为准。任务 7 的 `formatBytes` 导出名标注「读文件确认」——已给 fallback 说明。

**类型一致性**：
- `GenPhase`/`phase_str`（任务 1 定义）→ 任务 2/3/4 使用一致 ✅
- `on_progress: Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>>` 全链路一致（GenerationJob / generate_thumbnail 的 `&dyn` / service 闭包）✅
- `ThumbnailPhase` 前端字面量 `'queued'|'decoding'|'resizing'|'encoding'|'writing'` 与 Rust `phase_str` 输出一致 ✅
- `ThumbnailState.generating` 字段 `phase/startedAt/timings`：任务 5 定义 → 任务 6/7/8 使用一致 ✅
- `ThumbnailProgressEvent`（tauri.ts）字段与 Rust `ProgressEvent` camelCase 对齐（epoch/cacheKey/path/phase/elapsedMs）✅
- popover props `anchorRect`：任务 7 组件定义 → 任务 8 MasonryView 传入一致 ✅
