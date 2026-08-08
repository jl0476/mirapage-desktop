# 瀑布流缩略图缓存 — 实现与性能报告

- **日期**：2026-08-08
- **模块**：v0.1.0-module3.0.7-masonry-thumbnail-cache
- **设计**：`docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md`
- **计划**：`docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md`

> 本报告记录实现内容、动机（改造前基线）与已被单测/编译期保证的硬约束。
> **改造后的实时 rAF 帧时间测量需在本地 Windows Tauri 环境实跑**（计划任务13 E2E 步骤），
> 本文先落地可复现的算法/并发约束证据；实时数值留空待补。

---

## 1. 改造前基线（动机）

测试目录 `normal`（224 张 3K–6K 壁纸）。通过 `requestAnimationFrame` 帧间隔统计 +
PerformanceObserver longtask + 控制变量实验（CSS will-change / img display:none）定位根因
（详见 `memory/masonry-large-image-render-lag.md`）：

| 实验 | 最大单帧 | >100ms 严重掉帧 | 结论 |
|---|---:|---:|---|
| 基线（约 18 张 3K–4K 原图） | 313ms | 5 | 明显卡顿 |
| + will-change / contain:paint | 296ms | 3 | 图层隔离不是根因 |
| 隐藏 `.masonry-img`（保留布局 DOM） | 18.6ms | 0 | 恢复正常 |

- JS longtask（>50ms）= 0 → 瓶颈不在 JS / 布局。
- 根因：4K 图 **paint/decode + GPU 纹理上传**成本。18+ 张 3K-4K 同时进入渲染管线。
- `new Image()` 原图预读只能提前读取/部分解码，**不降低像素量与纹理成本**。

**结论**：瀑布流必须停止直接渲染大尺寸原图，改为按列宽生成缩略图。

---

## 2. 实现内容（任务 1–11）

### Rust 后端（`src-tauri/src/thumbnail/`）

| 模块 | 职责 | 单测 |
|---|---|---:|
| `mod.rs` | 协议 serde 类型（与 TS 字节级对齐）、算法版本 | 5 |
| `policy.rs` | 尺寸档位 / 生成阈值 / 像素预算 / 资源预设 / 内存估算 / 并发准入纯函数 | 28 |
| `orientation.rs` | EXIF Orientation 1–8 像素变换 | （集成测试覆盖）|
| `generator.rs` | 读字节→EXIF→解码首帧→方向归一化→缩放→WebP→`.tmp` 原子写 | 6 + 集成 8 |
| `key.rs` | source_key / cache_key（SHA-256，缓存根不参与 key） | 13 |
| `index.rs` | `thumbnail_cache` DAO（get/upsert/remove/total_bytes/oldest_until_bytes/touch_many/clear_all/get_verified）| 12 |
| `scheduler.rs` | tokio actor：优先队列 + in-flight 去重 + worker/内存预算 + stale 取消 + 老化 | 10 |
| `service.rs` | ThumbnailService + classify_item + evict_to_limit + 事件 + LRU | 6 |
| `commands/thumbnails.rs` | 8 个 IPC 命令（图片字节不进前端） | — |

migration 009：`thumbnail_cache` 表（16 列）+ `idx_thumbnail_cache_lru`。

### 前端（`src/`）

| 模块 | 职责 | 单测 |
|---|---|---:|
| `lib/thumbnail.ts` | 协议类型 + 预设 + 值域归一化 + quality margin | 20 |
| `composables/useMasonryLayout.ts` | `selectPathsInPixelWindow` 像素窗口四组 + `thumbnailWindows` | 35（含 10 像素窗口）|
| `composables/useMasonryThumbnails.ts` | 像素窗口合成去重 batch + 80ms debounce + epoch + 事件 + retry | 10 |
| `components/filebrowser/MasonryThumbnail.vue` | 6 状态卡片（spinner/淡入/失败重试） | 8 |
| `MasonryView.vue` | 移除 `new Image()` 原图预读，接入缩略图队列（源码守卫测试）| 5 |
| `stores/settings.ts` | 9 个 thumbnail 设置 key + 预设/custom 联动 + runtime 推送 | 6 |
| `components/settings/ThumbnailCacheSettings.vue` | 资源模式/清晰度/容量/高级设置 UI | — |

