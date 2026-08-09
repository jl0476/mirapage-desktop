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
    pub image_name: Option<String>,  // 新增：masonry 写入的锚点；旧行 NULL
    pub reader_mode: String,
    pub updated_at: i64,
    // 注：finished 不在 ProgressItem —— finished 仍走 list_progress_finished 独立接口
    //      （readStatus store 需要全量 finished map，单独 IPC 更高效）
    //      get_progress 不返回 finished，避免破坏现有 readStatus 流程
}
```

#### 2.2.2 `save_progress` 保留 finished 参数（不破坏 reader）

⚠️ **P0 修复**：现有 `save_progress(book_id, page, reader_mode, finished: Option<bool>)` 签名**追加** image_name 参数（放最后），**不删 finished 参数**。reader 翻末页的 `finished=Some(true)` 路径必须继续工作。

**SQL 设计**：用 **固定参数化** + `COALESCE / CASE WHEN`，**不再用 `format!` 拼接**：

```rust
#[tauri::command]
pub fn save_progress(
    db: tauri::State<crate::db::Db>,
    book_id: i64,
    page: i64,
    reader_mode: String,
    finished: Option<bool>,         // 现有（位置不动）
    image_name: Option<String>,     // 新增（最后）
) -> Result<(), String> {
    let conn = db.conn();
    let now = chrono_now();

    // 固定参数化 SQL：
    //   - INSERT: finished 用 COALESCE(?finished, 0)，image_name 直接绑 nullable
    //     （None → SQL NULL 而非空字符串，与设计承诺一致）
    //   - ON CONFLICT UPDATE: 用 CASE WHEN/CASE WHEN
    //     finished = CASE WHEN ?finished IS NULL THEN progress.finished ELSE ?finished END
    //     image_name = COALESCE(excluded.image_name, progress.image_name)
    //     （None 入参时保留旧值，Some(_) 覆盖）
    //
    // 5 个 bind 参数（?1..?5）：
    //   ?1=book_id  ?2=page  ?3=reader_mode  ?4=image_name  ?5=finished  ?6=updated_at

    let sql = "
        INSERT INTO progress (book_id, page, reader_mode, image_name, updated_at, finished)
        VALUES (?1, ?2, ?3, ?4, ?6, COALESCE(?5, 0))
        ON CONFLICT(book_id) DO UPDATE SET
            page = excluded.page,
            reader_mode = excluded.reader_mode,
            image_name = COALESCE(excluded.image_name, progress.image_name),
            updated_at = excluded.updated_at,
            finished = CASE WHEN ?5 IS NULL THEN progress.finished ELSE ?5 END
    ";

    // finished 在 tauri command 边界转 i64（None → NULL 不传值）
    let finished_param: Option<i64> = finished.map(|b| if b { 1 } else { 0 });

    conn.execute(
        sql,
        rusqlite::params![book_id, page, reader_mode, image_name, finished_param, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

**关键不变量**：
- reader 翻页调 `saveProgress(bookId, page, readerMode, finished?, undefined /* imageName */)` → image_name 列保留旧值（COALESCE）；finished 按入参更新（CASE WHEN）
- reader 翻末页 `saveProgress(bookId, page, readerMode, true, undefined)` → finished=1（Some(true)），image_name 不变
- masonry 滚动调 `saveProgress(bookId, page, 'single', undefined, imageName)` → image_name 更新；finished 保留旧值（CASE WHEN ?5 IS NULL → 旧 finished）
- masonry 写入**不能传 finished**——若误传 Some(false) 会把已读重置为未读，这是 P0 风险

⚠️ **前端 saveProgress 包装**：保持 finished 在 imageName 之前的参数顺序（兼容现有 reader 调用点），新增 imageName 作为最后一个参数。

⚠️ **completed test**：Rust 单测必须覆盖关键 4 组合：
1. `finished=Some(true), image_name=None`：行不存在 → INSERT finished=1 image_name=NULL；行存在 → UPSERT finished=1 image_name 保留
2. `finished=None, image_name=None`（reader 普通翻页）：finished 保留旧，image_name 保留旧
3. `finished=None, image_name=Some("x.jpg")`（masonry 滚动）：finished 保留旧，image_name=x.jpg
4. 重复 masonry 写入（finished 始终 None）：image_name 每次覆盖，finished 不被重置

#### 2.2.3 `get_progress` 返回新字段

```rust
#[tauri::command]
pub fn get_progress(
    db: tauri::State<crate::db::Db>,
    book_id: i64,
) -> Result<Option<ProgressItem>, String> {
    let conn = db.conn();
    let result = conn
        .query_row(
            "SELECT book_id, page, image_name, reader_mode, updated_at
             FROM progress WHERE book_id = ?1",
            rusqlite::params![book_id],
            |row| {
                Ok(ProgressItem {
                    book_id: row.get::<_, i64>(0)?,
                    page: row.get::<_, i64>(1)?,
                    image_name: row.get(2)?,           // 新增
                    reader_mode: row.get::<_, String>(3)?,
                    updated_at: row.get::<_, i64>(4)?,
                })
            },
        )
        .ok();
    Ok(result)
}
```

#### 2.2.4 `mark_finished` 不清 image_name

⚠️ **P0 修复**：`mark_finished(bookId, finished=true)` 是 reader 内"标完成"按钮——读者**已经读完**，写入 image_name 是冗余/可能错的（currentReadImageName 是 last spread 但不是末图）。**不动 image_name**。

```rust
// 现有 mark_finished 已不写 image_name —— 保留现状不动。
// 仅重置（reset）才需要清 image_name —— 新增 reset_progress 命令或在 mark_finished 加参数。
```

⚠️ **新决策**：要不要加 `reset_progress` 命令清 image_name？目前 `mark_finished(false)` 只清 finished 不清 page/image_name（现有逻辑）。**本版本不动 reset 行为**——重置时保留 image_name 作 fallback。这意味着 reset 后下次进 masonry 仍跳到原位置（这是设计取舍，等用户反馈再调整）。

如果用户希望 reset 清 image_name：在 `mark_finished(bookId, false)` 分支加 `image_name = NULL`。**本期不做，记入待办**。

### 2.3 前端 tauri.ts 改动

⚠️ **参数顺序保持向后兼容**：`saveProgress(bookId, page, readerMode, finished?, imageName?)`——新参数放最后。

```ts
// src/lib/tauri.ts

export interface ProgressItem {
  bookId: number;
  page: number;
  imageName: string | null;   // 新增
  readerMode: string;
  updatedAt: number;
  // 注：finished 字段不在 ProgressItem —— 仍走 listProgressFinished
}

export async function saveProgress(
  bookId: number,
  page: number,
  readerMode: string,
  finished?: boolean,         // 现有（保持位置）
  imageName?: string,         // 新增（最后）
): Promise<void> {
  return invoke<void>('save_progress', {
    bookId,
    page,
    readerMode,
    finished,
    imageName,
  });
}
```

**调用约定**：
- reader 翻页：`saveProgress(bookId, page, readerMode, finished?)` → 第 5 参 undefined（imageName 不变）
- reader 翻末页：`saveProgress(bookId, page, readerMode, true)` → imageName 不变（之前翻页已写过）
- masonry 滚动：`saveProgress(bookId, page, 'single' /* placeholder */, undefined, imageName)` → 第 4 参 undefined，**finished 不动**
- masonry 不能传 finished（即使是 undefined 也要明确）——TS 类型 `finished?: boolean` 强制调用者明确

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
  /** P1 修复：渲染用 entries（来自 displayedEntries，可能被搜索/隐藏已读过滤） */
  renderEntries: Ref<readonly MediaEntry[]>;
  /** P1 修复：page 计算用 canonicalImageNames（来自 fb.sortedEntries 过滤图片，不受 UI 过滤影响） */
  canonicalImageNames: ComputedRef<string[]>;
  /** layout map 来自 useMasonryLayout（基于 renderEntries） */
  layoutMap: ComputedRef<Map<string, { top: number; height: number }>>;
  scrollTop: Ref<number>;
  /** MasonryView.scrollToEntry：渐进校正版本（见 §4.2 P1 修复） */
  scrollToEntry: (imageName: string) => Promise<boolean>;
  /** settings 开关：自动跳转（不影响 lastBrowseProgress 查询） */
  autoRestoreOnMount: ComputedRef<boolean>;
  /** settings 开关：是否记录 */
  enabled: ComputedRef<boolean>;
}

export interface UseMasonryBrowsePositionReturn {
  start: () => Promise<void>;
  stop: () => void;
  jumpToLast: () => Promise<void>;
  /** 缓存 progress（不论 enabled/autoRestore，进入目录总是查一次） */
  lastBrowseProgress: ComputedRef<ProgressItem | null>;
  /** 是否有 imageName 可跳转 */
  hasRecordedProgress: ComputedRef<boolean>;
}
```

#### 3.2.2 实现要点

```ts
const DEBOUNCE_MS = 300;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let stopScrollWatch: (() => void) | null = null;
let stopEnabledWatch: (() => void) | null = null;
let activeStartSeq = 0;  // P2 修复：每次 start()/stop() 递增，await 后校验
const lastWrittenPath = ref<string | null>(null);
const lastBrowseProgress = ref<ProgressItem | null>(null);
/** P2 修复：bookId 按 source+absPath 缓存，in-flight 去重。 */
const bookIdCache = new Map<string, Promise<number | null>>();

/** P0 修复：顶部可见图算法。
 *  反例（之前）：`item.top <= scrollTop && item.top < bestTop` → 滚到任何位置都选 top 最小的图（即首图）。
 *  正解：
 *    1) 优先找与滚动基线相交（baseline 在图内）的图片 → 取 top 最大者（最接近基线上方的图）。
 *    2) 无相交项（基线落在图间空隙）→ 退而求其次：top <= scrollTop 中 top 最大者（同样最接近上方）。
 *    3) 仍无 → 退而求其次：top > scrollTop 中 top 最小者（视口内首图）。
 *    4) 全无 → null（layout 未就绪）。 */
const topmostImage = computed<MediaEntry | null>(() => {
  const scrollTop = params.scrollTop.value;
  const map = params.layoutMap.value;
  const entries = params.renderEntries.value;  // P1 修复：用渲染列表
  let intersectingBest: { path: string; top: number } | null = null;  // (1) 相交
  let aboveBest: { path: string; top: number } | null = null;          // (2) 仅上方
  let belowBest: { path: string; top: number } | null = null;          // (3) 仅下方
  for (const e of entries) {
    if (!isImage(e.name)) continue;
    const item = map.get(e.path);
    if (!item) continue;
    const baselineIn = item.top <= scrollTop && item.top + item.height > scrollTop;
    if (baselineIn) {
      if (!intersectingBest || item.top > intersectingBest.top) intersectingBest = { path: e.path, top: item.top };
    } else if (item.top <= scrollTop) {
      if (!aboveBest || item.top > aboveBest.top) aboveBest = { path: e.path, top: item.top };
    } else {
      if (!belowBest || item.top < belowBest.top) belowBest = { path: e.path, top: item.top };
    }
  }
  const pick = intersectingBest ?? aboveBest ?? belowBest;
  if (!pick) return null;
  return entries.find((e) => e.path === pick.path) ?? null;
});

/** P0 修复：page 必须用 canonicalImageNames（来自 fb.sortedEntries，未被 UI 过滤）的下标。
 *  这是与 ReaderView 完全一致的图片序列——reader 翻页用 canonical page。
 *  即使 masonry 视图过滤掉某些图，page 仍按全序列算。 */
const topmostPage = computed<number>(() => {
  const e = topmostImage.value;
  if (!e) return 0;
  return params.canonicalImageNames.value.indexOf(e.name);
});
```

⚠️ **`canonicalImageNames` 来源**（P1 修复）：不是从 `props.entries` 派生（`props.entries` 实际是 `displayedEntries`，受搜索/隐藏已读过滤）。改由 **父级 FileBrowser 传 `fb.sortedEntries`（未过滤的排序后列表）+ 过滤图片**：

```ts
// FileBrowser.vue 内
const canonicalImageNames = computed(() =>
  fb.sortedEntries.filter((e) => isImage(e.name)).map((e) => e.name)
);

// 传给 MasonryView 新的 prop
<MasonryView :canonical-image-names="canonicalImageNames" ... />
```

`fb.sortedEntries` 已含 `effectiveSortField / effectiveSortAscending`（per-folder override 自动 resolve，CLAUDE.md §3.0.2-reader-polish）——与 ReaderView 完全同源。

排序规则已在 fb.sortedEntries 内部封装，不再需要额外同步。

async function ensureBookIdForCurrentDir(): Promise<number | null> {
  const currentPath = params.currentPath.value;
  const descriptor = params.descriptor.value;
  const absPath = currentPath;

  // P2 修复：bookId 必须缓存 + in-flight 去重，且 RPC 期间校验目录
  const cacheKey = `${JSON.stringify(descriptor)}|${absPath}`;
  const cached = bookIdCache.get(cacheKey);
  if (cached) return cached;

  // 捕获请求时的目录快照（防止 RPC 期间目录切换污染）
  const pathAtRequest = absPath;
  const descAtRequest = JSON.parse(JSON.stringify(descriptor)) as SourceDescriptor;

  const promise = (async (): Promise<number | null> => {
    const cover = await enumerateCover(descAtRequest, pathAtRequest);
    const bookId = await createBook({
      title: pathAtRequest.split(/[\\/]/).filter(Boolean).pop() || pathAtRequest,
      sourceDescriptor: descAtRequest,
      absolutePath: pathAtRequest,
      sourceType: descAtRequest.type === 'local' ? 'Local' : capitalize(descAtRequest.type),
      favorite: false,
      ...cover,
    });
    // RPC 返回后校验仍是同一目录
    if (params.currentPath.value !== pathAtRequest) return null;
    return bookId;
  })();

  bookIdCache.set(cacheKey, promise);
  // 30s 后清理缓存（防堆积；用户在同一目录 30s 内持续滚动可复用）
  setTimeout(() => bookIdCache.delete(cacheKey), 30000);
  return promise;
}

async function recordCurrentTop(): Promise<void> {
  if (!params.enabled.value) return;
  const e = topmostImage.value;
  if (!e) return;
  if (e.path === lastWrittenPath.value) return;
  try {
    const bookId = await ensureBookIdForCurrentDir();
    if (bookId == null) return;
    // P2 修复：保存后校验当前 startSeq（与函数入口 seq 比对）
    const seqAtEntry = activeStartSeq;
    await saveProgress(
      bookId,
      topmostPage.value,
      'single',
      undefined,
      e.name,
    );
    if (seqAtEntry !== activeStartSeq) return;  // 已被新 start() 或 stop() 抢占，丢弃写入
    lastWrittenPath.value = e.path;
    lastBrowseProgress.value = {
      bookId,
      page: topmostPage.value,
      imageName: e.name,
      readerMode: 'single',
      updatedAt: Date.now(),
    };
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

/** 启用/禁用 scroll watcher（Settings.enabled 切换时调）。 */
function enableWatcher(): void {
  if (stopScrollWatch) return;  // 幂等
  stopScrollWatch = watch(
    () => [params.scrollTop.value, params.renderEntries.value.length] as const,
    () => scheduleRecord(),
  );
}
function disableWatcher(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (stopScrollWatch) { stopScrollWatch(); stopScrollWatch = null; }
}

async function restoreAndScroll(): Promise<void> {
  const seqAtEntry = activeStartSeq;
  try {
    const bookId = await ensureBookIdForCurrentDir();
    if (seqAtEntry !== activeStartSeq) return;  // P2 校验
    if (bookId == null) return;
    const progress = await getProgress(bookId);
    if (seqAtEntry !== activeStartSeq) return;  // P2 校验
    lastBrowseProgress.value = progress;
    if (!params.autoRestoreOnMount.value) return;
    if (!progress?.imageName) return;
    await params.scrollToEntry(progress.imageName);
  } catch (err) {
    log('[useMasonryBrowsePosition] restoreAndScroll failed', err);
  }
}

/** P1 修复：start() 幂等 + Settings.enabled 切换时 watcher 动态启停。
 *  P2 修复：每次 start() 递增 activeStartSeq，await 后校验。 */
async function start(): Promise<void> {
  activeStartSeq += 1;  // 抢占旧 start() / stop()
  // 关闭 debounce + 旧 watcher（start 幂等：允许重复调）
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (stopScrollWatch) { stopScrollWatch(); stopScrollWatch = null; }
  lastWrittenPath.value = null;

  // P1 修复：单独 watch enabled，运行时切换时注册/注销 watcher
  if (stopEnabledWatch) stopEnabledWatch();
  stopEnabledWatch = watch(
    () => params.enabled.value,
    (now) => { now ? enableWatcher() : disableWatcher(); },
    { immediate: true },  // 进入时立即同步
  );

  await restoreAndScroll();
}

/** stop() 销毁所有 watcher 并抢占 startSeq。 */
function stop(): void {
  activeStartSeq += 1;  // 抢占：在飞的 await 都失效
  disableWatcher();
  if (stopEnabledWatch) { stopEnabledWatch(); stopEnabledWatch = null; }
  lastWrittenPath.value = null;
  // lastBrowseProgress 不清 —— 关闭"记录进度"开关后仍可手动跳转
}

async function jumpToLast(): Promise<void> {
  const seqAtEntry = activeStartSeq;
  let progress = lastBrowseProgress.value;
  if (!progress) {
    try {
      const bookId = await ensureBookIdForCurrentDir();
      if (seqAtEntry !== activeStartSeq) return;
      if (bookId == null) return;
      progress = await getProgress(bookId);
      if (seqAtEntry !== activeStartSeq) return;
      lastBrowseProgress.value = progress;
    } catch (err) {
      log('[useMasonryBrowsePosition] jumpToLast failed', err);
      return;
    }
  }
  if (!progress?.imageName) return;
  await params.scrollToEntry(progress.imageName);
}

onBeforeUnmount(stop);

return {
  start,
  stop,
  jumpToLast,
  /** P1 修复：lastBrowseProgress 总是查询缓存（不论 enabled/autoRestore）。 */
  lastBrowseProgress: computed(() => lastBrowseProgress.value),
  /** 是否有 imageName 可跳转（FileBrowser canReadNow 用）。 */
  hasRecordedProgress: computed(() => !!lastBrowseProgress.value?.imageName),
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
| 目录切换 | §3.4 composable 内部 watch descriptor/currentPath → stop()+start() 重新初始化 |
| 目录无图片 | masonry 不渲染，composable 不挂载（已知 fallback） |
| 空进度（用户未浏览过） | `saveProgress` 静默成功；`lastBrowseProgress.value = null`；按钮 disabled |
| 重复写入（同一图持续可见） | `lastWrittenPath` 去重，不重复 IPC |
| `enabled.value === false` | `scheduleRecord` 不触发；`lastBrowseProgress` **仍查询**（手动按钮可用）；`jumpToLast` 仍可用 |
| `autoRestoreOnMount === false` | `lastBrowseProgress` **仍查询**；`scrollToEntry` 不调 |
| 滚动跨多个图（快滚） | debounce 保证只写最后一个顶部可见图 |
| 异步目录切换竞态 | ensureBookId 捕获 pathAtRequest 快照；RPC 返回校验 currentPath |
| `getProgress` / `saveProgress` IPC 失败 | 静默吞（容错，不影响 UX） |

### 3.4 composable 挂载位置与目录切换

⚠️ **P1 修复**：组件层级是 `FileBrowser → FileList → MasonryView`，**FileBrowser 加 key 控制不到 MasonryView**。正确的做法有两种：

**做法 A（推荐）**：在 MasonryView 内部显式 watch `descriptor / currentPath` 变化 → `stop() + start()` 重置。

```ts
// MasonryView.vue 内
watch(
  () => [props.descriptor, props.currentPath] as const,
  () => {
    browsePosition.stop();
    void browsePosition.start();
  },
);
```

**做法 B**：在 FileList.vue 的 `<MasonryView>` 加 `:key="`${descriptorKey}|${currentPath}`"` —— key 化能让 Vue 卸载+重建实例，强制成对 start/stop；但同时也会重建 useMasonryThumbnails 队列，浪费（缩略图状态会清）。

**本版本选做法 A**：
- 缩略图状态保留（用户切回目录不重排）
- composable 显式控制生命周期，可读性好
- 与 `useMasonryThumbnails` 现有的 watch `[descriptor, colWidth, dpr, quality]` 模式一致（bumpEpoch）

⚠️ **start() 重复调用保护**：`restoreAndScroll` 内部 `lastBrowseProgress = await getProgress(...)` 是异步——如果 start() 被快速重复调用（用户狂点目录），可能出现 race condition。**保护**：
```ts
let startSeq = 0;
async function start() {
  const seq = ++startSeq;
  // ... async work ...
  if (seq !== startSeq) return;  // 已被新调用覆盖，丢弃旧结果
}
```

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

### 4.2 进 masonry 自动跳转（MasonryView.scrollToEntry 实现）

⚠️ **P1 修复**：现有 `useVirtualList.scrollToPath` 是固定行高虚拟列表的方法，**MasonryView 没有 scrollToPath expose**；layout map 首次就有所有条目（基于估算尺寸），但**位置仍会随测量批次到达而漂移**——不能"等 layout 收敛"然后跳一次了事。

**新设计语义：「立即跳估算位置 + 渐进校正」**：

```ts
// MasonryView.vue 内新增
async function scrollToEntry(imageName: string): Promise<boolean> {
  const target = props.entries.find((e) => e.name === imageName);
  if (!target) {
    log('[MasonryView] scrollToEntry: imageName not in current entries (filter?)', imageName);
    return false;
  }
  // 等目标进入 layout map（layout 必然含所有 entries，最多等 200ms）
  let item: MasonryItem | undefined;
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    item = layout.value.map.get(target.path);
    if (item) break;
    await nextTick();
  }
  if (!item) {
    log('[MasonryView] scrollToEntry: layout map missing after timeout', imageName);
    return false;
  }
  if (containerRef.value) containerRef.value.scrollTop = item.top;

  // 渐进校正：每次 measuredMap 更新都重新对齐锚点（最多 3s 或 5 批）
  const targetPath = target.path;
  let corrections = 0;
  const stop = watch(
    () => measuredMap.value.get(targetPath),
    () => {
      if (corrections >= 5) return;
      const updated = layout.value.map.get(targetPath);
      if (updated && containerRef.value) {
        containerRef.value.scrollTop = updated.top;
        corrections += 1;
      }
    },
    { flush: 'post' },
  );
  setTimeout(() => stop(), 3000);
  log('[MasonryView] scrollToEntry: jumped + started anchor correction', imageName);
  return true;
}
```

**目标图片被 UI 过滤掉时（搜索/隐藏已读）的决策**：用户开启过滤后，目标图不在 `props.entries` 里 → `scrollToEntry` 返回 false → 不自动恢复，按钮仍可点（用户清除过滤后手动跳）。**不做临时取消过滤跳转**（会破坏用户的过滤状态，违反 §1.5 选择）。

`MasonryView.defineExpose` 加 `scrollToEntry`，通过 composable params 暴露给 useMasonryBrowsePosition。

### 4.3 顶栏「立即阅读」按钮无选中走 progress

#### 4.3.1 FileBrowser.vue::canReadNow

```ts
const canReadNow = computed(() => {
  const e = selectedEntry.value;
  if (e) return e.isDirectory === true || isImage(e.name);
  // 未选中：当前 masonry 目录有 progress 记录 → 启用
  // P1 修复：用 lastBrowseProgress（不论 enabled/autoRestore 总是查询缓存），不再绑 recordCurrentTop 翻转
  return masonryLastBrowseProgress.value?.imageName != null;
});
```

`masonryLastBrowseProgress` 由 FileList 转发 MasonryView 暴露的 `browsePosition.lastBrowseProgress`（composable 返回值）。

#### 4.3.2 FileBrowser.vue::onReadNowClick

```ts
function onReadNowClick() {
  const e = selectedEntry.value;
  if (e) {
    if (e.isDirectory) void readerActions.readNow(e);
    else void readerActions.readFromImage(e);
    return;
  }
  // 未选中 + 当前目录：走 progress（传缓存避免 IPC）
  void readerActions.readFromCurrentPath({
    cachedProgress: masonryLastBrowseProgress.value,
  });
}
```

#### 4.3.3 useReaderActions.ts::readFromCurrentPath（新增）

⚠️ **P0 修复**：之前的伪代码把函数参数命名为 `opts`，与外层 `useReaderActions` 的 `opts`（ReaderActionsOptions 接口）冲突，类型过不了。同时 `saveNavigationContext` 是无参回调，不接 4 参数。

**修正**：readFromCurrentPath 接 `{ cachedProgress }`，其他依赖继续从外层 `opts` 取。

```ts
// useReaderActions.ts 内（与 readNow / readFromImage 同 scope）
async function readFromCurrentPath(
  args: { cachedProgress?: ProgressItem | null } = {},
): Promise<void> {
  log('[useReaderActions] readFromCurrentPath called');
  // 根目录作为图片目录时 currentPath === '' 也允许（不 abort）
  const rootPath = opts.resolveRootPath();
  const currentPath = opts.getCurrentPath?.() ?? '';
  // currentPath === '' 是合法的（用户选了 rootPath 本身作为图片目录），不 abort
  // 仅在 opts 完全没提供 getCurrentPath 时降级到 rootPath
  const descriptor = opts.buildSourceDescriptor(rootPath);

  // 优先缓存，避免重复 getProgress IPC
  let progress = args.cachedProgress ?? null;
  if (!progress?.imageName) {
    // 缓存空 → 走 IPC 兜底（复用 readNow 同样的 ensureBookId 路径）
    const dirName = currentPath.split(/[\\/]/).filter(Boolean).pop() || rootPath.split(/[\\/]/).filter(Boolean).pop() || 'root';
    const dirEntry: MediaEntry = {
      name: dirName, path: '', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0,
    };
    const { bookId } = await ensureBookId(dirEntry, /*favorite=*/false);
    if (bookId === null) {
      log('[useReaderActions] readFromCurrentPath: bookId null, abort');
      return;
    }
    progress = await getProgress(bookId);
  }
  if (!progress?.imageName) {
    log('[useReaderActions] readFromCurrentPath: no progress.imageName, abort');
    return;
  }
  // saveNavigationContext 是无参回调（opts.saveNavigationContext?: () => void）
  try {
    opts.saveNavigationContext?.();
  } catch (e) {
    log('[useReaderActions] readFromCurrentPath: saveNavigationContext failed (容错)', e);
  }
  await router!.push({
    name: 'reader',
    params: { bookId: String(progress.bookId) },
    query: { at: encodeURIComponent(progress.imageName) },
  });
}
```

**根目录支持**：当 rootPath 本身就是图片目录（currentPath === ''），`readFromCurrentPath` 仍工作——`ensureBookId` 接受 entry.path === '' 时 absPath = currentPath = ''，`createBook` 用 rootPath.basename 作 title，IPC 路径正确。

`router` 注入：useReaderActions 顶部已有 `let router: Router | null; try { router = useRouter() ?? null; } catch ...; if (!router && opts.router) router = opts.router;`（line 63-69）——复用 `router!`。

### 4.4 手动跳转按钮（toolbar）

FileBrowser.vue toolbar：

```vue
<button
  v-if="viewMode === 'masonry'"
  type="button"
  class="tb-btn"
  :disabled="!masonryLastBrowseProgress?.imageName"
  :title="masonryLastBrowseProgress?.imageName ? t('fileBrowser.jumpToLast') : t('fileBrowser.noRecordedProgress')"
  data-test="btn-jump-to-last"
  @click="onJumpToLastClick"
>
  <svg ...>{{ ICON_REWIND_TO_LAST }}</svg>
</button>
```

按钮 enable 条件：`masonryLastBrowseProgress?.imageName != null`（不论 enabled/autoRestore 开关）。

`onJumpToLastClick`：
```ts
function onJumpToLastClick() {
  fileListRef.value?.masonryJumpToLast();  // 转发到 MasonryView
}
```

`FileList.vue::defineExpose` 加 `masonryJumpToLast` 和 `masonryLastBrowseProgress`：
```ts
const masonryLastBrowseProgress = ref<ProgressItem | null>(null);

// onMounted 时由 FileList 监听 MasonryView 暴露的 ref（FileList 是中间层）
watch(
  () => masonryRef.value?.browsePosition?.lastBrowseProgress?.value ?? null,
  (v) => { masonryLastBrowseProgress.value = v; },
);

async function masonryJumpToLast(): Promise<void> {
  await masonryRef.value?.jumpToLast();
}

defineExpose({
  // ...existing
  masonryJumpToLast,
  masonryLastBrowseProgress: computed(() => masonryLastBrowseProgress.value),
});
```

`MasonryView.vue::defineExpose` 加 `jumpToLast` + `browsePosition`：
```ts
defineExpose({
  regenerate: regenerateThumbnail,
  regenerateBatch: regenerateBatchFn,
  retry: retryThumbnail,
  retryBatch: retryBatchFn,
  jumpToLast: () => browsePosition.jumpToLast(),  // 新增
  browsePosition,                                   // 新增：暴露 composable 整体
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
| `save_progress` 重复调（UPSERT） | bookId 唯一，第二次 page/image_name/finished 按入参更新（现有 save_progress 已是 UPSERT 模式 progress.rs:64-99，本版本扩展 image_name 分支处理） |
| `get_progress` 返回新字段 | shape 含 imageName |
| `mark_finished` 不动 image_name | page=0（保持），image_name 保留，finished=1 |
| migration 010 跑后旧行 | image_name 默认 NULL |

### 6.2 前端单测

| 文件 | 用例 |
|---|---|
| `composables/useMasonryBrowsePosition.test.ts`（新） | debounce 300ms 触发写入；连续滚动只写一次（同图去重）；stop 清理 timer；start 触发 restoreAndScroll + 查 lastBrowseProgress；autoRestoreOnMount=false 不调 scrollToEntry；enabled=false 不写但 lastBrowseProgress 仍查；目录切换 stop+start 重新初始化；startSeq 保护（重复 start 只生效最后一次） |
| `composables/useMasonryBrowsePosition.test.ts`（扩展） | **文件夹混排**：entries 含 `vol01/(dir)` `vol02/(dir)`，topmostImage 不返回文件夹；**搜索过滤**：displayedEntries 过滤后 topmostImage 仍走 layout map 找图片；**隐藏已读**：filterByHideFinished 过滤后顶部图计算正确；**异步目录切换**：start() 中途切目录，await 后旧返回值被丢弃；**关闭自动跳转但手动跳转**：autoRestoreOnMount=false，jumpToLast() 仍可用 |
| `views/MasonryView.test.ts`（新） | `scrollToEntry(imageName)`：目标存在 → scrollTop=item.top；目标不存在 → 返回 false；layout 收敛前等待 → nextTick 循环 |
| `stores/settings.test.ts`（扩展） | recordBrowsePosition / restoreBrowsePositionOnEnter 默认 true；setter 持久化到 getSetting mock；loadAll 从 DB 读 |
| `stores/reader.test.ts`（扩展） | emitChanged payload 含 imageName；saveProgress 收到 imageName |
| `views/ReaderView.test.ts`（扩展 4 用例） | imageName 命中走 imageName；imageName 不命中 fallback page；都缺失走 0；既有 `?at=` 优先 |
| `composables/useReaderActions.test.ts`（扩展） | readFromCurrentPath：cachedProgress 命中不走 IPC；cachedProgress 空 → 走 IPC 兜底；progress 无 → noop |
| `stores/fileBrowser.test.ts`（扩展） | canReadNow：无选中 + lastBrowseProgress.imageName != null → true；无选中 + null → false |
| `views/Settings.test.ts`（扩展） | 新 section 渲染 + BooleanRow 点击调 setter |

### 6.3 E2E 手测（dev）

按以下 13 场景验证：

**基础流程**
1. 进 vol02（masonry 视图）滚到第 50 张 → 等 300ms → DB 里 `progress.image_name = 'page-050.jpg'`
2. 退出 app → 重启 → 进 vol02 → 自动跳到 page-050
3. 点 toolbar「↶ 跳到上次」按钮 → 跳到 page-050
4. 顶栏「立即阅读」（不选中任何 entry）→ 进 reader，从 page-050 开始
5. Settings 关闭「自动跳转」→ 进 vol02 不跳，按钮仍可点
6. Settings 关闭「记录进度」→ 滚动不写 DB；已存在的 progress 仍可手动跳（验证 lastBrowseProgress 缓存）
7. reader 翻页 → progress.image_name 更新到当前 spread 首图；退出 reader 进 masonry 跳到刚翻到的图
8. 改名 vol02/page-050.jpg → page-049.jpg → 重启 → imageName 找不到 fallback page → 跳到 page 旧位置（验证 fallback 正确）
9. 跨源：local vol01 有 progress，smb vol01（同名）独立——不串

**鲁棒性场景**（按用户要求新增）
10. **文件夹混排**：vol02 根目录含子目录 `sub1/`, `sub2/` + 30 张图，滚到第 25 张 → topmostImage 应是图（不是 sub1）；page 应是 imageNames 数组下标（非 entries 下标）
11. **搜索过滤**：masonry 工具栏搜 "page-0" → 列表过滤 → 顶部可见图 = "page-005" → progress.imageName 写入 "page-005"，page = imageNames.indexOf("page-005")（不被搜索过滤影响）
12. **隐藏已读**：开启「隐藏已读」过滤，列表只剩未读图 → 顶部可见图 = 未读图 → progress 写入正确
13. **异步目录切换**：进 vol02 → 立刻切到 vol03 → 旧 start() 的 ensureBookId/restoreAndScroll 返回后被 startSeq 校验丢弃，不污染 vol03 state

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

300ms debounce + 同图去重 → 用户主动滚动时约 1 次/停顿。`save_progress` 已是 UPSERT（progress.rs:64-99 现有），单次 IPC ~5ms（SQLite 本地）。

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

### 7.9 mark_finished / reset 不清 image_name 的设计取舍

**等级：低**

本版本 `mark_finished(bookId, finished=false)` **不**清 image_name——用户重置后下次进 masonry 仍跳到原位置（imageName 在）。

**取舍**：用户重置意味着"我不想再被这个位置打断"，但 imageName 跳回首图后下一次滚动又会写同一个 imageName（如果还是首图）→ 死循环式重置失效。

**P2 待办**（记入 backlog，不在本版本做）：让 `mark_finished(false)` 同时清 `image_name = NULL`。本期不做，等用户反馈决定。

### 7.10 顺手扩展的 4 分支 SQL 复杂度

**等级：低**

§2.2.2 的 SQL 用 `format!` 拼接 finished_set / image_name_set 字符串——增加 SQL 注入风险点（虽然参数都是 Option<bool> / Option<String> 类型安全）。

**缓解**：`finished_set` 是编译期字符串字面量（"1"/"0"/"finished"），无注入；`image_name_set` 同上（"excluded.image_name" / "image_name"）。

## §8 数据流图

参见设计稿（同 §8 内容，简化版）。

## §9 实施步骤

参见设计稿（同 §9 内容，writing-plans 阶段展开为可勾选任务列表）。

## §10 规格自检（修稿后 v3）

1. **占位符扫描**：未发现 "TODO / 待定"
2. **内部一致性**：
   - §2.2.2 SQL 固定参数化与 §6.1 测试用例匹配
   - §3.2.2 ensureBookId 缓存 + §4.3.3 readFromCurrentPath 优先缓存：避免重复 IPC 一致
   - §3.4 显式 watch descriptor/currentPath + §3.2.2 activeStartSeq 抢占：start/stop/restoreAndScroll/jumpToLast/recordCurrentTop 全部 await 后校验
   - §4.2 scrollToEntry 「立即跳估算 + 渐进校正」语义
3. **范围检查**：14 步实施，可由单个 plan 覆盖
4. **模糊性检查**：
   - "顶部可见图"：3 级优先级（相交 > 上方 > 下方）取最接近滚动基线的图片（非文件夹）
   - "page"：canonicalImageNames 数组下标（fb.sortedEntries 过滤图片）
   - "imageName 找不到"：`indexOf === -1`（ReaderView 走 page fallback）
   - "fallback page"：spreadIndexForPage(progress.page)
5. **P0/P1/P2 用户反馈覆盖**：
   - ✅ P0 顶部锚点算法 3 级优先级（相交 → 上方 → 下方）
   - ✅ P0 save_progress SQL 固定参数化 + COALESCE/CASE WHEN，无 format!
   - ✅ P0 readFromCurrentPath 类型修正（参数名为 args，外层 opts 不冲突）
   - ✅ P1 imageNames 改 canonicalImageNames（来自 fb.sortedEntries，不受 UI 过滤）
   - ✅ P1 scrollToEntry 「立即跳估算 + 渐进校正」+ 过滤态决策（不过滤掉目标）
   - ✅ P1 Settings 运行时切换：start() 内 watch enabled 动态注册/注销 watcher
   - ✅ P2 startSeq 整合进所有 await 后校验 + stop() 递增抢占
   - ✅ 根目录 currentPath=''：readFromCurrentPath 不再 abort；dirName fallback 到 rootPath.basename
6. **用户额外要求覆盖**：
   - ✅ 文件夹混排 / 搜索过滤 / 隐藏已读 / 异步目录切换 / 关闭自动跳转但手动跳转（§6.2 + §6.3）

## §11 v3 修订摘要

| # | 问题 | 修复 |
|---|---|---|
| 1 | topmostImage 反选首图 | 3 级优先级：相交 > 上方 > 下方 |
| 2 | save_progress SQL 首次失败 | 固定参数化 + COALESCE/CASE WHEN，无 format! |
| 3 | readFromCurrentPath 类型错 | 参数 args，外层 opts 不冲突 |
| 4 | imageNames 受 UI 过滤 | 改 canonicalImageNames 来自 fb.sortedEntries |
| 5 | scrollToEntry 不收敛 | 改「立即跳估算 + 渐进校正」 |
| 6 | Settings 运行时切换不生效 | start() 内 watch enabled 动态启停 |
| 7 | startSeq 未整合 | activeStartSeq 在所有 await 后校验 |
| 8 | 根目录 currentPath='' | readFromCurrentPath 不再 abort；dirName fallback 到 rootPath.basename |