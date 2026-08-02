# v0.1.0-module3.0 — 书库 / 阅览记录 重写（对齐 Android schema）

- **日期**: 2026-08-02
- **状态**: 已批准（待规格审查）
- **关联**: DESIGN.md §1.4 + §1.5；perfect-viewer `LibraryEntity` / `BrowseHistoryEntity` / `LibraryRepository`
- **参考实现**: `F:\WorkSpaceCollection\git\perfect-viewer\app\src\main\java\top\racyan\data\local\entity\LibraryEntity.kt`、`BrowseHistoryEntity.kt`、`repository\LibraryRepository.kt`

## 1. 背景与目标

### 1.1 用户反馈（v0.1.0-module2.0 之后）

> 参考安卓 perfect-viewer 的逻辑：书架应该为书库；书库应该手动添加，而不是点击立即阅读就添加；阅览记录现在完全不可用，参考安卓的逻辑修复。

三条独立但相关：

1. **术语** — desktop 当前 "书架" 不一致（Library.vue docstring 写"书架视图"，UI 用了 "Library"），按 Android 用"书库"
2. **library 行为错位** — desktop 的 "立即阅读" 与 "加入书库" 都通过 `create_book` 写 book 行（`is_favorite=0`），LibraryScreen 不区分，全部显示 → 用户实际"自动加入书库"。Android 用 `is_favorite` 字段区分 temp import（read-now）vs manual add（add-to-library），LibraryScreen 列出全部但视觉上 favorites 优先。
3. **history 完全不可用** — `History.vue` 第 47/68/82 行 RouterLink 路径错误（`{ path: '/reader', query: { bookId } }` 不匹配 router 的 `/reader/:bookId` path-param 路由），点击 history 行 → 无响应。同时 desktop 的 `browse_history` 表是 per-book（book_id 主键），与 Android 的 per-folder（`sourceDescriptor + relPath` 主键）语义不同。

### 1.2 目标

1. **库（library / 书库）严格区分手动添加** — LibraryScreen 只列 `is_favorite=1`；"立即阅读" 创建临时 row（供 progress 关联 book_id，但 Library 看不到）；"加入书库" 设 `is_favorite=1`（Library 可见）。
2. **History 按 Android BrowseHistory 完整重写** — folder-level，FileBrowser 每次导航成功自动 upsert；History 列文件夹，点击 → 跳回 FileBrowser 对应路径。
3. **Schema 对齐 Android** — `book` 表重命名为 `library`，字段补齐（`absolutePath` / `sourceType` / `coverEntryPath` / `coverEntryName` / `pageCount` / `addedAt`），与 Android backup/restore 字节级一致。

### 1.3 非目标

- 编辑类（CLAUDE.md §6 决策锁）：不做 library row 删除 / 重命名 / 拖放（用 `set_favorite(false)` 隐式移除）
- Backup / Restore 与 Android 互通（本模块 scope 外，后续 Phase 9 再做）
- LibraryScreen 封面图渲染（数据层准备好，UI 留给后续 polish — 不在本批）
- "Recently read" 临时 row 视图（is_favorite=0 但 lastReadAt 非空）—— 用户从 FileBrowser 重新进入文件夹时可通过 "Reading/Finished" 状态发现
- browse_history 旧数据迁移（旧 per-book 行语义与新 per-folder 不兼容 → DROP）

## 2. 核心决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| 术语 "书架" → "书库" | **仅 zh-CN.ts 显示字符串 + Library.vue 顶部 docstring** | i18n key 保留 `library.*`，影响最小 |
| Library 过滤 | `list_library` 加 `WHERE is_favorite = 1` | 一行 SQL，前端零改动 |
| `create_book` 入参 | 新增 `favorite: bool` + `absolutePath: String` + `sourceType: String`；新增内部 enumerate（封面/页数） | 与 Android `LibraryRepository.importFromSource` 字节级镜像 |
| `book` → `library` 表重命名 | `ALTER TABLE book RENAME TO library` + 7 个 `ALTER TABLE library ADD COLUMN` | 标准 SQLite 操作，不丢旧数据；后续 backup/restore 直接对接 |
| 旧 `browse_history` (per-book) | **DROP + 重建**（per-folder，Android 对齐） | 语义不兼容，无可迁移 |
| History 自动记录触发点 | FileBrowser `fetch()` 成功后调 `record_history_navigation` | Android `BrowseHistoryRepository.record` 在 FileBrowser 导航成功时调，对齐 |
| History 视图行为 | 列文件夹 + 时间；点击 → 跳 FileBrowser 对应 path；右键/长按 → 删除 | Android BrowseHistoryScreen 完全对齐 |
| progress.rs 删除 `DELETE FROM browse_history` | 删除（per-book history 已废，mark_finished 不再联动） | 旧 logic 配套清理 |

