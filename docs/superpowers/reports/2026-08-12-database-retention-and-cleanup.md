# 数据库保留与自动清理 — 实施验收报告

- 日期：2026-08-13
- 对应 spec：`docs/superpowers/specs/2026-08-12-database-retention-and-cleanup-design.md`
- 对应 plan：`docs/superpowers/plans/2026-08-12-database-retention-and-cleanup.md`
- 7 任务全部完成，逐任务提交。

## 1. 任务与提交

| 任务 | commit | 内容 |
| --- | --- | --- |
| 1 migration 012 | `ef36c1d` | `browse_history` 加 `visit_count`/`last_cleanup_candidate_at`；`maintenance_state` 表（回填 `thumbnail_cache_total_bytes`）；spec §7 索引；稳定 LRU 索引替换；6 个维护设置默认值（INSERT OR IGNORE）。不触碰 like 表 / migration 011。 |
| 2 历史评分与清理 | `64ba992` | `score_entry` 评分纯函数（recency/frequency/pin）；`run_history_cleanup` 单事务（天数规则 + 条数规则保护窗口外最低分）；pin 检测（shortcut/library EXISTS）；`preview` 只读；`record_history` UPSERT `visit_count += 1`。 |
| 3 缩略图容量元数据 | `a3a01fc` | `upsert` ON CONFLICT + 同事务维护 `thumbnail_cache_total_bytes`；`remove`/`remove_batch`/`clear_all`/`get_verified` 计数一致；`oldest_until_bytes` 稳定排序 + 单批 256；`evict_to_limit` 分批回收至 80% 水位；`sample_and_clean_dirty` 两端各 128 脏索引抽样；`ensure_schema` 补建 maintenance_state。 |
| 4 MaintenanceService | `eac70d1` | generation-token 防抖调度核心（30s 防抖 / 60s 节流 / 110% 旁路 / run_now 绕过）；`AppExecutor`（spawn_blocking）；`run_maintenance_once` 三阶段独立 Db 借用；4 个 IPC 命令；`record_history` 接 dirty。 |
| 5 列表分页 | `9c05e87` | history/library/shortcuts keyset cursor（无参兼容全量）；`list_progress_finished` 加 `book_ids` 收窄；`Paginated<T>` 信封；前端 tauri.ts 解包 `.items`（stores 零改动）。 |
| 6 前端 | `592f45b` | `stores/maintenance.ts`（loadSummary/saveConfig/fetchPreview/runConfirmed）；Settings 第 8 个 section「存储与数据维护」；中英 i18n；window.confirm 二次确认。 |
| 7 验证 | （本提交） | EXPLAIN 快照测试 + 本报告。 |

## 2. 验证结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 后端单测 | `cargo test` | **277 passed; 1 failed; 1 ignored**。失败为 `webdav_impl::parse_propfind`（main 预先既有，与本次无关，`git diff` 证明未触该文件）；ignored 为 EXPLAIN 快照（手动）。 |
| 前端单测 | `npm test` | **901 passed / 901**（72 文件）。 |
| 类型检查 | `npm run type-check` | 0 error。 |
| 生产构建 | `npm run build` | ✓ built（含 vue-tsc + Vite）。 |
| 集成测试 | `cargo test --test thumbnail_pipeline --test thumbnail_generator` | 4 + 8 全绿（任务 3 改 thumbnail 热路径后回归通过）。 |

后端用例增量：migration 012（+9）、history（+13）、thumbnail（+10）、scheduler（+7）、pagination/keyset（+10）= **+49** 新 Rust 测；前端 +5（maintenance store 4 + Settings section 计数调整）。

## 3. 清理场景验证（对应 spec §10 验收标准）

均由对应单测覆盖（此处摘要结论）：

