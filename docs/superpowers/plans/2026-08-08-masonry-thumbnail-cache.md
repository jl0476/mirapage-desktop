# 瀑布流按需缩略图与可迁移缓存实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 为瀑布流增加按视口生成的高清缩略图、受控后台解码、持久缓存、失败重试和可恢复缓存迁移，消除滚动时直接解码大原图造成的卡顿，同时保持真实比例和原图阅读体验。

**架构：** Vue 根据瀑布流像素窗口批量提交需求，Rust 服务做缓存命中、优先级调度、内存预算和缩略图生成。生成结果以 Tauri asset URL 交给 `<img>`，IPC 只传元数据。SQLite 保存缓存索引，缓存文件原子落盘；缓存目录迁移由独立 manifest 驱动，可取消、继续和回滚。

**技术栈：** Tauri 2、Rust 2021、Tokio、rusqlite、image 0.24.9、kamadak-exif 0.6.1、webp 0.2.6、Vue 3、Pinia、Vitest、happy-dom。

**设计依据：** `docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md`

---

## 实施约束

- 只为当前可见区、前后预读区和允许的空闲扩展区生成，不做目录全量生成。
- 第一阶段只生成 Local 数据源缩略图；Archive、SMB、WebDAV 返回 `original` 或 `unsupported`，但 IPC 类型保持通用。
- 阅读器、双击打开和属性读取继续使用原图；缩略图只服务瀑布流卡片。
- Rust 输出经过 EXIF Orientation 像素归一化的 WebP，不复制 EXIF。
- 默认最大 worker 为 2，预计解码内存总预算为 128MB；两者均可配置。
- 不通过 IPC 返回图片字节或 Base64；成功结果只返回缓存文件路径和元数据。
- 所有验收使用单元测试、组件测试、数据库/文件系统断言、事件状态和性能采样数据。
- 不改动用户未跟踪文件 `AGENTS.md`、`src-tauri/icons/瀑布流.svg`、`src-tauri/icons/详情列表_view-list.svg`。

## 文件与职责

### 新增 Rust 文件

- `src-tauri/src/thumbnail/mod.rs`：模块导出和领域类型。
- `src-tauri/src/thumbnail/policy.rs`：尺寸桶、是否生成、像素预算、资源预设和内存估算纯函数。
- `src-tauri/src/thumbnail/orientation.rs`：EXIF Orientation 解析结果到像素变换的映射。
- `src-tauri/src/thumbnail/key.rs`：源身份、文件身份、策略版本和缓存 key。
- `src-tauri/src/thumbnail/generator.rs`：读取、解码、方向归一化、缩放、WebP 编码、原子写入。
- `src-tauri/src/thumbnail/index.rs`：`thumbnail_cache` SQLite DAO、访问时间批量刷新、LRU 查询。
- `src-tauri/src/thumbnail/scheduler.rs`：优先队列、worker、内存预算、in-flight 去重、stale 取消。
- `src-tauri/src/thumbnail/service.rs`：Tauri 管理状态，连接 scheduler、index、事件和清理。
- `src-tauri/src/thumbnail/migration.rs`：缓存目录校验、manifest、同盘移动、跨盘复制校验、恢复和回滚。
- `src-tauri/src/commands/thumbnails.rs`：批量请求、重试、强制重建和缓存管理命令。

### 新增前端文件

- `src/lib/thumbnail.ts`：前后端协议类型、设置枚举、预设和值域归一化。
- `src/lib/thumbnail.test.ts`：设置和预设纯函数测试。
- `src/composables/useMasonryThumbnails.ts`：像素窗口请求、事件监听、状态映射、epoch 和重试。
- `src/composables/useMasonryThumbnails.test.ts`：请求批次、stale 事件、重试和清理测试。
- `src/components/filebrowser/MasonryThumbnail.vue`：单卡占位、spinner、淡入、失败重试。
- `src/components/filebrowser/MasonryThumbnail.test.ts`：卡片状态机和事件隔离测试。
- `src/components/settings/ThumbnailCacheSettings.vue`：资源模式、清晰度、缓存容量/目录、迁移和清理 UI。
- `src/components/settings/ThumbnailCacheSettings.test.ts`：设置联动和迁移状态测试。

### 修改文件

- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：图像、EXIF 和 WebP 依赖。
- `src-tauri/src/lib.rs`、`src-tauri/src/commands/mod.rs`：服务初始化和命令注册。
- `src-tauri/src/db/migrations.rs`：migration 009 缓存索引。
- `src/lib/tauri.ts`：缩略图 IPC 封装；图片字节仍不进入前端。
- `src/stores/settings.ts`、`src/stores/settings.test.ts`：九个设置项、预设与自定义模式。
- `src/composables/useMasonryLayout.ts`、对应测试：输出基于 top/height 的像素窗口路径。
- `src/components/filebrowser/MasonryView.vue`、对应测试：移除原图 `new Image()` 预读，接入缩略图队列。
- `src/components/filebrowser/MasonryRow.vue`、对应测试：渲染 `MasonryThumbnail`，保持选中和阅读状态。
- `src/components/filebrowser/RowContextMenu.vue`、对应测试：图片增加“重新生成缩略图”。
- `src/components/filebrowser/FileBrowser.vue`、对应测试：传递缩略图上下文和强制重建事件。
- `src/views/Settings.vue`、`src/views/Settings.test.ts`：挂载缓存设置组件。
- `src/locales/zh-CN.ts`、`src/locales/en-US.ts`、`src/locales/i18n-keys.test.ts`：新增双语文案。
- `docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md`：记录自动采样数据、命令和结论。

