# 阅览记录导出 JSON（browse_history export）设计文档

- 日期：2026-08-18
- 模块号：3.1.2（跨机器打 tag 前需 `git fetch github main` 确认未被占用）
- 参考契约：`docs/reference/2026-08-18-browse-history-export-reference.md`（实际导出样本 `browse_history_20260818_161925.json` 因含真实内网 IP 与阅览记录标题，仅本地参考、不入仓）
- 状态：已与用户对齐三项口径（§1.3）

---

## 1. 背景与目标

### 1.1 功能

提供「将本地全部阅览记录导出为单个明文 JSON」的能力：

- 数据源：`browse_history` 全表，LEFT JOIN `library`（liked）与 `progress`（进度）
- 输出：Android MiraPage 导出 schema **v2（30 字段平铺命名空间）** 的等价结构
- 仅导出，不支持导入（对齐参考 §1「当前仅支持导出」）
- 入口两处（用户拍板）：阅览记录页（History.vue）工具栏 + 设置页 maintenance section

### 1.2 与参考实现的关系

**数据结构参考 Android，逻辑按桌面端重写**：

- 字段名 / 字段序 / null 语义 / 顶层结构：字节级对齐参考样本
- 联表逻辑、descriptor 展平、枚举映射：按桌面端 schema（`browse_history` 复合主键、`progress` 无 scale/direction 列、`library.is_favorite`）重写

### 1.3 已拍板口径（2026-08-18）

| 决策点 | 结论 |
|---|---|
| readerMode / scaleMode / readDirection 枚举值 | **对齐实际样本（大写）**：`SINGLE` / `DOUBLE` / `VERTICAL_WEBTOON`、`FIT_WIDTH` 等、`LEFT_TO_RIGHT` / `RIGHT_TO_LEFT`。md 文档 §3.6 的小写写法与实际样本不一致，以样本为准 |
| scaleMode / readDirection 取值 | **恒 null**（桌面端 progress 表无 per-book 数据，是全局设置；诚实导出，未来 progress 加列后再填真值） |
| 导出入口 | History 工具栏 + Settings maintenance 两处，同一命令 |
| 架构 | 方案 1：Rust 一站式 command（dialog + 组装 + 写文件），组装抽纯函数可单测 |
| schemaVersion | **2**（字段集与 Android v2 完全一致，30 字段无增减） |

---

## 2. 非目标（本次不做）

- 从 JSON 导入回应用
- 导出 `lastVisitedAt` / `totalPages`（对齐参考 §6 不导出清单）
- `progress` 表加 `scale_mode` / `read_direction` 列（scaleMode 恒 null 的根因，留未来模块）
- 加密 / 签名 / 压缩（明文 JSON）
- 账号密码导出（永不导出，仅 accountId FK）
- 按源过滤 / 选择性导出（全量导出）

---

## 3. 导出 JSON 契约

### 3.1 顶层结构

