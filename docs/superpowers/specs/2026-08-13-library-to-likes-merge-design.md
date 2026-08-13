# Library → Likes 合并设计

- **日期**: 2026-08-13
- **模块**: v0.1.0-module3.0.7-likes-merge
- **状态**: 设计中
- **相关代码**: `src/views/{Library,Likes}.vue` / `src/stores/{library,likes}.ts` / `src-tauri/src/commands/{library,likes}.rs` / `src-tauri/src/db/migrations.rs`

---

## 1. 背景与动机

桌面端当前存在**两套并行的"收藏"机制**,语义重叠、数据割裂、视图读错表。审计后发现:

### 1.1 三层语义表(实测代码 + 实测 DB 后理清)

| 维度 | `library` 表(`book` 重命名) | `browse_history` 表 | `like` 表 |
|---|---|---|---|
| schema | 001 就有 `is_favorite` 字段 | folder-level,001 + 004 重写 | 独立表 `(book_id, liked_at)`,001 |
| 写入触发 | 阅读时 / 瀑布流浏览目录(`createBook`,默认 `is_favorite=0`) | 阅读 + 进目录浏览 | **只** Reader 主菜单 ❤️(`toggle_like`) |
| 命令 | `list_library`(`WHERE is_favorite=1`)/ `set_favorite` / `create_book` / `get_book` | `record_history` / `list_history` | `list_likes` / `toggle_like` |
| 前端 store | `useLibraryStore`(被 4 处消费) | `useHistoryStore` | `useLikesStore`(**零视图消费**) |
| 实测行数 | 2 行(均 `is_favorite=0`) | 2 行 | **0 行** |

### 1.2 视图层错位

- **Library.vue** 显示 `library WHERE is_favorite=1`,行内 ⭐ toggle 调 `setFavorite` ✓ 自洽
- **Likes.vue** 名义叫"喜欢",却 `import useLibraryStore` + `items.filter(b => b.isFavorite)` —— **完全不读 `like` 表**,等于 Library 的二次过滤视图,无独立价值
- **ReaderView `is-liked`** 绑 `book.isFavorite`(读 library),但 ❤️ 点击调 `toggleLike`(写 like 表)—— **数据源不一致**,toggleLike 后主菜单 ❤️ 不刷,Likes 页不显示

### 1.3 `like` 表是死表

实测 0 行,前端 Likes 页不读,后端 `useLikesStore` 零视图消费。`like` 表 + `likes.rs` + `useLikesStore` + `LikeItem` 整套是为了对称而对称的孤儿。

### 1.4 "书库"中文歧义

"书库"听起来像"所有书的集合",但 Library.vue 只显示 `is_favorite=1` 子集。已读的书(`is_favorite=0` 隐式 import)进不去 Library 页,用户看到空列表会困惑。"喜欢"语义明确,跟 ❤️ 心智一致。

### 1.5 图标已经走 ❤️

SideNav `/likes` 项、Reader 主菜单 ❤️ 按钮、空状态图标都是心形。只有 Library.vue 内部 toggle 是 ⭐ —— 分裂状态。

---

## 2. 目标 / 非目标

### 目标

1. 删除冗余的 `like` 表 + 整套 `likes` 后端/前端/store/IPC
2. 视图层"去掉书库,改为喜欢":删 Library 视图,重写 Likes 视图读 `library.is_favorite`
3. 修 Reader 主菜单 ❤️ 的数据源不一致 bug(toggleLike → setFavorite)
4. 文案全入口统一为"喜欢"(FileBrowser / EntryDetailPanel / RowContextMenu / Reader)
5. migration 011 数据合并 + 干净 DROP `like` 表(不丢用户数据)
6. 不影响任何其他功能(History / Shortcuts / Bookmarks 业务逻辑 / FileBrowser 业务逻辑 / Android 备份互导)

### 非目标

