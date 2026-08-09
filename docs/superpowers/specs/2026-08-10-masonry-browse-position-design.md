# 瀑布流浏览位置 = 阅读进度（masonry browse position = progress）

- 状态：设计稿（待用户审查）
- 日期：2026-08-10
- 目标版本：v0.1.0-module3.0.8

## 背景

`v0.1.0-module3.0.6-masonry` 落地瀑布流视图后，用户在图片目录里滚到第 50 张图后退出 app，下次再回到同目录只能从第一张重新滚一遍。这违背了"瀑布流也是阅读"的直觉。

`v0.1.0-module3.0.2-reader-polish` 已经把 reader 内"当前 spread 首图"作为持久化锚点（`?at=imageName` query 参数），但**只覆盖 reader 内的翻页动作**——瀑布流滚动从未驱动进度。

本版本统一"浏览过的位置 = 阅读进度"语义：masonry 滚动时把"顶部可见图"自动写进 progress，进 masonry 目录时自动跳到那里，顶栏「立即阅读」按钮无选中时也走 progress。

## 用户已确认的决策（对齐 7 个问题）

| # | 决策点 | 选定 |
|---|---|---|
| 1 | 进度数据源 | 复用 `progress` 表（不新建表） |
| 2 | 进度驱动方 | 瀑布流主导 + reader 翻页叠加（双写） |
| 3 | 写入时机 | 滚动停止 300ms debounce |
| 4 | 跳转策略 | 默认自动 + 可关 |
| 5 | 手动按钮位置 | toolbar「↶ 跳到上次」按钮，仅 masonry 视图 |
| 6 | 顶栏「立即阅读」未选中 | 走 progress 的 imageName；无 progress 时按钮 disabled |
| 7 | Settings 开关 | 2 个 BooleanRow（记录进度 / 自动跳转） |

## 范围

### 做
- `progress` 表新增 `image_name TEXT NULL` 列（migration 010）
- 瀑布流滚动监听 → 顶部可见图 → saveProgress（image_name + page 双写）
- 进 masonry 目录自动跳转（默认开启，可关）
- 顶栏「↶ 跳到上次」按钮（仅 masonry）
- 顶栏「立即阅读」按钮无选中时走 progress
- reader 翻页保存 progress 时**双写** image_name
- Settings 页 `fileBrowser` section + 2 个 BooleanRow

### 不做
- bookmark 表 schema 改动（`bookmark.page INTEGER` 保持）
- 跨卷继续阅读（find_next_volume）改造
- history / search 视图的浏览位置
- Android 端对齐（项目不存在）
- progress 表 `page INTEGER` 列移除（保留做迁移兜底）

## §2 数据模型

### 2.1 DB schema 改动

**migration 010**（追加到 `src-tauri/src/db/migrations.rs` 现有 `migrations` 数组末尾）：

```sql
-- progress 加 image_name 锚点（瀑布流浏览位置复用 progress 表）
-- 不删 page INTEGER：bookmark.page、mark_finished 重置、旧行迁移都依赖
ALTER TABLE progress ADD COLUMN image_name TEXT;
```

索引：`book_id` 已是 PRIMARY KEY，不加新索引。

### 2.2 Rust progress.rs 改动

#### 2.2.1 `ProgressItem` 加字段

```rust
// src-tauri/src/commands/progress.rs
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressItem {
    pub book_id: i64,
    pub page: i64,
    pub image_name: Option<String>,  // 新增
    pub reader_mode: String,
    pub finished: bool,
    pub updated_at: i64,
}
```

#### 2.2.2 `save_progress` 加可选参数