```json
{
  "schemaVersion": 2,
  "totalCount": 260,
  "warnings": [],
  "items": [ ... ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | Int | 恒 2 |
| `totalCount` | Int | `items.length`（成功导出条数，损坏跳过条不计入） |
| `warnings` | String[] | 损坏 / 跳过明细；无则空数组 |
| `items` | Item[] | 条目主体，按 `last_visited_at DESC` 排序 |

顶层**不带** `exportedAt` / `versionCode` / `versionName`（对齐参考 §2.2）。

### 3.2 编码细节

- UTF-8；缩进 2 空格；LF 换行（`serde_json::to_string_pretty` 原生满足）
- 不转义 `/`（serde_json 不转义；参考样本中 `\/` 是 Gson 行为，JSON 语义等价，不跟进）
- 文件名：`browse_history_yyyyMMdd_HHmmss.json`，**本地时间**，由前端生成传入（规避 Rust 端无 chrono 手写时区转换）

### 3.3 单条 Item：30 字段（序 = 样本字段序）

```
id, relPath, displayName, sourceType,
local_rootUri,
smb_host, smb_initialPath, smb_path, smb_accountId, smb_port,
webdav_baseUrl, webdav_path, webdav_accountId,
archive_fileUri, archive_format, archive_originType,
archive_origin_rootUri, archive_origin_host, archive_origin_initialPath,
archive_origin_path, archive_origin_accountId, archive_origin_port,
archive_originEntryPath, archive_archiveRelPath,
pageIndex, finished, readerMode, scaleMode, readDirection,
liked
```

**命名空间规则**：不适用的字段值 = `null` 但 **key 始终保留**（serde `Option` 默认序列化，禁用 `skip_serializing_if`）。唯一例外：`liked` 强制布尔，`false` 不是 null。

### 3.4 字段映射总表

| 字段 | 桌面端来源 | 规则 |
|---|---|---|
| `id` | 导出序号 | 1..N（`browse_history` 复合主键无自增 id；**非稳定标识**，仅作行定位） |
| `relPath` | `browse_history.rel_path` | 原样 |
| `displayName` | `browse_history.display_name` | 原样 |
| `sourceType` | descriptor tag | `local` / `smb` / `webdav` / `archive` |
| `liked` | `library.is_favorite`（经 `browse_history.book_id` LEFT JOIN） | 0→`false`，1→`true`；未命中 library 行→`false`（非 null） |
| `local_rootUri` | `Local.root_path` | 仅 `sourceType == "local"` 非 null；语义为桌面绝对路径（对应 Android SAF URI 位） |
| `smb_host` | **`account` 表按 `account_id` 联查** | descriptor.Smb 不含 host；账号已删→null |
| `smb_initialPath` | `Smb.initial_path` | |
| `smb_path` | `Smb.path` | |
| `smb_accountId` | `Smb.account_id` | i64 |
| `smb_port` | `Smb.port` | i32 |
| `webdav_baseUrl` | `WebDav.base_url` | |
| `webdav_path` | `WebDav.path` | |
| `webdav_accountId` | `WebDav.account_id` | |
| `archive_fileUri` | `Archive.archive_path` | 桌面绝对路径 |
| `archive_format` | `Archive.format` | serde lowercase 值映射：`cbz`/`cbr`/`zip`/`rar` 原样；`sevenz`→`"7z"` |
| `archive_originType` | `origin` 变体名 | `None`→null；`"local"` / `"smb"` |
| `archive_origin_rootUri` | `origin = Local{root_path}` | 其他 origin 形态时 null |
| `archive_origin_host` | origin=Smb 的 account_id 联 `account.host` | 账号缺失→null |
| `archive_origin_initialPath` | origin=Smb 的 `initial_path` | |
| `archive_origin_path` | origin=Smb 的 `path` | |
| `archive_origin_accountId` | origin=Smb 的 `account_id` | |
| `archive_origin_port` | origin=Smb 的 `port` | |
| `archive_originEntryPath` | `Archive.origin_entry_path` | |
| `archive_archiveRelPath` | `Archive.archive_rel_path` | |
| `pageIndex` | `progress.page` | 无 progress 行→null |
| `finished` | `progress.finished` | 0→`false`，1→`true`；无 progress 行→null |
| `readerMode` | `progress.reader_mode` 映射 | `"single"`→`"SINGLE"`；`"double"`→`"DOUBLE"`；`"webtoon"`→`"VERTICAL_WEBTOON"`；未知值→`to_uppercase()` 原样输出；无 progress 行→null |
| `scaleMode` | — | **恒 null**（§1.3 拍板） |
| `readDirection` | — | **恒 null**（§1.3 拍板） |

注：`Archive.entry_prefix` 无 Android 对应字段，不导出（不丢信息：`relPath` 已含包内位置语义）。

### 3.5 warnings 规则

单条损坏不影响其他条目导出，跳过并记入顶层 `warnings`：

1. **descriptor JSON 解析失败**：`"relPath={rel_path}: source descriptor 解析失败: {err}"`
2. **origin 不支持形态**：`origin` 为 `WebDav` 或嵌套 `Archive`（Android v2 schema 只有 local/smb origin 字段位）：`"relPath={rel_path}: 不支持的 origin 形态: {variant}"`

---

## 4. Rust 设计

### 4.1 新文件 `src-tauri/src/commands/history_export.rs`

`commands/mod.rs` 加 `pub mod history_export;`；`lib.rs` 的 `generate_handler![...]` 追加 `commands::history_export::export_browse_history`。

### 4.2 数据结构

```rust
use serde::Serialize;

