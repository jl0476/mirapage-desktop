# 瀑布流缩略图缓存实现代码审查报告

> 审查日期：2026-08-08  
> 审查范围：`d4e6d98..f6c6014` 及当前工作区未提交变更  
> 设计文档：`docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md`  
> 实现计划：`docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md`

## 1. 审查结论

缩略图策略、生成器、EXIF 像素归一化、磁盘索引、调度器和前端卡片状态机的基础框架已经建立，但当前实现还不能视为完整符合设计。

本次审查发现：

- 6 个 P1 重要问题；
- 4 个 P2 一般问题；
- 缓存位置迁移和端到端性能验收尚未实现；
- 当前工作区可以编译，但提交 `f6c6014` 不包含维持编译所需的 `scheduler.rs` 修改，单独检出提交后不可复现当前结果。

最高优先级应先处理子目录路径、完成事件 key 和提交完整性。这三项会直接导致子目录图片生成失败、卡片持续转圈或其他开发者无法构建提交。

## 2. 验证证据

本次重新执行了以下验证。

### 2.1 前端

```powershell
npm.cmd test
npm.cmd run type-check
```

结果：

- Vitest：62 个测试文件通过；
- Vitest：658 个测试通过，0 个失败；
- `vue-tsc --noEmit`：退出码 0。

测试输出仍包含已有 Vue lifecycle 和 RouterLink warning，但未造成测试失败。

### 2.2 Rust

由于当前环境未设置默认 rustup toolchain，验证时显式使用：

```powershell
$env:RUSTUP_HOME='D:\compile\.rustup'
$env:CARGO_HOME='D:\compile\.cargo'
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml thumbnail
cargo test --manifest-path src-tauri/Cargo.toml --test thumbnail_generator
```

结果：

- `cargo check`：退出码 0，但基于当前未提交的 `scheduler.rs` 修改；
- thumbnail 过滤测试：81 个通过，0 个失败；
- `thumbnail_generator` 集成测试：8 个通过，0 个失败；
- EXIF Orientation 1–8、PNG alpha、GIF 第一帧、格式解码、长图像素预算和原子写入测试均通过。

需要注意：`cargo test ... thumbnail` 会把 `thumbnail_generator` 中名称不含 thumbnail 的 8 个测试全部过滤掉，不能用该命令单独证明生成器集成测试通过，必须显式运行 `--test thumbnail_generator`。

## 3. P1 重要问题

### P1-1：子目录图片源路径缺少 `currentPath`

#### 现象

`LocalMediaSource::list_directory()` 返回的 `MediaEntry.path` 只是当前目录内的相对路径。例如进入 `normal` 目录后，图片路径仍可能是 `a.jpg`。

前端提交缩略图请求时直接发送该路径：

- `src/composables/useMasonryThumbnails.ts:124-137`

后端直接执行：

```rust
let abs = local_abs_path(&root_path, &item.path);
```

位置：

- `src-tauri/src/thumbnail/service.rs:320`

因此实际读取路径为：

```text
root/a.jpg
```

而正确路径应为：

```text
root/normal/a.jpg
```

#### 影响

- 根目录缩略图可能正常；
- 进入任意子目录后，缩略图生成会读错文件；
- 文件不存在时卡片进入失败或持续等待；
- 这与之前 `normal` 目录图片加载失败的现象高度一致。

#### 修复建议

IPC 请求应区分：

```ts
interface ThumbnailRequestItem {
  uiPath: string;       // 当前列表内稳定 key，例如 a.jpg
  sourceRelPath: string; // 相对 source root 的完整路径，例如 normal/a.jpg
}
```

后端只用 `sourceRelPath` 读取文件和生成 cache key；前端事件状态只用 `uiPath` 更新卡片。不要把绝对磁盘路径返回前端。

必须增加真实链路测试：

```text
root/normal/a.jpg
→ 当前目录 normal
→ 请求 a.jpg
→ 后端读取 root/normal/a.jpg
→ 完成事件更新 a.jpg 卡片
```

### P1-2：完成事件使用绝对磁盘路径作为前端状态 key

#### 现象

提交任务时，`CompletionMeta.rel_path` 实际取自 `task.job.source_path`：