## 3. 数据层

### 3.1 Migration 005（`src-tauri/src/db/migrations.rs`）

```rust
if current < 5 {
    apply_005_library_history_redesign(conn)?;
    conn.execute(
        "INSERT INTO _migrations (version, applied_at) VALUES (5, ?1)",
        [chrono_now()],
    )?;
}

fn apply_005_library_history_redesign(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        -- book → library 重命名（Android LibraryEntity 对齐）
        ALTER TABLE book RENAME TO library;

        -- library 补字段（Android LibraryEntity 全字段）
        ALTER TABLE library ADD COLUMN source_type TEXT NOT NULL DEFAULT 'Local';
        ALTER TABLE library ADD COLUMN absolute_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE library ADD COLUMN cover_entry_path TEXT;
        ALTER TABLE library ADD COLUMN cover_entry_name TEXT;
        ALTER TABLE library ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE library ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;

        -- 加 UNIQUE 索引：Android LibraryEntity `(sourceDescriptorJson, absolutePath)` 一致
        CREATE UNIQUE INDEX IF NOT EXISTS idx_library_source_path
            ON library(source_descriptor, absolute_path);

        -- 旧 per-book browse_history 重写为 per-folder
        DROP TABLE IF EXISTS browse_history;
        CREATE TABLE browse_history (
          source_descriptor TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          display_name TEXT NOT NULL,
          last_visited_at INTEGER NOT NULL,
          PRIMARY KEY (source_descriptor, rel_path)
        );
        CREATE INDEX idx_browse_history_last_visited
            ON browse_history(last_visited_at DESC);
        "#,
    )?;
    Ok(())
}
```

### 3.2 新 `library` 表（最终态）

| 字段 | 类型 | NOT NULL | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | AUTOINCREMENT | 主键 |
| `title` | TEXT | ✓ | — | 书名 |
| `source_descriptor` | TEXT | ✓ | — | SourceDescriptor JSON 字符串 |
| `source_type` | TEXT | ✓ | 'Local' | "Local" / "Archive" / "Smb" / "WebDav"（`descriptor::class.simpleName`） |
| `absolute_path` | TEXT | ✓ | '' | 书根路径（相对 source root；desktop Local = 文件夹相对 rootPath 的路径，如 "Vol.01"） |
| `cover_entry_path` | TEXT | ✗ | NULL | 封面图绝对路径（enumerate 后填） |
| `cover_entry_name` | TEXT | ✗ | NULL | 封面图文件名 |
| `page_count` | INTEGER | ✓ | 0 | 图片页数 |
| `last_read_at` | INTEGER | ✗ | NULL | 最近一次阅读时间戳 |
| `added_at` | INTEGER | ✓ | 0 | 加入时间戳（Android `System.currentTimeMillis()`） |
| `is_favorite` | INTEGER | ✓ | 0 | 0=临时 / 1=手动加入书库 |

UNIQUE: `(source_descriptor, absolute_path)` —— 同位置的书只一行（与 Android 一致）

### 3.3 新 `browse_history` 表

| 字段 | 类型 | NOT NULL | 说明 |
|---|---|---|---|
| `source_descriptor` | TEXT | ✓ | SourceDescriptor JSON |
| `rel_path` | TEXT | ✓ | 文件夹相对 root 的路径（如 "" / "Vol.01" / "specials/2024"） |
| `display_name` | TEXT | ✓ | 列表显示名（文件夹最后一段或 root 别名） |
| `last_visited_at` | INTEGER | ✓ | 最近一次导航时间戳 |

PRIMARY KEY: `(source_descriptor, rel_path)` —— 同文件夹只一条，重复访问 refresh 时间戳（Android `OnConflictStrategy.REPLACE` 行为）

## 4. Rust Commands

### 4.1 `commands/library.rs` 完全重写