- **不**改 `library` 表 schema(001~008 全部保留,Android LibraryEntity 对齐)
- **不**改 `useReaderActions.ts::addToLibrary` 函数(逻辑不变,只是文案改)
- **不**改 `useLibraryStore` API(items / favorites / sorted / refresh / toggleFavorite 全保留)
- **不**改 RowContextMenu `onResetProgress` 的预存在 bug(见 §10)
- **不**做"已喜欢"按钮状态联动(FileBrowser 入口仍单向 `setFavorite(true)`,不查当前是否已喜欢)
- **不**假设所有 profile 的 `like` 表都 0 行(已发布 4 个 release tag,任何下载安装的用户都有自己的 DB;migration 011 先 UPDATE 合并再 DROP,见 §4.3)

---

## 3. 核心决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| 数据源 | 保留 `library.is_favorite` 字段 | Android 对齐;migration 不动;`library` 表是 progress 持久化的支撑表 |
| `like` 表处理 | migration 011 先 UPDATE 合并到 `library.is_favorite=1`,再 DROP | 工程实践:破坏性升级尽量保留数据;已发布 4 个 release tag,不能假设所有 profile 0 行;`like.book_id` 必有对应 `library.id`(toggle_like 调用点守 `book?.id != null`,book.id 来自 get_book 查 library 表),UPDATE 无丢失风险 |
| Library 视图 | 整个删 | "书库"概念被"喜欢"取代 |
| Likes 视图 | 重写,读 `useLibraryStore.favorites` | store 已有 computed,白送;数据源跟 Library 同表 |
| 行内 toggle | 保留 ❤️ toggle(用户拍板) | 跟原 Library ⭐ toggle 一致,只是图标换 |
| Reader 主菜单按钮 | 删"加入书库"按钮,保留 ❤️ toggle | 两者职责重叠(都 setFavorite),合并为单一入口 |
| ❤️ toggle 实现 | 改调 `setFavorite(book.id, !book.isFavorite)` | 顺手修数据源不一致 bug |
| FileBrowser 入口文案 | 全部统一"喜欢" | 避免"加入书库"vs"喜欢"认知割裂 |
| i18n 文案源 | 复用 `reader.like`(已存在) | 符合 §2.1 key 语义化,删 2 个孤儿 key |
| SideNav 顺序 | likes 提到 library 原位置(第 3 位) | 保持视觉位置,用户肌肉记忆不乱 |
| Reader 主菜单"加入书库"按钮文案 | `喜欢` / `取消喜欢` | 用户拍板,跟 ❤️ 一致 |

---

## 4. §1 数据层

### 4.1 保留(不动)

- `library` 表 schema + migration 001~008
- 所有 `commands::library` 命令(`list_library` / `set_favorite` / `create_book` / `get_book`)
- `useLibraryStore`(逻辑 + API 全保留,只是消费方变化)

### 4.2 删除

| 文件 | 内容 |
|---|---|
| `src-tauri/src/commands/likes.rs` | 整个文件(`list_likes` / `toggle_like` / `LikeItem`) |
| `src-tauri/src/commands/mod.rs` | 删 `pub mod likes;`(否则 Rust 编译失败 — 模块声明指向已删文件) |
| `src-tauri/src/lib.rs::generate_handler!` | 移除两条注册:`commands::likes::list_likes` + `commands::likes::toggle_like` |
| `src/lib/tauri.ts` | 删 `listLikes` / `toggleLike` 函数 + `LikeItem` 类型导出 |
| `src/stores/likes.ts` | 整个文件 |
| `src/stores/likes.test.ts` | 整个文件 |

### 4.3 migration 011 — 数据合并 + DROP

下一个可用版本号是 **011**(009 = thumbnail_cache,010 = progress_image_name 已占用,代码审查 P0 反馈)。