- **visit_count 递增**：`record_history_inner_repeat_increments_visit_count` — 同目录 10 次 UPSERT 后 `visit_count=10`，`last_visited_at` 更新。✓
- **条数淘汰按评分**：`cleanup_count_deletes_lowest_score_first` — 4 条上限 2，最旧低频先删、高频/近期保留；稳定排序 `score ASC, last_visited_at ASC, source_descriptor ASC, rel_path ASC`。✓
- **保护窗口阻止条数淘汰**：`cleanup_protect_window_blocks_count_deletion` — 3 条全在 7 天保护窗口内，超限 1 但 `protected_exceeds_limit` 标记、0 删除。✓
- **天数规则无条件**：`cleanup_deletes_over_retention_days_regardless_of_score` — 100 天前 + 高频（visit_count=100）仍被天数规则删。✓
- **缩略图 LRU 回收**：`evict_to_limit_batched_stable_and_counter_consistent` — 600B/上限 400B → 回收至 ≤320B（80% 水位），维护态计数 == 实际 `SUM(byte_size)`，最旧 3 条被删。✓
- **容量元数据一致性**：`upsert_replace_adjusts_total_by_diff` / `remove_decrements_total` / `clear_all_resets_total_to_zero` / `get_verified_dirty_delete_decrements_total` — 所有写路径计数与 SUM 一致。✓
- **不触其他表**：`cleanup_does_not_touch_library_shortcut_progress` — 历史清理后 library/shortcut/progress 行不变。✓
- **自动维护关闭只统计**：`run_maintenance_once(auto=true)` 读 `maintenance_auto_cleanup_enabled`，关闭时 `do_delete=false`，0 删除（store 测 `saveConfig({autoCleanupEnabled:false})` 不调 runMaintenance）。✓

## 4. EXPLAIN QUERY PLAN（spec §7 索引采用证据）

数据量 200 行各表，`cargo test explain_query_plan_snapshot -- --ignored --nocapture` 输出：

```
PLAN history  : SEARCH browse_history USING INDEX idx_browse_history_cleanup (last_visited_at<?)
PLAN library  : SEARCH library USING COVERING INDEX idx_library_favorite_read (is_favorite=?)
PLAN thumbnail: SCAN thumbnail_cache USING COVERING INDEX idx_thumbnail_cache_lru_key
```

三条查询均采用 spec §7 新增/替换的索引（history 走 `idx_browse_history_cleanup`、library 走 covering `idx_library_favorite_read`、thumbnail LRU 走 covering `idx_thumbnail_cache_lru_key`，避免 sort）。索引**存在性**由 `migration_012_creates_query_indexes` 守护；规划器**采用**因依赖数据量启发式，列为 `#[ignore]` 手动验证（输出见上）。

## 5. 升级安全性（spec §9：不删既有数据）

- migration 012 仅 `ALTER TABLE ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX` / `INSERT OR IGNORE` —— **不在升级过程删除任何历史或缓存文件**。首次实际清理由运行时 maintenance 服务按配置触发。
- `migration_012_like_table_still_absent` 守护：012 不重建 `like` 表，不引用它。
- `migration_012_does_not_overwrite_existing_settings` 守护：`INSERT OR IGNORE` 不覆盖用户已配置的设置值。
- `migration_012_backfills_thumbnail_cache_total_bytes`：以一次 `SUM(byte_size)` 回填计数，既有索引行不丢。
- 历史清理前只删 `browse_history` 行，不触碰 `library` / `progress` / `shortcut` / `directory_sort` / `directory_masonry`（spec §2 边界 + 单测验证）。

## 6. 有意差异 / 待办

- **readStatus 暂未迁移到 `bookIds` 调用**：`listProgressFinished` 已支持 `bookIds` 收窄（spec §7），但前端 `readStatus.refresh()` 仍走无参全量（兼容路径，功能正确）。迁移到 per-folder bookIds 是后续可选优化（无功能影响）。
- **library/shortcuts 分页前端未启用虚拟加载**：后端 keyset 已就绪（无参兼容全量），前端 stores 仍一次拉全量。这俩表用户手工维护、量小，按需再迁移。
- **webdav `parse_propfind` 测试为 main 预先既有失败**，与本方案无关，留作独立 issue。
- **`oldest_until_bytes` 单批 256**：超大缓存由 `evict_to_limit` 循环逐批回收，已测；极端万级缓存的实测帧时间待本地 `tauri:dev` 跑（缩略图性能报告 `2026-08-08-masonry-thumbnail-performance.md` 同款待跑项）。