```rust
#[tauri::command]
pub async fn save_progress(
    db: tauri::State<crate::db::Db>,
    book_id: i64,
    page: i64,
    image_name: Option<String>,        // 新增（默认 NULL 兼容旧调用）
    reader_mode: String,
) -> Result<(), String> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO progress (book_id, page, image_name, reader_mode, finished, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)
         ON CONFLICT(book_id) DO UPDATE SET
            page = excluded.page,
            image_name = excluded.image_name,
            reader_mode = excluded.reader_mode,
            updated_at = excluded.updated_at",
        rusqlite::params![
            book_id,
            page,
            image_name,        // 新增
            reader_mode,
            chrono_now(),
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

`ON CONFLICT ... DO UPDATE` 模式——`progress.book_id` 已是 PRIMARY KEY，一次 INSERT/UPSERT 替代现有 SELECT+INSERT/UPDATE 三步（这是性能优化，顺手做）。

#### 2.2.3 `get_progress` 返回新字段

```rust
#[tauri::command]
pub async fn get_progress(
    db: tauri::State<crate::db::Db>,
    book_id: i64,
) -> Result<Option<ProgressItem>, String> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT book_id, page, image_name, reader_mode, finished, updated_at
         FROM progress WHERE book_id = ?1"
    ).map_err(|e| e.to_string())?;
    let item = stmt.query_row(rusqlite::params![book_id], |row| {
        Ok(ProgressItem {
            book_id: row.get(0)?,
            page: row.get(1)?,
            image_name: row.get(2)?,         // 新增
            reader_mode: row.get(3)?,
            finished: row.get::<_, i64>(4)? != 0,
            updated_at: row.get(5)?,
        })
    }).ok();
    Ok(item)
}
```

#### 2.2.4 `mark_finished` 重置时 image_name = NULL

```rust
// 现有：page = 0
// 改为：
conn.execute(
    "INSERT INTO progress (book_id, page, image_name, reader_mode, finished, updated_at)
     VALUES (?1, 0, NULL, ?2, 1, ?3)
     ON CONFLICT(book_id) DO UPDATE SET
        page = 0,
        image_name = NULL,
        finished = 1,
        updated_at = excluded.updated_at",
    rusqlite::params![book_id, reader_mode, chrono_now()],
).map_err(|e| e.to_string())?;
```

### 2.3 前端 tauri.ts 改动

```ts
// src/lib/tauri.ts

export interface ProgressItem {
  bookId: number;
  page: number;
  imageName: string | null;   // 新增
  readerMode: string;
  finished: boolean;
  updatedAt: number;
}

export async function saveProgress(
  bookId: number,
  page: number,
  imageName: string | null,   // 新增（第三个参数，插在 readerMode 之前）
  readerMode: string,
): Promise<void> {
  return invoke<void>('save_progress', {
    bookId,
    page,
    imageName,                // 新增
    readerMode,
  });
}
```

⚠️ **参数顺序变更**：`saveProgress(bookId, page, imageName, readerMode)`——所有现有调用点必须同步改。

### 2.4 数据库迁移兼容性

migration 010 跑完后，旧 `progress` 行的 `image_name` 全部为 NULL。ReaderView 恢复路径按 imageName → page → 0 顺序 fallback（见 §4），旧行仍能正确恢复（走 page 路径）。**无数据丢失**。

## §3 写入路径（双轨）

### 3.1 路径 A：reader 翻页（双写 imageName）

#### 3.1.1 调用点清单（需逐个改）

| 文件 | 行号 | 现状 | 改动 |
|---|---|---|---|
| `src/stores/reader.ts` | 79 | `saveProgress(info.bookId, info.page, 'single', isLast ? true : undefined)` | 加 `imageName: info.imageName ?? null` |
| `src/views/ReaderView.vue` | 477 | `saveProgress(reader.bookId, currentReadPage(), 'single')`（onUnmounted） | 加 `imageName: currentReadImageName()` |
| `src/views/ReaderView.vue` | 其他 | grep `saveProgress` 全部找出 | 同上 |

#### 3.1.2 `currentReadImageName()` helper（ReaderView.vue）

```ts
/** 当前 spread 起始图在 imageNames 里的文件名（用于 progress.image_name 锚点）。 */
function currentReadImageName(): string | null {
  const idx = reader.currentSpreadIndex;
  const sp = reader.spreads[idx];
  if (!sp) return null;
  return imageNames.value[sp.start] ?? null;
}
```

#### 3.1.3 `PageChangeInfo` payload（reader.ts）

```ts
interface PageChangeInfo {
  bookId: number;
  page: number;
  imageName: string | null;   // 新增
  mode: 'single' | 'double';
  finished?: boolean;
}
```

#### 3.1.4 `emitChanged`（reader.ts:66-87）

```ts
const spread = spreads.value[currentSpreadIndex.value];
const page = spread?.start ?? 0;
const imageName = spread ? imageNames.value[spread.start] ?? null : null;
emitChanged({ bookId, page, imageName, mode: 'single', finished: isLast });
```

### 3.2 路径 B：瀑布流滚动（新增 composable）

#### 3.2.1 文件：`src/composables/useMasonryBrowsePosition.ts`

```ts
// useMasonryBrowsePosition.ts — 瀑布流滚动 → progress 双写（image_name + page）
//
// 职责：
//   1. 监听 scrollTop + 300ms debounce，写入顶部可见图的 (imageName, page)
//   2. 进 masonry 时自动跳到 progress 记录的图（settings.restoreBrowsePositionOnEnter 开关）
//   3. 提供手动 jumpToLast() 给 FileBrowser toolbar「↶ 跳到上次」按钮
//
// 不依赖 Tauri IPC 之外的副作用。bookId 复用 ensureBookId 模式（同 readNow/readFromImage）。
```

接口：

```ts
export interface UseMasonryBrowsePositionParams {
  descriptor: Ref<SourceDescriptor>;
  currentPath: Ref<string>;
  entries: Ref<readonly MediaEntry[]>;
  visibleRange: ComputedRef<{ start: number; end: number }>;
  /** 暴露给父级的"立即跳"按钮触发器 */
  scrollToPath: (path: string) => void;
  /** settings 开关：自动跳转 */
  autoRestoreOnMount: ComputedRef<boolean>;
  /** settings 开关：是否记录（父关则 composable 整体失效） */
  enabled: ComputedRef<boolean>;
}