/// 导出条目：30 字段，字段名/字段序对齐 Android v2 样本（混合命名，逐字段显式 rename）。
#[derive(Debug, Serialize)]
pub struct ExportedItem {
    pub id: i64,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(rename = "local_rootUri")]
    pub local_root_uri: Option<String>,
    #[serde(rename = "smb_host")]
    pub smb_host: Option<String>,
    #[serde(rename = "smb_initialPath")]
    pub smb_initial_path: Option<String>,
    #[serde(rename = "smb_path")]
    pub smb_path: Option<String>,
    #[serde(rename = "smb_accountId")]
    pub smb_account_id: Option<i64>,
    #[serde(rename = "smb_port")]
    pub smb_port: Option<i32>,
    #[serde(rename = "webdav_baseUrl")]
    pub webdav_base_url: Option<String>,
    #[serde(rename = "webdav_path")]
    pub webdav_path: Option<String>,
    #[serde(rename = "webdav_accountId")]
    pub webdav_account_id: Option<i64>,
    #[serde(rename = "archive_fileUri")]
    pub archive_file_uri: Option<String>,
    #[serde(rename = "archive_format")]
    pub archive_format: Option<String>,
    #[serde(rename = "archive_originType")]
    pub archive_origin_type: Option<String>,
    #[serde(rename = "archive_origin_rootUri")]
    pub archive_origin_root_uri: Option<String>,
    #[serde(rename = "archive_origin_host")]
    pub archive_origin_host: Option<String>,
    #[serde(rename = "archive_origin_initialPath")]
    pub archive_origin_initial_path: Option<String>,
    #[serde(rename = "archive_origin_path")]
    pub archive_origin_path: Option<String>,
    #[serde(rename = "archive_origin_accountId")]
    pub archive_origin_account_id: Option<i64>,
    #[serde(rename = "archive_origin_port")]
    pub archive_origin_port: Option<i32>,
    #[serde(rename = "archive_originEntryPath")]
    pub archive_origin_entry_path: Option<String>,
    #[serde(rename = "archive_archiveRelPath")]
    pub archive_archive_rel_path: Option<String>,
    #[serde(rename = "pageIndex")]
    pub page_index: Option<i64>,
    pub finished: Option<bool>,
    #[serde(rename = "readerMode")]
    pub reader_mode: Option<String>,
    #[serde(rename = "scaleMode")]
    pub scale_mode: Option<String>,      // 恒 None
    #[serde(rename = "readDirection")]
    pub read_direction: Option<String>,  // 恒 None
    pub liked: bool,
}

/// 顶层文档（字段序：schemaVersion, totalCount, warnings, items）。
#[derive(Debug, Serialize)]
pub struct ExportDoc {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
    #[serde(rename = "totalCount")]
    pub total_count: usize,
    pub warnings: Vec<String>,
    pub items: Vec<ExportedItem>,
}

/// IPC 返回（camelCase，项目 IPC 惯例）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub exported: bool,
    pub path: Option<String>,
    pub total_count: usize,
}
```

### 4.3 纯函数组装（单测主战场，不碰 dialog / 文件 IO）

```rust
/// 联表 + 展平映射。损坏行（descriptor 解析失败 / 不支持的 origin）跳过并记 warnings。
pub(crate) fn build_export_doc(conn: &rusqlite::Connection) -> ExportDoc
```

实现要点：

1. **account host 预载**（防 N+1）：`SELECT id, host FROM account` 一次读入 `HashMap<i64, Option<String>>`。archive origin=Smb 与顶层 smb 共用此表。
2. **主查询**：

```sql
SELECT bh.source_descriptor, bh.rel_path, bh.display_name, bh.book_id,
       l.is_favorite, p.page, p.reader_mode, p.finished
FROM browse_history bh
LEFT JOIN library l ON bh.book_id = l.id
LEFT JOIN progress p ON p.book_id = l.id
ORDER BY bh.last_visited_at DESC
```

3. **逐行**：`serde_json::from_str::<SourceDescriptor>(...)` 失败 → warnings 跳过；成功 → `map_row` 产出 `ExportedItem`（id = 递增序号，从 1 起）。
4. **`is_favorite` / `finished` 空值语义**：LEFT JOIN 未命中列值为 NULL——`liked = row.is_favorite.unwrap_or(0) != 0`；`finished` NULL → `None`。
5. `map_reader_mode`：§3.4 映射（single/double/webtoon 三值 + 未知值 `to_uppercase()`）。

### 4.4 command（dialog + 写文件）

```rust
use tauri_plugin_dialog::DialogExt;

