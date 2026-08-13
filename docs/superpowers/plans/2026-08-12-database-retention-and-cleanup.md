# 数据库保留与自动清理实现计划

> **面向 AI 代理的工作者：** 实现时使用 `subagent-driven-development` 或 `executing-plans`，逐项完成并在每项后审查。

**目标：** 为浏览历史和缩略图缓存实现可配置、自动执行、可预览的保留与清理机制，同时消除持续增长查询的全表瓶颈。

**架构：** 新的 Rust `maintenance` 模块集中管理历史保留配置、预览和串行执行；DAO 保持表级职责。`browse_history` 记录访问频次。现有 `ThumbnailService` 继续独占缩略图请求、LRU 淘汰、缓存位置迁移和缓存清空，容量元数据仅在既有 `thumbnail::index` DAO 内维护。前端 Settings 消费组合维护摘要、编辑配置、展示预览和发起确认操作。

**技术栈：** Tauri 2、Rust、rusqlite、Vue 3、Pinia、Vitest、Cargo test。

---

## 文件清单

- 修改：`src-tauri/src/db/migrations.rs`：新增 migration 012，添加字段、索引、维护状态表和默认设置；不触碰 migration 011 的 Likes 数据合并。
- 创建：`src-tauri/src/maintenance/mod.rs`：维护服务的公共类型、配置和调度入口。
- 创建：`src-tauri/src/maintenance/history.rs`：历史评分、候选选择与删除 DAO。
- 修改：`src-tauri/src/thumbnail/index.rs`：缓存总字节元数据、稳定 LRU 查询与脏索引扣减；不新建平行缩略图维护模块。
- 修改：`src-tauri/src/commands/history.rs`：访问次数 UPSERT、分页查询和维护 dirty 通知。
- 修改：`src-tauri/src/thumbnail/index.rs`：事务化容量计数与稳定 LRU 查询。
- 修改：`src-tauri/src/commands/thumbnails.rs`：复用维护预览与执行入口。
- 修改：`src-tauri/src/lib.rs`：注册 maintenance state、Tauri commands 和启动恢复。
- 修改：`src/lib/tauri.ts`：维护 IPC 类型及调用封装。
- 创建：`src/stores/maintenance.ts`：维护配置、摘要、预览与执行状态。
- 修改：`src/views/Settings.vue`：增加「存储与数据维护」section。
- 修改：对应 Rust 与 Vitest 测试文件。

### 任务 1：数据库 migration 012 与配置契约

**文件：**

- 修改：`src-tauri/src/db/migrations.rs`
- 测试：`src-tauri/src/db/migrations.rs`

- [ ] 编写迁移测试：先执行 migration 011 后，migration 012 的 `browse_history` 含 `visit_count=1`，`maintenance_state` 存在，`like` 表仍不存在，设置默认值不会覆盖已有值。

- [ ] 运行 `cd src-tauri; cargo test migration_012`，确认测试失败。

- [ ] 新增 migration 012：添加 `visit_count`、`last_cleanup_candidate_at`；建 `maintenance_state`；建/替换设计文档第 7 节索引；以一次 `SUM(byte_size)` 初始化 `thumbnail_cache_total_bytes`；用 `INSERT OR IGNORE` 写入维护设置。不得修改 `apply_011_drop_like_table`。

- [ ] 运行 `cd src-tauri; cargo test migration_012`，确认通过。

### 任务 2：历史评分与有界清理

**文件：**

- 创建：`src-tauri/src/maintenance/history.rs`
- 创建：`src-tauri/src/maintenance/mod.rs`
- 修改：`src-tauri/src/commands/history.rs`
- 测试：`src-tauri/src/maintenance/history.rs`

- [ ] 编写失败测试：同等时间下 `visit_count=10` 的评分高于 `visit_count=1`；超过天数的记录无条件成为候选；7 天保护窗口阻止仅因条数造成的清理。

- [ ] 编写失败测试：清理 2,000 条上限时，按 `score ASC, last_visited_at ASC, source_descriptor ASC, rel_path ASC` 删除，且不会删除 `library`、`progress`、`shortcut` 行。

- [ ] 实现 `HistoryRetentionConfig`、`HistoryCleanupPreview`、评分纯函数和候选查询；所有删除以单一短事务完成并返回统计。

- [ ] 修改 `record_history` 的 UPSERT：冲突时 `visit_count = browse_history.visit_count + 1`，同时更新时间与目录显示名。

- [ ] 运行 `cd src-tauri; cargo test maintenance::history commands::history`，确认通过。

### 任务 3：在既有 ThumbnailService 中补齐容量元数据与 LRU 淘汰

**文件：**

- 修改：`src-tauri/src/thumbnail/index.rs`
- 修改：`src-tauri/src/thumbnail/service.rs`
- 测试：`src-tauri/src/thumbnail/index.rs`
- 测试：`src-tauri/src/thumbnail/service.rs`

- [ ] 编写失败测试：upsert 替换相同 key 时总字节数按差额变化；remove、clear、`get_verified` 删除脏行时总字节数同步减少。