export interface UseMasonryBrowsePositionReturn {
  /** onMounted 时调：自动跳转 + 启动 scroll watcher */
  start: () => Promise<void>;
  /** onBeforeUnmount 时调：清理 debounce timer + 停止 watcher */
  stop: () => void;
  /** 手动跳到 progress 记录的图（toolbar 按钮调） */
  jumpToLast: () => Promise<void>;
  /** 是否能找到有效 progress 记录（FileBrowser.canReadNow 用） */
  hasRecordedProgress: ComputedRef<boolean>;
}
```

#### 3.2.2 实现要点

```ts
const DEBOUNCE_MS = 300;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let stopScrollWatch: (() => void) | null = null;
const lastWrittenPath = ref<string | null>(null);
const hasRecordedProgress = ref(false);

const topmostImage = computed<MediaEntry | null>(() => {
  const r = params.visibleRange.value;
  if (r.end === 0) return null;
  return params.entries.value[r.start] ?? null;
});

async function ensureBookIdForCurrentDir(): Promise<number | null> {
  const rootPath = params.descriptor.value.type === 'local'
    ? (params.descriptor.value as any).rootPath
    : '';
  const currentPath = params.currentPath.value;
  const absPath = currentPath;
  const title = currentPath.split(/[\\/]/).pop() || currentPath;
  const cover = await enumerateCover(params.descriptor.value, absPath);
  const bookId = await createBook({
    title,
    sourceDescriptor: params.descriptor.value,
    absolutePath: absPath,
    sourceType: params.descriptor.value.type === 'local' ? 'Local' : capitalize(params.descriptor.value.type),
    favorite: false,
    ...cover,
  });
  return bookId;
}

async function recordCurrentTop(): Promise<void> {
  if (!params.enabled.value) return;
  const e = topmostImage.value;
  if (!e) return;
  if (e.path === lastWrittenPath.value) return;  // 去重：连续可见同一图不重复写
  try {
    const bookId = await ensureBookIdForCurrentDir();
    if (bookId == null) return;
    await saveProgress(
      bookId,
      params.visibleRange.value.start,  // page = 当前排序下 0-based 索引
      e.name,                            // imageName = 文件名
      '',                                 // reader_mode 空串（masonry 没有 reader_mode）
    );
    lastWrittenPath.value = e.path;
    hasRecordedProgress.value = true;
  } catch (err) {
    log('[useMasonryBrowsePosition] recordCurrentTop failed', err);
  }
}

