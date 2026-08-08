# 瀑布流按需缩略图与缓存设计

- **日期**：2026-08-08
- **模块**：v0.1.0-module3.0.7-masonry-thumbnail-cache
- **状态**：待审查
- **依赖模块**：v0.1.0-module3.0.6-masonry
- **适用范围**：第一阶段实现 Local 数据源；核心接口保持 `SourceDescriptor` 通用，为 Archive / SMB / WebDAV 后续接入保留边界

---

## 1. 背景

v0.1.0-module3.0.6 为文件浏览器增加了按真实宽高比排列的瀑布流视图，并实现：

- 变高虚拟滚动，只渲染当前可见区与缓冲区；
- Rust 读取图片 header，提前获得宽高；
- `new Image()` 对视口附近原图进行预读；
- `<img decoding="async">`；
- 真实比例占位、按需 header 预读和加载提示。

这些措施解决了目录规模、DOM 数量、图片比例和磁盘冷读取问题，但不能解决多张 4K/8K 原图同时进入 WebView2 渲染管线时的掉帧。

### 1.1 性能诊断结论

测试目录：`normal`，224 张壁纸，常见尺寸为 3K–6K。

通过 `requestAnimationFrame` 统计滚动期间帧间隔，并进行控制变量实验：

| 实验 | 最大单帧 | 大于 100ms 的严重掉帧 | 结论 |
|---|---:|---:|---|
| 基线：约 18 张 3K–4K 原图 | 313ms | 5 | 明显卡顿 |
| 增加 `will-change` 与 `contain: paint` | 296ms | 3 | 改善很小，图层隔离不是根因 |
| 隐藏 `.masonry-img`，保留全部布局 DOM | 18.6ms | 0 | 恢复正常，确认瓶颈来自大图解码、纹理上传和绘制 |

同时观察到：

- JS `longtask` 数量为 0，布局计算不是当前 224 图场景的主要瓶颈；
- 图片使用 `convertFileSrc()` 通过 Tauri asset protocol 加载，不存在把原图二进制或 Base64 通过 `invoke` 传输的问题；
- 原图预读只能提前完成读取和部分解码，不能降低原始像素数量与 GPU 纹理成本。

**结论：瀑布流必须停止直接渲染大尺寸原图，改为只渲染与列宽匹配的按需缩略图。**

---

## 2. 目标与非目标

### 2.1 目标

1. 瀑布流中不再直接渲染超过阈值的 4K/8K 原图。
2. 缩略图保持完整图片内容与真实宽高比，不裁剪。
3. 首次访问只生成当前视口附近的缩略图，不全量扫描或生成整个目录。
4. 快速滚动、切目录、切视图时，后台任务不会继续无效占用 CPU、内存和磁盘。
5. 缩略图清晰度随列宽、系统 DPR 和窗口大小自适应。
6. 缓存可持久复用、限制容量、自动清理，并支持修改和迁移缓存位置。
7. 失败时提供明确的单卡片重试入口，不让单张坏图阻塞整批任务。
8. EXIF Orientation 在 Rust 端归一化，缩略图方向与布局尺寸一致。
9. 图片字节不通过 Tauri IPC 传输；IPC 只传状态、路径和小型元数据。

### 2.2 非目标

1. 不为全部目录预生成缩略图。
2. 第一阶段不支持 Archive / SMB / WebDAV 的缩略图生成；只保持接口可扩展。
3. 不修改原图，不向原图写入任何数据。
4. 不把缩略图作为备份、导出或长期媒体资产。
5. 不做专业级完整色彩管理；第一阶段以稳定的 sRGB 显示为目标。
6. 不做超长图纵向分片；若 3–4MP 整图缩略图仍不能满足性能，再单独设计切片方案。
7. 不使用 WGPU 绕过 WebView2；当前问题可通过降低瀑布流像素量解决。

---

## 3. 核心决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 生成范围 | 均衡模式默认可见区 + 向下 1.5 屏 + 向上 0.5 屏；支持资源预设和自定义 | 保证正常滚动命中，同时严格限制资源 |
| 生成时机 | 视口驱动；均衡模式停止滚动后额外预生成 1 屏 | 不全量生成，不让快速滚动制造大量无效任务 |
| 占位方式 | 真实比例占位 + 单卡片轻量 spinner | 首次访问不加载大原图，也不发生布局跳动 |
| 输出尺寸 | 根据列宽、DPR、清晰度余量选择 512–2048 档 | 兼顾清晰度、缓存复用与渲染成本 |
| 大图判定 | 像素、字节数、相对显示尺寸综合判断 | 单一长边或文件大小都不足以反映成本 |
| 输出格式 | 静态 WebP；默认高清质量82，支持标准/高清/超清，保留 alpha | 体积、清晰度和 WebView2 支持平衡较好 |
| EXIF | 只读取 Orientation 并应用到像素；输出不复制 EXIF | 避免双重旋转、隐私泄露和额外体积 |
| 资源并发 | 默认均衡模式：2 worker + 128MB 预计解码内存预算；支持预设和高级设置 | 防止两张超大图同时解码导致内存峰值，同时允许用户按设备能力调节 |
| 文件传输 | asset protocol 加载缓存文件 | 避免大字节 IPC |
| 磁盘缓存 | 默认 512MB，LRU 清理，用户可选 256MB/512MB/1GB/2GB | 有界、可配置、可重建 |
| 缓存位置 | 默认系统 Local cache；支持修改和迁移已有缓存 | 避免 Roaming，满足用户磁盘规划需求 |
| 迁移策略 | 同盘优先 rename，跨盘复制后校验，再切换和删除旧目录 | 可恢复、不丢缓存 |
| 失败重试 | 失败覆盖层单击重试；右键提供“重新生成缩略图” | 普通操作可发现，高级操作可强制绕过缓存 |