```rust
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookItem {
    pub id: i64,
    pub title: String,
    pub source_descriptor: String,
    pub source_type: String,
    pub absolute_path: String,
    pub cover_entry_path: Option<String>,
    pub cover_entry_name: Option<String>,
    pub page_count: i64,
    pub last_read_at: Option<i64>,
    pub added_at: i64,
    pub is_favorite: bool,
}

#[tauri::command]
pub fn list_library(db: tauri::State<crate::db::Db>) -> Result<Vec<BookItem>, String> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, source_descriptor, source_type, absolute_path,
                cover_entry_path, cover_entry_name, page_count,
                last_read_at, added_at, is_favorite
         FROM library
         WHERE is_favorite = 1
         ORDER BY last_read_at IS NULL, last_read_at DESC, added_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_book_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookArgs {
    pub title: String,
    pub source_descriptor: serde_json::Value,
    pub absolute_path: String,
    pub source_type: String,
    pub favorite: bool,
    /// caller 提供的根 MediaSource（用于 enumerate 图片）。来自前端 useReaderActions。
    /// Rust 端不持有 MediaSource 上下文 → 前端先 enumerate 一次，传 coverEntryPath/Name + pageCount。
    pub cover_entry_path: Option<String>,
    pub cover_entry_name: Option<String>,
    pub page_count: i64,
}

#[tauri::command]
pub fn create_book(args: CreateBookArgs, db: tauri::State<crate::db::Db>) -> Result<i64, String> {
    let conn = db.conn();
    let descriptor_str = serde_json::to_string(&args.source_descriptor)?;

    // 复用同 (sourceDescriptor, absolutePath) 的 row
    let existing: Option<(i64, bool)> = conn.query_row(
        "SELECT id, is_favorite FROM library WHERE source_descriptor = ?1 AND absolute_path = ?2",
        rusqlite::params![descriptor_str, args.absolute_path],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? != 0)),
    ).optional()?;

    if let Some((id, is_fav)) = existing {
        // favorite=true 且当前未 favorite → 升级（Android LibraryRepository.importFromSource 行为）
        if args.favorite && !is_fav {
            conn.execute(
                "UPDATE library SET is_favorite = 1 WHERE id = ?1",
                rusqlite::params![id],
            )?;
        }
        return Ok(id);
    }

    // 新 INSERT
    let now = chrono_now();
    conn.execute(
        "INSERT INTO library
            (title, source_descriptor, source_type, absolute_path,
             cover_entry_path, cover_entry_name, page_count,
             added_at, is_favorite)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            args.title,
            descriptor_str,
            args.source_type,
            args.absolute_path,
            args.cover_entry_path,
            args.cover_entry_name,
            args.page_count,
            now,
            if args.favorite { 1i64 } else { 0i64 },
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn set_favorite(book_id: i64, favorite: bool, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    conn.execute(
        "UPDATE library SET is_favorite = ?1 WHERE id = ?2",
        rusqlite::params![if favorite { 1i64 } else { 0i64 }, book_id],
    )?;
    Ok(())
}
```

**关键决策**：enumerate 图片（封面/页数）放**前端**而非 Rust：
- 前端 `useReaderActions` 已有 `MediaSourceFactory` 上下文，可直接 `listDirectory` + 过滤图片
- Rust 端 `create_book` 是纯 DB 操作，无 IO 依赖，~5ms
- 失败时 fallback：`page_count=0` / `cover_entry_path=None`（书架列表仍可显示）

### 4.2 `commands/history.rs` 完全重写

```rust
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowseHistoryEntry {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub display_name: String,
    pub last_visited_at: i64,
}

#[tauri::command]
pub fn list_history(db: tauri::State<crate::db::Db>) -> Result<Vec<BrowseHistoryEntry>, String> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT source_descriptor, rel_path, display_name, last_visited_at
         FROM browse_history ORDER BY last_visited_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let sd_str: String = row.get(0)?;
        let sd_value: serde_json::Value = serde_json::from_str(&sd_str)
            .unwrap_or(serde_json::Value::Null);
        Ok(BrowseHistoryEntry {
            source_descriptor: sd_value,
            rel_path: row.get(1)?,
            display_name: row.get(2)?,
            last_visited_at: row.get(3)?,
        })
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordHistoryArgs {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub display_name: String,
}

#[tauri::command]
pub fn record_history(args: RecordHistoryArgs, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    let descriptor_str = serde_json::to_string(&args.source_descriptor)?;
    let now = chrono_now();
    conn.execute(
        "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source_descriptor, rel_path) DO UPDATE SET
           display_name = excluded.display_name,
           last_visited_at = excluded.last_visited_at",
        rusqlite::params![descriptor_str, args.rel_path, args.display_name, now],
    )?;
    Ok(())
}

#[tauri::command]
pub fn delete_history(source_descriptor: serde_json::Value, rel_path: String,
                      db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    let descriptor_str = serde_json::to_string(&source_descriptor)?;
    conn.execute(
        "DELETE FROM browse_history WHERE source_descriptor = ?1 AND rel_path = ?2",
        rusqlite::params![descriptor_str, rel_path],
    )?;
    Ok(())
}
```