- [ ] 编写失败测试：缓存 600 B、上限 400 B 时，既有 `evict_to_limit` 按 `last_accessed_at ASC, cache_key ASC` 删除并回收至 320 B 或更小；每批不超过 256 项；容量元数据与实际索引和一致。

- [ ] 将 `INSERT OR REPLACE` 改为 `ON CONFLICT(cache_key) DO UPDATE`；在同一事务更新 `maintenance_state.thumbnail_cache_total_bytes`。

- [ ] 在既有 `ThumbnailService` 中实现分批索引删除、提交后磁盘删除和两端各 128 条的脏索引抽样检查；维护预览只读取 `cache_info` 和本次 LRU 候选，不重建缩略图调度器。

- [ ] 运行 `cd src-tauri; cargo test thumbnail::index thumbnail::service`，确认通过。

### 任务 4：维护服务、调度和 IPC

**文件：**

- 修改：`src-tauri/src/maintenance/mod.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/src/commands/thumbnails.rs`
- 创建：`src-tauri/src/commands/maintenance.rs`
- 测试：`src-tauri/src/maintenance/mod.rs`

- [ ] 编写失败测试：30 秒内多次 history dirty 通知只合并为一次执行；同类历史任务 60 秒内不重复运行；历史条数超过上限 110% 时立即调度。缩略图淘汰沿用 `ThumbnailService` 已有触发链。

- [ ] 实现 `MaintenanceService`：`mark_history_dirty`、`preview`、`run_now`，以及最近结果写入 `settings`；缩略图部分调用 `ThumbnailService::cache_info` 和新增的只读候选预览方法。

- [ ] 注册 `get_maintenance_summary`、`get_maintenance_preview`、`run_maintenance`、`update_maintenance_settings` 命令；`run_maintenance` 要求前端显式传入 `confirmed=true`，自动任务内部调用不走 IPC。

- [ ] 运行 `cd src-tauri; cargo test maintenance commands::maintenance`，确认通过。

### 任务 5：列表分页与状态查询收敛

**文件：**

- 修改：`src-tauri/src/commands/history.rs`
- 修改：`src-tauri/src/commands/library.rs`
- 修改：`src-tauri/src/commands/shortcuts.rs`
- 修改：`src-tauri/src/commands/progress.rs`
- 修改：`src/lib/tauri.ts`
- 修改：相关 Pinia stores 与测试。

- [ ] 编写失败测试：每个列表请求的默认 `limit=100`、最大 `limit=500`；第二页不会重复首尾记录；游标无效返回参数错误。

- [ ] 实现 keyset cursor。历史使用 `last_visited_at + source_descriptor + rel_path`；快捷方式使用 `created_at + id`；收藏书库使用完整排序字段和 `id`。

- [ ] 将 `list_progress_finished` 改为接受当前 FileBrowser entries 对应的 `book_ids`，由 `readStatus.refresh(bookIds)` 调用，并测试它不会返回未请求书籍的状态。

- [ ] 运行 `npm test -- --runInBand` 和 `cd src-tauri; cargo test commands`，确认通过。

### 任务 6：前端维护设置与确认流程

**文件：**

- 创建：`src/stores/maintenance.ts`
- 修改：`src/lib/tauri.ts`
- 修改：`src/views/Settings.vue`
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`
- 测试：`src/stores/maintenance.test.ts`
- 测试：`src/views/Settings.test.ts`

- [ ] 编写失败测试：维护 section 展示历史/缩略图当前值和上限；关闭自动维护只保存配置且不调用执行命令；「立即维护」必须先取得预览，再确认后执行。

- [ ] 实现 store 的 `loadSummary`、`saveConfig`、`preview`、`runConfirmed`；所有调用都经 `src/lib/tauri.ts`。

- [ ] 在 Settings 新增「存储与数据维护」section：历史条数/天数/近期保护输入、自动维护开关、缩略图上限摘要、预览对话框和最近结果。

- [ ] 同步中英文 i18n key，并运行 `npm test -- src/stores/maintenance.test.ts src/views/Settings.test.ts`。

### 任务 7：端到端验证与性能验收

**文件：**

- 修改：`docs/superpowers/reports/2026-08-12-database-retention-and-cleanup.md`

- [ ] 创建临时 SQLite fixture：2,500 条历史、超过容量的缩略图索引、高频和低频目录混合。

- [ ] 运行 `EXPLAIN QUERY PLAN`，确认历史分页使用 `idx_browse_history_last_visited` 或 `idx_browse_history_cleanup`，收藏列表使用 `idx_library_favorite_read`，LRU 使用 `idx_thumbnail_cache_lru_key`。

- [ ] 运行完整验证：

```powershell
npm run type-check
npm test
npm run build
cd src-tauri
cargo test
```

- [ ] 在报告中记录测试数量、各清理场景的删除结果、`EXPLAIN QUERY PLAN` 输出摘要，以及升级不会删除既有数据的证据。