---

## 任务 1：锁定依赖与缩略图领域协议

**文件：**

- 修改：`src-tauri/Cargo.toml`
- 修改：`src-tauri/Cargo.lock`
- 新增：`src-tauri/src/thumbnail/mod.rs`
- 新增：`src/lib/thumbnail.ts`
- 新增：`src/lib/thumbnail.test.ts`

- [ ] **步骤 1：先写前端协议和值域失败测试**

在 `src/lib/thumbnail.test.ts` 覆盖：

```ts
expect(resolveThumbnailPreset('balanced')).toEqual({
  workerLimit: 2,
  decodeMemoryMb: 128,
  prefetchScreens: 1.5,
  idleGeneration: true,
  idlePrefetchScreens: 1,
});
expect(normalizeWorkerLimit(0)).toBe(1);
expect(normalizeWorkerLimit(9)).toBe(4);
expect(normalizeDecodeMemoryMb(129)).toBe(128);
expect(normalizeCacheLimitMb(1)).toBe(128);
```

同时锁定协议联合类型：

```ts
export type ThumbnailState =
  | { kind: 'original'; url: string }
  | { kind: 'cached'; cacheKey: string; path: string; width: number; height: number }
  | { kind: 'queued'; cacheKey: string }
  | { kind: 'generating'; cacheKey: string }
  | { kind: 'failed'; cacheKey: string; retryable: boolean; message: string }
  | { kind: 'unsupported' };
```

- [ ] **步骤 2：运行测试并确认失败**

执行：

```powershell
npx vitest run src/lib/thumbnail.test.ts
```

预期：FAIL，提示 `@/lib/thumbnail` 不存在。

- [ ] **步骤 3：实现最小协议和纯函数**

在 `src/lib/thumbnail.ts` 定义：

```ts
export type ThumbnailResourceMode = 'powerSaver' | 'balanced' | 'performance' | 'custom';
export type ThumbnailQuality = 'standard' | 'high' | 'ultra';
export type ThumbnailPriority = 'visible' | 'ahead' | 'behind' | 'idle';

export interface ThumbnailRequestItem {
  path: string;
  fileSize: number;
  modifiedAt: number | null;
  sourceWidth: number;
  sourceHeight: number;
  requiredWidth: number;
  priority: ThumbnailPriority;
}
```

实现三个固定预设和离散值归一化。质量档位仅传 `standard/high/ultra`，内部 bucket、像素阈值不暴露到设置层。

- [ ] **步骤 4：添加兼容项目 MSRV 的依赖**

在 `src-tauri/Cargo.toml` 增加：

```toml
image = { version = "0.24.9", default-features = false, features = ["jpeg", "png", "gif", "bmp", "webp"] }
kamadak-exif = "0.6.1"
webp = { version = "0.2.6", default-features = false }
```

在 `src-tauri/src/thumbnail/mod.rs` 先定义与 TS 同字段语义的 serde 类型，并从 `src-tauri/src/lib.rs` 暂时只声明 `mod thumbnail;`，不注册命令。

- [ ] **步骤 5：验证依赖、协议和 MSRV**

执行：

```powershell
npx vitest run src/lib/thumbnail.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：Vitest PASS；Cargo 完成依赖解析和编译，不出现 rust-version 错误。

- [ ] **步骤 6：提交**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/thumbnail/mod.rs src/lib/thumbnail.ts src/lib/thumbnail.test.ts
git commit -m "feat(masonry): define thumbnail protocol and dependencies"
```

---

## 任务 2：实现尺寸、生成阈值与资源预算纯函数

**文件：**

- 新增：`src-tauri/src/thumbnail/policy.rs`
- 修改：`src-tauri/src/thumbnail/mod.rs`

- [ ] **步骤 1：写策略失败测试**

测试必须覆盖：

- `required_width = card_width * dpr * quality_margin`；
- bucket 向上取 `512/768/1024/1536/2048`；
- 原图直用条件必须全部满足；
- 任一硬阈值命中即生成；
- 灰区为低优先生成；
- 正常图 3MP、极端长图 4MP 输出预算；
- 预计解码内存 `width * height * 4 + output_working_set`；
- 单任务超过预算时允许独占执行；
- 实际并发同时受 worker、内存和队列约束。

示例断言：

```rust
assert_eq!(select_bucket(801), 1024);
assert_eq!(select_bucket(2100), 2048);
assert_eq!(quality_policy(Quality::High).margin, 1.25);
assert_eq!(resource_preset(ResourceMode::Balanced).worker_limit, 2);
assert_eq!(resource_preset(ResourceMode::Balanced).decode_memory_mb, 128);
assert_eq!(allowed_jobs(2, 128, &[100, 100]), 1);
assert_eq!(allowed_jobs(2, 64, &[100]), 1);
```