### 4.3 `commands/progress.rs` 清理

```rust
// 旧 save_progress 里:
//   "DELETE FROM browse_history WHERE book_id = ?1"  ← 删除（per-book history 废）

// 旧 mark_finished 里:
//   "DELETE FROM browse_history WHERE book_id = ?1"  ← 删除

// save_progress 本身保留：
//   UPDATE progress SET page = ?, ... WHERE book_id = ?
//   UPDATE library SET last_read_at = ? WHERE id = ?
//   （表名 book → library）
```

### 4.4 `lib.rs` 注册

```rust
tauri::generate_handler![
    // ... 现有 commands
    commands::history::list_history,
    commands::history::record_history,       // 入参变更（bookId → descriptor + relPath + displayName）
    commands::history::delete_history,        // 新增
    commands::library::list_library,
    commands::library::create_book,           // 入参扩展
    commands::library::set_favorite,
    // ...
]
```

## 5. 前端

### 5.1 `src/lib/tauri.ts` — IPC 签名

```ts
// 旧
export async function createBook(title: string, descriptor: SourceDescriptor): Promise<number>;

// 新
export interface CreateBookArgs {
  title: string;
  sourceDescriptor: SourceDescriptor;
  absolutePath: string;
  sourceType: string;
  favorite: boolean;
  coverEntryPath: string | null;
  coverEntryName: string | null;
  pageCount: number;
}
export async function createBook(args: CreateBookArgs): Promise<number>;

// history IPC
export interface BrowseHistoryEntry {
  sourceDescriptor: SourceDescriptor;
  relPath: string;
  displayName: string;
  lastVisitedAt: number;
}
export async function listHistory(): Promise<BrowseHistoryEntry[]>;  // 返回类型变化
export async function recordHistory(sourceDescriptor: SourceDescriptor, relPath: string, displayName: string): Promise<void>;
export async function deleteHistory(sourceDescriptor: SourceDescriptor, relPath: string): Promise<void>;
```

### 5.2 `src/composables/useReaderActions.ts`

```ts
import { listDirectory } from '@/lib/tauri';  // 用于 enumerate 封面

async function enumerateCover(rootPath: string, absPath: string) {
  // 调 listDirectory(sourceDescriptor, absPath) → 过滤图片 → natural-sort → 取第一张
  try {
    const entries = await listDirectory(/* source descriptor */, absPath);
    const images = entries
      .filter(e => !e.isDirectory && mimeUtils.isImage(e.name))
      .sort(naturalCompare('name'));
    if (images.length === 0) return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
    const first = images[0];
    return {
      coverEntryPath: first.path,
      coverEntryName: first.name,
      pageCount: images.length,
    };
  } catch {
    return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
  }
}

async function ensureBookId(entry: MediaEntry, favorite: boolean): Promise<number | null> {
  const rootPath = opts.resolveRootPath(/* root, not entry */);
  const absPath = entry.path;  // 相对于 root 的路径
  const descriptor = opts.buildSourceDescriptor(rootPath);
  const sourceType = descriptor.type === 'local' ? 'Local' : capitalize(descriptor.type);
  
  const cover = await enumerateCover(rootPath, absPath);
  
  return await createBook({
    title: entry.name,
    sourceDescriptor: descriptor,
    absolutePath: absPath,
    sourceType,
    favorite,
    ...cover,
  });
}

async function readNow(entry: MediaEntry): Promise<void> {
  const bookId = await ensureBookId(entry, /*favorite=*/false);  // 临时，Library 不可见
  // ... navigation
}

async function addToLibrary(entry: MediaEntry): Promise<void> {
  const bookId = await ensureBookId(entry, /*favorite=*/true);  // 手动，Library 可见
  // ... onLibraryChanged
}
```

### 5.3 `src/stores/fileBrowser.ts` — 自动记录