```rust
fn apply_011_drop_like_table(conn: &Connection) -> anyhow::Result<()> {
    // 工程实践:破坏性升级先合并数据再 DROP。
    // like.book_id 必有对应 library.id(toggle_like 调用点 ReaderView:638
    // 守 `book?.id != null`,book.id 来自 get_book 查 library 表),
    // 所以 IN 子查询无丢失风险 — 任何 like 行都能在 library 找到对应 row。
    conn.execute_batch(
        r#"
        UPDATE library
           SET is_favorite = 1
         WHERE id IN (SELECT book_id FROM `like`)
           AND is_favorite = 0;

        DROP TABLE IF EXISTS `like`;
        "#,
    )?;
    Ok(())
}
```

挂到 `apply_migrations` 版本序列末尾,版本号 11。`MAX(version)` 守门自动跳过已应用。

**migration 测试**(`migrations.rs` 末尾测试块):
- 现有 `assert_eq!(v, 10, ...)` 改为 `assert_eq!(v, 11, ...)`
- 新增测试:apply_011 后 `sqlite_master` 查无 `like` 表
- 新增测试:apply_011 前插入 `(library.id=42, is_favorite=0)` + `like(book_id=42)`,apply_011 后 `library.id=42` 的 `is_favorite=1`(数据合并验证)

---

## 5. §2 视图层

### 5.1 Library.vue — 整个删

无复用价值(逻辑迁 Likes.vue)。

### 5.2 Likes.vue — 重写

视觉布局**照搬** Library.vue,改 3 处:

| 元素 | 原 Library.vue | 新 Likes.vue |
|---|---|---|
| 页面标题 | `t('library.title')` = "书库" | `t('likes.title')` = "喜欢" |
| 行内 toggle 图标 | ⭐ star filled/outline | ❤️ heart filled/outline |
| toggle 调用 | `library.toggleFavorite(book.id)` | 同上(store 不变) |

数据源:
- 原 Likes.vue(错): `storeToRefs(library).items.filter(b => b.isFavorite)`
- 新 Likes.vue: `storeToRefs(library).favorites`(store 第 16 行 computed,等价于上面但语义明确)

行内 toggle 取消喜欢 → `library.toggleFavorite(book.id)` → store 第 36 行 `items.value.map(b => ... isFavorite: false)` → `favorites` computed 自动 filter 掉 → **行消失**(符合心智:取消喜欢 = 从 Likes 页移除)。

**"打开阅读器"链接**(代码审查 P2 反馈):必须用命名路由 + params,不能用 query。
```diff
- <!-- 当前 Likes.vue(错): query 形式,路由匹配失败 -->
- <RouterLink :to="{ path: '/reader', query: { bookId: book.id } }">
+ <!-- 新 Likes.vue(对): 命名路由 + params,跟 Library.vue / 路由契约 /reader/:bookId 一致 -->
+ <RouterLink :to="{ name: 'reader', params: { bookId: book.id } }">
```
路由契约是 `/reader/:bookId`(`router/index.ts:49`),query 形式会匹配不到。Library.vue 原本就是 params 形式,"照搬"已隐含正确,此处明确写出避免实施时照搬错版本。

### 5.3 router/index.ts

```diff
- {
-   path: '/library',
-   name: 'library',
-   component: () => import('@/views/Library.vue'),
- },
+ // 兼容旧链接:升级前用户可能保留 /library 的状态(dev hot reload、调试、未来 deep-link)
+ // 重定向到 /likes,而不是 404(代码审查 P2 反馈)
+ {
+   path: '/library',
+   redirect: '/likes',
+ },
```

`/likes` 路由保留,不动。`/library` 改为 **redirect 到 `/likes`**(不是直接删),兼容性更好 —— 桌面应用虽不像 web 有"用户收藏 URL",但开发态 hot reload / 调试 / 未来若加 deep-link 都可能落到 /library,有兜底比 404 友好。代价仅 4 行 router 配置 + 1 条测试。

### 5.4 SideNav.vue