/// 导出全部阅览记录。前端传默认文件名（本地时间戳由前端生成）。
/// 用户取消对话框 → Ok(exported=false)，不算错误。
#[tauri::command]
pub fn export_browse_history(
    app: tauri::AppHandle,
    db: tauri::State<crate::db::Db>,
    default_file_name: String,
) -> Result<ExportOutcome, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .set_file_name(&default_file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(ExportOutcome { exported: false, path: None, total_count: 0 });
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let doc = build_export_doc(&db.conn());
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ExportOutcome {
        exported: true,
        path: Some(path.to_string_lossy().into_owned()),
        total_count: doc.total_count,
    })
}
```

约束说明：

- **sync command + blocking dialog**：tauri-plugin-dialog 的 blocking 变体设计用于非主线程；Tauri 2 sync command 在 IPC 处理线程执行（非主线程），符合插件约束。**实现后必须在 `tauri:dev` 实机验证不死锁**（冒烟清单 §8）。
- 参数名 `default_file_name` 由 Tauri 自动做 IPC 边界 camelCase 转换（前端传 `defaultFileName`），与现有命令行为一致。
- 写文件使用 `std::fs::write`（无 `.tmp` 原子写——导出是低频用户主动操作，目标路径由用户在对话框指定，简单直写；失败返回错误字符串）。

---

## 5. 前端设计

### 5.1 `src/lib/tauri.ts`（IPC 封装）

```ts
export interface BrowseHistoryExportOutcome {
  exported: boolean;
  path: string | null;
  totalCount: number;
}

export async function exportBrowseHistory(defaultFileName: string): Promise<BrowseHistoryExportOutcome> {
  return invoke('export_browse_history', { defaultFileName });
}
```

### 5.2 `src/lib/format.ts`（文件名生成，共享两入口）

```ts
/** 本地时间戳 yyyyMMdd_HHmmss（导出文件名用，对齐 Android 命名） */
export function formatExportTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function browseHistoryExportFileName(now: Date = new Date()): string {
  return `browse_history_${formatExportTimestamp(now)}.json`;
}
```

### 5.3 History.vue（入口一）

header 右侧、`ListSearchInput` 之前加「导出」按钮：

- `data-test="btn-export"`；小按钮，体量/配色对齐 header 现有控件（back link / ListSearchInput 一档）
- 状态机 `ref<'idle' | 'exporting' | 'done' | 'failed'>`：
  - `idle` → 点击 → `exporting`（按钮 disabled）→ 调 `exportBrowseHistory(browseHistoryExportFileName())`
  - 返回 `exported: false`（用户取消）→ 静默回 `idle`
  - 返回 `exported: true` → `done`，按钮文本短暂切为 `t('history.exported', { count })`，3s 后回落 `idle`（setTimeout 在 `onUnmounted` 清理）
  - 异常 → `failed`，显示 `t('history.exportFailed')` 3s 回落
- 列表为空时仍可点击（导出空 items 数组 + totalCount 0，合法）

### 5.4 Settings.vue（入口二）

maintenance section「历史记录」子块（`historyTitle` 下方、NumberRow 之后）加一行操作行：

- 左侧 label + description（`settings.maintenance.exportHistory` / `exportHistoryDesc`），右侧按钮 `data-test="maintenance-export-history"`
- 点击走同一 `exportBrowseHistory`；反馈同 §5.3 状态机（done 文案复用 `history.exported`）

### 5.5 i18n（zh-CN / en-US 双语同步）

| key | zh-CN | en-US |
|---|---|---|
| `history.export` | 导出 | Export |
| `history.exporting` | 导出中… | Exporting… |
| `history.exported` | 已导出 {count} 条 | Exported {count} items |
| `history.exportFailed` | 导出失败 | Export failed |
| `settings.maintenance.exportHistory` | 导出阅览记录 | Export browse history |
| `settings.maintenance.exportHistoryDesc` | 将全部阅览记录（含进度与喜欢状态）导出为 JSON 文件 | Export all browse history (with progress & liked) to a JSON file |

---

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 用户取消保存对话框 | `Ok({ exported: false })`，前端静默回 idle，无 toast |
| descriptor JSON 非法（历史脏数据） | 该行跳过 + warnings 记录，其余行正常导出 |
| 目标路径不可写（权限 / 占用） | command 返回 Err 字符串，前端 `failed` 状态显示 |
| DB 读失败 | 同上（SQL 错误冒泡为 Err） |

---

## 7. 测试计划

### 7.1 Rust（`commands/history_export.rs` 内 `#[cfg(test)]`，in-memory DB + migrations）