function scheduleRecord(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void recordCurrentTop();
  }, DEBOUNCE_MS);
}

async function restoreAndScroll(): Promise<void> {
  if (!params.autoRestoreOnMount.value) return;
  try {
    const bookId = await ensureBookIdForCurrentDir();
    if (bookId == null) return;
    const progress = await getProgress(bookId);
    if (!progress?.imageName) return;
    const path = toRootRelativePath(params.currentPath.value, progress.imageName);
    // 等 layout 收敛（measuredMap 可能未到，layout map 可能缺该图）
    await nextTick();
    await nextTick();
    params.scrollToPath(path);
    hasRecordedProgress.value = true;
  } catch (err) {
    log('[useMasonryBrowsePosition] restoreAndScroll failed', err);
  }
}

async function start(): Promise<void> {
  await restoreAndScroll();
  stopScrollWatch = watch(
    () => params.visibleRange.value.start,
    () => scheduleRecord(),
  );
}

function stop(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (stopScrollWatch) stopScrollWatch();
  stopScrollWatch = null;
  lastWrittenPath.value = null;
  hasRecordedProgress.value = false;
}

async function jumpToLast(): Promise<void> {
  try {
    const bookId = await ensureBookIdForCurrentDir();
    if (bookId == null) return;
    const progress = await getProgress(bookId);
    if (!progress?.imageName) return;
    const path = toRootRelativePath(params.currentPath.value, progress.imageName);
    params.scrollToPath(path);
  } catch (err) {
    log('[useMasonryBrowsePosition] jumpToLast failed', err);
  }
}

onBeforeUnmount(stop);