`items` 数组删 library 项,likes 项**移到第 3 位**(原 library 位置)。结果:

```
/          (文件浏览器)
/shortcuts (快捷方式)
/likes     (喜欢)      ← 提到原 library 位置
/bookmarks (书签)
/history   (阅览记录)
/accounts  (账号)
/settings  (设置)
```

### 5.5 Bookmarks.vue

第 57 行 backlink `to="/library"` → `to="/likes"`。

---

## 6. §3 Reader 主菜单 + 接线 + bug 修复

### 6.1 ReaderMainMenu.vue

- 删 `NAV_ITEMS` 数组中 `{ path: '/library', key: 'nav.library' }`(第 101 行)
- 删"加入书库"按钮(`data-test="menu-lib-add"`,第 230-234 行)—— 跟 ❤️ toggle 数据语义重叠,合并为 ❤️ 单一入口
- ❤️ toggle 按钮(`data-test="menu-lib-like"`)文案不变,仍是 `t('reader.like')` / `t('reader.unlike')` = "喜欢" / "取消喜欢"
- 删 `onAddToLibrary` 函数 + `emit('add-to-library')` 声明

### 6.2 ReaderView.vue

- 第 24 行 import:删 `toggleLike`,保留 `setFavorite`
- 第 637 行 `@add-to-library="book?.id != null && setFavorite(book.id, true)"` 整行删
- 第 638 行改为:
  ```diff
  - @toggle-like="book?.id != null && toggleLike(book.id)"
  + @toggle-like="book?.id != null && toggleFavorite(book.id)"
  ```
  其中 `toggleFavorite` 是本组件新增的本地 handler(不是 store 的),实现:
  ```ts
  async function toggleFavorite(bookId: number): Promise<void> {
    if (!book.value) return;
    const nextFav = !book.value.isFavorite;
    await setFavorite(bookId, nextFav);
    // 同步本地 book ref,否则同一阅读会话内 ❤️ 无法反复切换(代码审查 P1 反馈):
    // book 是 get_book 单次查的快照,不刷则下次点击仍读旧 isFavorite,
    // 第二次点击会再写 setFavorite(id, true),无法取消喜欢。
    book.value = { ...book.value, isFavorite: nextFav };
  }
  ```

**顺手修两个 bug**:
1. **数据源不一致**: 原 toggleLike 写 like 表(将被删),跟 `:is-liked="book?.isFavorite"` 读 library 不一致。改后 toggle 直接写 library.is_favorite,跟 isLiked 绑定一致
2. **同会话无法取消喜欢**(代码审查 P1 反馈): 原本 book 是快照不刷,第一次点 ❤️ 后内存仍 false,第二次点击仍写 setFavorite(true)。新 handler 在 IPC 成功后同步 `book.value.isFavorite`,❤️ 可反复切换

### 6.3 toggle 后 UI 状态

Reader 主菜单 ❤️ toggle 后(见 §6.2 新 handler):
- `setFavorite(book.id, nextFav)` 写 DB ✓
- `book.value.isFavorite = nextFav` 同步本地 ref ✓(代码审查 P1 反馈要求)
- `:is-liked="book?.isFavorite"` 响应式触发,主菜单 ❤️ 图标立即翻转 ✓
- 同一阅读会话可反复切换喜欢/取消喜欢 ✓
- Likes 页打开时 `library.refresh()` 拉最新 `is_favorite=1` 列表 ✓

**不需要**引入 library store 订阅(那需要把 book 改为响应式 store 派生,scope 过大)。本地 ref 同步足够覆盖 Reader 主菜单场景。

---

## 7. §4 FileBrowser 三入口文案统一

3 处 `t('fileBrowser.addToLibrary')` / `t('fileBrowser.contextMenu.addToLibrary')` 改为 `t('reader.like')`:

| 文件 | 行 | 当前 | 改为 |
|---|---|---|---|
| `src/components/filebrowser/FileBrowser.vue` | 625 | `:title="t('fileBrowser.addToLibrary')"` | `:title="t('reader.like')"` |
| `src/components/filebrowser/FileBrowser.vue` | 633 | `{{ t('fileBrowser.addToLibrary') }}` | `{{ t('reader.like') }}` |
| `src/components/filebrowser/EntryDetailPanel.vue` | 171 | `＋ {{ t('fileBrowser.addToLibrary') }}` | `＋ {{ t('reader.like') }}` |
| `src/components/filebrowser/RowContextMenu.vue` | 149 | `＋ {{ t('fileBrowser.contextMenu.addToLibrary') }}` | `＋ {{ t('reader.like') }}` |

**逻辑不变**:按钮仍是单向 `setFavorite(true)` via `emit('add-to-library')` → `readerActions.addToLibrary`。

---

## 8. §5 i18n 整理(zh-CN.ts + en-US.ts 双语对齐)

### 8.1 删

| key 命名空间 | 说明 |
|---|---|
| `nav.library` | SideNav/Reader 主菜单导航项 |
| `library.*` 整组 namespace | `title` / `empty` / `favorite` / `unfavorite` / `addFavorite` / `removeFavorite` / `source.{library,bookmark,history,tag}` —— 全是孤儿或被 Library.vue(本轮删)引用 |
| `reader.menu.library` | Reader 主菜单 navigate 数组项 |
| `fileBrowser.addToLibrary` | FileBrowser 工具栏按钮(改用 `reader.like`) |
| `fileBrowser.contextMenu.addToLibrary` | RowContextMenu 菜单项(改用 `reader.like`) |

验证: `library.*` sub-keys 引用情况已 grep 确认,只有 `library.unfavorite/favorite` 被 Library.vue 引用(本轮删),其余孤儿。

### 8.2 保留(不动)

| key | 用途 |
|---|---|
| `nav.likes` | SideNav 第 3 位项 |
| `likes.*` namespace | `title`='喜欢' / `empty`='还没有喜欢的书' / `toggleOn`='喜欢' / `toggleOff`='取消喜欢'(已有,足够) |
| `reader.like` / `reader.unlike` | ❤️ toggle 按钮两态文案,FileBrowser 入口也复用 |

---

## 9. §6 测试策略

### 9.1 前端(Vitest)

实测 grep 确认原文件状态: `FileBrowser.test.ts` / `EntryDetailPanel.test.ts` / `RowContextMenu.test.ts` **不断言** `addToLibrary` / `toggleLike` 相关文案或行为,这三处可不动。但 `ReaderView.test.ts` / `SideNav.test.ts` / `ReaderMainMenu.test.ts` 必改(代码审查后扩范围,见下表)。

