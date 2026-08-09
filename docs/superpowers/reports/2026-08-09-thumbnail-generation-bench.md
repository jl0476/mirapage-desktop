1# 缩略图制作（Generation）性能与瓶颈实测报告

- **日期**：2026-08-09
- **模块**：v0.1.0-module3.0.7-masonry-thumbnail-cache
- **背景**：缩略图首次生成慢（4K 单张 ~3.2s），用户反馈"加载慢"。本报告通过分阶段 benchmark 定位瓶颈，实测各优化方案的真实加速比。
- **关联**：实现报告 [`2026-08-08-masonry-thumbnail-performance.md`](./2026-08-08-masonry-thumbnail-performance.md)、代码审查 [`2026-08-08-masonry-thumbnail-code-review.md`](./2026-08-08-masonry-thumbnail-code-review.md)
- **benchmark 代码**：[`src-tauri/tests/thumbnail_bench.rs`](../../src-tauri/tests/thumbnail_bench.rs)（`#[ignore]`，手动跑）

---

## ⚠ 基准方法限制（必须先读）

本报告的数据有以下方法论限制，结论应视为**当前样本下的观察**，非发布包的精确预测：

1. **test profile（debug 构建）**：`cargo test` 默认 dev profile，未优化。release 包真实耗时更低，但比例关系可能不同。
2. **仅 3 次取最小值**：样本量小，掩盖抖动。应预热后 20-30 次取 median/p95。
3. **各阶段与 total 分别取不同轮次的最小值**：阶段表里 `decode`/`resize`/`encode` 的 min 可能来自不同轮次，**不能严格相加**等于 total。total 是独立取 min。因此"分项之和 = total"不成立，基于分项的预估是粗略的。
4. **单机单次环境**：未控制后台负载、CPU 频率缩放、热节流。
5. **纯 bench 缺源读取与原子写入**：`bench_gen_stages` 从内存字节开始（source_bytes 已读入），不含源文件读取和 `write_atomic` 的 IO；端到端测法又混入前端轮询/IPC/事件/渲染。两者差值**未分段归因**。

后续严谨 bench 建议 见第 12 节。

---

## 1. 复现命令

```bash
cd src-tauri

# 各阶段耗时（decode / orient / resize / encode）
cargo test --test thumbnail_bench bench_gen_stages -- --ignored --nocapture

# resize 方案对比（image Triangle vs thumbnail vs Nearest vs fast-image-resize）
cargo test --test thumbnail_bench bench_resize_compare -- --ignored --nocapture
```

> 跑前需停 `tauri:dev`（避免 target 锁）。测试图取自 `F:\WallPaper\normal`（1080p PNG / 4K JPEG / 7802×4389 PNG 三档）。

---

## 2. 制作管线（`generator.rs::generate_thumbnail`）

源图字节 -> WebP 缓存文件，7 步固定顺序：

```
源字节 ──① read_orientation(EXIF 1-8)
       ──② image::load_from_memory(decode JPEG/PNG/GIF/BMP/WEBP 首帧)
       ──③ apply_orientation(方向归一化，烘焙进像素)
       ──④ compute_output_size(目标宽高: bucket + pixel_budget + clarity_floor)
       ──⑤ resize_exact(Triangle)(缩放, 不放大)
       ──⑥ encode_webp(按 alpha 选 RGB/RGBA, webp crate)
       ──⑦ write_atomic(.tmp -> flush -> fsync -> rename)
```

**关键约束**：`DynamicImage` / 原始像素**绝不跨 IPC**（图片字节不进前端），成功结果只回宽高 + 字节数；缩略图字节落在磁盘缓存文件，前端经 asset protocol 加载。

**输出尺寸算法**（`compute_output_size`）：
- 不放大（输出宽 ≤ 源宽）
- 按目标宽度缩放后若总像素超预算（普通 3MP / 长图 4MP），等比缩到预算内
- 清晰度底线（`clarity_floor_width`）优先于预算（保证最小清晰度）

---

## 3. 各阶段实测耗时（`bench_gen_stages`，3 次取最好）

| 图 | decode | orient | resize | encode | total |
|---|---|---|---|---|---|
| 1080p PNG（2MP）| 67ms (10%) | 0 | **541ms (84%)** | 37ms (6%) | 646ms |
| 4K JPEG（8MP）| 1072ms (37%) | 0 | **1750ms (60%)** | 56ms (2%) | 2896ms |
| 7802×4389 PNG（34MP）| 3415ms (34%) | 0 | **6657ms (65%)** | 63ms (1%) | 10183ms |

**观察**（受第 ⚠ 节方法限制约束）：
- resize 在三档中都占比最高（60-84%），是首要优化方向
- decode 次要（10-37%），encode 极小（1-6%）
- 阶段值分别取各轮 min，**不可严格相加**；占比按各自 min 粗算，仅作方向参考

---

## 4. 单张总时间（两种测法对比）