return {
  start,
  stop,
  jumpToLast,
  hasRecordedProgress: computed(() => hasRecordedProgress.value),
};
```

#### 3.2.3 关键依赖

- `enumerateCover / createBook / getProgress / saveProgress` 全部从 `@/lib/tauri` 导入
- `toRootRelativePath` 从 `@/composables/useMasonryLayout` 复用
- `log` 从 `@/lib/logger`
- `SourceDescriptor / MediaEntry` 从 `@/lib/sourceDescriptor`

### 3.3 边界处理

| 场景 | 行为 |
|---|---|
| masonry 切到 details 视图 | `useMasonryBrowsePosition` `onBeforeUnmount` 自动清理 |
| 目录切换 | 同一 composable 实例不重建时，由父级 key 控制重建（详见 §3.4） |
| 目录无图片 | masonry 不渲染，composable 不挂载（已知 fallback） |
| 空进度（用户未浏览过） | `saveProgress` 静默成功；`restoreAndScroll` 立即返回 |
| 重复写入（同一图持续可见） | `lastWrittenPath` 去重，不重复 IPC |
| `enabled.value === false`（Settings 关闭） | `scheduleRecord` 不触发；`restoreAndScroll` 不调用；`jumpToLast` 仍可用（用户手动） |
| 滚动跨多个图（快滚） | debounce 保证只写最后一个顶部可见图 |
| `getProgress` / `saveProgress` IPC 失败 | 静默吞（容错，不影响 UX） |

### 3.4 composable 挂载位置与目录切换

`MasonryView.vue` 持有 composable 实例。当目录切换时，`MasonryView` props `currentPath / descriptor / entries` 全变。

**关键约束**：composable 内部 `watch(visibleRange.start, scheduleRecord)` 会在 visibleRange 变化时触发——但**同一图可见时也会触发**（去重保护）。

**start/stop 触发点**：
- `onMounted` → `start()`
- `onBeforeUnmount` → `stop()`（自动）
- 目录切换 → 必须强制 MasonryView 实例重建（确保 start/stop 严格成对）

**强制重建做法**：在父级（FileBrowser.vue）的 `<MasonryView>` 上加 `:key="`${descriptorKey}|${currentPath}`"`，目录切换时 key 变化 → Vue 卸载旧实例 + 挂载新实例。

**降级 fallback**（如果父级加 key 影响其他功能）：在 composable 内部 `watch([descriptor, currentPath], () => { stop(); start(); })` 显式重置。

⚠️ **plan 阶段核实**：当前 MasonryView 是否被父级 key 化（FileBrowser.vue line 371-386 附近）。如无，优先选"父级 key 化"做法（更标准）；如影响其他，加 fallback 方案。

## §4 恢复路径

### 4.1 ReaderView 恢复（imageName 优先 + page fallback）

当前 `ReaderView.vue:402`：

```ts
const idx = SpreadPlanner.spreadIndexForPage(progress.page, spreads);
```

改为：

```ts
function resolveInitialSpreadIndex(progress: ProgressItem | null, spreads: Spread[]): number {
  if (!progress) return SpreadPlanner.spreadIndexForPage(0, spreads);
  // 1. 优先 imageName（masonry 写入的 anchor）
  if (progress.imageName) {
    const nameIdx = imageNames.value.indexOf(progress.imageName);
    if (nameIdx >= 0) {
      const idx = SpreadPlanner.spreadIndexForPage(nameIdx, spreads);
      log('[ReaderView] restore: imageName hit', progress.imageName, '→ spread', idx);
      return idx;
    }
    log('[ReaderView] restore: imageName not found', progress.imageName, 'fallback to page');
  }
  // 2. fallback page（旧行 / 改名 / 换源）
  return SpreadPlanner.spreadIndexForPage(progress.page, spreads);
}
```

调用点（`ReaderView.vue`）：
```ts
const idx = resolveInitialSpreadIndex(progress, spreads);
```

**末页钳位（line 405）保留**——避免刚开就跨卷。

**优先级顺序**（最终）：
1. `?at=imageName` query 参数（最高，临时）
2. `progress.imageName` → 当前排序下 imageNames.indexOf
3. `progress.page`（旧行 / imageName 找不到）
4. `0`（都缺失）

### 4.2 进 masonry 自动跳转

`MasonryView.vue::onMounted` 在 `triggerPrefetch()` 之后：

```ts
async function autoRestorePosition(): Promise<void> {
  if (!settingsStore.restoreBrowsePositionOnEnter) return;
  await browsePosition.start();  // composable 内部已封装 restoreAndScroll
}
```

实际 composable 在 `start()` 内部调用 `restoreAndScroll()`——所以 `MasonryView.onMounted` 只需 `await browsePosition.start()`。

### 4.3 顶栏「立即阅读」按钮无选中走 progress

#### 4.3.1 FileBrowser.vue::canReadNow

```ts
const canReadNow = computed(() => {
  const e = selectedEntry.value;
  if (e) return e.isDirectory === true || isImage(e.name);
  // 未选中：当前 masonry 目录有 progress 记录 → 启用
  return hasBrowseProgress.value;  // 新增 computed（由 MasonryView 暴露）
});
```

#### 4.3.2 FileBrowser.vue::onReadNowClick

```ts
function onReadNowClick() {
  const e = selectedEntry.value;
  if (e) {
    if (e.isDirectory) void readerActions.readNow(e);
    else void readerActions.readFromImage(e);
    return;
  }
  // 未选中 + 当前目录：走 progress
  void readerActions.readFromCurrentPath();  // 新方法
}
```

#### 4.3.3 useReaderActions.ts::readFromCurrentPath（新增）

```ts
async function readFromCurrentPath(): Promise<void> {
  log('[useReaderActions] readFromCurrentPath called');
  const rootPath = opts.resolveRootPath();
  const currentPath = opts.getCurrentPath?.() ?? '';
  if (!currentPath) {
    log('[useReaderActions] readFromCurrentPath: no currentPath, abort');
    return;
  }
  const descriptor = opts.buildSourceDescriptor(rootPath);
  const dirName = currentPath.split(/[\\/]/).filter(Boolean).pop() || currentPath;
  const dirEntry: MediaEntry = {
    name: dirName,
    path: '',
    isDirectory: true,
    isArchive: false,
    size: 0,
    modifiedAt: 0,
  };
  const { bookId, absPath } = await ensureBookId(dirEntry, /*favorite=*/false);
  if (bookId === null) {
    log('[useReaderActions] readFromCurrentPath: bookId null, abort');
    return;
  }
  const progress = await getProgress(bookId);
  if (!progress?.imageName) {
    log('[useReaderActions] readFromCurrentPath: no progress.imageName, abort');
    return;
  }
  // saveNavigationContext 复用现有 readNow 模式
  try {
    saveNavigationContext(rootPath, descriptor, currentPath, false);
  } catch (e) {
    log('[useReaderActions] readFromCurrentPath: saveNavigationContext failed (容错)', e);
  }
  await router.push({
    name: 'reader',
    params: { bookId: String(bookId) },
    query: { at: encodeURIComponent(progress.imageName) },
  });
}
```

`router` 注入：useReaderActions 现有 `useRouter()` 调用（`useReaderActions.ts:21` 附近）— 复用。

### 4.4 手动跳转按钮（toolbar）

FileBrowser.vue toolbar：

```vue
<button
  v-if="viewMode === 'masonry'"
  type="button"
  class="tb-btn"
  :disabled="!masonryHasProgress"
  :title="masonryHasProgress ? t('fileBrowser.jumpToLast') : t('fileBrowser.noRecordedProgress')"
  data-test="btn-jump-to-last"
  @click="onJumpToLastClick"