映射正确性（`build_export_doc` 字段级断言）：

1. **local 行**：30 个 key 全部存在（serde_json 解析后 key 集合断言）；不适字段为 null；`local_rootUri` = rootPath；`liked` 布尔
2. **liked 联表**：library 行 is_favorite=1 → true；=0 → false；无 library 行（book_id NULL / 无匹配）→ false
3. **progress 未命中**：pageIndex / finished / readerMode 均 null；scaleMode / readDirection 恒 null
4. **progress 命中**：pageIndex = page；finished 0→false / 1→true
5. **readerMode 映射**：single→SINGLE；double→DOUBLE；webtoon→VERTICAL_WEBTOON；未知值 "weird"→"WEIRD"
6. **smb 变体**：5 字段映射 + account host 命中；account 行缺失 → smb_host null
7. **webdav 变体**：3 字段映射
8. **archive origin=None**：archive_fileUri/format 有值，origin 8 字段全 null
9. **archive origin=Local**：originType="local"、origin_rootUri 有值、其余 origin 字段 null；sevenz→"7z" 格式映射
10. **archive origin=Smb**：originType="smb"、5 字段 + host 联表
11. **warnings**：非法 descriptor 行跳过且其余行不受影响（totalCount 不含跳过行）；origin=WebDav / 嵌套 Archive 跳过记 warnings
12. **顶层结构**：schemaVersion=2；totalCount=items.len()；按 last_visited_at DESC 排序；id 为 1..N 递增序号
13. **格式**：`to_string_pretty` 输出含 2 空格缩进 + LF；null 字段 key 保留（反序列化回 Value 后 `get(...)` 为 `Value::Null` 而非缺失）

### 7.2 前端（Vitest）

1. `format.test.ts`：`formatExportTimestamp` 各段补零（月/日/时/分/秒 < 10）、跨年边界；`browseHistoryExportFileName` 完整拼接格式
2. `History.test.ts`：按钮渲染；点击 → `exportBrowseHistory` 以 `browse_history_` 前缀 + `.json` 后缀的文件名被调（mock `@/lib/tauri`）；`exported: false` 回 idle；`exported: true` → done 文案（含 count）；异常 → failed 文案；导出中 disabled
3. `Settings.test.ts`：maintenance 导出行渲染 + 点击调用（同 mock 模式）
4. i18n 双语一致性：新 keys 在 zh-CN / en-US 均存在（沿用现有 i18n 测试模式）

### 7.3 实机冒烟（tauri:dev）

1. History 点导出 → 保存对话框弹出且默认文件名格式正确 → 保存 → 文件生成
2. `jq '{schemaVersion, totalCount, warnings, fields: (.items[0] | keys | length)}' file.json` → schemaVersion=2、fields=30
3. 取消对话框 → 无报错无残留状态
4. Settings 入口同流程
5. **blocking dialog 不死锁验证**（§4.4 约束）
6. 与参考样本结构 diff：字段名集合与字段序一致（`jq '.items[0] | keys_unsorted'` 对比）

---

## 8. 风险与对策

| 风险 | 评估 | 对策 |
|---|---|---|
| `blocking_save_file` 死锁 | sync command 在 IPC 线程（非主线程），插件文档允许；但需实证 | 冒烟 §7.3-5 专项验证；若死锁改 async command + 回调式 `save_file` + oneshot channel |
| 大表内存峰值 | `to_string_pretty` 一次性 String（约为 DB 数据 2-3 倍）；个人阅览记录量级（数百~数千条）远无压力 | 接受；流式写出留未来（非目标） |
| 导出期间 DB 锁 | `Db.conn()` Mutex 短持有（单次 SELECT + 内存组装），与现有命令一致 | 接受 |
| 历史脏 descriptor | migration 013 已清理存量；残留由 warnings 兜底 | §3.5 |
| Windows 路径含非 ASCII | `to_string_lossy` 仅在返回展示路径用；写文件用 `PathBuf` 原生 | 无损 |

---

## 9. 验收标准

1. `cargo test -p mirapage-desktop-lib` 全绿（新增 ≥13 用例）
2. `npm run type-check` + `npm test -- --run` 全绿（新增 ≥8 用例）
3. 实机冒烟 §7.3 六项全过
4. 导出文件与参考样本结构 diff：30 字段名 + 字段序一致，null 规则一致，`liked` 恒布尔