- `src-tauri/src/thumbnail/service.rs:376-380`

`source_path` 是 Local 文件的绝对路径。任务完成后，该值直接成为事件中的 `path`：

- `src-tauri/src/thumbnail/service.rs:591`
- `src-tauri/src/thumbnail/service.rs:606`

前端状态 Map 使用的 key 则是 `entry.path`：

- `src/composables/useMasonryThumbnails.ts:78-81`

#### 影响

后端可能成功生成缩略图，但前端收到：

```text
path = D:\Wallpaper\normal\a.jpg
```

前端真正渲染的卡片 key 为：

```text
a.jpg
```

两个 key 不一致，导致生成完成事件更新了一个不存在的卡片状态，原卡片继续保持 `queued` 或 spinner。

#### 修复建议

`CompletionMeta` 至少拆分为：

```rust
struct CompletionMeta {
    ui_path: String,
    source_rel_path: String,
    source_abs_path: PathBuf,
    // ...
}
```

- `source_abs_path` 只供 Rust 读取；
- `source_rel_path` 写缓存索引；
- `ui_path` 写状态事件。

### P1-3：提交 `f6c6014` 不是可独立构建的完整提交

#### 现象

`service.rs` 已使用：

```rust
job.source_path
```

但 `GenerationJob.source_path` 字段只存在于当前未提交的工作区修改：

- `src-tauri/src/thumbnail/scheduler.rs:40-44`

当前 Git 状态显示：

```text
M src-tauri/src/thumbnail/scheduler.rs
```

#### 影响

- 当前工作区可以通过 `cargo check`；
- 其他开发者检出 `f6c6014` 后会遇到字段不存在的编译错误；
- CI、发布构建和问题复现无法基于提交 SHA 得到相同结果。

#### 修复建议

先为 Local 文件路径生成增加回归测试，再把 `scheduler.rs`、相关 service 调整和测试一起提交。提交后必须在干净工作区重新执行：

```powershell
git status --short
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --test thumbnail_generator
```

### P1-4：预读和缓存设置没有真正控制运行逻辑

#### 现象

设置 store 已提供：

- `thumbnailPrefetchScreens`；
- `thumbnailIdleGeneration`；
- `thumbnailIdlePrefetchScreens`；
- `thumbnailCacheLimitMb`；
- `thumbnailCacheRoot`。

但布局窗口仍硬编码：

```ts
aheadScreens: 1.5,
behindScreens: 0.5,
idleScreens: 1,
```

位置：

- `src/composables/useMasonryLayout.ts:319-321`

此外：

- `setThumbnailCacheLimitMb()` 只持久化前端设置，不更新 `ThumbnailService.cache_limit_mb`；
- `thumbnailCacheRoot` 没有任何后端消费方；
- `thumbnailIdleGeneration=false` 不会阻止 idle 窗口形成；
- 资源预设切换后只有 worker、内存和质量通过 runtime command 发送到 Rust。

#### 影响

- 节能、均衡和高性能模式的预读范围实际相同；
- 用户关闭空闲生成后，仍可能提交 idle 任务；
- 修改缓存容量要重启应用才可能生效；
- 修改缓存位置完全无效。

#### 修复建议

`useMasonryLayout` 增加响应式参数：

```ts
prefetchScreens: Ref<number>;
idleGeneration: Ref<boolean>;
idlePrefetchScreens: Ref<number>;
```

`thumbnailWindows` 应由设置实时计算。runtime config command 同时传递缓存上限，或者增加独立命令：

```text
update_thumbnail_cache_limit
```

每项设置都需要测试“用户修改 → 运行行为变化”，不能只测试 store 值和数据库写入。

### P1-5：EXIF 方向归一化后的宽高没有同步给瀑布流布局

#### 现象

缩略图生成器会应用 EXIF Orientation，Orientation 5–8 会交换最终像素宽高。

但瀑布流的 `measuredMap` 来自 `list_image_dimensions` 的原始 header 尺寸，当前 header parser 不解析 EXIF Orientation。布局高度依旧按旋转前宽高比计算：

- `src/components/filebrowser/MasonryView.vue:96-116`
- `src/composables/useMasonryLayout.ts:239-251`