---

## 4. 总体架构

```text
Vue MasonryView
  │
  ├─ 计算当前列宽、DPR、可见区和预生成窗口
  ├─ 对每张图片计算目标尺寸档位和优先级
  └─ 批量请求缩略图状态（小型 JSON）
          │
          ▼
Rust ThumbnailService（Tauri managed state）
  ├─ 缓存 key / 文件有效性判断
  ├─ in-flight 去重
  ├─ visible / ahead / behind 优先级队列
  ├─ worker 与预计解码内存预算
  ├─ 读取原图、EXIF 方向归一化、缩放、WebP 编码
  ├─ 原子写入磁盘缓存
  ├─ SQLite 元数据索引
  └─ 发送 thumbnail-ready / thumbnail-failed 小型事件
          │
          ▼
Vue ThumbnailStateMap
  ├─ placeholder / queued / generating / ready / failed
  └─ ready 后将缓存绝对路径 convertFileSrc()，由 <img> 直接加载
```

### 4.1 模块边界

建议新增以下 Rust 单元：

```text
src-tauri/src/thumbnail/
  mod.rs             模块导出
  service.rs         服务状态、请求入口、队列调度、in-flight 去重
  policy.rs          尺寸档位、大图阈值、优先级和内存预算纯函数
  generator.rs       解码、EXIF 归一化、缩放、WebP 编码
  cache.rs           路径、原子写入、命中校验、LRU 清理
  migration.rs       缓存位置迁移、恢复和回滚
  types.rs           IPC/事件/内部类型

src-tauri/src/commands/
  thumbnails.rs      Tauri command 薄封装
```

前端建议新增：

```text
src/composables/useMasonryThumbnails.ts
  负责窗口请求、状态映射、事件监听、重试和 URL 切换

src/lib/thumbnailPolicy.ts
  前端尺寸需求镜像纯函数；与 Rust policy 语义一致并做一致性测试

src/components/filebrowser/MasonryThumbnail.vue
  负责占位、spinner、ready 淡入和失败覆盖层
```

`MasonryView.vue` 只负责布局与把 `entry + layout item + thumbnail state` 传给卡片，不承担缓存队列内部逻辑。

---

## 5. 生成窗口与任务优先级

### 5.1 窗口范围

均衡模式默认只关注：

```text
向上 0.5 屏 | 当前可见区 | 向下 1.5 屏
```

若当前可见 DOM 约 18 张，通常同时关注约 30–40 张。目录有 224、3944 或 14949 张时，任务规模仍保持在几十张。

当前 `prefetchPaths` 按 entry 索引扩展，不完全等价于像素屏数。新实现应基于 `layout.map` 的 `top/height` 与视口像素范围筛选：

```text
behindTop = max(0, scrollTop - viewportHeight * 0.5)
aheadBottom = scrollTop + viewportHeight * 2.5
```

筛选与该像素范围相交的图片，并按位置划分优先级。

### 5.2 优先级

| 优先级 | 范围 | 行为 |
|---|---|---|
| 0 `visible` | 当前视口相交 | 最高优先，优先占用空闲 worker |
| 1 `ahead` | 默认向下 1.5 屏 | 正常向下滚动预生成；范围由资源模式或高级设置决定 |
| 2 `behind` | 默认向上 0.5 屏 | 方便短距离回滚；按向下范围自动计算 |
| 3 `idle` | 默认停止滚动后额外向下 1 屏 | 仅 CPU 和队列空闲时运行；可关闭或调整 |

### 5.3 快速滚动

滚动事件在 150ms 内持续发生时视为快速滚动：

- 停止添加 `idle` 任务；
- 尚未开始的 `ahead/behind` 任务若离开窗口，立即从队列移除；
- 当前可见任务进入最高优先级；
- 已开始解码的任务不强制中断，让其完成并写缓存；
- 已读取但尚未进入解码阶段的 stale 任务允许取消。

停止滚动 300–500ms 后恢复正常预生成。

### 5.4 切目录与切视图

每个请求批次携带 `generation_id`：

- 切目录、切数据源或退出 masonry 时递增 `generation_id`；
- 未开始任务移除；
- 旧任务可以完成磁盘缓存写入，但不得更新新目录的 Vue 状态；
- 切回 details 后不继续创建新任务。

---

## 6. 缩略图尺寸与生成阈值

### 6.1 需求宽度

```text
required_width = card_css_width × device_pixel_ratio × quality_margin
quality_margin = 由清晰度设置决定；默认高清为 1.25
```

选择不小于需求宽度的最小尺寸档位：

```text
512 / 768 / 1024 / 1536 / 2048
```

用户界面不直接暴露 `quality_margin`、WebP 数值质量和尺寸档位，而提供三档“缩略图清晰度”：