>
  <svg ...>{{ ICON_REWIND_TO_LAST }}</svg>
</button>
```

按钮 enable 条件：`hasBrowseProgress`（composable 暴露的 computed）。

`onJumpToLastClick`：
```ts
function onJumpToLastClick() {
  fileListRef.value?.masonryJumpToLast();  // 转发到 MasonryView
}
```

`FileList.vue::defineExpose` 加 `masonryJumpToLast()`：
```ts
async function masonryJumpToLast(): Promise<void> {
  await masonryRef.value?.jumpToLast();
}
```

`MasonryView.vue::defineExpose` 加 `jumpToLast()`：
```ts
defineExpose({
  regenerate: regenerateThumbnail,
  regenerateBatch: regenerateBatchFn,
  retry: retryThumbnail,
  retryBatch: retryBatchFn,
  jumpToLast: () => browsePosition.jumpToLast(),  // 新增
});
```

## §5 Settings 页

### 5.1 数据层

`src/stores/settings.ts` 加 2 个 ref + getter/setter：

```ts
const recordBrowsePosition = ref(true);
const restoreBrowsePositionOnEnter = ref(true);

// loadAll() 里读
recordBrowsePosition.value = get('fb_record_browse_position') !== 'false';
restoreBrowsePositionOnEnter.value = get('fb_restore_browse_position_on_enter') !== 'false';

function setRecordBrowsePosition(v: boolean): void {
  recordBrowsePosition.value = v;
  set('fb_record_browse_position', v ? 'true' : 'false');
}
function setRestoreBrowsePositionOnEnter(v: boolean): void {
  restoreBrowsePositionOnEnter.value = v;
  set('fb_restore_browse_position_on_enter', v ? 'true' : 'false');
}
```

返回对象加 4 个：
```ts
return {
  // ...existing
  recordBrowsePosition: computed(() => recordBrowsePosition.value),
  restoreBrowsePositionOnEnter: computed(() => restoreBrowsePositionOnEnter.value),
  setRecordBrowsePosition,
  setRestoreBrowsePositionOnEnter,
};
```

### 5.2 UI

`Settings.vue` 加新 section（位置在"缩略图"section 之前，语义相邻）：

```vue
<section
  id="file-browser"
  class="bg-surface-1 xp-bd rounded-lg p-6"
  data-test="settings-filebrowser"