| 文件 | 状态 | 动作 | 影响 |
|---|---|---|---|
| `src/views/Library.test.ts` | **不存在** | 无需删(Library.vue 本就没单独组件测) | 0 |
| `src/stores/library.test.ts` | 存在 | **保留不动** | 0 |
| `src/stores/likes.test.ts` | 存在 | **删** | -4 用例 |
| `src/views/Likes.test.ts` | **不存在** | **新增**: favorites 渲染 + empty state + 行内 ❤️ toggle + 跳 reader RouterLink(**必须断言用 `name:'reader'` + `params`,不能用 query** — 代码审查 P2) | +3~4 用例 |
| `src/components/reader/ReaderMainMenu.test.ts` | 存在 | **改**: 删"加入书库"按钮测试(`menu-lib-add`);❤️ toggle 测试 emit 期望不变 | 净 -1~-2 |
| `src/views/ReaderView.test.ts` | 存在 | **改**(代码审查 P1,见 §6.2/§11.3): 新增用例 — 挂载 ReaderView(mock `setFavorite` + 注入 `book` ref),连续触发两次 `toggle-like` emit,断言依次调用 `setFavorite(id, true)` → `setFavorite(id, false)`,以及传给 ReaderMainMenu 的 `:is-liked` prop 随 `book.value.isFavorite` 同步翻转。**这条测试 ReaderMainMenu 自己覆盖不了**(它只能验 emit,不能验父级 IPC 调用 + book 状态同步) | +1~2 用例 |
| `src/router/index.test.ts` | **不存在** | **新增**(代码审查 P2): 验证 `/library` 重定向到 `/likes`。**必须用实际导航,不能用 `router.resolve()`**(代码审查 round 3 P1 反馈)— `resolve()` 不保证执行 redirect 链,可能仍返回 `/library`,导致测试既不可靠又可能误判通过。标准写法: <br>`await router.push('/library'); await router.isReady(); expect(router.currentRoute.value.fullPath).toBe('/likes');` | +1 用例 |
| `src/components/layout/SideNav.test.ts` | 存在 | **改**(代码审查 P1): ①router mock 删 `/library` 路由;②hrefs 期望从 8 个改 7 个 + likes 提到第 3 位 `['/', '/shortcuts', '/likes', '/bookmarks', '/history', '/accounts', '/settings']`;③i18n 文案断言删 `'书库'`;④原 `/library` 激活态测试改为 `/likes` 激活态测试;⑤"逐个点击 router.push 8 次"改为 7 次 | 净 -1~-2 |
| `src/components/filebrowser/FileBrowser.test.ts` | 存在 | **不动**(grep 确认无 addToLibrary 文案断言) | 0 |
| `src/components/filebrowser/EntryDetailPanel.test.ts` | 存在 | **不动**(grep 确认无 addToLibrary 文案断言) | 0 |
| `src/components/filebrowser/RowContextMenu.test.ts` | 存在 | **不动**(grep 确认无 addToLibrary 文案断言) | 0 |
| `src/views/{History,Settings,Shortcuts}.test.ts` | 存在 | **不动** | 0 |

### 9.2 后端(cargo test)

| 文件 | 动作 |
|---|---|
| `src-tauri/src/commands/likes.rs` 测试 | **随文件删** |
| `src-tauri/src/commands/library.rs` 测试 | **保留不动** |
| `src-tauri/src/db/migrations.rs` 测试 | **改 1 + 加 2**: 现有 `assert_eq!(v, 10, ...)` 改 `assert_eq!(v, 11, ...)`;新增 apply_011 后 `like` 表不存在断言;新增数据合并验证(apply_011 前插 `(library.id=42, is_favorite=0)` + `like(book_id=42)`,apply_011 后 `library.id=42.is_favorite=1`) |

### 9.3 目标

- 单测 582 → 估 580~586(删 likes store -4、加 Likes 组件 +3~4、ReaderMainMenu 改 -1~-2、SideNav.test 改 -1~-2、ReaderView 新增 toggle 用例 +1~2、router redirect 测试 +1、migration 测试 +2~-1)
- type-check 0 error
- `npm test` 全绿
- `cargo test -p mirapage-desktop-lib` 全绿

---

## 10. 影响面审计(确保"不影响其他功能")

### 10.1 不受影响(行为完全不变)

| 模块 | 原因 |
|---|---|
| History.vue 业务逻辑 | 用 `browse_history`,不读 library/like |
| Shortcuts.vue / Accounts.vue / Settings.vue | 都不读 library/like |
| FileBrowser.vue 业务逻辑 | `readerActions.addToLibrary` 调 IPC `setFavorite`,不读 like |
| EntryDetailPanel.vue | 只 emit `'add-to-library'`,父级处理(文案变,逻辑不变) |
| useReaderActions.ts | `addToLibrary(entry)` 内部调 `createBook + setFavorite`,不读 like |
| RowContextMenu.vue `onResetProgress` | 用 `useLibraryStore` 查 book_id。store 不删,行为不变(见 §11 预存在 bug) |
| Bookmarks 业务逻辑 | 不读 library/like |
| `useLibraryStore` API | 全保留,只是消费方变化 |
| `library` 表 schema + 所有 library commands | 001~008 不动,Android 备份互导不受影响 |
| Android schema 对齐 | `like` 表本就是桌面端独有的孤儿,Android LibraryEntity 没有。删后桌面端 schema 反而更贴近 Android |