- [ ] **步骤 2：运行并确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::policy
```

预期：FAIL，模块或函数不存在。

- [ ] **步骤 3：实现策略**

核心类型固定为：

```rust
pub enum SourceDecision { UseOriginal, Generate { bucket: u32, priority: GenerationUrgency } }
pub enum GenerationUrgency { Required, Opportunistic }
pub struct QualityPolicy { pub margin: f32, pub webp_quality: f32, pub max_bucket: u32 }
```

判断顺序：先计算方向归一化后的宽高，再算 `requiredWidth` 和 bucket；硬阈值优先于直用；直用条件必须全部成立；其余进入灰区。

- [ ] **步骤 4：运行策略测试**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::policy
```

预期：全部 PASS。

- [ ] **步骤 5：提交**

```powershell
git add src-tauri/src/thumbnail/mod.rs src-tauri/src/thumbnail/policy.rs
git commit -m "feat(masonry): add thumbnail sizing and budget policy"
```

---

## 任务 3：实现 EXIF Orientation 与缩略图生成器

**文件：**

- 新增：`src-tauri/src/thumbnail/orientation.rs`
- 新增：`src-tauri/src/thumbnail/generator.rs`
- 修改：`src-tauri/src/thumbnail/mod.rs`
- 新增：`src-tauri/tests/fixtures/thumbnail/README.md`
- 新增：`src-tauri/tests/thumbnail_generator.rs`

- [ ] **步骤 1：准备确定性 fixture**

测试运行时用 `image` 生成 3×2 四角不同颜色的 PNG/JPEG，再用测试 helper 写入 Orientation 1–8 的最小 EXIF APP1。`README.md` 记录角落颜色约定，避免依赖机器外部样本。

- [ ] **步骤 2：先写失败测试**

覆盖：

- Orientation 1–8 输出宽高和四角颜色；
- 方向 5–8 会交换宽高；
- JPEG、PNG、GIF、BMP、WebP 可解码；
- GIF 只取第一帧；
- PNG alpha 在 WebP 输出中保留；
- 长图输出像素不超过策略预算；
- 输出 WebP 无 EXIF Orientation；
- `.tmp` 写完后才 rename，失败不留下正式文件。

- [ ] **步骤 3：运行并确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test thumbnail_generator
```

预期：FAIL，generator API 不存在。

- [ ] **步骤 4：实现 Orientation 像素变换**

在 `orientation.rs` 用明确映射实现：

```rust
match orientation {
    2 => image.fliph(),
    3 => image.rotate180(),
    4 => image.flipv(),
    5 => image.rotate90().fliph(),
    6 => image.rotate90(),
    7 => image.rotate270().fliph(),
    8 => image.rotate270(),
    _ => image,
}
```

通过像素角落测试校正 5 和 7 的组合，不以肉眼判断方向。

- [ ] **步骤 5：实现生成管线**

`generator.rs` 的单入口：

```rust
pub fn generate_thumbnail(req: GenerateRequest) -> Result<GeneratedThumbnail, ThumbnailError>;
```

顺序固定为：读取原始字节 → EXIF Orientation → 解码第一帧 → 像素变换 → 按目标宽度和像素预算缩放 → RGBA/RGB 送入 `webp::Encoder` → 写 `.tmp` → flush → rename。禁止将 `DynamicImage` 或原始像素跨 IPC 返回。

- [ ] **步骤 6：验证生成器**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test thumbnail_generator
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::orientation
```

预期：Orientation 1–8、格式、alpha、像素预算和原子写测试全部 PASS。

- [ ] **步骤 7：提交**

```powershell
git add src-tauri/src/thumbnail src-tauri/tests/fixtures/thumbnail src-tauri/tests/thumbnail_generator.rs
git commit -m "feat(masonry): generate oriented WebP thumbnails"
```

---

## 任务 4：新增 migration 009 与缓存索引 DAO

**文件：**

- 修改：`src-tauri/src/db/migrations.rs`
- 新增：`src-tauri/src/thumbnail/key.rs`
- 新增：`src-tauri/src/thumbnail/index.rs`
- 修改：`src-tauri/src/thumbnail/mod.rs`

- [ ] **步骤 1：写 migration 和 key 失败测试**

在 `migrations.rs` 测试：升级到版本 9 后存在 `thumbnail_cache` 和 `idx_thumbnail_cache_lru`，旧表数据保持不变，重复执行幂等。

表结构严格采用设计文档字段：`cache_key/source_key/rel_path/source_size/source_modified_at/source_width/source_height/orientation/target_bucket/quality/cache_rel_path/output_width/output_height/byte_size/created_at/last_accessed_at`。

在 `key.rs` 测试：相同输入稳定、mtime/size/bucket/quality/policy version 任一变化都会变 key，绝对缓存根目录不参与 key。

