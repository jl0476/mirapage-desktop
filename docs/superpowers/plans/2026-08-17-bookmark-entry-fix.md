# 书签入口补齐与页码语义统一（实现记录）

> **面向 AI 代理的工作者：** 本文档为已实现功能的记录（初稿 plan 与实现偏差大，按实际实现重写）。日期：2026-08-17。

**目标：** 补齐书签添加入口（阅读器主菜单文案、阅读器右键、瀑布流/文件浏览器右键），修复书签跳转断链，统一书签页码语义为 canonical 图片索引。

**架构：** bookmark 表新增 `position_kind` 区分新旧语义（migration 015）；新写入统一 0-based canonical 图片索引；跳转经 `/reader/:bookId?bookmarkPage&bookmarkKind` 由 loader 折算定位。progress 语义不动（内部 0-based）。

**技术栈：** Vue 3、Pinia、Vitest、rusqlite migration、Tauri IPC。

---

## 实际实现（与初稿 plan 的差异已对齐）

### 1. 数据层（Rust）

- **migration 015**（`src-tauri/src/db/migrations.rs::apply_015_bookmark_position_kind`）：`ALTER TABLE bookmark ADD COLUMN position_kind TEXT NOT NULL DEFAULT 'spread'`。旧行按 legacy spread 索引解释；已知偏差：migration 015 之前 webtoon 模式创建的旧行实际是图片索引，被一刀切标 'spread'，恢复时多经一次 `spreads[n].start` 折算可能偏深（clamp 兜底，无模式记录无法无损区分，接受）。
- **`commands/bookmarks.rs`**：`BookmarkItem` 加 `position_kind` 字段 + `#[serde(rename_all = "camelCase")]`（**顺带修复基线隐性 bug**：原 derive 无 rename，序列化 snake_case 导致前端 `bookId/createdAt` 全 undefined）。`add_bookmark` 写死 `'image'`；`list_bookmarks` 返回该列。

### 2. 页码语义（核心约定）

- **存储**：`page` = 0-based canonical 图片索引。paged 模式写 `reader.spreads[currentSpreadIndex].start`，webtoon 写 `webtoonPageIndex`（两者同为图片索引，消除原 spread/image 混用）。
- **纯函数**（`src/lib/bookmarkPage.ts`）：`bookmarkPageForImage(imageNames, name)` 返回 0-based 索引或 null；`imageIndexForBookmark(position, kind, spreads)` 把存储位置折算为图片索引（legacy spread 取首图，负值钳 0）。
- **显示**：UI 一律 1-based。Bookmarks 列表 image kind 显示 `page + 1`；legacy spread 原样（当时语义即 spread 序号）。表单输入为 1-based，提交时 `-1`。

### 3. 跳转链（修复断链）

- 原 `Bookmarks.vue` 跳 `/reader?bookId&page` 是死链（路由实为 `/reader/:bookId` 且无人消费 query.page，预存在问题）。
- 现：`jumpTo` → `/reader/:bookId?bookmarkPage=N&bookmarkKind=image|spread`；`ReaderView` 解析 query（`/^\d+$/` 校验、kind 缺省 'image'）传入 loader。
- `useReaderBookLoader.LoadBookOptions` 增 `bookmarkPage/bookmarkPositionKind`：先经 `imageIndexForBookmark` 折算为图片索引，再 `spreadIndexForPage` 定位 paged 初始 spread；`restoreImageIndex`（webtoon 恢复链）直接钳位使用。优先级：`query.at`（图片名）> bookmarkPage > progress。
- 越界行为：webtoon 恢复钳位末图；paged 链 `spreadIndexForPage` 无匹配回首页（与 progress.page 链一致）。

### 4. 添加入口（3 个）

- **阅读器主菜单**（`ReaderMainMenu.vue`）：文案 `bookmarks.add` → `bookmarks.addBookmark`；新增 `bookId` prop，「打开书签」导航 `/bookmarks?bookId=`（打通列表入口——原来不带 bookId 恒显示"请先打开一本书"）。
- **阅读器右键菜单**（`ReaderContextMenu.vue`）：新增 `add-bookmark` 项，emit 给 ReaderView。
- **瀑布流/文件浏览器右键**（`RowContextMenu.vue` 图片单选 → `FileBrowser.onAddBookmarkFromCtx`）：`getBookStatus` 解析当前目录 library 行拿 bookId（拿不到 toast `bookmarks.openBookFirst`，不写脏数据）；页码按 `fb.sortedEntries` 当前生效排序过滤图片的 0-based 索引。
- **ReaderView.addCurrentBookmark** 统一收口（主菜单/右键共用），try/catch + log 防未捕获 rejection。

### 5. 测试

- `src/lib/bookmarkPage.test.ts`：纯函数 6 用例。
- `src/composables/useReaderBookLoader.test.ts`：+5 用例（image kind 直取 / double 模式 legacy spread 折算 / 越界两链各自行为 / query.at 优先级 / getProgress 不调用断言）；settings mock 改 getter 支持 double 模式。
- `src/views/Bookmarks.test.ts`（新建）：3 用例（列表显示 +1 / 表单 -1 / 跳转 query）。
- `src/components/reader/ReaderContextMenu.test.ts`、`RowContextMenu.test.ts`：入口 emit 断言。
- `src-tauri/src/db/migrations.rs`：migration 015 默认值断言 + 版本号断言 14→15 两处。

## 明确不做

- 不改 progress 语义（内部 0-based 不动）。
- 不做书签编辑/重命名/标签管理（用户明确不做编辑类）。
- 不做全局书签聚合页（仍以 `?bookId=` 单书上下文）。
- 不迁移旧 webtoon 书签行的 kind 标注（无模式记录，注释说明偏差即可）。