### 10.2 要改(19 处)

| # | 文件 | 动作 |
|---|---|---|
| 1 | `src/views/Library.vue` | 删 |
| 2 | `src/router/index.ts` | 删 `/library` component 路由,改为 `redirect: '/likes'`(代码审查 P2,兼容旧链接兜底) |
| 3 | `src/components/layout/SideNav.vue` | 删 library 项,likes 移到第 3 位 |
| 4 | `src/views/Likes.vue` | 重写(用 `library.favorites` + ❤️ toggle + reader 走 `name:'reader'`+`params`) |
| 5 | `src/views/Bookmarks.vue:57` | backlink `to="/likes"` |
| 6 | `src/components/reader/ReaderMainMenu.vue` | 删 navigate `/library` + 删"加入书库"按钮 + 删 onAddToLibrary |
| 7 | `src/views/ReaderView.vue` | 删 toggleLike import + 删 `@add-to-library` 接线 + 新增 `toggleFavorite` 本地 handler(写后同步 book ref,见 §6.2) |
| 8 | `src-tauri/src/commands/likes.rs` | 删 |
| 9 | `src-tauri/src/commands/mod.rs` | 删 `pub mod likes;`(代码审查 P1,否则 Rust 编译失败) |
| 10 | `src-tauri/src/lib.rs` | `generate_handler!` 删两条注册 |
| 11 | `src/lib/tauri.ts` | 删 listLikes/toggleLike/LikeItem |
| 12 | `src/stores/likes.ts` + `likes.test.ts` | 删 |
| 13 | `src-tauri/src/db/migrations.rs` | 加 migration 011(数据合并 + DROP,见 §4.3) |
| 14 | `src/locales/{zh-CN,en-US}.ts` | i18n 整理(§8) |
| 15 | `src/components/filebrowser/{FileBrowser,EntryDetailPanel,RowContextMenu}.vue` | 文案 `fileBrowser.addToLibrary` → `reader.like` |
| 16 | `src/components/layout/SideNav.test.ts` | 改(代码审查 P1,见 §9.1) |
| 17 | `src/components/reader/ReaderMainMenu.test.ts` | 改(删按钮测试) |
| 18 | `src/views/ReaderView.test.ts` | 改(新增连续 toggle 用例,代码审查 P1,见 §9.1) |
| 19 | `src/router/index.test.ts` | 新增(redirect 验证,代码审查 P2,见 §9.1) |
| + | `src/views/Likes.test.ts` | 新增(+ 含 reader params 断言) |

---

## 11. 不在范围(预存在问题)

### 11.1 RowContextMenu.onResetProgress 查 book_id 可能落空

`src/components/filebrowser/RowContextMenu.vue:80-100` 注释自相矛盾:
> // library.list 只会包含 is_favorite=1；temp-imported books 也已在 DB 中，refresh 后可见

实际 `list_library` SQL 是 `WHERE is_favorite = 1`,temp-imported books (`is_favorite=0`) **不在 list 里**。如果用户对未收藏的目录右键"重置进度",`library.items.find(...)` 找不到 match,后续重置逻辑走不下去。

**本次不修** —— 这是 §3 surgical 边界,跟"library → likes 改名"无关。如要修,改为 `list_library` 取消 `WHERE is_favorite=1` 过滤,或新增 `find_book_by_descriptor` IPC,scope 较大,留后续模块。

### 11.2 FileBrowser 入口按钮无"已喜欢"状态联动