- [ ] **步骤 2：运行并确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml db::migrations::tests::migration_009
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::key
```

预期：FAIL，版本仍为 8 或模块不存在。

- [ ] **步骤 3：实现 migration 009、稳定 key 和 DAO**

缓存相对路径固定为：

```text
v1/<cache-key[0..2]>/<cache-key>.webp
```

DAO 提供：`get`、`upsert`、`remove`、`total_bytes`、`oldest_until_bytes`、`touch_many`、`clear_all`。`touch_many` 每 30 秒或累计 100 条时事务提交一次。

- [ ] **步骤 4：增加真实文件一致性测试**

使用 `tempfile`：索引命中但文件不存在时返回 miss 并删除脏行；文件存在且 WebP 可解码时返回 hit；LRU 查询按 `last_accessed_at ASC`。

- [ ] **步骤 5：运行验证**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml migration_009
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::key
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::index
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```powershell
git add src-tauri/src/db/migrations.rs src-tauri/src/thumbnail/key.rs src-tauri/src/thumbnail/index.rs src-tauri/src/thumbnail/mod.rs
git commit -m "feat(masonry): persist thumbnail cache index"
```

---

## 任务 5：实现优先级调度、内存预算与 in-flight 去重

**文件：**

- 新增：`src-tauri/src/thumbnail/scheduler.rs`
- 修改：`src-tauri/src/thumbnail/mod.rs`

- [ ] **步骤 1：用假生成器写调度失败测试**

测试使用可控 channel，不做真实图片解码，覆盖：

- `visible > ahead > behind > idle`；
- 同优先级按提交顺序；
- 相同 cache key 只运行一次，多个订阅者收到同一结果；
- 新 epoch 到达后，旧 epoch 未开始的任务标 stale；
- 已开始任务允许完成并写缓存，但不向旧 epoch 发 UI 更新；
- worker=2 时同时运行不超过 2；
- 128MB 下两个 100MB 任务不并行；
- 单个 180MB 任务可在 128MB 配置下独占；
- 快速滚动期间 idle 不启动；
- 连续高优先级下，等待超过阈值的 ahead 不永久饥饿。

- [ ] **步骤 2：运行并确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::scheduler
```

预期：FAIL，scheduler 不存在。

- [ ] **步骤 3：实现 scheduler**

使用一个调度 actor 持有 `BinaryHeap<QueuedTask>`、`HashMap<CacheKey, InFlight>`、当前 worker 数和预计内存。真正的生成调用包在 `tokio::task::spawn_blocking`，不占 Tokio 异步 worker。

调度条件：

```rust
can_start = running_jobs < worker_limit
    && (running_memory + estimated_memory <= budget || running_jobs == 0);
```

设置变更只影响下一次调度，不中断正在编码的任务。

- [ ] **步骤 4：运行调度压力测试**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::scheduler -- --nocapture
```

预期：所有并发计数、顺序、stale 和去重断言 PASS，无挂起测试。

- [ ] **步骤 5：提交**

```powershell
git add src-tauri/src/thumbnail/scheduler.rs src-tauri/src/thumbnail/mod.rs
git commit -m "feat(masonry): schedule thumbnails within CPU and memory budgets"
```

---

## 任务 6：实现缩略图服务、缓存清理和 Tauri IPC

**文件：**

- 新增：`src-tauri/src/thumbnail/service.rs`
- 新增：`src-tauri/src/commands/thumbnails.rs`
- 修改：`src-tauri/src/commands/mod.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src/lib/tauri.ts`

- [ ] **步骤 1：写服务失败测试**

用临时 DB/缓存目录和 Local descriptor 覆盖：

- 小图满足全部直用条件返回 `original`；
- 大图首次返回 `queued`，完成后事件返回 `cached`；
- 热缓存直接返回 `cached`，不进入 worker；
- Local 路径只在 Rust 内解析；
- 非 Local 第一阶段返回 `unsupported`；
- 同一批请求只返回元数据，无 `Vec<u8>` 字段；
- 超过容量时从 100% 清到 80%，跳过 in-flight 和正在显示的保护 key；
- `clear_thumbnail_cache` 清文件和索引，但不删除根目录之外内容。

- [ ] **步骤 2：运行并确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::service
```

预期：FAIL，服务不存在。

- [ ] **步骤 3：实现 AppState 服务**

`ThumbnailService` 在 `setup` 中解析默认 `app_cache_dir()/thumbnail-cache`，从 settings 读取配置，恢复 index，并启动调度 actor。事件名固定为：

```text
thumbnail://state
thumbnail://cache-info
thumbnail://migration-progress
```

状态事件字段固定包含 `epoch/cacheKey/path/state/cachePath/outputWidth/outputHeight/message`，其中不适用字段为 `null`。

- [ ] **步骤 4：实现命令并注册**

命令：

```rust
request_thumbnails
retry_thumbnail
regenerate_thumbnail
update_thumbnail_runtime_config
get_thumbnail_cache_info
clear_thumbnail_cache
```

`request_thumbnails` 接收 `descriptor/items/epoch/visibleCacheKeys`。`retry` 使用相同 key；`regenerate` 删除旧文件和索引后重新排队。

- [ ] **步骤 5：封装前端 API**

在 `src/lib/tauri.ts` 只导出类型安全 wrapper，不允许组件直接 import `invoke`。缓存路径在前端用 `convertFileSrc(cachePath)` 转 asset URL。