| 清晰度 | 余量 | WebP质量 | 最大档位 |
|---|---:|---:|---:|
| `standard` 标准 | 1.0 | 78 | 1536 |
| `high` 高清 | 1.25 | 82 | 2048 |
| `ultra` 超清 | 1.5 | 88 | 2048 |

默认 `high`。清晰度变化不触发全缓存重建：现有缓存继续显示，仅在当前需求超过现有缓存能力时按需升级。质量等级参与 cache key，旧版本由 LRU 自然清理。

示例：

| 卡片宽度 | DPR | 加余量后的需求 | 选择档位 |
|---:|---:|---:|---:|
| 280px | 1.0 | 350px | 512 |
| 440px | 1.0 | 550px | 768 |
| 600px | 1.25 | 938px | 1024 |
| 750px | 1.5 | 1406px | 1536 |
| 900px | 2.0 | 2250px | 使用 2048 或原图，按阈值判断 |

### 6.2 直接使用原图

仅当以下条件全部满足时，masonry 可以直接使用原图：

```text
显示方向下的原图宽度 ≤ 目标档位 × 1.25
总像素 ≤ 2MP
原文件体积 ≤ 2MB
```

小图已经接近显示需求，生成缩略图收益不足。

### 6.3 必须生成缩略图

满足任一条件即生成：

```text
显示方向下的原图宽度 > 目标档位 × 1.5
或总像素 > 4MP
或原文件体积 > 4MB
或任意边 > 4096px
```

2–4MP、2–4MB 或尺寸倍率 1.25–1.5 的灰色区间仍生成缩略图，但优先级低于明确的大图。首次没有缓存时继续显示占位，不使用大原图作为临时回退，以免重新引入卡顿。

### 6.4 像素预算与超长图

普通缩略图目标不超过 3MP，极端长图允许放宽到 4MP。

按目标宽度缩放后若仍超过预算，则继续等比缩小，但最终宽度不得低于：

```text
card_css_width × device_pixel_ratio
```

清晰度底线与像素预算冲突时优先保证清晰度。若极端长图仍造成渲染问题，另立模块设计纵向切片，不在本阶段裁剪图片。

### 6.5 列数与窗口变化

- ResizeObserver 变化防抖 300ms；
- 只有需求跨尺寸档位才请求新版本；
- 已有更大档位可直接复用，不主动降级生成小版本；
- 现有较小档位可先显示，后台升级到更高档位；
- 同一档位内只重排布局，不重新生成。

缓存选择顺序：

```text
优先：不小于需求宽度的最小缓存
其次：已有最大缓存先显示，同时后台升级
最后：无缓存则占位 + spinner + 生成
```

---

## 7. EXIF、格式与颜色处理

### 7.1 当前行为

现有 masonry `<img>` 和 OpenSeadragon 都把原图 URL 交给 WebView2 的浏览器图片解码器，项目代码没有显式处理 EXIF Orientation。现代 WebView2 通常会按 EXIF 显示方向解码。

现有 Rust `image_header.rs` 只读取 JPEG SOF 的物理宽高，没有读取 Orientation。因此可能出现浏览器显示为竖图、布局却按横图比例计算的不一致。

### 7.2 方向归一化

缩略图生成流程：

```text
读取 EXIF Orientation
→ 解码原始像素
→ 执行 Orientation 1–8 对应的旋转/镜像
→ 得到显示方向像素和显示宽高
→ 缩放
→ 输出无方向元数据的 WebP
```

| Orientation | 处理 |
|---:|---|
| 1 | 不变 |
| 2 | 水平镜像 |
| 3 | 旋转 180° |
| 4 | 垂直镜像 |
| 5 | 镜像 + 旋转 90° |
| 6 | 顺时针 90° |
| 7 | 镜像 + 旋转 270° |
| 8 | 逆时针 90° |

`list_image_dimensions` 也应返回显示方向宽高；Orientation 5–8 需要交换宽高。

### 7.3 元数据策略

缩略图是可删除缓存，不复制 EXIF：

- Orientation 应用到像素后删除或写为 1；
- 不复制 GPS、相机信息、拍摄参数、MakerNote、作者、版权、拍摄时间和原始内嵌缩略图；
- 属性面板若未来展示 EXIF，始终读取原图；
- alpha 透明通道不是 EXIF，必须保留；
- 优先把颜色转换为 sRGB；第一阶段不实现专业级色彩管理。

### 7.4 格式策略

| 原格式 | 缩略图行为 |
|---|---|
| JPEG | 方向归一化后编码 WebP |
| PNG | 保留 alpha，编码 WebP |
| BMP | 强制生成 WebP |
| GIF / 动态 WebP | 仅取第一帧生成静态 WebP |
| 静态 WebP | 按阈值决定复用原图或重新缩放 |
| SVG | 第一阶段不做 Rust 光栅化；保持原图并限制后续专项处理 |
| AVIF | 依赖选定 Rust 解码库能力；支持时按普通静态图处理，不支持时进入 failed 状态 |

默认“高清”对应 WebP 质量 82。漫画文字、线稿和高频壁纸不使用质量 70，以避免块状和边缘模糊。

---

## 8. 生成队列与资源预算

### 8.1 资源模式

资源控制采用“预设 + 高级设置”结构。普通用户只需选择模式；修改任一高级参数后自动切换为 `custom`。