```ts
import { recordHistory } from '@/lib/tauri';

async function fetch(directory: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const entries = await listDirectory(currentSourceDescriptor.value, directory);
    // ... 现有逻辑
    entriesRef.value = entries;
    
    // ★ 新增：导航成功后自动 upsert browse_history
    recordHistory(
      currentSourceDescriptor.value,
      directory,
      directoryDisplayName(directory),  // 最后一段或 'root'
    ).catch(e => log('[fb] recordHistory failed', e));  // 失败容错，不影响 list
    
  } catch (e) {
    error.value = e as Error;
  } finally {
    loading.value = false;
  }
}

function directoryDisplayName(dir: string): string {
  if (!dir) return 'root';
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'root';
}
```

### 5.4 `src/stores/history.ts` — 全重写

```ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listHistory, recordHistory, deleteHistory, type BrowseHistoryEntry } from '@/lib/tauri';

export const useHistoryStore = defineStore('history', () => {
  const items = ref<BrowseHistoryEntry[]>([]);

  async function refresh(): Promise<void> {
    items.value = await listHistory();
  }

  /** FileBrowser 调用 — 容错，失败不抛 */
  async function record(descriptor: SourceDescriptor, relPath: string, displayName: string): Promise<void> {
    try {
      await recordHistory(descriptor, relPath, displayName);
    } catch (e) {
      log('[history] record failed', e);
    }
  }

  async function deleteEntry(entry: BrowseHistoryEntry): Promise<void> {
    await deleteHistory(entry.sourceDescriptor, entry.relPath);
    await refresh();
  }

  return { items, refresh, record, deleteEntry };
});
```

### 5.5 `src/views/History.vue` — 重写

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useHistoryStore } from '@/stores/history';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { formatDate } from '@/locales/helpers';

const { t } = useI18n();
const router = useRouter();
const store = useHistoryStore();
const { items } = storeToRefs(store);
const fb = useFileBrowserStore();

onMounted(() => {
  store.refresh();
});

async function openEntry(entry: BrowseHistoryEntry) {
  // 跳回 FileBrowser 对应 root + path
  // rootPath 从 entry.sourceDescriptor 提取
  const rootPath = entry.sourceDescriptor.rootPath;
  await fb.setRoot(rootPath);
  await fb.navigate(entry.relPath);
  router.push({ name: 'home' });
}

async function removeEntry(entry: BrowseHistoryEntry) {
  await store.deleteEntry(entry);
}
</script>

<template>
  <main class="history-view">
    <header>
      <h2>{{ t('history.title') }}</h2>
      <RouterLink to="/">← {{ t('common.back') }}</RouterLink>
    </header>

    <p v-if="items.length === 0" class="hint">{{ t('history.empty') }}</p>

    <ul v-else data-test="list" class="history-list">
      <li v-for="item in items" :key="`${item.sourceDescriptor.rootPath}::${item.relPath}`" data-test="row">
        <span class="icon">📁</span>
        <button class="name" @click="openEntry(item)">{{ item.displayName }}</button>
        <span class="time">{{ formatDate(item.lastVisitedAt, 'system') }}</span>
        <button class="delete" @click="removeEntry(item)" :aria-label="t('common.delete')">×</button>
      </li>
    </ul>
  </main>
</template>
```

### 5.6 `src/views/Library.vue` — 仅 docstring

```ts
// 顶部 docstring: "书架视图" → "书库视图"
```

### 5.7 `src/locales/zh-CN.ts` — 术语

```
// 搜索 "书架" 全替换 "书库"
// 注意：CLAUDE.md §6 决策 — 不翻译业务值（filename / path / shortcut label）保留原文
```

i18n key 保留 `library.*` / `history.*` 不变。

### 5.8 `src/views/Home.vue` / `ReaderView.vue` 不动

- `ReaderView.vue` 用 `/reader/:bookId` path param（已正确，history 跳转修好后自动可用）
- `Home.vue` 不显示 history，只显示 FileBrowser

## 6. 测试

### 6.1 新增/更新

| 文件 | 用例 |
|---|---|
| `src-tauri/src/commands/library.rs` (单元) | `create_book` 新书 INSERT / 同 source 复用 / favorite 升级 / 非 favorite 不降级 |
| `src-tauri/src/commands/history.rs` (单元) | `record_history` ON CONFLICT 行为 / `delete_history` 删除唯一 / `list_history` 排序 |
| `src/stores/fileBrowser.test.ts` | 加：`fetch` 成功后调 `recordHistory` (mock 验证)；`fetch` 失败不调 |
| `src/stores/history.test.ts` | 重写：`refresh` / `record` / `deleteEntry` (BrowseHistoryEntry shape) |
| `src/stores/library.test.ts` | 加：`list_library` 只返 favorite=1（mock 控） |
| `src/composables/useReaderActions.test.ts` | 重写：`readNow` 调 `createBook(favorite=false)` / `addToLibrary` 调 `createBook(favorite=true)` / 同 source 复用 + 升级 |
| `src/views/History.test.ts` (新) | mount → 列 items / 点击 → 调 fb.setRoot + fb.navigate + router.push / 删除 → refresh |
| `src/lib/tauri.ts` test | 加：deleteHistory / recordHistory 入参形状 |
| `src-tauri/src/db/migrations.rs` test | 旧 `book` 表存在 → migration 005 后变 `library` 表 + 7 新字段 + 旧数据保留 |

### 6.2 不变（仅 mock 形状更新）

- `useReaderStore` / `useSlideshowStore` / `useSettingsStore` — 不依赖 `book` 表名
- `bookmarks.test.ts` / `likes.test.ts` — 不依赖 library
- 现有 FileBrowser / Reader 测试 — 不依赖 history 形状

## 7. 验收

```bash
# Rust
cargo test -p mirapage-desktop-lib   # migration 005 + library + history 命令测试