| 图片 | 纯生成（bench，不含源读取/写入）| 端到端（devtools 前端 regenerate 轮询）|
|---|---|---|
| 1920×1080 | 646ms | **867ms** |
| 4K | 2896ms | **3.2s** |
| 7802×4389 | 10183ms | **10.5s** |

**差值未归因**：端到端与纯 bench 的差值（如 4K 的 ~300ms）包含前端轮询频率、IPC、事件处理、渲染、资源加载，而纯 bench 又不含源文件读取与 `write_atomic` 原子写入。两侧测的不是一个东西，**不能简单相减得出"调度开销"**。要归因需分段 trace（见第 12 节）。

---

## 5. 资源画像（单次采样）

| 资源 | 占用 | 说明 |
|---|---|---|
| **CPU** | 生成时 ~1.3 核（32 核机器的 4%）| `image` crate **纯 Rust 无 SIMD**，decode/resize 单线程 |
| 内存 | 进程 176MB | decode 后 RGBA buffer 是 transient（4K ~33MB/张），生成完释放 |
| IO | 极小 | 读源 + 写小 WebP（~50KB）|

**观察**：CPU 是瓶颈而非内存。但"~1.3 核"是单次采样，不能据此判定 `image` crate 内部存在串行点--并发未达 worker_limit 的原因可能是可见任务数、去重命中、内存准入拒绝，或单纯那次工作负载没同时跑满两个 job（见第 6 节）。

---

## 6. 调度模型（`scheduler.rs`）

```
allowed_jobs = min(worker_limit, 内存允许数, 队列长度)
单张超预算时独占（running==0 允许）
执行走 spawn_blocking（每个 admitted job 独立 blocking 线程）
```

| 参数 | 默认 | UI 选项 / 归一化上限 | 预设值 |
|---|---|---|---|
| worker_limit | 2 | `[1,2,3,4]` / `WORKER_LIMIT_MAX=4` | PowerSaver 1 / Balanced 2 / Performance 3 |
| memory_budget | 128MB | `[64,128,256,512]` | PowerSaver 64 / Balanced 128 / Performance 256 |
| 优先级 | visible>ahead>behind>idle | - | 窗口内先跑可见区 |
| 老化 | 5s 阈值 | - | 等待久的任务优先级提升，防饥饿 |

**并发未达 worker_limit 的原因未定位**：4K 图 est_mem ~51MB，2 张 102MB < 128MB 理论允许 2 并发，但第 5 节单次采样只见 ~1.3 核。可能原因：
- 该次工作负载的可见任务数不足 2（thumbnailWindows 内可见图少）
- in-flight 去重命中（同 cache_key 只跑一次）
- 内存准入拒绝（est_mem 估算与实际偏差）
- **不能推出 `image` crate 内部串行**：每个 admitted job 走独立 `spawn_blocking`（`scheduler.rs:358`），线程层面是并行的

要确认需记录 `running_count`/`pending`/dedup 命中/内存拒绝，并用 2/3/4 个**不同** 4K 图同时请求测吞吐（见第 12 节）。

---

## 7. 缓存命中模型

生成完写入索引（`thumbnail_cache` 表）+ WebP 文件。下次请求走 `get_verified`（按 cache_key 查索引 + 校验文件存在/大小）：
- 命中 -> 返回 cached（< 10ms，asset 加载 2-3ms）
- miss -> 删脏行 + 重新生成

**cache_key 输入**：source_descriptor + rel_path + size + modified + target_bucket + quality + orientation_version + algorithm_version（任一变则重新生成）。

---

## 8. resize 优化方案实测对比（`bench_resize_compare`，三档）

| 图 | image Triangle（当前）| image thumbnail | image Nearest | fast-image-resize |
|---|---|---|---|---|
| 1080p PNG | 519ms | **301ms (1.7x)** | 99ms (5.2x) | 851ms (0.6x) |
| 4K JPEG | 1728ms | **1113ms (1.6x)** | 183ms (9.4x) | 2944ms (0.6x) |
| 7802×4389 PNG | 6849ms | **4709ms (1.5x)** | 328ms (20.9x) | 11331ms (0.6x) |

**观察**：
- `image::imageops::thumbnail`（area resampling）三档稳定 1.5-1.7x，零依赖
- `fast-image-resize` 默认在大幅缩小场景（缩小比 7.5x）**反而更慢**（0.6x）--fir 的 SIMD 优势在大幅缩小时体现不出，默认 filter 更重。换库方案否决
- Nearest 最快但锯齿，缩略图不推荐

**质量客观评估（PSNR vs Triangle 基线，`bench_thumbnail_quality`）**：三档 PSNR -- 1080p PNG 42.5dB / 4K JPEG 53.0dB / 7802×4389 PNG 45.1dB，均 > 40dB（几乎无视觉差异）；输出尺寸 + alpha 一致性 assert 通过。thumbnail 已替换 Triangle 落地（见 `generator.rs`）。

---

## 9. 已落地的稳定性修复（影响制作链路）

本会话在排查"加载慢"过程中，定位并修复了多个影响制作链路的稳定性问题：