| 模式 | Worker 上限 | 解码内存预算 | 向下预生成 | 空闲额外生成 |
|---|---:|---:|---:|---:|
| `powerSaver` 节能 | 1 | 64MB | 0.5屏 | 关闭 |
| `balanced` 均衡 | 2 | 128MB | 1.5屏 | 1屏 |
| `performance` 高性能 | 3 | 256MB | 2.5屏 | 2屏 |
| `custom` 自定义 | 用户指定 | 用户指定 | 用户指定 | 用户指定 |

默认使用 `balanced`。高性能模式不默认使用 4 worker；同时解码多张 4K 图片可能增加 CPU 争用和内存峰值，3 worker 已属于激进配置。

### 8.2 Worker 上限

第一阶段 Local 数据源：

```text
默认最大并发 worker = 2
可选范围 = 1 / 2 / 3 / 4
```

- 修改后只影响后续任务，不强行终止正在执行的任务；
- 4 worker 显示高 CPU/内存占用警告；
- 不允许超过 4；
- worker 是并发上限，不代表调度器必须占满。

### 8.3 解码内存预算

```text
默认预计解码内存总预算 = 128MB
可选范围 = 64 / 128 / 256 / 512MB
```

任务开始前估算：

```text
estimated_decode_bytes = displayed_width × displayed_height × 4
```

若并行任务预计内存总和超过用户预算，后续任务等待。25MP 图片解码约需 100MB，在默认 128MB 预算下通常只能单任务执行。

单张图片本身超过预算时不能永久阻塞：当没有其他任务处于解码阶段时，允许一张超预算图片独占执行，并在卡片状态中显示“正在处理超大图片”。

实际并发始终按以下公式计算：

```text
actual_concurrency = min(
  worker_limit,
  memory_budget_allowed_tasks,
  runnable_queue_size
)
```

用户设置是资源上限，不是必须消耗完的目标。

解码、旋转、缩放和编码必须放到 Rust blocking worker，例如 `spawn_blocking`，不得占用 Tokio 异步调度线程，也不得交给 JS/Canvas。

### 8.4 预生成范围设置

高级设置允许调整向下预生成范围：

```text
0 / 0.5 / 1 / 1.5 / 2 / 3 屏
```

- 默认 1.5 屏；
- 0 表示只处理当前可见区；
- 范围越大，连续滚动命中率越高，但 CPU、IO 和缓存增长更快；
- 向上保留范围不单独开放，按向下范围约 1/3 自动计算，并在启用预生成时至少保留 0.5 屏。

空闲额外预生成范围：

```text
关闭 / 0.5 / 1 / 2 屏
```

默认 1 屏，仅在以下条件全部满足时执行：

- 停止滚动至少 500ms；
- 没有 `visible` 任务；
- worker 和内存预算有空余；
- 未进行缓存迁移或清理。

### 8.5 In-flight 去重

同一个 `cache_key` 同时只能有一个生成任务：

```text
请求到达
  ├─ ready：立即返回缓存路径
  ├─ in-flight：订阅现有任务结果
  └─ miss：创建新任务
```

避免 DOM 请求、预读请求、列数升级和多窗口请求重复解码同一大图。

### 8.6 公平性与运行时保护

- `visible` 永远优先于 `ahead/behind/idle`；
- 同级任务按距视口中心的距离排序；
- 单个目录最多连续占用一定批次，避免未来多窗口时长期饿死另一窗口；
- 缓存命中不占 worker；
- LRU 清理和缓存迁移不与缩略图编码抢占同一 blocking 并发额度。

无论用户如何配置，调度器始终强制以下保护：

- 内存预算优先于 worker 上限；
- `visible` 优先于所有预生成任务；
- 快速滚动暂停 `idle` 并清理过期排队任务；
- 缓存迁移和手动清理期间暂停生成；
- 系统出现明显内存压力时可临时降为单 worker；
- EXIF归一化、in-flight去重、stale取消和原子写入不能被用户关闭。

---

## 9. 缓存文件与索引

### 9.1 默认位置

缩略图使用系统本地缓存目录，不进入 Roaming 数据：

```text
%LOCALAPPDATA%/top.racyan.mirapage-desktop/cache/masonry-thumbnails/v1/
```

macOS/Linux 使用 Tauri 对应的 app cache directory。

### 9.2 文件布局

```text
masonry-thumbnails/v1/
  ab/cd/<cache-key>-512.webp
  ab/cd/<cache-key>-768.webp
  ef/01/<cache-key>-1024.webp
```

两级 hash 分片避免单目录文件数过多。文件名不直接包含用户路径，避免特殊字符、隐私和超长路径问题。

### 9.3 Cache key

第一阶段 Local key 包含：

```text
SourceDescriptor 规范化 JSON
相对路径
源文件大小
源文件 modifiedAt
尺寸档位
输出质量
方向归一化版本
缩略图算法版本
```

未来数据源身份：

- WebDAV：path + ETag；无 ETag 时 size + modifiedAt；
- SMB：path + size + modifiedAt；
- Archive：压缩包身份 + 压缩包 modifiedAt + entry path + CRC（可用时）。

### 9.4 原子写入

```text
生成到目标目录临时文件
→ flush / close
→ 校验可解码或至少校验非零大小
→ rename 为最终文件名
→ 更新 SQLite 索引
```

应用中断不会留下看似有效的不完整文件。超过 24 小时的 `.tmp` 在启动后后台清理。

### 9.5 SQLite 元数据