- [ ] **步骤 6：运行后端验证**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::service
cargo test --manifest-path src-tauri/Cargo.toml commands::thumbnails
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：全部 PASS，`cargo check` 无未注册命令或 Send/Sync 错误。

- [ ] **步骤 7：提交**

```powershell
git add src-tauri/src/thumbnail/service.rs src-tauri/src/commands/thumbnails.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat(masonry): expose thumbnail cache service"
```

---

## 任务 7：把瀑布流预读改为像素窗口

**文件：**

- 修改：`src/composables/useMasonryLayout.ts`
- 修改：`src/composables/useMasonryLayout.test.ts`

- [ ] **步骤 1：写像素窗口失败测试**

新增纯函数：

```ts
selectPathsInPixelWindow(layout, entries, {
  scrollTop,
  viewportHeight,
  aheadScreens,
  behindScreens,
  idleScreens,
}): { visible: string[]; ahead: string[]; behind: string[]; idle: string[] }
```

测试不规则高度和多列布局，断言按 `item.top/item.height` 相交选择，而不是按数组下标扩展；四组互斥且每组保持 entries 原顺序。

- [ ] **步骤 2：运行并确认失败**

```powershell
npx vitest run src/composables/useMasonryLayout.test.ts
```

预期：FAIL，像素窗口 API 不存在。

- [ ] **步骤 3：实现像素窗口并替换旧输出**

删除 `PREFETCH_BUFFER` 和旧 `prefetchPaths`。输出 `thumbnailWindows`；可见区仍保留少量 DOM buffer，但缩略图需求窗口与 DOM buffer 分开计算。

- [ ] **步骤 4：验证边界**

加入 scrollTop=0、接近底部、viewportHeight=0、列数变化、0px gap 的测试。

```powershell
npx vitest run src/composables/useMasonryLayout.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：提交**

```powershell
git add src/composables/useMasonryLayout.ts src/composables/useMasonryLayout.test.ts
git commit -m "refactor(masonry): select thumbnail work by pixel window"
```

---

## 任务 8：实现前端队列 composable 和卡片状态机

**文件：**

- 新增：`src/composables/useMasonryThumbnails.ts`
- 新增：`src/composables/useMasonryThumbnails.test.ts`
- 新增：`src/components/filebrowser/MasonryThumbnail.vue`
- 新增：`src/components/filebrowser/MasonryThumbnail.test.ts`

- [ ] **步骤 1：写 composable 失败测试**

mock `src/lib/tauri.ts` 和 Tauri event listen，覆盖：

- 四级窗口合成一个去重 batch；
- request debounce 为 80ms；
- 目录、列宽、DPR 或质量变化递增 epoch；
- 旧 epoch 事件被忽略；
- cached 路径转 URL；
- retry 仅改变目标卡片；
- unmount 后 unlisten，晚到事件不改状态；
- 可见 cache key 随请求上报给 LRU 保护。

- [ ] **步骤 2：写组件失败测试**

覆盖每种状态的 DOM：

```text
placeholder -> 比例占位
queued/generating -> 单个 CSS spinner + aria-label
cached -> img + ready class
original -> img
failed -> button“点击重试”
```

断言失败按钮 click 调用 `stopPropagation()`，只 emit `retry`，不触发父行选择；`load` 后才加 120ms 淡入 class；`error` emit `load-error`。

- [ ] **步骤 3：运行并确认失败**

```powershell
npx vitest run src/composables/useMasonryThumbnails.test.ts src/components/filebrowser/MasonryThumbnail.test.ts
```

预期：FAIL，两个模块不存在。

- [ ] **步骤 4：实现 composable**

状态 Map 以 `entry.path` 为 key；request item 使用已测尺寸、文件 size/mtime、`colWidth * devicePixelRatio`。快速滚动期间不提交 idle，停止滚动 250ms 后才允许 idle。

- [ ] **步骤 5：实现卡片组件**

spinner 仅使用 `transform: rotate()`，不使用滤镜、模糊或全卡重绘动画。图片样式：

```css
.thumbnail-image { display: block; width: 100%; height: auto; opacity: 0; }
.thumbnail-image.is-ready { opacity: 1; transition: opacity 120ms ease-out; }
```

卡片高度继续由原图方向归一化后的真实宽高比计算，图片只适应宽度，不使用 `cover`、固定高度或裁剪。测试以 `naturalWidth/naturalHeight`、输出元数据和卡片比例一致来防止形变，并允许整数布局产生最多 1px 的取整误差。

- [ ] **步骤 6：运行验证**

```powershell
npx vitest run src/composables/useMasonryThumbnails.test.ts src/components/filebrowser/MasonryThumbnail.test.ts
```

预期：全部 PASS。

- [ ] **步骤 7：提交**

```powershell
git add src/composables/useMasonryThumbnails.ts src/composables/useMasonryThumbnails.test.ts src/components/filebrowser/MasonryThumbnail.vue src/components/filebrowser/MasonryThumbnail.test.ts
git commit -m "feat(masonry): add thumbnail queue and card states"
```

---

## 任务 9：接入 MasonryView 并移除原图预读

**文件：**

- 修改：`src/components/filebrowser/MasonryView.vue`
- 修改：`src/components/filebrowser/MasonryView.test.ts`
- 修改：`src/components/filebrowser/MasonryRow.vue`
- 修改：`src/components/filebrowser/MasonryRow.test.ts`

- [ ] **步骤 1：先写集成失败测试**

断言：

- `MasonryView` 不再构造 `new Image()` 预读原图；
- visible/ahead/behind/idle 来自像素窗口；
- 卡片接收 thumbnail state 而不是原图 `src`；
- 尺寸 header 返回后请求使用真实比例；
- 0px gap 的布局坐标相邻边完全相等；
- cached 输出比例与卡片比例误差不超过 1px；
- 首批尚未完成时每卡独立显示状态，中央全屏 loading 只用于 entries/尺寸骨架阶段；
- 切目录会清空状态并递增 epoch。

- [ ] **步骤 2：运行并确认失败**

```powershell
npx vitest run src/components/filebrowser/MasonryView.test.ts src/components/filebrowser/MasonryRow.test.ts
```

预期：FAIL，仍传原图 `src`，仍存在 `new Image()`。

- [ ] **步骤 3：完成接入**

`MasonryRow` 保留绝对定位、选中 outline 和阅读 badge，把图片区域委托给 `MasonryThumbnail`。`MasonryView` 调 `useMasonryThumbnails`，原图 URL 只作为 service 返回 `original` 时的显示地址。

- [ ] **步骤 4：增加源码守卫测试**

测试读取编译前模块或通过 mock 全局 `Image` 统计，保证滚动预读不会创建脱离 DOM 的原图 Image 对象。此测试用于防止以后重新引入原图预解码。

- [ ] **步骤 5：运行验证**

```powershell
npx vitest run src/components/filebrowser/MasonryView.test.ts src/components/filebrowser/MasonryRow.test.ts src/composables/useMasonryLayout.test.ts
npm run type-check
```

预期：全部 PASS，无 prop/emits 类型错误。

- [ ] **步骤 6：提交**

```powershell
git add src/components/filebrowser/MasonryView.vue src/components/filebrowser/MasonryView.test.ts src/components/filebrowser/MasonryRow.vue src/components/filebrowser/MasonryRow.test.ts
git commit -m "feat(masonry): render cached thumbnails instead of originals"
```

---

## 任务 10：增加单击重试和右键强制重建

**文件：**

- 修改：`src/components/filebrowser/RowContextMenu.vue`
- 修改：`src/components/filebrowser/RowContextMenu.test.ts`
- 修改：`src/components/filebrowser/FileBrowser.vue`
- 修改：`src/components/filebrowser/FileBrowser.test.ts`
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`
- 修改：`src/locales/i18n-keys.test.ts`

