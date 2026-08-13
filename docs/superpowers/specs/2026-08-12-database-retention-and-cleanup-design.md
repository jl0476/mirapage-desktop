# 数据库保留与自动清理方案

- 状态：已确认，待实现
- 日期：2026-08-13（根据 migration 011「Library → Likes 合并」和当前缩略图服务更新）
- 范围：SQLite 元数据、缩略图索引、自动保留策略与「存储与数据维护」设置功能。

## 1. 目标

长期使用后，`browse_history` 和 `thumbnail_cache` 会持续增长。此方案在不执行本次数据清理、且不自动删除书库和阅读数据的前提下，实现以下目标：

1. 缩略图缓存始终受用户配置的容量上限约束，并按 LRU 自动淘汰。
2. 浏览历史始终受用户配置的条数和可选天数上限约束；超限时自动清理低访问价值的目录，而不是简单删除最早记录。
3. 高频访问、近期访问，以及已加入书库或快捷方式的目录得到保护，避免常用目录被清理。
4. 所有自动清理均可观测：设置页显示当前用量、上限、最近一次结果和预计可释放项；用户可以手动触发相同策略。
5. 查询保持有界：历史、书库和快捷方式列表提供分页；高频维护不再触发 `thumbnail_cache` 的全表 `SUM`。

## 2. 数据保留边界

| 数据 | 自动清理 | 规则 |
| --- | --- | --- |
| `thumbnail_cache` 索引与磁盘文件 | 是 | 超过容量上限时按 LRU 淘汰；损坏或缺失文件对应的索引立即清除。 |
| `browse_history` | 是 | 超过天数或条数上限时，按访问价值从低到高清理。 |
| `library`、`progress`、`bookmark`、`shortcut` | 否 | 不因容量、时间或条数自动删除。 |
| `directory_sort`、`directory_masonry` | 否 | 随目录配置保留，不以历史清理为副作用删除。 |

远程数据源无法连接不代表记录失效；本方案不根据 SMB 或 WebDAV 的连接失败删除任何业务记录。

## 3. 浏览历史的访问价值评分

### 3.1 新字段

`browse_history` 新增以下字段：

```sql
visit_count INTEGER NOT NULL DEFAULT 1,
last_cleanup_candidate_at INTEGER
```

`visit_count` 在每次成功打开目录时递增。`last_cleanup_candidate_at` 仅用于诊断和避免同一批候选频繁重复计算；不参与用户可见排序。

### 3.2 硬上限与评分的关系

评分只决定“超限后先删除谁”，不会绕过硬上限。

- 若启用天数上限：`last_visited_at < now - retention_days` 的历史一定是清理候选。
- 若超过条数上限：除受保护窗口外，选择评分最低的记录清理，直到条数回到上限。
- 受保护窗口默认 7 天：最近 7 天访问过的记录不参与条数淘汰；若这些记录本身已超过配置的天数上限，仍按天数规则清理。
- 若受保护记录数量已大于条数上限，不删除受保护记录；显示「上限暂时被近期记录占用」，待窗口自然过期后再回收。

### 3.3 评分公式

清理候选的访问价值为：

```text
recency = max(0, 1 - days_since_last_visit / 90)
frequency = min(1, log2(visit_count + 1) / 10)
pin = 1，如果目录存在于 library 或 shortcut；否则为 0
score = 0.60 × recency + 0.25 × frequency + 0.15 × pin
```

分数越低越先清理。该设计使用 90 天衰减，避免多年以前的高访问次数永久保护旧目录；`library` 和 `shortcut` 仅提供有限加分，不构成永久豁免。相同分数时按 `last_visited_at ASC`、再按 `source_descriptor ASC, rel_path ASC` 稳定排序。

## 4. 配置与默认值

在 `settings` 表新增以下键：

| 键 | 默认值 | 含义 |
| --- | ---: | --- |
| `maintenance_auto_cleanup_enabled` | `1` | 自动维护总开关。关闭时不删除，仅统计超限状态。 |
| `history_retention_max_entries` | `2,000` | 历史最大保留条数；`0` 表示不按条数限制。 |
| `history_retention_days` | `365` | 历史最长保留天数；`0` 表示不按天数限制。 |
| `history_recent_protect_days` | `7` | 条数淘汰的近期保护窗口，范围 0–30。 |
| `maintenance_last_run_at` | `0` | 最近一次维护完成时间。 |
| `maintenance_last_result_json` | `{}` | 最近一次维护统计。 |

缩略图继续复用现有 `fb_thumbnail_cache_limit_mb`。默认值应由 migration 以 `INSERT OR IGNORE` 写入，不覆盖用户已有设置。

## 5. 自动维护触发与并发模型

当前 `ThumbnailService` 已负责缩略图请求、LRU 淘汰、缓存位置迁移和缓存清空；不得创建平行的缩略图维护服务。新增的 `maintenance` 模块只负责浏览历史保留、跨域维护摘要和用户手动预览入口；缩略图维护通过 `ThumbnailService` 的既有执行路径接入摘要。

普通写入不直接进行全量历史删除：它们只标记 history dirty。

触发规则：

1. `record_history` 成功后标记 history dirty。
2. 缩略图生成、访问时间批量 flush、缓存容量设置变化继续由既有 `ThumbnailService` 调用 `evict_to_limit`；maintenance 仅读取其结果和当前缓存统计。
3. 历史维护以 30 秒防抖合并请求；应用空闲时执行一次。
4. 历史条数超过上限的 110% 时允许立即调度，但同类任务最多每 60 秒运行一次。
5. 历史维护任务使用单一队列串行执行，并将数据库事务缩小到「选出候选 → 删除历史记录 → 更新结果」。