>
  <h2 class="text-base font-semibold mb-4">
    {{ t('settings.fileBrowser.title') }}
  </h2>
  <BooleanRow
    :label="t('settings.fileBrowser.recordBrowsePosition')"
    :description="t('settings.fileBrowser.recordBrowsePositionDesc')"
    :model-value="settings.recordBrowsePosition"
    data-test="record-browse-position"
    @update:model-value="settings.setRecordBrowsePosition"
  />
  <BooleanRow
    class="mt-4"
    :label="t('settings.fileBrowser.restoreBrowsePosition')"
    :description="t('settings.fileBrowser.restoreBrowsePositionDesc')"
    :model-value="settings.restoreBrowsePositionOnEnter"
    :disabled="!settings.recordBrowsePosition"
    data-test="restore-browse-position"
    @update:model-value="settings.setRestoreBrowsePositionOnEnter"
  />
</section>
```

子开关 disabled 当父关——避免逻辑不一致。

### 5.3 i18n

zh-CN：

```ts
// settings.fileBrowser
title: '文件浏览器',
recordBrowsePosition: '记录瀑布流浏览位置',
recordBrowsePositionDesc: '在瀑布流视图滚动时自动记录最近浏览的图片。',
restoreBrowsePosition: '进入目录时自动跳转',
restoreBrowsePositionDesc: '关闭后只会记录，需要手动点击工具栏的「↶ 跳到上次」按钮。',
```

en-US：

```ts
title: 'File Browser',
recordBrowsePosition: 'Record masonry browse position',
recordBrowsePositionDesc: 'Automatically record the topmost visible image while scrolling in masonry view.',
restoreBrowsePosition: 'Auto-jump on directory enter',
restoreBrowsePositionDesc: 'When disabled, the position is still recorded but you must click the toolbar "↶ Jump to last" button manually.',
```

zh-CN `fileBrowser` namespace：

```ts
jumpToLast: '跳到上次',
noRecordedProgress: '当前目录未记录浏览位置',
```

en-US mirror：

```ts
jumpToLast: 'Jump to last',
noRecordedProgress: 'No recorded position in this directory',
```

### 5.4 设置驱动的运行时反应

Settings 开关是 reactive ref——composable 接 `enabled / autoRestoreOnMount` computed。Settings 改 → 立即生效，无需重启。

特殊：关闭 `recordBrowsePosition` 后，已记录的 progress 不删除——下次开启仍可跳。再次开启时**不会回填**未记录的中间浏览（设计取舍：避免上线就重写历史进度）。

## §6 测试覆盖

### 6.1 Rust 单测（`src-tauri/src/commands/progress.rs` 同文件测试模块）

| 用例 | 断言 |
|---|---|
| `save_progress` 带 image_name | 读回 `image_name == Some("x.jpg")` |
| `save_progress` 不带 image_name（旧调用兼容） | 读回 `image_name == None` |
| `save_progress` 重复调（UPSERT） | bookId 唯一，第二次 page/image_name 覆盖（顺手优化：save_progress 改为 ON CONFLICT DO UPDATE 替代现有 SELECT+INSERT/UPDATE） |
| `get_progress` 返回新字段 | shape 含 imageName |
| `mark_finished` 重置 | page=0, image_name=None, finished=1 |
| migration 010 跑后旧行 | image_name 默认 NULL |

### 6.2 前端单测

| 文件 | 用例 |
|---|---|
| `composables/useMasonryBrowsePosition.test.ts`（新） | debounce 300ms 触发写入；连续滚动只写一次（同图去重）；stop 清理 timer；start 触发 restoreAndScroll；autoRestoreOnMount=false 不调 restore；enabled=false 不写 |
| `stores/settings.test.ts`（扩展） | recordBrowsePosition / restoreBrowsePositionOnEnter 默认 true；setter 持久化到 getSetting mock；loadAll 从 DB 读 |
| `stores/reader.test.ts`（扩展） | emitChanged payload 含 imageName；saveProgress 收到 imageName |
| `views/ReaderView.test.ts`（扩展 4 用例） | imageName 命中走 imageName；imageName 不命中 fallback page；都缺失走 0；既有 `?at=` 优先 |
| `composables/useReaderActions.test.ts`（扩展） | readFromCurrentPath 路径：progress 有 → router.push `?at=`；progress 无 → noop |
| `stores/fileBrowser.test.ts`（扩展） | canReadNow：无选中 + hasBrowseProgress=true → true；无选中 + hasBrowseProgress=false → false |
| `views/Settings.test.ts`（扩展） | 新 section 渲染 + BooleanRow 点击调 setter |

### 6.3 E2E 手测（dev）

按以下 9 场景验证：

1. 进 vol02（masonry 视图）滚到第 50 张 → 等 300ms → DB 里 `progress.image_name = 'page-050.jpg'`
2. 退出 app → 重启 → 进 vol02 → 自动跳到 page-050
3. 点 toolbar「↶ 跳到上次」按钮 → 跳到 page-050
4. 顶栏「立即阅读」（不选中任何 entry）→ 进 reader，从 page-050 开始
5. Settings 关闭「自动跳转」→ 进 vol02 不跳，按钮仍可点
6. Settings 关闭「记录进度」→ 滚动不写 DB，进 masonry 无 progress（按钮 disabled）
7. reader 翻页 → progress.image_name 更新到当前 spread 首图；退出 reader 进 masonry 跳到刚翻到的图
8. 改名 vol02/page-050.jpg → page-049.jpg → 重启 → imageName 找不到 fallback page → 跳到 page 旧位置（验证 fallback 正确）
9. 跨源：local vol01 有 progress，smb vol01（同名）独立——不串

## §7 风险 & 边界

### 7.1 reader 恢复路径改动引入 regression

**等级：中**

ReaderView 恢复逻辑改 4 处优先级路径。潜在 regression：imageName 找不到时 fallback page，page 在新排序下指向的图未必是用户预期的——但这是"改名的预期"，非 regression。

缓解：4 个 fallback 场景全覆盖测试（§6.2 ReaderView.test.ts）。

### 7.2 跨卷继续阅读（find_next_volume）依赖 progress.page

**等级：低**

`reader.find_next_volume` 当前依赖 `progress.page` 找下一个目录。本次 reader 写入**双写** imageName + page，page 字段**保持现状不动**——find_next_volume 不需改。

### 7.3 瀑布流写入 IPC 频率

**等级：低**

300ms debounce + 同图去重 → 用户主动滚动时约 1 次/停顿。`saveProgress` 改为 UPSERT（§2.2.2 顺手优化）后单次 IPC ~5ms（SQLite 本地）。

### 7.4 bookId 跨源冲突

**等级：无**

`library.book_id` 是 INTEGER 主键，`create_book` UNIQUE 约束在 `(source_descriptor, absolute_path)`（`library.rs:133-139`）。跨源同路径 → 不同 bookId。`progress.book_id` 通过 library 反查拿 source。

### 7.5 旧行 image_name 为 NULL

**等级：无**

migration 010 后旧行 `image_name` 默认 NULL。ReaderView 恢复按 `imageName → page → 0` 优先级 fallback，旧行走 page 路径正常恢复。**无数据丢失**。

### 7.6 Settings 开关并存

**等级：低**

- 关闭 `recordBrowsePosition`：`useMasonryBrowsePosition.enabled=false` → `scheduleRecord` 不触发；`jumpToLast` 仍可用（progress 还在 DB 里）
- 关闭 `restoreBrowsePositionOnEnter`：进 masonry 不自动跳；toolbar 按钮仍可用

### 7.7 测试覆盖扩张

**等级：中**

8 个文件测试改动 + 1 个新 composable 测试。`ReaderView.test.ts` 4 个 fallback 用例是核心回归保护。

### 7.8 imageName 长度 / Unicode / 大小写敏感

**等级：无**

SQLite TEXT 列无长度限制（实际限 1GB）。`imageNames.indexOf` 严格区分大小写——与文件名匹配（NTFS 大小写不敏感，但 indexOf 区分——文件名从 listDirectory 来，字符串严格相等，OK）。

## §8 数据流图

参见设计稿（同 §8 内容，简化版）。

## §9 实施步骤

参见设计稿（同 §9 内容，writing-plans 阶段展开为可勾选任务列表）。