按钮单向 `setFavorite(true)`,已喜欢的书再点是 no-op(SQL UPDATE 同值)。视觉上不区分"已喜欢" vs "未喜欢"。**本次不修** —— 需要让 FileBrowser 知道每个目录是否已喜欢,涉及性能 + state 管理,scope 过大。

### 11.3 Reader 主菜单 ❤️ toggle 后 book ref 不刷(已纳入本次修复)

~~预存在 UX 局限~~ —— 代码审查 P1 反馈指出:这并非"接受局限",而是**功能性 bug**(同一阅读会话无法取消喜欢)。本次 §6.2 已纳入修复:新增本地 `toggleFavorite` handler,IPC 成功后同步 `book.value.isFavorite`,❤️ 可反复切换。**测试要求**: ReaderView/ReaderMainMenu 测试须覆盖"喜欢 → 取消喜欢"连续 toggle 场景。

---

## 12. 验证标准

### 12.1 自动化

- [ ] `npm run type-check` 0 error
- [ ] `npm test -- --run` 全绿(580~586 用例)
- [ ] `cargo test -p mirapage-desktop-lib` 全绿
- [ ] `cargo check` 通过

### 12.2 手动(E2E via tauri-devtools MCP,按 `docs/tauri-devtools-debugging.md`)

- [ ] SideNav 顺序: 文件浏览器 / 快捷方式 / **喜欢** / 书签 / 阅览记录 / 账号 / 设置
- [ ] `/library` URL 直接访问 → **重定向到 `/likes`**(代码审查 P2:不删而是 redirect,兜底兼容)
- [ ] Likes 页打开: 显示 `library.is_favorite=1` 的书;空状态文案"还没有喜欢的书"
- [ ] Likes 页行内 ❤️ toggle: 取消喜欢 → 该行消失;再 reader 主菜单 ❤️ 重新喜欢 → Likes 页出现
- [ ] Reader 主菜单: "加入书库"按钮已删;❤️ toggle 按钮文案"喜欢"/"取消喜欢"
- [ ] Reader ❤️ toggle: DB `library.is_favorite` 翻转(用 sqlite 读验证)
- [ ] FileBrowser 工具栏 / EntryDetailPanel / RowContextMenu 三处按钮文案"喜欢"
- [ ] 点 FileBrowser 工具栏"喜欢" → DB `library.is_favorite=1` → Likes 页出现
- [ ] `like` 表已 DROP:`sqlite_master` 查无此表
- [ ] History / Bookmarks / Shortcuts / Settings 页功能不受影响

### 12.3 构建

- [ ] `npm run build` 通过(vue-tsc + Vite)
- [ ] `tauri build --no-bundle`(portable 单 exe)可选 —— 验证后端编译

---

## 13. 工作量估计

- **15 源码文件改 + 3 测试改(SideNav / ReaderMainMenu / ReaderView) + 4 文件删 + 2 测试新增(Likes.test.ts / router/index.test.ts) + 1 migration + i18n 2 文件**(见 §10.2,19 项 + 1 新增)
- 单测 582 → 估 580~586(净 +0~+4:删 likes store -4 / 加 Likes +3~4 / ReaderMainMenu 改 -1~-2 / SideNav 改 -1~-2 / ReaderView 加 toggle +1~2 / router redirect +1 / migration 测试 +2~-1)
- 实施 TDD 节奏:先写/改测试(失败)→ 实现 → 测试通过 → type-check → commit
- 估 commit 数: 5-7 个(数据层 / 视图层 / Reader 接线 / FileBrowser 文案 / i18n / migration / 测试整理,可合可分)

---

## 14. 后续可能(留作记录,不在本 spec)

- **修 RowContextMenu.onResetProgress bug**(§11.1)
- **FileBrowser 入口按钮"已喜欢"状态联动**(§11.2)
- **Likes 页支持搜索/排序**(目前按 `lastReadAt DESC`,无 UI 控制)
- **Likes 页支持批量管理**(多选取消喜欢)