- [ ] **步骤 1：写交互失败测试**

断言：失败覆盖层单击只重试；右键图片出现 `fileBrowser.contextMenu.regenerateThumbnail`；目录和非图片不显示；点击后调用 `regenerateThumbnail`，关闭菜单并让对应卡片进入 queued。

- [ ] **步骤 2：运行并确认失败**

```powershell
npx vitest run src/components/filebrowser/RowContextMenu.test.ts src/components/filebrowser/FileBrowser.test.ts src/locales/i18n-keys.test.ts
```

预期：FAIL，菜单事件和 i18n key 不存在。

- [ ] **步骤 3：实现菜单事件链**

给 `RowContextMenu` 增加 `regenerate-thumbnail` emit；`FileBrowser` 接收后通过 `MasonryView` expose 的 `regenerate(path)` 或共享 composable action 执行。不要把“普通重试”和“强制删除缓存后重建”合并。

- [ ] **步骤 4：运行验证**

```powershell
npx vitest run src/components/filebrowser/RowContextMenu.test.ts src/components/filebrowser/FileBrowser.test.ts src/components/filebrowser/MasonryThumbnail.test.ts src/locales/i18n-keys.test.ts
```

预期：全部 PASS，中英文 key 集合一致。

- [ ] **步骤 5：提交**

```powershell
git add src/components/filebrowser/RowContextMenu.vue src/components/filebrowser/RowContextMenu.test.ts src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts src/locales/zh-CN.ts src/locales/en-US.ts src/locales/i18n-keys.test.ts
git commit -m "feat(masonry): retry and regenerate failed thumbnails"
```

---

## 任务 11：持久化资源模式、清晰度和缓存限制

**文件：**