#### 影响

Orientation 5–8 图片可能出现：

- 卡片高度错误；
- 缩略图实际比例与布局比例不同；
- 图片被行容器 `overflow: hidden` 截断；
- 图片之间出现不一致的缝隙；
- 加载完成后比例突变。

#### 修复建议

首选方案是让尺寸 command 返回“展示方向归一化后的宽高”：

```rust
struct ImageDim {
    width: u32,
    height: u32,
    orientation: u8,
}
```

Orientation 5–8 在返回前交换宽高。缩略图生成完成后，再使用 `outputWidth/outputHeight` 校验卡片比例；若比例发生变化，调用已有滚动锚定补偿逻辑。

### P1-6：LRU 清理没有保护可见项和 in-flight 文件

#### 现象

前端虽然提交了 `visible_cache_keys`，后端只调用 `touch_many()` 更新访问时间。

实际执行 LRU 清理时使用空保护集合：

```rust
evict_to_limit(
    &conn,
    &meta.cache_root,
    meta.cache_limit,
    &HashSet::new(),
)
```

位置：

- `src-tauri/src/thumbnail/service.rs:585`

热缓存响应还把 `cache_key` 设置为 `None`：

- `src-tauri/src/thumbnail/service.rs:348`
- `src-tauri/src/thumbnail/service.rs:481`

前端因此无法持续上报热缓存卡片的保护 key。

#### 影响

- 刚生成的可见缩略图可能在浏览器 asset 请求完成前被删除；
- 正在显示的缓存可能被清理；
- in-flight 目标文件没有保护；
- 热缓存访问可能无法正确延长 LRU 生命周期。

#### 修复建议

服务维护以下集合：

```text
visible/ahead cache keys
in-flight cache keys
recently completed cache keys
```

清理时合并为 `protected_keys`。cached 响应和 cached 事件都必须返回 cache key。刚完成文件可以增加短暂保护期，避免写入后立刻被清理。

## 4. P2 一般问题

### P2-1：缓存索引元数据大量为空

`build_row()` 当前写入：

```rust
source_key: String::new(),
source_size: None,
source_modified_at: None,
source_width: None,
source_height: None,
orientation: None,
quality: String::new(),
```

位置：

- `src-tauri/src/thumbnail/service.rs:622-650`

这与 migration 009 和设计文档定义的索引语义不一致。虽然 cache key 中包含部分身份信息，但数据库失去诊断、统计、修复和未来跨数据源复用能力。

建议 `CompletionMeta` 保存完整 `CacheKeyInput`、源尺寸、orientation、quality 和真实 `target_bucket`，生成完成后一次性写入。

### P2-2：清空缓存没有与正在生成的任务协调

`clear_thumbnail_cache` 会删除现有文件和索引，但不会暂停调度器、取消未开始任务或等待正在写入的任务。

可能出现：

```text
用户点击清空
→ 文件和索引被删除
→ 正在生成的任务稍后完成
→ 缓存重新出现
```

设计要求迁移和手动清理期间暂停生成。建议增加 maintenance lock，并明确清理语义：取消 queued、等待或隔离 running、清理、恢复调度。

### P2-3：Standard 清晰度最大 bucket 没有正确应用

`quality_policy(Standard)` 定义最大 bucket 为 1536，但 `classify_item()` 使用：

```rust
let target_bucket = policy::select_bucket(item.required_width);
```

没有按照 `qp.max_bucket` 截断。当前 debug assert 还允许 2048，因此 Standard 在高 DPR 下仍可能生成 2048 缩略图，增加 CPU、缓存和 GPU 纹理开销。

建议：

```rust
let target_bucket = policy::select_bucket(item.required_width).min(qp.max_bucket);
```

同时测试 Standard/High/Ultra 在相同列宽和 DPR 下选择不同上限。

### P2-4：设置组件使用原生 `<select>`

`ThumbnailCacheSettings.vue` 多处使用原生 `<select>`，不符合项目 AGENTS 中统一自定义 dropdown 的 UI 约束。

这不会破坏缩略图功能，但可能造成 WebView 样式不一致，并偏离现有设置页组件体系。建议复用 `EnumRow` 或项目已有 dropdown 模式。