---

## 3. 已被测试/编译期保证的硬约束

下表每一项都有对应单测或源码守卫，可在 CI 复现：

| 验收阈值 | 保证方式 | 状态 |
|---|---|---|
| 默认 Local 生成并发 ≤ 2 | `scheduler::allowed_jobs` + 压力测试（worker=2 cap）| ✅ 单测 |
| 默认预计解码内存 ≤ 128MB（单张超预算独占除外）| `policy::estimated_decode_memory_mb` + scheduler 内存预算测试 | ✅ 单测 |
| EXIF Orientation 1–8 像素归一化，输出无 EXIF | 集成测试四角颜色 + read_orientation(output)==1 | ✅ 集成 |
| 透明通道（PNG alpha）/ GIF 首帧保留 | 集成测试 | ✅ 集成 |
| 缓存写入原子（`.tmp`→rename），失败不留正式文件 | 集成测试 | ✅ 集成 |
| LRU 从 100% 清到 80%，跳过 protected | `index::oldest_until_bytes` + `service::evict_to_limit` | ✅ 单测 |
| in-flight 去重 / stale 取消 / 老化不饥饿 | scheduler 10 测试 | ✅ 单测 |
| 瀑布流不再 `new Image()` 预读原图 | `MasonryView.test.ts` 源码守卫 | ✅ 守卫 |
| 卡片接收 thumbnail state 而非原图 src | `MasonryView.test.ts` 守卫（`:thumb-state`） | ✅ 守卫 |
| 图片字节不经 IPC（只传路径/元数据）| `commands/thumbnails.rs` 无 `Vec<u8>` 返回字段 | ✅ 编译期 |
| 中英文 i18n key 对称 | `i18n-keys.test.ts`（settings.* 含 thumbnail.*）| ✅ 单测 |
| 0px gap 像素窗口边界不重不漏 | `selectPathsInPixelWindow` 半开区间测试 | ✅ 单测 |

---

## 4. 待本地实跑的实时指标（任务13 E2E）

以下指标需在本地 Windows Tauri 环境（`npm run tauri:dev`）对 `normal` 目录实跑 rAF 采样，
**改造前基线已知不达标**（§1），改造后预期达标，数值待补：

| 指标 | 目标 | 改造前 | 改造后（待测）|
|---|---:|---:|---:|
| 可见 DOM 图片数 | ≤ 40 | ~18 | _（虚拟化不变，应 ≤ 40）_|
| 瀑布流直接加载超阈值 4K 原图 | 0 | 18+ | _（守卫保证 0）_|
| 滚动最大单帧 | < 50ms | 313ms | _待测_ |
| >100ms 严重掉帧 | 0 | 5 | _待测_ |
| 热缓存主要帧时间 | < 33ms | n/a | _待测_ |
| 冷缓存首张缩略图出现 | ≤ 500ms | n/a | _待测_ |

**复现命令**：
```bash
npm run tauri:dev
# 打开 normal 目录 → 切瀑布流视图 → DevTools Performance / rAF 采样
npm test                              # 前端 658 测试
cargo test --manifest-path src-tauri/Cargo.toml thumbnail   # 缩略图相关全绿
```

**当前验证状态**：前端 658 测试 0 error；Rust 缩略图相关 145 测试全绿
（另有 `algorithm::path::test_crumbs` / `source::webdav_impl` 2 个**预存在** Windows 平台测试与本模块无关）。

---

## 5. 未完成项（计划任务 12–13）

- **任务12 缓存位置迁移**：`thumbnail/migration.rs`（manifest 状态机、同盘 rename / 跨盘复制校验、
  resume / rollback）+ 6 个管理命令 + 设置页目录选择 UI。**未实现**；当前缓存固定在系统 cache 目录。
- **任务13 集成测试**：`tests/thumbnail_pipeline.rs`（冷/热缓存端到端 + 并发/内存断言）、
  `MasonryThumbnail.integration.test.ts`（1000 entry 滚动 DOM/事件）**未编写**；
  本文实时数值待本地实跑补全。