新增 migration 009，建议表结构：

```sql
CREATE TABLE thumbnail_cache (
  cache_key          TEXT PRIMARY KEY,
  source_descriptor TEXT NOT NULL,
  rel_path           TEXT NOT NULL,
  size_bucket        INTEGER NOT NULL,
  source_size        INTEGER,
  source_modified_at INTEGER,
  relative_file      TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  width              INTEGER NOT NULL,
  height             INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  last_accessed_at   INTEGER NOT NULL,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  failure_until      INTEGER
);

CREATE INDEX idx_thumbnail_cache_lru
ON thumbnail_cache(last_accessed_at);
```

索引只保存相对缓存文件名，缓存根目录迁移时无需更新每条记录。

### 9.6 访问时间批量写入

每次 `<img>` 命中不立即写 SQLite：

- Rust 内存暂存访问时间；
- 每 30–60 秒批量 flush；
- 正常退出时尽力 flush；
- LRU 允许近似，不追求毫秒级精确。

---

## 10. 容量限制与自动清理

### 10.1 默认设置

| 设置 | 默认值 | 可选值 |
|---|---:|---|
| 缓存容量 | 512MB | 256MB / 512MB / 1GB / 2GB |
| 自动清理高水位 | 100% | 固定 |
| 清理目标 | 80% | 固定 |
| 未访问优先期 | 30天 | 内部策略 |

### 10.2 清理触发

- 写入后发现容量超过上限；
- 设置页降低容量；
- 用户点击“清理缓存”；
- 启动后检测旧版本或孤儿文件；
- 自动清理最多每分钟触发一次，不阻塞浏览。

### 10.3 LRU 删除

超过容量后按 `last_accessed_at` 从旧到新删除，直到降到上限的 80%。30 天未访问缓存优先进入候选。

删除顺序：

```text
删除缓存文件
→ 删除 SQLite 索引
```

若文件缺失则直接删索引；若索引缺失但发现孤儿文件，低优先级后台清理。

### 10.4 手动清理

清理前：

- 暂停新任务；
- 取消尚未开始的任务；
- 等待正在写入的临时文件结束或标记为废弃；
- 删除缓存文件和索引；
- 恢复队列。

清理不影响原图、阅读进度、书库和业务数据库数据。

---

## 11. 自定义缓存位置与迁移

### 11.1 设置界面

Settings 新增“缩略图缓存”区域：

```text
资源模式
[均衡 ▼]

缩略图清晰度
[高清 ▼]

缓存位置
[C:\Users\...\masonry-thumbnails] [更改]

缓存上限
[512MB ▼]

当前占用：184MB，共 1,284 个文件
[打开缓存目录] [清理缓存]

[展开高级设置]
  最大并发任务       [2 ▼]
  解码内存预算       [128MB ▼]
  向下预生成范围     [1.5屏 ▼]
  空闲时继续预生成   [开启]
  空闲额外生成范围   [1屏 ▼]
```

用户修改任一高级资源参数时，资源模式自动变为“自定义”；重新选择节能/均衡/高性能模式时，以该模式预设覆盖高级参数，并在UI中即时显示将采用的worker、内存和预生成范围。

自定义位置校验：

- 必须是可写目录；
- 不允许磁盘根目录；
- 不允许项目工作区或原图目录本身；
- 写入测试文件验证权限；
- 检查目标磁盘空间；
- 网络映射盘允许选择，但显示性能警告；
- 目标暂时不可用时回退默认缓存目录并提示，不静默丢失当前配置。

### 11.2 迁移选项

切换位置时提供：

```text
○ 移动现有缓存到新位置
○ 清理旧缓存，之后按需重新生成
```

项目必须支持迁移已有缓存。

### 11.3 迁移流程

```text
暂停新缩略图任务
→ 等待/取消当前队列
→ 校验目标目录
→ 统计源文件数和总字节
→ 检查目标空间（当前缓存大小 + 10%余量）
→ 迁移
→ 校验
→ 原子切换缓存根路径设置
→ 删除迁移 manifest
→ 后台删除旧目录
→ 恢复生成任务
```

迁移期间已有缩略图继续从旧目录显示，未缓存卡片保持占位和 spinner。

### 11.4 同盘与跨盘

- 同一文件系统优先目录 rename；
- rename 不可用时降级逐文件复制；
- 跨盘逐文件复制到 `.tmp`，校验大小后 rename；
- 整体校验完成前不删除任何旧文件。

### 11.5 可恢复迁移

迁移目录保存 manifest：

```json
{
  "sourceRoot": "...",
  "targetRoot": "...",
  "startedAt": 0,
  "copiedFiles": 0,
  "totalFiles": 0,
  "copiedBytes": 0,
  "totalBytes": 0,
  "status": "copying"
}
```

异常退出后启动时提供：

```text
检测到未完成的缓存迁移
[继续迁移] [回滚到原位置]
```

回滚时缓存根仍指向旧目录，删除目标临时文件和副本。旧文件在成功提交前从不删除。

### 11.6 迁移进度与取消

设置页显示文件数、字节数和进度。用户可取消：

- 停止安排新复制；
- 当前文件复制完成后退出；
- 根路径保持旧位置；
- 清理目标临时文件与副本；
- 恢复缩略图生成队列。

应用退出不强制等待迁移完成，下次可继续或回滚。