## 5. 尚未实现的设计内容

### 5.1 缓存位置迁移

以下设计内容均未实现：

- 修改缓存目录；
- 迁移已有缓存；
- 同盘 rename；
- 跨盘复制和 WebP 校验；
- migration manifest；
- 迁移进度事件；
- 取消迁移；
- 启动后继续迁移；
- 回滚到原目录；
- 成功提交前保持旧目录 active。

现有实现报告也在 `docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md:116-117` 明确标记任务 12 未实现。

### 5.2 端到端与性能验收

计划要求的以下内容未完成：

- `src-tauri/tests/thumbnail_pipeline.rs`；
- `src/components/filebrowser/MasonryThumbnail.integration.test.ts`；
- 1,000 entry DOM、滚动、stale event 集成测试；
- 改造后冷缓存首张时间；
- 冷缓存主要可见区完成时间；
- 热缓存帧时间；
- 最大滚动帧时间；
- 大于 100ms 严重掉帧数量；
- 瀑布流直接加载超过阈值原图的真实统计。

性能报告中的改造后指标仍为“待测”，因此目前只能确认若干算法约束，不能证明用户最关心的“大图滚动卡顿”已经解决。

## 6. 测试覆盖缺口

现有测试偏重纯函数和组件状态，缺少下面几条最关键的跨层链路。

### 6.1 子目录完整链路

```text
MasonryView currentPath
→ requestThumbnails
→ ThumbnailService Local 路径解析
→ generator
→ SQLite index
→ thumbnail://state
→ 对应 MasonryThumbnail ready
```

### 6.2 热缓存保护链路

```text
cached response 带 cacheKey
→ 前端上报 visible key
→ LRU 清理跳过可见文件
→ asset URL 仍可读取
```

### 6.3 EXIF 布局链路

```text
Orientation 6 原图
→ header 尺寸
→ 归一化布局尺寸
→ 生成缩略图尺寸
→ 卡片比例一致
→ 无裁剪、无额外缝隙
```

### 6.4 清空与生成并发链路

```text
任务正在生成
→ 用户清空缓存
→ 队列暂停/取消
→ 清理完成
→ 缓存不会自动重新出现
```

## 7. 建议修复顺序

### 第一批：恢复核心可用性

1. 修复 `currentPath/sourceRelPath/uiPath` 路径模型；
2. 修复完成事件使用绝对路径的问题；
3. 提交当前未提交的 `GenerationJob.source_path` 修改；
4. 增加子目录端到端回归测试；
5. 在干净工作区重新执行 Cargo 和前端验证。

### 第二批：保证比例、设置和缓存安全

1. 让尺寸测量应用 EXIF Orientation；
2. 把预读和 idle 设置接入 `thumbnailWindows`；
3. 让缓存容量修改运行时生效；
4. cached 响应返回 cache key；
5. LRU 保护可见、ahead、in-flight 和 recently completed；
6. 修复缓存索引完整元数据；
7. 协调清空缓存与正在运行的任务；
8. 应用质量档位最大 bucket。

### 第三批：补齐设计范围

1. 实现可修改缓存位置；
2. 实现 manifest 驱动的迁移、取消、继续和回滚；
3. 补齐 1,000 entry 和冷/热缓存集成测试；
4. 在 Windows Tauri 环境采集改造后的真实性能数据；
5. 更新性能报告，移除所有“待测”；
6. 依据实测结果判断是否仍需长图分片或更激进的虚拟化策略。

## 8. 完成判定标准

只有满足以下条件，才建议把本功能标记为完成：

- 子目录图片可以稳定生成并显示缩略图；
- 完成事件可以准确更新当前卡片；
- Git 工作区干净，单独检出 HEAD 可以构建；
- EXIF Orientation 1–8 的布局比例和缩略图比例一致；
- 节能、均衡、高性能和自定义设置真实改变运行行为；
- 缓存容量修改即时生效；
- LRU 不删除可见和生成中文件；
- 缓存目录可以迁移、取消、继续和回滚；
- 清空缓存不会被后台任务立即重新写回；
- 计划中的端到端测试全部存在并通过；
- 改造后性能数据达到设计阈值，或明确记录未达标项和下一步方案。