| # | 问题 | 根因 | 修复 | 效果 |
|---|---|---|---|---|
| 1 | **缩略图永不加载**（全 spinner）| `ThumbnailRequestItem` 漏 `rename_all="camelCase"`，Tauri 2 不转 struct 字段 case -> 反序列化失败 -> `flushRequest` catch 静默吞错 | 加 serde 标注 + 回归测试 | stateMap 0->53，首屏可加载 |
| 2 | **白屏 + 右键失效**（5 处）| header 失败的图 `flushRequest`/`findEntry` skip -> 永不请求 + 右键 regenerate 无效 | `decide_source` 0 尺寸强制 Generate / `HEADER_READ_LEN` 8192->65536 / 未测量传 0 不 skip / `MasonryThumbnail` undefined 显示 spinner | 白屏->0，右键 regenerate 生效 |
| 3 | **死锁/无响应**（Db Mutex 长期持有）| `spawn_completion` 在 async worker 做同步 Db+IO+Mutex lock，竞争时连锁卡死所有 Db 命令 | Db+evict 移入 `spawn_blocking` / pk 锁移入 Db 锁内统一顺序 / emit 移出 Db 锁 | get_info 超时->3ms，压测无卡 |
| 4 | **旧索引兼容**（P0 修复前遗留）| 旧索引 `cache_rel_path` 缺 `v1/`，迁移后 miss -> 重新生成 4K | `repair_legacy_cache_rel_paths` 启动补前缀 | 旧索引命中，免重新生成 |

> 这些修复确保"制作链路"能正常工作（请求能到达、生成不卡死、缓存能命中），是性能优化的前提。

---

## 10. 待决策优化（按性价比）

| 方案 | 效果 | 成本 | 推荐 |
|---|---|---|---|
| **resize -> `image::thumbnail`** | 4K resize 1.6x（三档 1.5-1.7x），PSNR > 40dB | 零依赖，已实施 | ✅ 已落地 |
| 增 worker_limit（≤4，UI 上限）+ decodeMemory 256MB | 多核并发，新目录首屏可能提速 | 设置页自助，零代码 | ⚪ 用户可试，效果需测 |
| mozJPEG 替换 decode（JPEG）| JPEG decode 可能 10x | C 依赖，中等改动 | ⚪ 性价比待 release bench 验证 |
| fast-image-resize | 0.6x 更慢 | - | ❌ 实测否决 |

**4K 收益粗估（不精确）**：triangle 1728ms -> thumbnail 1113ms，差 615ms。若总时间约 2896ms，则约 2281ms，**约 -21%**（非此前误写的 -23%）。注意这是分项 min 外推，实际总时间需同次样本测量。

---

## 11. 综合判断（观察，非定论）

以下均为**当前样本下的观察**，受第 ⚠ 节方法限制约束：

- 缓存命中后首屏加载快（单次观察 ~1.5s 22 张），首次生成 4K ~3.2s/张
- 慢的根因方向：`image` crate 全链路纯 Rust 单线程（decode + resize），无 SIMD；4K 单张里 resize 占比最高
- "~0.3s/MP"是三档混合 PNG/JPEG 的粗略观察，**不能按像素数精确归因**（PNG/JPEG 解码成本不同）
- "破 1s 必须动 decode"是基于当前 decode 占比的推断；若 resize 先优化（thumbnail 1.6x），decode 占比会上升，结论可能变化
- 免费午餐方向：`thumbnail`（零依赖 1.5-1.7x，质量待评估）

**方法论启示**：性能优化前必须先 benchmark 定位真瓶颈。本次"换 decode 库"和"换 resize 库（fir）"两个直觉假设都被实测推翻--真瓶颈是 resize，且 fir 在大幅缩小场景反而更慢。但本次 bench 方法本身也有局限（test profile / 3 次 / 阶段分别 min），更严谨的结论需补 release + 多次 + 同次样本的测量。

---

## 12. 后续严谨 bench 建议

针对第 ⚠ 节的方法限制，如需精确数据支撑决策，建议补：

1. **release profile + 充分采样**：`cargo test --release`，预热后 20-30 次，报告 median/p95/min-max；每次保留完整阶段样本（decode/resize/encode/total 来自**同一次**运行）。
2. **分段 trace 归因端到端**：在 request 入队、实际启动、源读取完成、生成完成、索引写入、事件发出、前端收到、图片 load 各点打时间戳，归因 ~300ms 差值的真实构成。
3. **并发吞吐实测**：记录 `running_count`/`pending`/dedup 命中/内存拒绝/实际开始时间；用 2/3/4 个**不同** 4K 图同时请求，测吞吐与首屏延迟，确认 worker_limit 提升的真实收益（而非凭 est_mem 推断）。
4. **thumbnail 质量客观评估**：SSIM/PSNR 对比 Triangle vs thumbnail；验证输出尺寸、透明 PNG、EXIF 旋转、缓存元数据一致性。三档图分别测（本报告第 8 节已补三档 resize 数据，但总时间预估仍需同次样本）。
5. **PNG/JPEG 分离归因**：decode 成本按格式分组测，避免混算"每像素耗时"。