---

## 12. 前端卡片状态与交互

### 12.1 状态机

```text
placeholder
  → queued
  → generating
  → ready
  → failed
```

状态含义：

| 状态 | 视觉 | 行为 |
|---|---|---|
| `placeholder` | 按真实比例占位 | 等待进入请求窗口 |
| `queued` | 中央小 spinner | 已排队，尚未获得 worker |
| `generating` | 同一 spinner | 正在生成，不显示高频百分比 |
| `ready` | 缩略图 120ms opacity 淡入 | spinner 消失 |
| `failed` | 错误图标 + “点击重试” | 可直接重试 |

### 12.2 Spinner 性能约束

- 只在当前真实 DOM 的卡片显示；
- 预读区无 DOM，不渲染 spinner；
- 使用简单 CSS border 旋转；
- 不使用 blur、filter、box-shadow；
- 同屏通常不超过 30–40 个；
- `prefers-reduced-motion` 下改为静态加载图标；
- 动画只修改 transform，淡入只修改 opacity。

### 12.3 失败重试

失败卡片覆盖层包含明确按钮：

```text
图片加载失败
↻ 点击重试
```

点击重试按钮：

- `stopPropagation()`，不改变图片选中状态；
- 清除短期失败标记；
- 检查并删除损坏缓存；
- 重新进入最高优先级队列；
- 状态返回 spinner；
- 成功后淡入。

右键菜单增加“重新生成缩略图”：

- 即使当前 ready 也可使用；
- 删除当前尺寸档位的缓存；
- 忽略短期失败状态；
- 强制重新生成；
- 用于方向、颜色、损坏或陈旧缓存问题。

### 12.4 自动重试

- 同一次浏览自动重试最多一次；
- IO暂时错误允许退避重试；
- 损坏或不支持格式写入 `failure_until`，避免每次滚动重复解码；
- 单张失败不阻塞批次；
- 磁盘写失败但内存允许时，可在当前会话展示内存结果并提示缓存未保存。

---

## 13. IPC 与事件设计

### 13.1 原则

IPC 只传小型 JSON，不传图片二进制、Base64 或像素数组。

缓存图片由：

```text
Rust 返回缓存绝对路径
→ 前端 convertFileSrc(path)
→ WebView2 asset protocol 原生加载文件
```

现有 `tauri.conf.json` 已启用 `protocol-asset`，无需为第一阶段额外引入 `img-cache://` 自定义协议。

### 13.2 批量请求

建议 command：

```ts
requestMasonryThumbnails({
  generationId,
  descriptor,
  requests: Array<{
    relPath: string;
    targetBucket: 512 | 768 | 1024 | 1536 | 2048;
    priority: 'visible' | 'ahead' | 'behind' | 'idle';
    sourceSize?: number;
    sourceModifiedAt?: number;
  }>;
}): Promise<Array<{
  relPath: string;
  status: 'original' | 'ready' | 'queued' | 'failed';
  cachePath?: string;
  width?: number;
  height?: number;
  errorKind?: string;
}>>
```

批量接口避免每张卡片一次 invoke。

### 13.3 事件

Rust 完成任务后发送小型事件：

```text
masonry-thumbnail-ready
masonry-thumbnail-failed
masonry-thumbnail-migration-progress
masonry-thumbnail-migration-complete
masonry-thumbnail-cache-cleared
```

事件必须包含 `generationId`、`relPath` 和 `cacheKey`。前端忽略不属于当前 generation 的 UI 更新，但缓存文件本身可保留。

### 13.4 管理命令

建议包括：

- `retry_masonry_thumbnail`；
- `invalidate_masonry_thumbnail`；
- `get_thumbnail_cache_info`；
- `clear_thumbnail_cache`；
- `validate_thumbnail_cache_location`；
- `migrate_thumbnail_cache`；
- `cancel_thumbnail_cache_migration`；
- `resume_thumbnail_cache_migration`；
- `rollback_thumbnail_cache_migration`。

所有前端调用仍必须封装在 `src/lib/tauri.ts`，组件不直接 import `invoke`。

---

## 14. 设置与持久化

新增 settings key：

```text
fb_thumbnail_resource_mode          balanced
fb_thumbnail_worker_limit           2
fb_thumbnail_decode_memory_mb       128
fb_thumbnail_quality                high
fb_thumbnail_prefetch_screens       1.5
fb_thumbnail_idle_generation        1
fb_thumbnail_idle_prefetch_screens  1
fb_thumbnail_cache_root             空值表示系统默认 cache dir
fb_thumbnail_cache_limit_mb         512
```

值域与归一化：

| key | 合法值 |
|---|---|
| `fb_thumbnail_resource_mode` | `powerSaver / balanced / performance / custom` |
| `fb_thumbnail_worker_limit` | `1 / 2 / 3 / 4` |
| `fb_thumbnail_decode_memory_mb` | `64 / 128 / 256 / 512` |
| `fb_thumbnail_quality` | `standard / high / ultra` |
| `fb_thumbnail_prefetch_screens` | `0 / 0.5 / 1 / 1.5 / 2 / 3` |
| `fb_thumbnail_idle_generation` | `0 / 1` |
| `fb_thumbnail_idle_prefetch_screens` | `0 / 0.5 / 1 / 2` |
| `fb_thumbnail_cache_limit_mb` | 预设或自定义，最小 128MB |