缩略图缓存原有淘汰已运行在 `spawn_blocking` 路径；历史维护也必须避免在 Tauri command 同步持锁期间执行大批删除，从而降低它与 `touch_many`、阅读进度写入争用同一个 SQLite `Mutex` 的机会。

## 6. 缩略图缓存优化

### 6.1 容量元数据

新增单行表 `maintenance_state`：

```sql
CREATE TABLE maintenance_state (
  key TEXT PRIMARY KEY,
  integer_value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

其中 `thumbnail_cache_total_bytes` 由缩略图 DAO 在插入、替换、删除和清空时同一事务更新。首次 migration 以一次 `SUM(byte_size)` 回填。此后既有 `ThumbnailService::cache_info()` 和 `get_thumbnail_cache_info` 都读取该元数据，不再为每次显示信息做全表聚合。

### 6.2 淘汰

当前 `ThumbnailService::evict_to_limit` 在 `total_bytes > limit_bytes` 后回收至上限的 80% 水位。保留该回收水位，避免每生成一张缩略图便再次触发淘汰。候选按 `last_accessed_at ASC, cache_key ASC` 扫描 LRU 索引；每批最多 256 项，避免一次传递大量行到 Rust 内存。

`idx_thumbnail_cache_lru` 改为覆盖稳定排序的索引：

```sql
CREATE INDEX idx_thumbnail_cache_lru_key
ON thumbnail_cache(last_accessed_at ASC, cache_key ASC);
```

旧索引在新 migration 中删除。`INSERT OR REPLACE` 改为 `INSERT ... ON CONFLICT(cache_key) DO UPDATE`，以便准确计算旧/新 `byte_size` 差额并避免 replace 的删除再插入语义；此改动在既有 `thumbnail::index` DAO 内完成，不能改变 `ThumbnailService` 的公开请求和事件协议。

### 6.3 损坏条目

`get_verified` 发现文件不存在或为空时，继续删除对应索引；删除操作必须同步扣减 `thumbnail_cache_total_bytes`。定期维护抽样检查最近访问与最旧访问两端各最多 128 条，处理磁盘被外部删除留下的脏索引；不扫描整个缓存目录。

## 7. 查询与索引治理

新增 migration 补齐下列索引：

```sql
CREATE INDEX idx_library_favorite_read
ON library(is_favorite, last_read_at DESC, added_at DESC);

CREATE INDEX idx_shortcut_created_at
ON shortcut(created_at DESC, id DESC);

CREATE INDEX idx_bookmark_book_page
ON bookmark(book_id, page);

CREATE INDEX idx_book_tag_tag_book
ON book_tag(tag_id, book_id);

CREATE INDEX idx_browse_history_cleanup
ON browse_history(last_visited_at ASC, visit_count ASC);
```

所有列表 command 统一接受 `{ limit, cursor }`，但必须先为现有前端调用保留无参数兼容分支，再分批将 store 切换为分页：

- 历史和快捷方式使用 `(timestamp, id-or-key)` keyset cursor，避免大 offset。
- 收藏书库使用 `(last_read_at_is_null, last_read_at, added_at, id)` keyset cursor。
- 初始 `limit` 为 100，最大 500；前端虚拟列表按需加载下一页。
- `list_progress_finished` 改为接收当前目录对应的 `book_ids`；`readStatus` store 由 FileBrowser 在 entries 已加载后传入这批 id，不再扫描全表并构造全量 `HashMap`。

## 8. 用户功能：「存储与数据维护」

在 Settings 增加独立 section，包含：

1. 缩略图缓存：当前索引条数、磁盘估算占用、容量上限、自动清理开关、立即维护按钮。
2. 浏览历史：当前条数、条数上限、天数上限、近期保护天数、自动清理开关、评分规则说明。
3. 维护预览：展示本次会删除的历史条数、缩略图条数、预计释放字节数和前 20 个历史候选；预览不写库、不删文件。
4. 最近结果：运行时间、触发来源、删除数量、释放空间、是否因保护窗口而暂时超出条数上限。

「立即维护」使用与自动维护相同的规则；按钮先弹出预览，再由用户确认。自动维护不弹窗，但结束后更新结果信息。

## 9. 升级与安全性

本功能使用 **migration 012**。migration 011 已由 Library → Likes 合并占用并删除了 `like` 表，maintenance 方案不得引用 `like` 表，也不得复用版本号 011。migration 012 仅新增列、表、索引和默认设置：不在升级过程中删除任何历史或缓存文件。首次实际清理由运行时维护服务在用户完成升级后按配置触发。

每次维护使用事务写入删除结果和 `maintenance_state`；文件删除失败不回滚数据库删除，但记录 orphan 文件计数，后续可由缩略图目录扫描工具处理。历史清理前会删除 `browse_history` 行，不触碰关联的 `library`、`progress`、`shortcut` 或目录配置。

## 10. 验收标准

- 历史访问同一目录 10 次后，`visit_count` 为 10；最近访问时间更新。
- 超过历史条数上限时，低频且久未访问目录先被清理；近期窗口内记录不因条数淘汰。
- 超过历史天数上限时，即使目录曾高频访问，也会被清理。
- 缩略图总容量超过上限后，LRU 淘汰恢复至上限以内，且容量元数据准确。
- 自动维护关闭时不删除记录，但维护页准确报告超限状态。
- 所有列表分页加载；历史、收藏和快捷方式在大数据量下不再全量 IPC 返回。
- `npm test`、`npm run type-check` 和 `cargo test` 全部通过。