- 修改：`src/stores/settings.ts`
- 修改：`src/stores/settings.test.ts`
- 新增：`src/components/settings/ThumbnailCacheSettings.vue`
- 新增：`src/components/settings/ThumbnailCacheSettings.test.ts`
- 修改：`src/views/Settings.vue`
- 修改：`src/views/Settings.test.ts`
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`

- [ ] **步骤 1：写 store 失败测试**

覆盖九个 key 的默认值、加载、持久化和值域归一化。选择预设时一次性更新对应资源参数；手改 worker、内存、预读或 idle 后模式变为 `custom`；清晰度和缓存上限不改变资源模式。

默认值固定为：

```text
balanced / 2 / 128 / high / 1.5 / true / 1 / default-root / 512
```

- [ ] **步骤 2：写设置组件失败测试**

覆盖：预设下高级参数只读展示；选择 custom 后可编辑；worker 4 显示警告；缓存上限最小 128MB；修改值调用 store setter 和 `update_thumbnail_runtime_config`；缓存统计显示文件数和字节数。

- [ ] **步骤 3：运行并确认失败**

```powershell
npx vitest run src/stores/settings.test.ts src/components/settings/ThumbnailCacheSettings.test.ts src/views/Settings.test.ts
```

预期：FAIL，新设置和组件不存在。

- [ ] **步骤 4：实现 store 和设置 UI**

每个 setter 先更新 ref，再持久化，再推送 Rust runtime config。多个预设字段使用一个 store action 顺序写 DB，最后推送一次 runtime config，避免中间态多次重排调度器。

把 `ThumbnailCacheSettings` 挂在现有 masonry section 下，保留列数与 gap 设置在前，缩略图资源和缓存设置在后。

- [ ] **步骤 5：运行验证**

```powershell
npx vitest run src/stores/settings.test.ts src/components/settings/ThumbnailCacheSettings.test.ts src/views/Settings.test.ts src/locales/i18n-keys.test.ts
npm run type-check
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```powershell
git add src/stores/settings.ts src/stores/settings.test.ts src/components/settings/ThumbnailCacheSettings.vue src/components/settings/ThumbnailCacheSettings.test.ts src/views/Settings.vue src/views/Settings.test.ts src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(settings): configure thumbnail resources and cache"
```

---

## 任务 12：实现缓存位置校验和可恢复迁移

**文件：**

- 新增：`src-tauri/src/thumbnail/migration.rs`
- 修改：`src-tauri/src/thumbnail/service.rs`
- 修改：`src-tauri/src/commands/thumbnails.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src/lib/tauri.ts`
- 修改：`src/components/settings/ThumbnailCacheSettings.vue`
- 修改：`src/components/settings/ThumbnailCacheSettings.test.ts`

- [ ] **步骤 1：先写迁移失败测试**

使用两个临时目录和注入式 filesystem adapter 覆盖：

- 目标目录可创建、可写、不是源目录子目录；
- 同卷走 rename；
- 跨卷走 `copy -> .tmp -> byte size + WebP decode 校验 -> rename`；
- manifest 每完成一个文件原子更新；
- 取消后旧 root 仍为 active；
- 全部校验成功后才切 settings root；
- 提交后删除旧缓存文件和 manifest；
- 中断后 resume 跳过已校验文件；
- rollback 删除目标临时/已复制缓存，保留旧目录；
- 索引相对路径无需逐行重写；
- 迁移和清理期间生成队列暂停。

- [ ] **步骤 2：运行并确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::migration
```

预期：FAIL，migration service 不存在。

- [ ] **步骤 3：实现 manifest 状态机**

manifest 固定字段：

```rust
struct MigrationManifest {
    version: u32,
    source_root: PathBuf,
    target_root: PathBuf,
    mode: MigrationMode,
    phase: MigrationPhase,
    completed: BTreeSet<String>,
    total_files: u64,
    total_bytes: u64,
    copied_bytes: u64,
}
```

phase 为 `Preparing/Moving/Verifying/Committing/Completed/Cancelled/RollingBack`。manifest 写入目标根的 `.mirapage-thumbnail-migration.json.tmp` 后原子替换正式文件。

- [ ] **步骤 4：注册管理命令**

增加：

```text
validate_thumbnail_cache_location
migrate_thumbnail_cache
cancel_thumbnail_cache_migration
resume_thumbnail_cache_migration
rollback_thumbnail_cache_migration
get_thumbnail_migration_state
```

应用启动时检测 manifest，仅上报恢复状态，不自动选择继续或回滚。

- [ ] **步骤 5：接入设置 UI**

目录选择使用现有 Tauri dialog plugin；有缓存时给“迁移已有缓存”和“从新位置开始”两个明确动作。迁移进度显示文件数、字节数、阶段和取消按钮；恢复状态显示继续/回滚。

- [ ] **步骤 6：运行迁移与 UI 验证**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnail::migration
npx vitest run src/components/settings/ThumbnailCacheSettings.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
npm run type-check
```

预期：全部 PASS；取消、中断、继续、回滚都由临时目录断言确认旧缓存可用。

- [ ] **步骤 7：提交**

```powershell
git add src-tauri/src/thumbnail/migration.rs src-tauri/src/thumbnail/service.rs src-tauri/src/commands/thumbnails.rs src-tauri/src/lib.rs src/lib/tauri.ts src/components/settings/ThumbnailCacheSettings.vue src/components/settings/ThumbnailCacheSettings.test.ts
git commit -m "feat(settings): migrate thumbnail cache safely"
```

---

## 任务 13：自动化集成与性能验收

**文件：**

- 新增：`src-tauri/tests/thumbnail_pipeline.rs`
- 新增：`src/components/filebrowser/MasonryThumbnail.integration.test.ts`
- 新增：`docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md`
- 按结果修改：上述实现文件