# Frontend
npm run type-check && npm test -- --run   # 全过 + 新增测试 0 fail

# 手动验证（参考 §1.1）
1. FileBrowser 双击目录（无图）→ 立即阅读 → Library 不出现该书（is_favorite=0）✓
2. FileBrowser 选中目录（有图）→ 加入书库 → Library 出现该书（is_favorite=1）✓
3. Library 列表按 lastReadAt DESC，None 排后面 ✓
4. FileBrowser 在 3 个目录间上下导航 → History 列 3 条文件夹（按时间倒序）✓
5. History 点击一行 → 跳回 FileBrowser 对应 root + path ✓
6. History 删除一行 → 行消失，DB 行被删 ✓
7. 同一文件夹再访问 → last_visited_at refresh，时间戳更新（不新增行）✓
```

## 8. Critical files

| 路径 | 状态 | 改动 |
|---|---|---|
| `src-tauri/src/db/migrations.rs` | 改 | 新增 `apply_005_library_history_redesign` |
| `src-tauri/src/commands/library.rs` | 改 | BookItem 加 6 字段 + list_library WHERE + create_book 入参扩展 + 复用升级 |
| `src-tauri/src/commands/history.rs` | 改 | 完全重写（BrowseHistoryEntry + record + delete） |
| `src-tauri/src/commands/progress.rs` | 改 | 删 `DELETE FROM browse_history` + 表名 `book` → `library` |
| `src-tauri/src/lib.rs` | 改 | 注册 `delete_history`；其它 command 注册不变 |
| `src/lib/tauri.ts` | 改 | createBook / listHistory / recordHistory / 新增 deleteHistory / 新增 BrowseHistoryEntry 类型 |
| `src/composables/useReaderActions.ts` | 改 | 重写 ensureBookId(favorite) + enumerate 封面 + 删 recordHistory 调用 |
| `src/stores/fileBrowser.ts` | 改 | fetch 成功调 recordHistory |
| `src/stores/history.ts` | 改 | 重写为 BrowseHistoryEntry |
| `src/views/History.vue` | 改 | 重写（folder 行 + 删除 + 跳 FileBrowser） |
| `src/views/Library.vue` | 改 | 仅 docstring "书架" → "书库" |
| `src/locales/zh-CN.ts` | 改 | "书架" → "书库" 全替换 |
| `CLAUDE.md` | 改 | §6 加新决策：library 只显 favorite / history 重写为 folder-level |

## 9. Out of scope

- LibraryScreen 封面图渲染（数据准备好，UI 留给后续 polish）
- backup/restore 与 Android 互通（Phase 9）
- "Recently read" 临时 row 视图
- 编辑类（library row 删除 / history 重命名 displayName）

## 10. 决策记录（CLAUDE.md §6 待加）

- **library 只显示 favorite** — 用户反馈明确，Android LibraryScreen 模式扩展（Android UI 仍列全部，桌面端过滤更严）
- **history 重写为 folder-level** — Android BrowseHistory 直接对齐，per-book 行丢弃
- **`book` 表重命名为 `library`** — 与 Android `LibraryEntity` 字节级镜像，简化 backup/restore 对接
- **enumerate 封面放前端** — Rust `create_book` 保持纯 DB（不依赖 MediaSource），enumerate 失败时 fallback `pageCount=0`