加载设置时必须归一化越界值。缓存自定义上限若超过目标磁盘可用空间的20%，显示警告但不直接禁止；真正写入仍受磁盘空间检查和LRU高水位保护。

不向用户暴露以下安全或实现参数：2MP/4MP生成阈值、2MB/4MB文件阈值、3MP/4MP像素预算、尺寸档位列表、EXIF处理、输出格式、LRU 100%→80%水位、in-flight去重、stale取消和resize防抖。这些参数必须保持内部一致，避免错误配置重新引入大图卡顿或缓存分裂。

运行时状态不放 settings：

- 当前容量与文件数由缓存服务计算；
- 迁移进度来自服务事件/manifest；
- 生成队列与 in-flight 状态只在内存；
- 每张图片状态由 `useMasonryThumbnails` 管理。

修改缓存位置时，只有迁移成功提交后才持久化新 root。迁移未完成或回滚时 settings 仍指向旧位置。

---

## 15. 数据源演进

### 15.1 第一阶段：Local

第一阶段只实现 Local：

- 已有稳定绝对路径和 asset protocol；
- 当前卡顿复现目录均为 Local；
- 可先验证生成、缓存、迁移和清理完整闭环；
- 避免同时引入远程下载、压缩包 entry 解码和连接错误处理。

### 15.2 通用边界

以下接口从第一阶段开始使用 `SourceDescriptor`，不写死 Local：

- cache key builder；
- thumbnail request types；
- source identity；
- generator 输入抽象；
- failure kind；
- 缓存索引字段。

未来接入时只新增“如何获得原始字节/文件身份”，不修改 Vue 状态机、尺寸策略、缓存清理和迁移。

### 15.3 非 Local 暂时行为

Archive / SMB / WebDAV 在第一阶段继续使用现有原图路径或占位行为，不假装缩略图已支持。UI不显示“生成中”后永久等待；服务应明确返回 `unsupported_source`，前端按当前兼容策略展示。

---

## 16. 错误处理

| 错误 | 行为 |
|---|---|
| 原图不存在 | failed，不自动无限重试 |
| 权限拒绝 | failed，显示权限错误 |
| 图片损坏 | failed + failure cooldown |
| 格式不支持 | failed，允许右键强制重试但结果可再次失败 |
| 磁盘空间不足 | 停止磁盘写入，触发清理；仍不足则提示 |
| 缓存文件损坏 | 删除文件与索引，重新生成 |
| 缓存目录不可用 | 回退默认目录并提示；不丢当前配置意图 |
| SQLite索引写失败 | 删除刚生成文件或标记孤儿，避免假命中 |
| 任务过期 | 可完成缓存写入，不更新当前UI |
| 迁移中断 | 下次启动继续或回滚 |
| 旧缓存删除失败 | 新缓存继续使用，设置页提供再次清理 |

日志记录阶段耗时：读取、解码、方向处理、缩放、编码、写盘。默认不打印用户完整路径到公开日志，使用截断路径或 cache key。

---

## 17. 测试策略

### 17.1 Rust 纯函数

`thumbnail/policy.rs`：

- 资源模式到worker、内存和预生成范围的映射；
- 自定义worker与内存值域归一化；
- `actual_concurrency`同时受worker、内存和队列限制；
- 单张图片超过预算时允许独占执行且不死锁；
- DPR与质量余量选择正确档位；
- 标准/高清/超清映射到正确余量、WebP质量和最大档位；
- 小图直接原图判定；
- >4MP、>4MB、边长>4096强制生成；
- 灰色区间低优先生成；
- 3MP/4MP像素预算；
- 超长图清晰度底线；
- 预计解码内存；
- 优先级排序；
- cache key 稳定性与输入变化失效。

### 17.2 EXIF与编码

构造或 fixture 覆盖 Orientation 1–8：

- 方向正确；
- 5–8宽高交换；
- 输出 Orientation 删除或为1；
- alpha保留；
- 动图只取第一帧；
- 输出尺寸和像素预算正确；
- 缩略图可被标准解码器重新打开。

### 17.3 Cache

- 命中、miss、损坏文件自愈；
- 原子写入中断无最终脏文件；
- 同 cache key in-flight 去重；
- LRU从100%清至80%；
- 索引缺文件与文件缺索引；
- 临时文件清理；
- 修改时间、大小、档位和算法版本变化后失效。

### 17.4 Migration

- 同盘rename；
- 跨盘复制；
- 空间不足拒绝开始；
- 中途取消回滚；
- 应用中断后继续；
- 目标文件冲突；
- 校验失败不切root；
- 成功后旧目录删除失败不影响新缓存；
- settings只在成功提交后更新。

### 17.5 Vue / TypeScript

- 像素窗口筛选和优先级；
- generationId过滤旧事件；
- placeholder/queued/generating/ready/failed状态；
- spinner只在DOM可见卡片；
- ready淡入；
- 点击重试不触发行选择；
- 右键强制重建；
- 列数跨档升级、同档不重建；
- 修改高级参数后资源模式切为自定义；
- 切换资源预设正确覆盖高级参数；
- worker、内存、预生成范围和清晰度设置持久化及越界归一化；
- 切目录取消过期状态；
- `prefers-reduced-motion`静态图标；
- 中英文i18n key一致。

### 17.6 集成与 E2E

至少覆盖：