- [ ] **步骤 1：写冷缓存和热缓存集成测试**

在 Rust 临时目录生成以下数据集：普通 JPEG、透明 PNG、Orientation 1–8 JPEG、25MP JPEG、宽高比大于 10:1 的长图、损坏文件、同名但 mtime 不同文件。

断言：

- 第一次请求生成，第二次请求命中；
- WebP 可重新解码，方向、宽高和 alpha 正确；
- 大图不把完整像素送到前端协议；
- 坏图失败不阻塞同批其他图；
- 默认同时生成数不超过 2，预计内存不超过 128MB，超预算单任务独占；
- 缓存超过上限后回落到 80% 水位。

- [ ] **步骤 2：写 DOM 和事件集成测试**

模拟 1,000 个不定高 entry、滚动和状态事件，断言：

- 实际 MasonryRow DOM 不超过 40；
- 可见窗口只请求当前相交和配置的前后屏；
- 快速滚动不会提交连续 idle 批次；
- stale 事件不替换新目录卡片；
- 缩略图 ready 前后卡片 top/left/width/height 不变；
- 失败重试不会改变选中项；
- 0px gap 的水平和垂直相邻边差值为 0。

- [ ] **步骤 3：先运行并记录基线失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test thumbnail_pipeline -- --nocapture
npx vitest run src/components/filebrowser/MasonryThumbnail.integration.test.ts
```

预期：首次编写时若任何目标不满足则 FAIL；不得通过放宽设计阈值掩盖失败。

- [ ] **步骤 4：加入可重复性能采样**

测试内部用 `Instant` 记录 Rust 冷生成、热命中和每任务解码峰值估算；前端测试用 `performance.now()` 记录 1,000 项布局、滚动状态批处理和单次事件更新。报告记录机器信息、fixture 参数、命令、P50/P95/max 和是否达标。

验收阈值：

```text
MasonryRow DOM                    <= 40
默认 Local 生成并发              <= 2
默认预计解码内存                 <= 128MB，单个超预算任务独占除外
热缓存请求到状态返回 P95         <= 500ms
典型 JPEG 冷缓存首张完成         <= 500ms
冷缓存主要可见区完成             <= 2s
前端滚动状态处理单次 max          < 50ms
前端 >100ms 长任务                0
热缓存主要滚动帧处理 max          < 33ms
瀑布流直接加载超过硬阈值的原图    0
```

时间阈值测试在 CI 中只输出数据并断言算法/并发硬约束；在本地 Windows Tauri 环境执行时才作为发布阻断，避免共享 runner 抖动产生误报。

- [ ] **步骤 5：运行完整验证矩阵**

```powershell
npm test
npm run type-check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：全部命令 exit code 0。

- [ ] **步骤 6：检查设计覆盖和禁止项**

执行：

```powershell
rg -n "new Image\(|base64|readFile\(" src/components/filebrowser src/composables/useMasonryThumbnails.ts
rg -n "TODO|TBD|placeholder implementation|暂不实现" src-tauri/src/thumbnail src/composables/useMasonryThumbnails.ts src/components/filebrowser/MasonryThumbnail.vue
```

预期：第一条不命中缩略图字节预读实现；第二条无结果。`readFile` 若出现在旧的 header 尺寸通路注释中，必须确认不用于缩略图完整字节传输。

- [ ] **步骤 7：填写性能报告**

`docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md` 必须包含：

- commit SHA；
- Windows、WebView2、CPU、内存和构建模式；
- 数据集图片数、尺寸、格式和总字节；
- 每项阈值的实测值和 PASS/FAIL；
- 失败项的根因和后续任务，不写模糊结论。

- [ ] **步骤 8：最终提交**

```powershell
git add src-tauri/tests/thumbnail_pipeline.rs src/components/filebrowser/MasonryThumbnail.integration.test.ts docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md
git commit -m "test(masonry): verify thumbnail pipeline and performance"
```

---

## 最终核对清单

- [ ] 没有目录全量缩略图生成入口。
- [ ] WebView 不通过 IPC 接收图片二进制或 Base64。
- [ ] 瀑布流大图命中硬阈值时不再直接加载原图。
- [ ] 阅读器仍使用原图，不受缩略图清晰度和缓存清理影响。
- [ ] EXIF Orientation 1–8 由像素断言覆盖，输出不含 EXIF。
- [ ] 透明通道和 GIF 第一帧行为有测试。
- [ ] 默认 worker=2、预算=128MB，设置变更运行时生效。
- [ ] worker、内存、质量、预读、idle、缓存位置和上限都可持久化。
- [ ] in-flight 去重、stale 取消和单任务独占预算有测试。
- [ ] 缓存写入原子，LRU 从 100% 清到 80%。
- [ ] 缓存迁移支持同盘、跨盘、取消、继续和回滚。
- [ ] 普通失败可单击重试，右键可强制重建。
- [ ] 0px gap 的坐标断言通过，加载前后卡片几何不变化。
- [ ] 中英文 i18n key 完全一致。
- [ ] `npm test`、type-check、build、Cargo test/check 全部通过。
- [ ] 性能报告包含可复现命令和原始数值。