1. `normal` 224张3K–6K壁纸；
2. 含EXIF Orientation 1–8的目录；
3. 透明PNG、BMP、GIF、WebP、损坏图片；
4. 极端长图；
5. 快速滚动到底再回顶；
6. 列数2→8→2切换；
7. 冷缓存与热缓存；
8. 清理缓存；
9. 修改缓存位置并迁移；
10. 迁移中退出并恢复；
11. 节能/均衡/高性能资源模式切换；
12. 自定义worker 1–4与内存64–512MB组合；
13. 标准/高清/超清在不同DPR和列数下的清晰度与缓存升级。

---

## 18. 性能验收标准

在 `normal` 目录、常用4列、冷缓存和热缓存分别测量：

| 指标 | 目标 |
|---|---:|
| 可见DOM图片数 | ≤40 |
| masonry中直接渲染超过阈值的4K原图 | 0 |
| 本地SSD首张缩略图出现 | ≤500ms（典型JPEG） |
| 冷缓存首屏主要内容可见 | ≤2s |
| 热缓存首屏主要内容可见 | ≤500ms |
| 滚动最大单帧 | <50ms |
| >100ms严重掉帧 | 0 |
| 热缓存主要帧时间 | <33ms |
| Rust缩略图预计解码内存 | 不超过当前用户预算；单张超预算图片只允许独占执行 |
| 实测额外瞬时内存 | 均衡模式目标<150MB；其他模式不得无视用户预算并发 |
| Local生成并发 | 不超过当前worker上限；默认均衡模式≤2 |
| 快速滚动后过期排队任务 | 在一个调度周期内移除 |

若缩略图方案仍出现>100ms掉帧，首先检查实际 `<img naturalWidth>` 是否仍是原图尺寸，以及是否有原图预读残留。当前 `MasonryView` 的 `new Image()` 原图预读必须由缩略图预生成请求完全替代。

---

## 19. 实施阶段划分

### 阶段 A：策略与EXIF纯函数

- 引入并配置图片解码/缩放依赖；
- 尺寸档位、大图阈值、像素预算；
- EXIF Orientation 1–8；
- cache key；
- Rust与TS策略一致性测试。

### 阶段 B：Local生成器与磁盘缓存

- `ThumbnailService`；
- 受控 worker、内存预算、in-flight 去重；
- WebP生成；
- 原子写入；
- migration 009索引；
- asset protocol路径返回。

### 阶段 C：Vue按需队列与卡片状态

- 像素级生成窗口；
- 批量请求和事件；
- 单卡spinner、淡入和失败重试；
- 移除现有 `new Image()` 原图预读；
- 列数/DPR档位升级。

### 阶段 D：缓存设置、清理与迁移

- 容量设置和统计；
- 资源模式、清晰度与高级资源设置；
- worker/内存/预生成范围持久化与运行时生效；
- 清理；
- 修改缓存位置；
- 同盘/跨盘迁移；
- manifest恢复与回滚；
- 设置页进度UI。

### 阶段 E：E2E与性能回归

- 冷/热缓存；
- 真实大图；
- EXIF和特殊格式；
- 迁移异常；
- rAF帧时间对照；
- 更新DESIGN.md、CLAUDE.md和E2E报告。

---

## 20. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Rust图片库显著增加构建体积 | 只启用需要的JPEG/PNG/GIF/WebP feature，评估release增量 |
| WebP编码本身抢CPU | 受worker上限与内存预算双重约束，快速滚动暂停低优先任务 |
| EXIF库与解码库方向语义不同 | Orientation 1–8 fixture验证像素角落颜色 |
| 生成速度跟不上快速滚动 | 占位不加载原图；visible抢占；热缓存逐步改善 |
| 大缓存迁移失败 | 旧目录成功提交前不删除；manifest恢复/回滚 |
| 用户把缓存放网络盘 | 设置页警告，仍允许；性能验收以本地cache为基线 |
| 缓存索引与文件不一致 | 原子写入、启动轻量修复、定期孤儿清理 |
| 2048缩略图仍较大 | 像素预算；性能不达标时单独设计长图切片 |
| 当前header不支持WebP尺寸 | 阶段A补齐WebP header或统一由图片库探测 |
| asset protocol暴露范围过宽 | 后续安全专项可收窄scope；本模块只返回cache目录内路径 |

---

## 21. 最终用户体验

首次进入大图目录：

1. 目录列表和header尺寸先返回；
2. masonry立即按真实比例排版；
3. 每张可见卡片显示轻量占位与spinner；
4. Rust优先生成当前可见缩略图；
5. 完成一张就淡入一张，不等待整批；
6. 向下1.5屏在后台受控预生成；
7. 滚动时大多数图片已命中，未命中继续显示稳定占位；
8. 再次访问直接使用磁盘缓存。

用户可以：

- 点击失败覆盖层重试；
- 右键强制重新生成；
- 调整缓存容量；
- 选择节能、均衡或高性能资源模式；
- 在高级设置中调整worker、解码内存和预生成范围；
- 选择标准、高清或超清预览质量；
- 清理缓存；
- 修改缓存位置并迁移已有缓存；
- 在迁移中取消、退出、继续或回滚。

整个过程中不修改原图、不全量生成、不通过IPC传输图片字节，并把CPU、内存、DOM和磁盘占用限制在明确预算内。
