/res/# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# MiraPage Desktop

跨平台桌面漫画阅读器。**Tauri 2.x**（Rust 后端）+ **Vue 3**（前端）+ **OpenSeadragon**（图像渲染）。与 MiraPage Android 是**完全独立**的新项目，但领域算法语义按 Android 版对齐重写。

完整设计见 [`DESIGN.md`](./DESIGN.md)；本文只列骨架协作所需信息。

---

## 常用命令

> 前端：`Node 18+`（推荐 24+）。后端：`Rust 1.75+`。
> 桌面端 dev 必须用 `tauri:dev`（只跑 `vite` 无法加载 Rust IPC）。

```bash
# 安装依赖
npm install

# 开发（需 Rust 工具链；Vite 端口固定 1420）
npm run tauri:dev

# 仅前端（浏览器调试，无 IPC）
npm run dev

# 生产构建（先 vue-tsc 类型检查，再 Vite 出 dist/）
npm run build
npm run tauri:build                       # MSI + NSIS 安装包
npm run tauri -- build --no-bundle        # 单 exe 自包含（portable，无安装向导）

# 前端测试（Vitest + happy-dom）
npm test                # 单次
npm run test:watch      # 监听

# 仅类型检查
npm run type-check
```

Rust 端单独命令（在 `src-tauri/` 下）：

```bash
cargo test              # 运行 algorithm/ 模块单测（natural_sort, mime, path, spread_planner）
cargo build             # 后端编译（开发期很少需要，tauri:dev 会自动做）
```

跑单个测试示例：

```bash
# Vitest：匹配文件路径
npx vitest run src/lib/naturalSort.test.ts

# Cargo：按测试名过滤
cargo test -p mirapage-desktop-lib natural_compare
```

---

## 架构（一张图）

```
┌─────────────────────────── Vue 前端 (src/) ───────────────────────────┐
│ views/*  →  stores/* (Pinia)  →  lib/tauri.ts (IPC 桥)                │
│                                     ↓ invoke()                        │
└──────────────────────────────────────┬───────────────────────────────┘
                                       │  JSON: SourceDescriptor
┌─────────────────────────── Tauri 后端 (src-tauri/src/) ────────────────┐
│ commands/*  ──→  source::MediaSourceFactory::resolve(descriptor)      │
│                          │ match descriptor.type:                     │
│                          ├── LocalMediaSource       (Phase 1 ✓)       │
│                          ├── ArchiveMediaSource     (Phase 3, stub)   │
│                          ├── SmbMediaSource         (Phase 7, stub)   │
│                          └── WebDavMediaSource      (Phase 8, stub)   │
│                                                                          │
│ algorithm/*   纯函数：natural_sort, mime, path, spread_planner         │
│ db/           rusqlite + migrations（001_init 7 张核心表 + settings） │
└──────────────────────────────────────────────────────────────────────────┘
```

### 核心抽象

**`SourceDescriptor` 枚举**（`src-tauri/src/source/descriptor.rs` 与 `src/lib/sourceDescriptor.ts`）是前后端唯一的**契约类型**。两边字段名 / JSON tag 必须**字节级同步**，未来与 Android 备份互导也走它。变体：`Local`、`Archive`、`Smb`、`WebDav`。

**`MediaSource` trait**（`src-tauri/src/source/trait_def.rs`）规定所有数据源实现 4 个方法：`list_directory` / `read_file`（支持 `ByteRange` 分块）/ `file_count` / `test`。所有方法都是 `async fn`，由 `tokio` 驱动。`MediaSourceFactory::resolve(&descriptor) -> Arc<dyn MediaSource>` 按 descriptor 类型分发。

**设计原则**：UI 层从不直接调 `LocalMediaSource` 等具体实现——所有 IO 通过 `factory.resolve()`。新增远程源（Phase 7-8）只动 `source/*_impl.rs` 与 `factory.rs`，commands 与前端代码**完全不动**。

### 后端模块（`src-tauri/src/`）

| 目录 | 职责 |
|---|---|
| `main.rs` | Tauri 入口；调用 `lib.rs::run()` |
| `lib.rs` | 注册 Tauri 插件、初始化 DB、注册 `MediaSourceFactory`、声明 `invoke_handler` |
| `commands/` | 前端 IPC 入口；`file_browser.rs`、`settings.rs`（其他命令 Phase 后补） |
| `source/` | `MediaSource` 抽象：`trait_def.rs`、`factory.rs`、`descriptor.rs`、4 个 `*_impl.rs` |
| `algorithm/` | **纯函数**，无 IO/DB/网络依赖，便于单测。直接 port 自 Android 同名算法 |
| `db/` | `rusqlite::Connection`（`Mutex` 包裹）；`migrations.rs` 按版本号顺序执行 |

### 前端模块（`src/`）

| 目录 | 职责 |
|---|---|
| `main.ts` / `App.vue` | 启动入口；`onMounted` 加载 settings store + 应用 locale |
| `router/index.ts` | 7 条路由：home/library/bookmarks/likes/history/accounts/settings |
| `views/*` | 顶层页面组件（仅路由占位 UI，业务实现按 Phase 推进） |
| `stores/` | Pinia；目前只有 `settings.ts`（启动时从 DB 加载全部设置项） |
| `lib/tauri.ts` | **唯一**封装 `invoke()` 的地方；前端代码不直接 import `@tauri-apps/api` |
| `lib/sourceDescriptor.ts` | `SourceDescriptor` TS 类型，与 Rust 端镜像 |
| `lib/mime.ts` / `lib/naturalSort.ts` | TS 版算法（与 Rust `algorithm::mime` / `natural_compare` 语义一致） |
| `locales/` | `vue-i18n` 消息；`zh-CN.ts` + `en-US.ts`；`resolveSystemLocale()` 把 `navigator.language` 映射到支持的 locale |

---

## 关键约束 & 注意事项

- **`tsconfig.json` 别名**：`@/*` → `src/*`；import 路径用 `@/lib/tauri`，不要写相对路径深链。
- **`vite.config.ts` 固定端口**：`port: 1420, strictPort: true`——Tauri 默认配置依赖此端口，不要改。
- **Tauri 命令注册**：`commands::mod.rs` 不自动发现；新 command 必须在 `lib.rs` 的 `tauri::generate_handler![...]` 列表里追加。
- **DB 迁移**：`db/migrations.rs::run` 用 `MAX(version)` 守门；新增迁移**追加**版本号（2, 3, ...），不要改 001 已发布的内容。
- **算法双实现**：所有 domain 算法在 Rust（`algorithm/`）和 TS（`lib/`）**各有一份**，语义必须一致。改一边务必同步另一边；改动以 Android 原版为真值源（见 DESIGN.md §13）。
- **`SourceDescriptor` 字段命名**：Rust 端 `snake_case`（serde `rename_all = "lowercase"` 在 `tag` 上），TS 端 `camelCase`——Tauri 自动在 IPC 边界做转换。改 Rust 字段时检查 TS 镜像。
- **包内 IPC**：前端禁止直接 `import { invoke } from '@tauri-apps/api'`；统一通过 `lib/tauri.ts`。
- **新增 `MediaSource` 实现**：① 在 `source/*_impl.rs` 写 trait impl → ② 在 `source/factory.rs::MediaSourceFactory` 加 `Arc` 字段并在 `new()` 初始化 → ③ 在 `factory.rs::resolve` 加 match 分支。前端、commands、UI 不动。
- **本地打包必须用 `tauri build`，不能用 `cargo build --release --manifest-path`**：Tauri CLI 在 Windows 上会向 WebView2 注册 `http://tauri.localhost/` 协议 handler；`cargo build` 漏掉这一步，webview 把 `tauri.localhost` 当真实 HTTP 连接，失败后显示 Edge 的 ERR_CONNECTION_REFUSED 白屏（项目首次 CI 打包踩过此坑）。`tauri build --no-bundle` 是 portable 单 exe 方案的官方做法，跳过 MSI/NSIS 但保留协议注册。
- **git remote**：两个 remote 均可用 —— `origin`（内网 Gitea）+ `github`（GitHub,jl0476/mirapage-desktop）。默认推送目标 `git push github main`；CI 自动化（`.github/workflows/`）只对 `github` 生效。内网同步按需 `git push origin main --tags`。

---

## 当前状态（Phase 1-8 主体完成）

| Phase | 内容 | 状态 |
|---|---|---|
| 1 | Tauri 骨架 + SQLite + `algorithm/` 纯函数 | ✅ |
| 2 | OpenSeadragon 阅读器 + 文件浏览器 + 阅读器路由 | ✅ `v0.1.0-module2.0`：`ReaderView` / `ReaderMainMenu` / 9 宫格 / 滚轮 / 轮播 |
| 3 | 压缩包（CBZ/ZIP） | 🟡 ZIP ✅；RAR/7z 占位（`unrar`/`sevenz-rust` 注释未启） |
| 4 | 书签/喜欢/历史/书架/标签/搜索 | ✅ 10 个 commands + 9 个 Pinia stores |
| 4.5 | 书库 / 阅览记录 / directory_sort（Android schema 对齐） | ✅ `v0.1.0-module3.0`：`library` 11 列 + `browse_history` folder-level + `directory_sort` per-folder |
| 5 | 跨卷连续阅读 + 幻灯片 | ✅ `findNextDirectory` + `slideshow` store |
| 6 | i18n（中/英） | ✅ TDD 双语一致性 |
| 7 | SMB 协议层 | ❌ stub（`smb_impl.rs` 多处 `NotImplemented`，`smb = "0.11"` 依赖已加未用） |
| 8 | WebDAV 协议层 | ✅ 真实现（`reqwest` + PROPFIND + Range GET） |
| 9 | 跨平台分发 | 🟡 CI 自动化 ✅；代码签名 / macOS `.dmg` / Linux `.AppImage` / 自动更新 ❌（`updater` 插件占位） |
| 3.0+ | 设置面板完整化 | ✅ `v0.1.0-module3.0-settings`：Settings.vue 重写（5 section + 锚点 nav）+ 9 宫格触控方案 + theme 切换 + i18n 45 keys（spec：`docs/superpowers/specs/2026-08-03-settings-panel-design.md`） |
| 3.0.2 | 阅读器打磨 + 立即阅读入口 | ✅ `v0.1.0-module3.0.2-reader-polish` 3 cluster（spec：`docs/superpowers/specs/2026-08-04-reader-polish-design.md`）：<br>**A 立即阅读入口** — `useReaderActions.readFromImage(image)` 双击图片 / 选中图片立即阅读（从该图开始）；`?at=imageName` query 携带起始图；FileBrowser `canReadNow` 扩到图片；ReaderView `route.query.at` 解析后优先用该图所在 spread（不做末页钳位）<br>**B 阅读器 UI 修复** — OSD `showNavigationControl: false` 修 #7 左上 X 图标 + #5 按钮被拦截；`inputBindings.closeReader: ['Escape']` + `useReaderHotkeys.dispatch` → `router.back()`；`ReaderOverlay` pointer-events 修复（外层 `pointer-events-none` + 按钮 `pointer-events-auto`）；`chromeShow = chromeVisible && !autoHide && (hovered || hoveredVisible)`（autoHide = isPlaying）实现 #8 幻灯片时隐藏 + hover 2s 临时显示；`tauri.conf.json` `minWidth: 800→480, minHeight: 600→360`<br>**C 6 种缩放** — `useReaderScale` composable + `settings.currentScaleMode` + `setScaleMode(mode)` 持久化为 `scale_mode` DB key；SinglePageViewer / DoublePageViewer `defineExpose({ getViewer/getBounds })` 给父级取 OSD 实例；6 mode 全接（fit-screen / fit-width / fit-height / original / full-screen / stretch）；9 宫格 `fitWidth` 改调 `setScaleMode`（立即 apply + 持久化）<br>Bugfix: `8c04c34` 恢复 `status.value = 'ready'`（被 Cluster A 改动误删，导致"加载中...卡住"）；`83cc3d0` reader 排序与 file browser 一致（`effectiveSortField` + `sortEntries`，含 per-folder override；`?at=` 按 name 找 index 不受排序影响） |
| 3.0.3 | 文件浏览器内搜索 | ✅ `v0.1.0-module3.0.3-search`（spec：`docs/superpowers/specs/2026-08-06-filebrowser-inline-search-design.md`）：Windows 风格——toolbar 常驻 SearchInput（150ms 防抖），输入即时过滤当前目录列表（仅当前层、非递归、子串匹配、大小写不敏感）；面包屑搜索态切静态文本"搜索结果 > 文件夹名"；状态栏显示"找到 N 项"；X 清除 / ESC 清空+失焦；进目录自动清空 query。复用 fileBrowser store 已有 searchQuery ref + setSearchQuery；新增 `lib/searchFilter.ts filterByQuery` 纯函数；displayedEntries 在 hotfix17 hideFinished 过滤上叠加 searchQuery 过滤。删除旧全局 `/search` 数据库元数据搜索全套（Search.vue / search store / 路由 / tauri.ts SearchHit / 后端 search 命令 / search.* i18n / 侧栏项）。残留孤儿（settings.ts SearchMode/search_mode、fileBrowser.search='搜索' 单 key）留后续清理。 |
| 3.0.4 | 文件浏览器虚拟列表 | ✅ `v0.1.0-module3.0.4-virtuallist`（spec：`docs/superpowers/specs/2026-08-06-large-folder-perf-design.md`）：手写 `useVirtualList` composable（~80 行）+ FileList 三视图统一虚拟化 + viewMode 切换 DOM 复用（CSS `:not()` 显隐）+ 算法层顺手修 4 个 O(n²) hot path（`pathIndex` O(1) / `toggleSelection` in-place + `triggerRef` / `readStatus.finishedSet` O(1) / `displayedEntries` 单次循环合并 fast path）。**E2E 实测**：14949 entry "AI" 目录 DOM 节点 194,485 → 1,284（**151×**）；JS heap 167 MB → 32 MB（**5.3×**）；搜索 "page" 后 DOM 1,284 → 137（**1,415×**）；hover 200 次 avg 0.002ms / longtask 0；滚动到底 clamp 正确。msedgewebview2 总内存预期 1.5 GB → 300-500 MB。完整 E2E 报告 `docs/superpowers/reports/2026-08-06-virtuallist-e2e.md`（commit b6ad078）。<br>**11 hotfix（同 tag，已 merge）**：<br>(1) `17ed8ea` 删孤儿 `lib/searchFilter.ts`（v0.1.0-module3.0.3 内联后无 caller）<br>(2) `fff103d` statusbar 路径分隔符统一 `/` + VirtualRow 选区 outline 不再三重叠<br>(3) `b54eb98` row view block `height: 100%` 撑满 29px row host（消除 11px 空白）<br>(4) `9f05db1` `formatDateTime` 加时分秒显示<br>(5) `04aea4c` 文件列表字体颜色加深（secondary → primary）<br>(6) `2082813` grid 视图用 CSS grid auto-fill 多列 wrap<br>(7) `3b25a9e` 全名浮窗 tooltip 恢复（Teleport to body）<br>(8) `915de53` tooltip gap 6px → 2px（紧贴）<br>(9) `4a9bca7` tooltip 对齐 hotfix15 原版（下方 4px + 左对齐）<br>(10) `d7f0aad` details 各数据列 truncate + scoped CSS 兜底<br>(11) `71c7730` name-cell `display: block`（span inline 不支持 ellipsis） |
| 3.0.5 | 快捷方式跨源 + 子目录 | ✅ `v0.1.0-module3.0.5-shortcut-cross-source`：对齐 MiraPage Android `ShortcutEntity`——schema 从 `(id, root_path UNIQUE, label, created_at)` 升级到 `(id, source_descriptor_json, rel_path, alias, icon_hint, created_at, UNIQUE(source_descriptor_json, rel_path))`，跨源（Local/Smb/WebDav/Archive）+ 支持子目录快捷方式。migration 007 用「重建表」标准模式 + Rust 行级迁移旧 root_path → Local descriptor JSON（避免 SQL 字符串拼接反斜杠畸形）。iconHint 本地派生（Rust `icon_hint_for` / TS `iconHintFor` 双实现，按 descriptor.type_str）。UI 图标 ⭐ STAR → 📌 PushPin（对齐 PV 教训：Star 被多次误解为书签，见 specs/2026-07-29-like-feature-design.md:301）。打开子目录 shortcut 走两步模式 setRoot+navigate(relPath)，复用 History.vue openEntry 模式。保留独立 `/shortcuts` 页面 + activeId 概念作为有意差异（Android 是 sheet 嵌入式无状态）。**有意差异 vs Android**：保留 INSERT OR IGNORE（不跟 Android 的 REPLACE，保留旧 alias 更友好）；保留独立页面；保留 activeId。前置依赖零新增：Rust SourceDescriptor 已 derive Serialize/Deserialize、TS 类型完整、list_directory 命令早已走完整 descriptor——shortcut 是唯一还在用裸路径字符串的异类，本次对齐到其他 4 个表范式。单测 535→539（+12 shortcut store/migration、+2 子目录用例，-10 旧 rootPath 用例调整）。 |
| 3.0.6 | 文件浏览器瀑布流 | ✅ `v0.1.0-module3.0.6-masonry`（spec：`docs/superpowers/specs/2026-08-07-masonry-layout-design.md`）：图片目录瀑布流视图——图片按真实宽高比拉伸 + 贪心放最短列（借鉴 v3-waterfall useLayout 算法，源码存 `docs/reference/v3-waterfall-master/` 仅供借鉴不引入依赖）+ 变高虚拟滚动扩展现有 `useVirtualList`。**删 list/grid 视图**，ViewMode 收窄为 `details \| masonry`，工具栏图标按钮直接切换（详情在前 + 瀑布流，非下拉）。**Rust 端**：新增 `algorithm/image_header.rs` 纯函数手写 JPEG/PNG/GIF/BMP header 字节解析（无 image crate，纯 std，双实现 TS `lib/imageHeader.ts`）+ `list_image_dimensions` command（tokio JoinSet + Semaphore 16 并发批量读 header，只读 256B）+ migration 008 `directory_masonry` 表（per-folder 列数/列间距/行间隔，三列可 NULL + COALESCE 部分更新）。**预读策略**：不全量拉尺寸，借鉴图片懒加载——首屏可见 + 3 屏预读，未测量用估算宽高比（3:4）占位，渐进式 totalHeight。**滚动锚定** applyMeasuredBatch（上方 item 尺寸到达补偿 scrollTop，E1 简化为 visibleRange 重算，实测无跳动）。**布局参数双层**：工具栏 ⚙ popup（仅 masonry 出现）per-folder override + Settings 页全局默认，复用 directory_sort 的 locationKey 模式。**慢速 I/O 适配**：Local 挂载远程存储场景，按需预读 + img lazy 字节按需 fetch。无图目录 masonry 按钮 disabled + 自动回落 details。**E2E 实测**（D:\Wallpaper\normal 224 entry）：虚拟化 224 → 10-28 DOM；列数 4→6 实时重排（width 254→169px）；⚙ popup 3 slider；滚动预读正常；双击图片进 reader 兼容。单测 539→582。**待打磨**（留后续）：像素级 scrollTop 锚定补偿、resolve in-flight cancel、hasImages 搜索态副作用、var(--ease-out) 残留（FileList.details-header/FileBrowser.tb-btn 预存在未定义变量）。 |
| 3.0.7 | 缩略图缓存（消除 4K 渲染卡顿）| ✅ `v0.1.0-module3.0.7-masonry-thumbnail-cache` 任务1-13 已完成（实时帧时间待本地实跑）（spec：`docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md`，plan：`docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md`，报告：`docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md`）。**根因**：4K 图 paint/decode + GPU 纹理（基线 max 313ms / 5 次 >100ms 掉帧；隐藏 img → 18.6ms / 0，确认非 JS/图层），`new Image()` 原图预读不降像素量无效。**方案**：Rust 按列宽生成 WebP 缩略图（EXIF Orientation 1-8 像素归一化 + 像素预算 + 原子写），asset protocol 加载，图片字节不进 IPC。**Rust `thumbnail/`**：policy（尺寸档位/阈值/预算/并发纯函数 28 测）/ orientation（1-8 四角颜色集成测）/ generator（WebP 管线 + .tmp 原子写）/ key（SHA-256 cache_key，缓存根不参与）/ index（thumbnail_cache DAO + LRU + 文件一致性 + ensure_schema）/ scheduler（tokio actor：优先队列+in-flight 去重+worker/内存预算+stale 取消+cancel_all+老化 11 测）/ service（classify/evict/事件/迁移）/ migration（FsOps+manifest 状态机+copy/verify/resume/cancel/commit/rollback 7 测）/ commands（14 命令）。migration 009。**前端**：useMasonryLayout `selectPathsInPixelWindow` 像素窗口四组（半开区间，0px gap 不重不漏，设置驱动 ahead/idle）/ useMasonryThumbnails（去重 batch+80ms debounce+epoch+事件+retry，sourceRelPath/uiPath 路径模型）/ MasonryThumbnail（6 状态卡片，纯 transform spinner+120ms 淡入+失败重试 stopPropagation）/ MasonryView 移除 `new Image()` 接入队列（源码守卫，list_image_dimensions EXIF 方向归一化）/ settings 9 key（预设/custom 联动+runtime 推送+缓存位置迁移 UI）。**代码审查 P1/P2 全修**（路径模型/完成事件 key/LRU 保护/设置控制运行/EXIF 布局/Standard max_bucket/索引元数据/清空协调/EnumRow/提交完整性）。**验证**：前端 665 测试 0 error；Rust 缩略图 94 单测 + 4 管线集成 + 8 生成器集成全绿。**待跑**：本地 `npm run tauri:dev` 采集改造后实时 rAF 帧时间填报告。 |
| 3.0.8 | 缩略图 polish + 浏览位置 = 阅读进度 | ✅ 双 tag `v0.1.0-module3.0.8-thumbnail-polish` + `v0.1.0-module3.0.8-masonry-browse-position`（同一 commit `4f783ad`，后续 11 个 fix 到 `83a0c52` HEAD）（spec：`docs/superpowers/specs/2026-08-10-masonry-browse-position-design.md`，4 套报告：`2026-08-08-masonry-thumbnail-{performance,code-review}.md` + `2026-08-09-thumbnail-generation-bench.md` + `2026-08-10-masonry-policy-hit-rate.md`）：<br>**A 缩略图 polish** — ThumbnailCacheSettings.vue 完整化（EnumRow 串联 mode/quality/cacheLimit + cacheUsed/clear + 缓存位置迁移 validate/migrate/resume/cancel/rollback/recovery + advanced toggle 4 key）；P0/P1 修复一波（路径模型/完成事件 key/LRU 保护/索引元数据/质量档位/EXIF 布局/Standard max_bucket/清空协调/EnumRow/提交完整性）；ViewMode 图标换 SVG 资产（`src/icons/瀑布流.svg` + `详情列表_view-list.svg`）；policy hit-rate 实测<br>**B 浏览位置 = 阅读进度** — migration 010 `progress.image_name` 列（瀑布流滚动锚点，NULL 走 page fallback）；`useMasonryBrowsePosition` composable（滚动监听 + 竞态保护 + 缓存）；`scrollToEntry` 渐进校正；reader-actions `readFromCurrentPath`（缓存优先 + rootPath fallback + router guard）；FileBrowser 工具栏「↶ 跳到上次」按钮 + canonicalImageNames + canReadNow 扩展；Settings masonry section + `recordBrowsePosition` / `restoreBrowsePositionOnEnter` 2 BooleanRow + fileBrowser section + 字号统一<br>**C 完整日志** — Rust `thumbnail/{service,scheduler,generator}` + worker panic `catch_unwind` 写到 `main.log`；前端 `useMasonryThumbnails` 加 5 个关键日志点 + `listen()` catch `isTauriEnv` 判断；修 4 unhandled rejection<br>**D fix 集群** — resize 视觉焦点漂移（viewport anchor 捕获+恢复 path+ratio）；resize 不污染 recordCurrentTop；classify CACHED 决策前验证磁盘文件；Priority enum Display impl 防 `{}` 静默空串；restoreAndScroll 用户开关只控读行为（按钮永远 enable）；scrollToEntry watch 清理；瀑布流 worker 上限 4→16<br>单测 582→**717** 前端 / Rust thumbnail 100 单测+12 集成+3 bench（ignored）。**实测发现**（本次汇总）：Rust lib 179 测试 177 pass + **2 失败**（`algorithm/path::test_crumbs`、`source/webdav_impl::parse_propfind`），且 CI 不跑 cargo test（只 cargo check）—— 详见 [`docs/superpowers/reports/2026-08-11-feature-matrix.md`](./superpowers/reports/2026-08-11-feature-matrix.md) |
| 3.0.9 | 跨卷连续阅读链路打通 | ✅ `v0.1.0-module3.0.9-cross-volume` 14 commits（spec v2：`docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md` + 计划：`docs/superpowers/plans/2026-08-11-cross-volume-reading.md` + 设计审查报告：`docs/superpowers/reports/2026-08-11-cross-volume-reading-design-review.md`）：<br>**三层架构** — 跨卷意图（末页再向下/slideshow/9 宫格/Alt+→/瀑布流按钮 5 入口）→ CrossVolumeController（模式决策 off/auto/manual + requestSeq 竞态 + sameBookIdentity 结构化校验 + canStart 加载期守卫 + settleIdle 集中收口）→ 统一 Book Loader `useReaderBookLoader.loadBookById(bookId)` 返回不可变 `ReaderBookSnapshot`（不写 refs、不调 reader.openBook）→ ReaderView.commitBookSnapshot 原子提交。route 是当前卷身份**唯一真值**，跨卷走 `navigateToVolume(ensureBookId+router.replace)` → route watch（immediate:true 替代原 onMounted）→ `loadRouteBook` 加载新卷。<br>**Rust 端** — `pick_sibling` 纯函数（仅过滤 `is_directory`，返回 entry 克隆避免索引歧义）+ `VolumeDirection` 强类型 enum（非法 IPC 入参反序列化报错）+ `find_next_volume` async command 接 MediaSourceFactory（仅 Local，非 Local 明确 Err；集成测试用 tempdir + LocalMediaSource，codebase 首例 factory 集成测试）。`ProgressItem.finished` 跨边界 gap 修复：Rust `get_progress_inner` SQL 加 `finished` 列 + row 解析 `!= 0`；TS `ProgressItem` 加字段；Loader 去掉 `& { finished?: boolean }` 死代码交叉类型 ——"已读完→首页"端到端打通。<br>**11 条不变量端到端闭环**（spec §4.3）：route 唯一真值 / watch immediate 唯一入口 / 失败不保留旧卷（route 变即 visibleReader=false 触发 loading，catch 时 closeBook+清 refs+error UI）/ 去重看 phase=ready / 原子提交 / busy 覆盖 loader（busy=phase!=='idle'\|\|bookLoadPhase==='loading'）/ pendingCrossVolume 只在 awaiting-confirm 非空（settleIdle 集中收口 + dismissManual 仅 awaiting-confirm 生效）/ route.query.at 清空 / pendingNextVolume 五处消费 / saveCurrentProgressNow await+取消旧 debounce / setOnAtLastNextAttempt(null) 卸载清理。<br>**触发接线** — 末页 watch 消费 `slideshow.pendingNextVolume` → `crossVolume.maybeContinue(false, 'next')` 看模式；9 宫格 `zoneActions.nextVolume` → `maybeContinue(true, 'next')`（force=true 不看模式）；Alt+→ 经扩展的 `useReaderHotkeys({nextVolume})`（folderNext dispatch 真实接 actions.nextVolume，TODO 已删）；瀑布流按钮走独立 `onCrossNextVolume`（fileListRef.masonryFlushNow → findNextVolume → 双重陈旧校验 path+root → fb.navigate）。<br>**UI** — 通用 toast（useToast 单例 ref 队列 + ToastHost Teleport 到 body）+ ContinueNextVolumeToast manual 模式底部胶囊（纯 props/emits **不调 useCrossVolume()**，P0-2 修复单实例所有权）。ToastHost 最终审查后挂在 `src/App.vue` 顶层（spec §13 本意，最终审查 I1 修复 FileBrowser 路径下 toast 也能渲染）。<br>**A7 修复**（E2E 后发现）：auto/force 跨卷成功 → resume slideshow（仅当调用前 isPlaying=true，spec §7.2）+ `pushToast('reader.crossVolume.jumped', {title})` 短暂反馈。manual 路径不续播（用户主动确认，由 confirmManual 自己的 capsule 提示）。<br>**9222 自动化 E2E 验证**（含 I1 + A7 修复后全绿）：off 模式不跨卷+消费 flag / auto 模式真实跨卷+URL 同步+续播+jumped toast 1500ms / manual 模式 capsule 出现+点跳转跨卷 / 末页再向下才触发（翻到末页不触发）/ 加载失败不保留旧卷（reader-error UI 渲染+bookId=null+status=idle）/ 并发10 次只跨 1 次 / ToastHost App.vue 顶层渲染 toast-host。<br>**14 commits**（任务 0-10 实施 + 任务5审查修复补测试 + 最终审查I1修复 + A7两补）：0baa8d0/20bc8ed/aef174f/9559198/2fd7a6c/3f4963c/3d62669/0deb1c2/a81e3b0/48607c9/c4dcf3f/6a2a3fd/3a57e63/fb29346。前端 717→799（+82），Rust 跨卷 +30（pick_sibling 9 + find_next_volume 14 + progress finished 7），type-check 0 / cargo check clean / portable build ok / 2 pre-existing Rust fail（test_crumbs / parse_propfind）与本任务无关。**8 项次要 backlog** 记入 progress.md（force=true 续播无 spec 字面 / 模块级 onAtLastNextAttempt 测试 hygiene / progressSaveFailed 是否阻断待定 / retryCurrentRead未单测 / 测试文件末换行 / BookIdentity/sameBookIdentity YAGNI 越界 / FileBrowser 图标 path 非严格 skip-forward / role dialog vs status a11y）。 |
| 3.1.1 | 瀑布流滚到底算读完 + 底栏下一卷 + StatusBar 布局优化 | ✅ `v0.1.0-module3.1.1`（spec `2026-08-12-masonry-finished-and-statusbar-next-volume-design.md` v7，7 轮审查闭环）：<br>**A 瀑布流滚到 finished**（7 轮审查打磨的状态机）：<br>① **finished 状态机** — `useMasonryBrowsePosition` 加 atBottom + bottomSince + stableTimer + 两阶段提交（spec §2.3 审查 P1 v5/v6 核心）：阶段1（seq/writeSeq 早退可取消 + bookId==null 持久失败不重试 + IPC catch scheduleRetry）+ IPC（saveProgress try/catch）+ 阶段2（**always** 记 successfulWrites + UI 缓存仅最新请求 `writeSeq===activeWriteSeq && sameDir` 更新 + 陈旧成功不污染）；finished 单调（只传 true 不传 false）；A9 复合去重（快路径 `(path, finishedParam) === lastWritten*` \|\| 慢路径 `successfulWrites.has(identity)`）；缓存单调（`finishedNow \|\| lastBrowseProgress.finished \|\| false`）；A7 幂等（已 finished 整次 skip）。滚到底 + 停留 ≥ STABLE_MS=1200ms 才升级 finished=true（A2 不变量，5 出口清理 + 回调置空防死锁）。<br>② **progressWriteKey 纯函数** — `src/lib/progressWriteKey.ts` JSON.stringify 结构化序列化防 `\|` 碰撞 + finished ?? null 归一化 + 7 单测（无 Vue/Tauri 依赖）。<br>③ **atBottom 三档规则** — `computeAtBottom(sh, ch, st)` 纯函数 + BOTTOM_THRESHOLD_PX=64 + 档1 `sh<=ch`（不足一屏停留即可）+ 档2 `ch<sh<2ch` 须 `st>0`（防顶部误判）+ 档3 `sh>=2ch` 贴底；MasonryView atBottom computed + `void layout.value.totalHeight` 响应式触发源（缩略图尺寸渐进收敛时强制重算）。<br>④ **状态机骨架** — atBottom param + watch（false→true 调 scheduleRecord，true→false 调 clearStableTimer）+ stableTimer/clearStableTimer/scheduleRetryIfStillAtBottom + 5 出口清理（start/stop/disableWatcher/resize 分支/recordCurrentTop else）+ recordCurrentTop 入口 enabled 守卫（flushNow 也走）。<br>⑤ **开启/关闭 recordBrowsePosition** — 关闭时 recordCurrentTop 入口 return，flushNow 也跳过（审查 P1-2 验收 A-T9）。<br>**B 底栏 StatusBar 下一卷入口（复用 onCrossNextVolume + 预查）**：<br>① StatusBar 新增 props（nextVolumeTitle/Loading/Disabled）+ emit next-volume + 四态渲染（loading 优先于 undefined，右段空 div 保对称）。<br>② FileBrowser `prefetchNextVolume` + `nextVolumeRequestSeq` 三分支陈旧校验（成功/失败/finally）+ debounce 300ms + 切目录立即置 loading（不闪空）+ 早返关 loading + onUnmounted 清理 debounce + 全局 afterEach 卸载 wrapper（防 timer 泄漏，line-832 确认）。<br>**C StatusBar 三段等宽布局**：footer 改为三段各 flex-1，路径真正居中（修偏右），与下一卷右段对称。<br>**D 卷名 hover 跑马灯**：固定宽度容器 + JS 测量 scrollWidth + hover translateX 4s linear + watch 兜底 RO 重测 + `:not(:disabled)` 禁用态不滚 + button min-w-0 max-w-full 让 truncate 不被架空。<br>单测 851→**895** 前端（+44：progressWriteKey 7 + computeAtBottom 6 + useMasonryBrowsePosition A-T1/T2/T3/T4/T5/T9/T14/T16/T20/T21 10 + StatusBar 13 + FileBrowser B-T1~B-T8 8）。Rust 库 0 改动（cargo check/build Finished pre-existing warnings only）。type-check 0 / cargo build Finished / npm run build ok (4.50s)。**16 文件改动 + 1 新文件**（progressWriteKey.ts）。 |
| 3.1.0 | 文件浏览器路径身份修复 | ✅ `v0.1.0-module3.1.0-path-identity`（spec：`docs/superpowers/specs/2026-08-12-file-browser-navigation-identity-design.md`，plan：`~/.claude/plans/soft-percolating-kitten.md`）。**根因**：`FileBrowser.vue:63` `getLastFetchedPath: () => fb.lastFetchedPath \|\| fb.rootPath \|\| ''` 把根目录合法 `''` 当 falsy 回退成绝对 `rootPath`，经 readFromImage → createBook.absolutePath + recordHistory.relPath 污染 library/history；Windows `PathBuf::join(root, absoluteChild)` 丢弃 root 导致 source 边界绕过（P0）。<br>**修复（8 维度）**：<br>① **前后端校验器双实现** — `src/lib/relativePath.ts` `validateSourceRelativePath` + Rust `algorithm/path.rs::validate_source_relative`（语义 1:1，接受 `''`/`a`/`a/b`/`a\\b`，拒绝盘符/绝对/UNC/`..`/NUL），前端 25 测 + Rust 12 测。顺手修 pre-existing `test_crumbs`（断言 len 3→4）。<br>② **首因修复** — FileBrowser.vue:63 删 `\|\| fb.rootPath \|\| ''` fallback，改 `fb.rootPath === null ? null : fb.lastFetchedPath` 区分「未加载 null」与「根目录 ''」；readFromImage 守卫 `if (!parentPath)` → `if (parentPath === null)`，根目录双击图片 createBook/history 写 `''`。<br>③ **前端写入边界接入** — fileBrowser store navigate/up/fetch/restoreNavigationContext（assertRelPath helper，非法不改 state 不发 IPC）；useReaderActions ensureBookId（absPath 校验）+ safeRecordHistory（relPath 校验，替换 3 处直调 recordHistory）；useReaderBookLoader 移除 isAlreadyAbs 兼容分支（强制相对 join，污染数据显式报错）+ 跨卷 target.relPath 校验；useMasonryBrowsePosition ensureBookIdForCurrentDir 校验；useMasonryThumbnails sourceRelPath 校验（flushRequest + buildItem 两点）；FileBrowser onSaveSubmit 校验。<br>④ **Rust 后端边界** — `MediaSourceError::PathEscape` variant；`LocalMediaSource::resolve_path` 改返 `Result<PathBuf, MediaSourceError>` join 前校验（6 测含 absolute/unc/dotdot 拒绝）；`thumbnail::service::local_abs_path` 改返 `Result<PathBuf, ThumbnailError>` 同款校验（2 调用点 request/resubmit 短路 err_result）；create_book/record_history/create_shortcut descriptor 反序列化校验 + 路径校验（shortcuts 抽 `normalize_shortcut_input` 纯函数 4 测）。<br>⑤ **快捷方式收敛**（spec §6.4）— Shortcuts.vue onOpen 改为仅 setActive + router.push('/')；FileBrowser.vue `openShortcut(id)` 唯一执行点（watch + onMounted 主动检查 + lastOpenedShortcutId 去重守卫 + relPath 校验失败 clearActive）；shortcuts store 加 clearActive。<br>⑥ **异步导航 requestId 防护**（spec §6.5）— fileBrowser store 模块级 `fetchRequestId`，fetch 捕获 myId + await 后 `myId !== fetchRequestId` 丢弃过期回写（entries/lastFetchedPath/error/loading）；setRoot 开头 `++fetchRequestId` 失效在途（含 setRoot(null)）。2 个 deferred Promise 乱序测试。<br>⑦ **i18n** — `error.pathEscapesRoot` 中英双语。<br>**不做**（用户确认）：不写存量清理 migration/UI（坏行靠后端校验自然失效，用户手动删）；不做 schema rename（absolute_path 列名保留，注释改称 sourceRelPath）。<br>单测 799→**851** 前端（+52）/ Rust lib 209→**226**（+17：path 12 + local 6 + shortcuts 4 + service 2 - test_crumbs 修好；pre-existing 仅剩 parse_propfind 1 fail）。type-check 0 error / cargo check clean。**24 文件改动 + 2 新文件**（relativePath.ts/.test.ts）。 |

**构建**：见 [`BUILD.md`](./BUILD.md)。Rust ≥ 1.96 需 `Cargo.toml` 的 `indexmap` 修复（schemars/indexmap 兼容性，详见 BUILD.md §2）。

**实测状态快照（2026-08-11）**：见 [`docs/superpowers/reports/2026-08-11-feature-matrix.md`](./superpowers/reports/2026-08-11-feature-matrix.md) — 基于实际代码扫描 + `npm test` + `cargo test` 实测的功能矩阵（已完成 / 占位 / 未实现 / 缺口优先级）。

**CI 自动化**：GitHub Actions 已端到端验证打包链路——`.github/workflows/verify.yml`（push/PR 触发：前端 type-check + test + build + 后端 `cargo check`）和 `.github/workflows/release.yml`（push `v*` tag 或手动触发：完整 release 构建 + 上传 portable exe 到 GitHub Release）。4 个 Release tag 已发布：`v0.1.0-ci-test`（MSI + NSIS 安装包）、`v0.1.0-ci-portable-v2`（portable 单 exe，当前可用）、`v0.1.0-module3.0-settings`、`v0.1.0-module3.0.2-reader-polish`。完整描述、产物路径、tag 发版命令见 [BUILD.md §5.3](./BUILD.md)。

> ⚠️ **CI 覆盖缺口（功能矩阵 §1.5 实测发现）**：`verify.yml` 只跑 `cargo check` 不跑 `cargo test`，Rust 端 2 个失败用例（`algorithm/path::test_crumbs`、`source/webdav_impl::parse_propfind`）永远抓不到。修复:在 verify.yml 第 9 步后追加 `cargo test --lib --no-fail-fast --quiet`。

**待验证**：本地 Windows 原生环境的首次直接 `cargo check` / `cargo build` / `tauri build` 仍有待验证——CI 跑通不等于本地一定能跑（Rust 工具链版本、MSVC Build Tools 完整性、文件路径等因素都可能影响）。

---

## 开发规约（v0.1.0-module2.0 沉淀）

下文是写完模块 #2 后沉淀的约定。新增模块前先读一遍——**约束比自由更重要**，避免无意义的返工。

### 0. 阅读器交互规约（v0.1.0-module2.0 新增）

**0.1 路由**

- 阅读器路由 `/reader/:bookId`（bookId 是 history 表的主键）。
- `ReaderView.vue` 是 thin wrapper：`listHistory` 找 entry → `fileBrowser.setRoot` 拿 MediaEntry[] → 过滤图片 → `convertFileSrc` 转 `tauri://localhost/` URL → `reader.openBook`。
- onUnmounted：`saveProgress` 兜底 + `slideshow.pause()` + `reader.closeBook()`。

**0.2 全屏阅读控制 Dialog（`ReaderMainMenu.vue`）**

- 用 `<Teleport to="body">` 跳出 reader 容器 z-index，`z-[1100]` 高于一切。
- `bg-black/88 backdrop-blur-sm flex flex-col items-stretch p-8 gap-4 overflow-y-auto` —— 88% 透明黑 + 模糊背景。
- **不自动 fade out**（Android 已删），显式关闭按钮 + 路由跳转关闭。
- Props：`show / title / currentSpreadIndex / totalSpreads`，emit `update:show / back / jump-page / cycle-mode / cycle-direction`。

**0.3 9 宫格点击（`useReaderTouchZones.ts`）**

- 3x3 网格：`tl / tm / tr / ml / mm / mr / bl / bm / br`（**全部 3 字母 key，与 Android 端保持一致**）。
- **v0.1.0-module3.0-settings 起**：动作源从硬编码 `DEFAULT_READER_ZONES` 改为 `settings.touchScheme`（reactive）+ `settings.touchZonesEnabled` master toggle。类型枚举 `TouchAction` 在 `src/lib/readerSettings.ts`，11 个值（**删除** PV 的 `toggle-chrome`）：`none / prev-page / next-page / jump-first / jump-last / open-main-menu / slideshow-toggle / fit-width / folder-prev / folder-next / open-file-browser`。
- 默认映射（`DEFAULT_TOUCH_SCHEME`，对齐 PV `TouchScheme.DEFAULT`）：`tl=fit-width / tm=open-file-browser / tr=jump-last / ml=prev-page / mm=open-main-menu / mr=next-page / bl=folder-prev / bm=slideshow-toggle / br=folder-next`。
- 中央 + 顶中 **都**映射 `open-main-menu` —— 让用户能稳定打开控制面板（任意点击屏幕中部）。
- `dispatchZoneAction(action, ctx)` 统一派发到 11 个回调（新增 `fitWidth` / `openFileBrowser`）。`fitWidth` 当前仅写 store + log（OSG viewer 未 expose），下次开卷生效。

**0.4 桌面端滚轮（`useReaderWheel.ts`）**

- `passive: false` 才能 `preventDefault()` 阻止页面滚动 + OSD 内部缩放。
- 250ms 节流避免 Mac 触控板惯性事件一次触发多页。
- `deltaY > 0` 下滚 = 下一页，`deltaY < 0` 上滚 = 上一页（与 Android 音量键一致）。
- 不区分水平滚轮（`deltaX`）—— 桌面端水平滚轮少见。
- `useReaderHotkeys` 也接管 `wheel`（走 `inputBindings.resolveHotkey`），二者并存：hotkey 走全局，wheel composable 走 containerRef，**只在 ReaderView 容器范围**生效。

**0.5 轮播 store（`useSlideshowStore`）**

- 运行时：`isPlaying / intervalMs / direction / loop` + `pendingNextVolume` ref。
- `start()` / `pause()` / `toggle()` 控制 setInterval。
- `reset()` —— 用户翻页/点击/滚轮时调用，**不影响 isPlaying** 仅重启 timer。
- `tick(onAdvance, onPrev, atLast)` 是回调式（**不直接调 reader store**，避免循环依赖）。
- 末页触发：`pause()` + `pendingNextVolume = true` → ReaderScreen watch 触发 `find_next_volume` IPC（v0.1.0-module2.0 留 TODO 占位，settings.continueToNextVolume 已就绪）。
- `setInterval` 在 Node / happy-dom 返回类型不一致（`Timeout` vs `number`）—— `let timerId: any = null` 绕过。
- **v0.1.0-module3.0-settings 起**：interval / direction / loop **全部经 Settings 页 UI 改写**（§11 设置面板），不再是 ReaderMainMenu 单独的临时控件入口。

**0.6 跨卷意图 flag**（v0.1.0-module3.0.9-cross-volume 重写）

- `slideshow.pendingNextVolume` 是 ref，ReaderView `watch` 它 → `crossVolume.maybeContinue(false, 'next')` → 看 `settings.continueToNextVolume` 模式（off/auto/manual）。
- 末页再向下触发：`reader.nextPage()` 内部检查 `isAtLastSpread`，若已在末页调注入的 `onAtLastNextAttempt` 回调（ReaderView 注入写 `slideshow.pendingNextVolume = true`），**不翻页**。序列边沿自动区分"翻到末页"与"末页再向下"，无需计时。
- **5 触发入口**（统一汇入 Controller）：
 - reader 末页再向下 / 滚轮 / 下键 / 触控 MR 区 → `slideshow.pendingNextVolume`（自动）
 - slideshow tick 末页 → 同一 flag（自动）
 - 9 宫格 `br=folder-next` / Alt+→ → `crossVolume.maybeContinue(true, 'next')`（force=true 不看模式）
 - 瀑布流工具栏"下一卷"按钮 → 独立 `onCrossNextVolume`（fileListRef.masonryFlushNow → findNextVolume → 双重陈旧校验 path+root → fb.navigate；不走 Controller/Loader）
- **pendingNextVolume 五处消费**（off 失败 / find 失败 / 导航成功 / 关闭胶囊 / 关闭 Controller 内部 clearPendingState）。
- **manual 模式**：crossVolume 填 `pendingCrossVolume` + `identityAtArm`（冻结身份供 confirmManual 再校验），不消费 flag。点跳转 → `crossVolume.confirmManual()` → 二次校验（防 stale 跨卷）→ navigateResolvedTarget；点 ✕ → `dismissManual`（推 requestSeq 失效在途请求 + settleIdle）。
- **auto/force 模式**：导航成功 → resume slideshow（仅当调用前 isPlaying=true）+ 推 `jumped` toast。manual 模式不续播（用户主动确认，由 confirmManual 自己的 capsule 提示）。
- 处理完后调 `consumePendingNextVolume()` 清 flag，避免重复触发。
- **route 是当前卷身份唯一真值**：跨卷走 `navigateToVolume(ensureBookId+router.replace)` → route watch（immediate:true）→ `loadRouteBook` 加载新卷。**不**"先加载再 replace"——那是双入口。

### 1. UI / UE 规范

**1.1 视觉风格基线**（与 Xplorer Next / Perfect-Viewer 对齐，参考 [`xplorer-next/apps/client/src/`](file:///F:/WorkSpaceCollection/git/xplorer-next)）

- **配色**：Tokyo Night 暗色，`--color-bg` `#0a0a1a` 渐变到 `#1a0a2e`；accent indigo `#6366f1`；文件类型色：folder=indigo、image=green `#34d399`、archive=orange `#fb923c`、video=ping `#f472b6`、audio=purple `#a78bfa`。
- **Tailwind v4 `@theme`**: 所有颜色 token 集中在 `src/styles/tailwind.css` 的 `@theme {}` 块声明，组件**只用 Tailwind utility class**（`bg-surface-1` / `text-accent` / `border-text-tertiary` 等），不用 scoped CSS 变量 hex 写死。
- **CSS 变量分两层**：`@theme` 生成的 `--color-*`（Tailwind utility 源）+ 组件 scoped CSS 里的 `var(--color-*)` 引用。**不要在模板里写 `style="background: #xxxxxx"`**，要写 utility。

**1.2 工具栏 / 按钮（Xplorer OperationBar 风格）**

- 容器：`bg-surface xp-bdb px-3 py-1.5 flex items-center gap-1 flex-wrap`，**无圆角、无 backdrop-blur**（Xplorer 真实风格）。
- 按钮统一 `.tb-btn` class：`text-xs (12px) px-2 py-1 gap-1 text-text-muted hover:bg-surface-light hover:text-text-primary transition-colors`，激活态 `text-accent`。
- **按钮间的分隔条**：`<span class="xp-divider-v shrink-0" />`（1px 垂直 token 化边，dark: 白/10，light: slate-300）。
- **图标尺寸**：12px（按钮内的 SVG）；16px（empty state 大图标）；14px（按钮外的列表图标）。
- 所有 SVG icon 用 `const ICON_X = 'm...lucide path data'` 形式内嵌在父组件 script 顶部，**不**用 lucide-vue-next / lucide-react 包，统一无依赖。
- **v0.1.0-module3.0-settings 视觉 token 化**：所有 1px 边框用 `xp-bd` / `xp-bdb` / `xp-bdt` / `xp-bdl` / `xp-bdr` / `xp-bdy` / `xp-bdx` utility（src/styles/tailwind.css @layer utilities），底层 var(--color-border-default)，dark/light 双主题自动切换。**禁用** raw `border-white/5` / `border-white/10` / `bg-white/10`（light 模式下不可见）。

**1.3 Dropdown（Xplorer 真实模式）**

三层结构，**不要**用 `<select>` 原生下拉（丑且 WebView 渲染不一致）：

```
<div class="relative" ref="dropdownRef">      ← 容器
  <button @click="open = !open">...</button>   ← trigger
  <div v-if="open" class="absolute left-0 top-full z-50 mt-1
       min-w-[170px] bg-surface-4 xp-bd
       rounded-lg py-1 shadow-xl backdrop-blur-xl">
    <button v-for="opt" class="flex w-full items-center px-3 py-1.5
         text-left text-xs hover:bg-surface-light"
         :class="opt.field === current ? 'text-accent' : ''">
      <span>{{ opt.label }}</span>
      <svg v-if="..." ... ArrowUp/Down 11px />
    </button>
  </div>
</div>
```

`click-outside` 关闭（Xplorer OperationBar 模式）：

```ts
onMounted(() => document.addEventListener('mousedown', onMouseDown))
onUnmounted(() => document.removeEventListener('mousedown', onMouseDown))
function onMouseDown(e: MouseEvent) {
  if (!dropdownRef.value?.contains(e.target as Node)) open.value = false
}
```

**1.4 列表行（FileList 行级规范）**

- 行高 `py-1.5 px-3`（紧凑 Xplorer 风格）；padding `p-2 px-3` 也可。
- 间距：name `gap-2`、icon `width: 18px`、text `text-xs (12px)`。
- 选中/未读/已读状态**只通过 scoped CSS class 切换**（`is-selected` / `is-reading` / `is-finished` / `is-directory` / `is-archive`），模板里 `:class` 数组或对象字面量。
- 图标 + 名字 + 状态 badge 三段式，badge `margin-left: auto` 推到右侧。
- **列表行 hover 颜色**：用 `--color-surface-light`（实色 `#161630`），**不是** 半透 `--color-surface-2`（Xplorer 用实色）。

**1.5 选中与多选**

- 单击 = 选中（更新 `selectedPaths` Set），双击 = 打开（emit `open`）；Enter = 双击，Space = 单击。
- `ctrlKey / metaKey` → toggle；`shiftKey` → range 选（依赖 `anchorPath` 记录上一次 click 的 path）。
- `selectedPaths` 是 `Set<string>`，key 用 `entry.path`，**不用** `entry.name`（同名文件会冲突）。
- 1 选中显示详情面板，多选不显示（Xplorer 也是）。

**1.6 详情面板字段规则**

- 全部前端**派生**（不要为 MediaEntry 元数据新增 IPC）。MediaEntry 字段：`name / path / isDirectory / isArchive / size / modifiedAt`（秒级）。
- 派生工具：`src/lib/mime.ts` 的 `extensionOf / mimeFromName`，`src/lib/format.ts` / `src/locales/helpers.ts` 的 `formatBytes / formatDate(seconds*1000, locale)`。
- **目录不显示扩展名**（避免 `VOL.11` / `S01.E03` 这类名字里的 `.` 误识别为扩展名），固定 `—`。
- **类型翻译用 i18n**：不要在模板里 `v-if="isDirectory"` 显示 `folder` 字符串硬码。用 `t('properties.typeDirectory')` 等 key。
- 字段缺失（`MediaEntry` 没有 `createdAt` / `accessedAt`）显示 `—`，**不要**为了填字段去 IPC。

**1.7 状态栏（Xplorer 三段式）**

- 左：`X 项 / 已选 Y 项 (Z MB)`；中：当前路径（`truncate` + `title` 是 full path）；右：暂留空（git / free-space 后续模块）。
- 容器：`bg-surface xp-bdt px-3 h-6 flex items-center justify-between gap-2 text-xs`。
- `role="status" aria-live="polite"`（屏幕阅读器友好）。

**1.8 Empty / Error / Loading**

- Empty state：图标放置在 `w-16 h-16 rounded-2xl bg-surface-1 xp-bd` 容器内，accent 色 stroke；下方 1 行 hint + 1 个 primary CTA（**主按钮不该是按钮组**，只能 1 个）。
- Error toast：`bg-error/8 border border-error text-error` + `shadow-[0_0_10px_rgba(248,113,113,0.3)]`（Xplorer 错误 glow）。
- Loading：单独 `<p v-if="fb.loading">` 行，**不要**用 spinner（Xplorer 也不滥用）。

### 2. i18n 约定

**2.1 namespace 命名（按模块 / 上下文）**

- `nav.*` — SideNav 标题（`fileBrowser / shortcuts / library / bookmarks / likes / history / accounts / settings / search`）
- `fileBrowser.*` — 文件浏览器 (`title / pickRoot / up / refresh / empty / sortBy / sortField.{name,date,size} / sortAscending / sortDescending / search / saveAsShortcut / shortcutLabel / shortcutSaved / noShortcut / goShortcuts / status.{finished,reading} / contextMenu.resetProgress / hideFinished / showFinished / viewMode / viewMasonry / viewDetails / masonrySettings / noImagesForMasonry / statusBar.{items,selected,path}`)
- `properties.*` — 详情面板 (`title / labelName / labelLocation / labelSize / labelType / labelExtension / labelModified / labelCreated / labelAccessed / noFileSelected / typeDirectory / typeFile / typeArchive / typeImage`)
- `search.*` — 搜索视图 (`placeholder / noResults / modeFuzzy / modeSubstring / resultsCount`)
- `common.*` — 通用 (`loading / cancel / save / etc`)
- `error.*` — 错误（`openFailed / fileNotFound / networkError / permissionDenied / timeout / ioError / unknown / pathTooLong`）
- `lang.*` — locale 切换 (`system / zh-CN / en-US`)

**2.2 命名规范**

- 用 camelCase 命名 key（`sortField` / `noShortcut`），**不**用 snake_case 或 kebab-case。
- 复数用 `items` / `selected`（不带 `Count` 后缀，靠 `count` 参数区分）。
- 状态值用 `finished` / `reading`（过去式 / 现在进行时），**不**用 `is-finished` / `is-reading`（那是 class 名）。
- 占位符 `{count}` / `{name}` / `{size}` — vue-i18n 模板里直接 `{count}`。

**2.3 中英文档对齐**

- **每个 i18n key 在 zh-CN.ts 和 en-US.ts 都必须存在**（type-check 不强制，但 raw value 缺失会 fallback 留 warning）。
- 翻译只在本文件里写一次，**不**在组件里 `$t('fileBrowser.sort')` 字符串硬编码。
- 新增 key 时**务必同时改两个文件**，避免后续 CI 失败。

**2.4 模板里调用**

```vue
<!-- 简单 -->
<span>{{ t('fileBrowser.empty') }}</span>

<!-- 带参数 -->
<span>{{ t('fileBrowser.statusBar.items', { count: total }) }}</span>

<!-- 缺 fallback 时 (测试里用) -->
<p>{{ $t?.('fileBrowser.empty') ?? '空目录' }}</p>
```

**2.5 业务值不要翻译**

- 文件名、路径、shortcut label、tag 名、bookmark label —— **保留原文**（用户输入的）。
- enum 值（如 `source: 'library' | 'bookmark' | 'history' | 'tag'`）—— 后端 schema / IPC 通信用，**不**翻译；UI 显示时通过 `t()` 映射。

### 3. 代码约定

**3.1 Component 命名 & 路径**

- PascalCase：`FileBrowser.vue`、`SortDropdown.vue`。
- 路径：`src/components/<feature>/<Component>.vue` 或 `src/views/<Page>.vue`。
- view（页面）放 `src/views/`，业务组件放 `src/components/<feature>/`。
- 纯逻辑（无 Vue 依赖）放 `src/lib/`，可独立测试。

**3.2 Props / Emits 命名**

- Props：`camelCase`，类型用 `interface` 声明，常量 `default` 用 `withDefaults`。
- Emits：`camelCase`，**总是**用 `defineEmits<{ (e: 'name', payload: Type): void }>()` 签名。
- 事件名与 prop 同名时，**不**用 `update:propName`（Vue 3 v-model 风格，只是有些场景适用）。
- 受控 prop 写注释说明父级必须 watch。

**3.3 Store 设计**

- Pinia setup store（`defineStore('id', () => { ... })` 风格）。
- state 全部 `ref`，派生用 `computed`，actions 是普通函数。
- **持久化 state**：调用 `useSettingsStore().update('key', value)`，**不**直接调 `setSetting`。store 内统一 `persist('fb_xxx', value)` 包装。
- **跨视图共享 state**（如 sortField / viewMode / selectedPaths）放专门 store，**不**放组件 local state。
- **视图临时 state**（如当前 dropdown 是否展开）放组件 `ref`。
- **域枚举 / 默认值**（v0.1.0-module3.0-settings 起）：阅读器相关枚举（`ScaleMode / ReadDirection / TouchZone / TouchAction`）+ 默认值（`DEFAULT_TOUCH_SCHEME` / `DEFAULT_SCALE_MODE` / `DEFAULT_READ_DIRECTION`）放 `src/lib/readerSettings.ts`，**无 Vue / Pinia / Tauri 依赖**，可独立 vitest。让 store 与 view 都依赖这一个模块，避免重复定义。

**3.4 IPC 桥接 (`src/lib/tauri.ts`)**

- 所有 `invoke()` 调用集中在本文件，**不**在组件里直接 `import { invoke }`。
- 函数命名：`listX / getX / addX / removeX / setX / recordX`（读 / 写 / upsert / delete / update / upsert）。
- TS 函数包装返回**纯类型**（不返回 Rust 原生 enum），前后端边界翻译在 `tauri.ts` 里完成。
- SourceDescriptor 字段命名：Rust `snake_case`，TS `camelCase`（Tauri 自动转换）。

**3.5 后端 → 前端类型同步**

- Rust `serde(rename_all = "camelCase")` + TS `interface` 字段名 `camelCase`，**字节级一致**。
- 改 Rust 端 struct 必须同步改 TS 端 interface + 加 regression test（参考 `src-tauri/src/source/descriptor.rs:171-187` 现有模式）。

**3.6 不能做的**

- ❌ 写 `any` / `as any`（TS 严格模式开启）。
- ❌ 用 `@ts-ignore` / `@ts-expect-error` 掩盖错误。
- ❌ 直接 `import { invoke } from '@tauri-apps/api'`（必须经过 `lib/tauri.ts`）。
- ❌ 在组件里写 `console.log` 调试（用 `src/lib/logger.ts` 的 `log()` 写文件日志）。
- ❌ 在 commits 里写 `🤖 Generated with Claude Code`。
- ❌ 编辑类功能（新建 / 重命名 / 删除 / 复制 / 粘贴 / 拖放）—— 用户明确不做。
- ❌ 验证功能时截图（验证靠 type-check + 单测 + 本地 build，不依赖视觉截图；`screenshots/` 目录不入仓，.gitignore 已隐式不跟踪空目录）。
- ❌ 在 `tauri::generate_handler!` 自动发现外漏掉注册命令。
- ❌ hardcode 颜色 / 字体大小（必须用 `@theme` token 或 Tailwind utility）。
- ❌ raw Tailwind `border-white/*` / `bg-white/*`（light 模式不可见，必须用 `xp-bd` / `xp-bdt` 等 token 化 utility）。
- ❌ scoped CSS 写 `border: 1px solid #xxx` 等硬编码 hex（与 theme token 切换冲突，应改用 utility class）。
- ❌ scoped CSS 用 `var(--ease-out)`（**该变量在 tailwind.css 未定义**，浏览器会 fallback 无缓动；用 CSS 关键字 `ease-out` 或具体 cubic-bezier）。注：FileList.details-header button / FileBrowser.tb-btn 预存在此问题，留后续清理。

### 4. 测试约定

**4.1 框架**

- Vitest + happy-dom（前端组件 / Pinia store / 纯函数）。
- Rust: `cargo test`（algorithm 全 pure + 部分 commands）。

**4.2 命名规范**

- `*.test.ts` 文件与被测文件同目录同级。
- describe 块用被测组件 / 函数名。
- it 描述用中文：`'click trigger 打开弹出层' / '空数组返回空'`。

**4.3 mock 模板**

```ts
vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listDirectory: vi.fn(), getSetting: vi.fn(async () => null) };
});
```

**4.4 必须测试**

- 所有 `*.test.ts` 文件**先写测试**（TDD 风格）。
- 单测跑：220 → 259 → 393 → 397 → 462 → 535 → 582 → 717 → **799** 用例（v0.1.0-module3.0.9 跨卷 +82 增量：useCrossVolume 27 + useReaderBookLoader 11 + ContinueNextVolumeToast 6 + ContinueNextVolumeToast 审查 + ReaderView 编排 + useReaderHotkeys actions + 瀑布流 flushNow/转发链 + useMasonryBrowsePosition 调整 + A7 两补 + 各项回归），目标 0 fail。Rust lib 单测 209 中跨卷 30 新测试全绿，pre-existing **177 pass / 2 fail**（`test_crumbs` / `parse_propfind` 与跨卷无关，详见 `docs/superpowers/reports/2026-08-11-feature-matrix.md` §1.5）。
- 任何新组件至少 1 个 default + 1 个 edge case（null / empty / disabled）。

### 5. Tag / Commit / Branch 约定

**5.1 模块 → Tag 命名**

- 模块内每个里程碑：`v0.1.0-module1.NN` （NN 从 17 开始计数：m1.17 / m1.20 / m1.21 / m1.22）。
- 跨模块：`v0.2.0-module2.0`。

**5.2 Commit 格式**

- 中文写 commit message（项目主要维护者中文）。
- 第一行 `[scope]: [简述]`，正文分点列改动。
- 引用 issue 时写 `Refs #123` / `Fixes #123`。
- 一个 commit = 一个可独立跑通的概念（比如"加 SortDropdown" 不要混"加 listDirectory IPC"）。

**5.3 提交流程**

```bash
# 1. 跑全测 + type-check
npm run type-check && npm test -- --run

# 2. 本地 build portable exe (可选 — 验证新增组件)
powershell.exe -ExecutionPolicy Bypass -File "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\scripts\\build-portable.ps1"

# 注: 现行脚本是 scripts/build-portable.ps1（旧根目录 tauri-build-portable.bat 已删除，勿引用）.
#   - 五步管线: 杀运行实例 -> npm run build -> build-tauri-inner.bat (vcvars64 + tauri build --no-bundle) -> copy exe -> MD5 校验
#   - 会杀掉正在运行的 dev/portable 实例; 产物 mirapage-desktop-local.exe 与 dev 共享 DB
#   - copy 3 次重试, 失败明确报错不静默

# 3. commit + tag + push
git add <files>
git commit -m "..."
git tag v0.1.0-module1.NN
git push github main
git push github v0.1.0-module1.NN
```

**5.4 不要 commit 进 git**

- `mirapage-desktop-local.exe`（本地 build 产物）
- `backend.diff / full.diff`（诊断遗留）
- `tsconfig.tsbuildinfo`（vue-tsc 缓存）

> `scripts/build-portable.ps1` + `scripts/build-tauri-inner.bat` **例外**：打包脚本 commit 进 git 便于跨机复用（现行 ps1 自 v0.1.0-module3.0.1+ 起接管；旧根目录 `tauri-build-portable.bat` 已删除）。

### 6. 决策记录（用户拍板）

- **CLI 风格 vs GitHub 风格**：用户偏好简洁中文 commit，**不要**保留 `🤖 Generated with Claude Code` co-author 提示。
- **编辑类功能**：用户明确不做（新建 / 重命名 / 删除 / 复制 / 粘贴 / 拖放）。后续 plan 不规划这些。
- **每个模块集中一个 milestone tag**（不要按子功能打多个 tag）。
- **本地构建优先**（BUILD.md §1.0）：Rust 改动先本地 `cargo check` + `cargo test`，再 push CI 验证。
- **不做百分比进度**（Xplorer / Perfect-Viewer 都用枚举三态）：阅读状态只用 `reading / finished / none` 离散值。
- **plan 文件位置**：`C:\Users\jl0476\.claude\plans\`，每次 plan 完整覆盖（不再 plan 旧内容，diff 友好）。
- **Rust 端不调 IPC 拿 metadata**（如 `get_detailed_file_properties`）—— 全部由前端 `extensionOf / mimeFromName / formatBytes` 派生，避免 Rust 端命令膨胀。
- **numbering 范围**：MediaEntry 字段就 6 个（`name / path / isDirectory / isArchive / size / modifiedAt`），不要为了详情面板扩字段（`createdAt / accessedAt / mime / extension` 等由前端派生）。
- **library 只显示 is_favorite=1**（v0.1.0-module3.0）：用户反馈明确；Android LibraryScreen 模式扩展（Android UI 仍列全部，桌面端过滤更严）；temp row 用于 progress 持久化但不显示
- **history 重写为 folder-level**（v0.1.0-module3.0）：Android BrowseHistory 直接对齐；旧 per-book 行丢弃
- **`book` 表重命名为 `library`**（v0.1.0-module3.0）：与 Android LibraryEntity 字节级镜像，简化 backup/restore 对接
- **per-folder 排序覆盖**（v0.1.0-module3.0）：Android DirectorySortEntity 对齐；`locationKey = JSON.stringify(sourceDescriptor) + "|" + relPath`
- **9 宫格触控 master toggle**（v0.1.0-module3.0-settings）：用户可在 Settings § Touch 顶部 BooleanRow 启用/关闭整 9 宫格点击（`touch_zones_enabled`，DB key，默认 `true`）。`useReaderTouchZones` 入口守卫 `if (!settings.touchZonesEnabled) return;`。每个区单独的 `none` 动作也可禁用单格。
- **breadcrumb 不要内层圆角矩形**（v0.1.0-module3.0-settings）：nav 用 `bg-surface xp-bdb px-3 py-1.5` 即可，**不要** inner `xp-bd rounded` 框，段间 chevron + 段按钮 `text-text-muted hover:bg-surface-light hover:text-text-primary` 即可。validation 反馈改用 `inset 2px 0 0 0 var(--color-success|error)` box-shadow 左侧条。
- **Settings section 卡片化**（v0.1.0-module3.0-settings）：5 个 section 各自 `bg-surface-1 xp-bd rounded-lg p-6`，parent `flex flex-col gap-6 max-w-[800px]` 自带间距；删 `<hr class="border-white/5 my-8">` 暗色专用分隔（light 不可见）。
- **Bookmarks / 旧 scoped CSS 视图迁移**（v0.1.0-module3.0-settings）：所有 `<style scoped>` 里 hardcoded hex CSS（`#2a2a2a` input bg / `#444` border 等）必须改用 Tailwind utility + xp-bd token。逐个迁移：Bookmarks.vue 已重写。
- **light theme token 1:1 迁移自 xplorer-next**（v0.1.0-module3.0-settings）：`tailwind.css` 在 `@theme` 块定义暗色 Tokyo Night token，在 `:root:not(.dark)` 块覆写浅色 xplorer-next `.theme-light` 同款 token（`#ffffff` bg、`#1e293b` text-primary、`#3b82f6` accent 等）。`useThemeSync` 切换 `html.dark` class。基线仍是 Tokyo Night 暗色（CLAUDE.md §1.1 设计基线不变）。
- **reader 排序与 file browser 一致**（v0.1.0-module3.0.2-reader-polish, `83cc3d0`）：`ReaderView.loadBook` 用 `useFileBrowserStore().effectiveSortField / .effectiveSortAscending` 替代硬编码 `naturalSort(name)`，复用 `lib/fileSort.sortEntries`；含 per-folder override（`directorySort` store 自动 resolve）。`?at=` 仍按 name 找 spread index，不受排序影响。**不要**在 reader 里单独定义 `sortEntries` 逻辑，**必须**复用 fileSort。
- **status.value = 'ready' 不能漏**（v0.1.0-module3.0.2-reader-polish, `8c04c34` 修复）：`openBook` 之后必须 `status.value = 'ready'`，否则 ReaderScreen v-else-if 永远不挂载。CLAUDE.md §0.1 注释强调过此约束（"给 openBook 之前准备 holds，openBook 之后立刻 ready"）。Contributors 改 loadBook 时务必保留此行。
- **瀑布流视图删 list/grid**（v0.1.0-module3.0.6-masonry）：ViewMode 收窄为 `details | masonry`。grid 被 masonry（图片真实宽高比）取代，list 与 details 信息重叠删除。工具栏视图切换用图标按钮直接切换（详情 ICON_DETAILS 在前 + 瀑布流 ICON_MASONRY），**不用下拉**（只剩 2 个视图）。老持久化值 'list'/'grid' 在 `loadLayout` fallback 到 'details'。
- **瀑布流布局参数双层**（v0.1.0-module3.0.6-masonry）：列数 / 列间距 / 行间距三个参数，per-folder override（工具栏 ⚙ popup，仅 masonry 出现）> 全局默认（Settings 页 masonry section）。复用 `directory_sort` 的 locationKey 模式（`directory_masonry` 表，三列可 NULL + COALESCE 部分更新，只写用户改过的维度）。默认列数 4（范围 2-8），默认间距 8px（范围 0-24）。
- **图片尺寸 Rust 读 header**（v0.1.0-module3.0.6-masonry）：新增 `list_image_dimensions` command 读图片 header（手写 JPEG/PNG/GIF/BMP 字节解析，纯 std 无 image crate）返回宽高。**这是对 §6 "Rust 不调 IPC 拿 metadata" 约定的合理边界外推**——该约束本意是"不为详情面板装饰字段加 IPC"，图片宽高是瀑布流布局骨架必需数据（无它虚拟滚动无法工作），与 `list_directory` 返回 size/modifiedAt 同性质。仅 masonry viewMode 触发，不进 MediaEntry 主字段。
- **瀑布流尺寸预读不全量**（v0.1.0-module3.0.6-masonry）：header 当懒加载资源，首屏可见 + 3 屏预读（动态，不硬编码 120 张），未测量用估算宽高比（3:4）占位，渐进式 totalHeight。适配本地挂载远程存储的慢速 I/O——不滚动不查。
- **瀑布流浏览位置 = progress**（v0.1.0-module3.0.8-masonry-browse-position）：复用 `progress` 表加 `image_name` 列（不新建表，不存 scrollTop 像素值），存"顶部可见图"文件名作持久锚点；page 列保留做 reader fallback。masonry 滚动主导写（300ms debounce + 同图去重）+ reader 翻页双写 image_name。`save_progress` 固定参数化 SQL + `COALESCE`/`CASE WHEN` 保 4 组合语义（无 `format!`）。
- **浏览位置 enabled 只控制写不控制读**（v0.1.0-module3.0.8）：关闭"记录进度"仍能手动跳（toolbar「↶ 跳到上次」+ 顶栏立即阅读根据 progress 记录 enable）。`6d9b1b9` 加控制 -> `d98695c` 取消，反复后最终结论（audit-fix P1 还原原意）。
- **mark_finished 不清 image_name**（v0.1.0-module3.0.8）：reset 后仍跳原位置（设计取舍，等用户反馈）；`mark_finished_inner` ON CONFLICT 只 SET finished + updated_at，不动 image_name。
- **resize 视觉焦点双层解耦**（v0.1.0-module3.0.8）：视觉层 `captureMasonryViewportAnchor`/`restoreMasonryViewportAnchor`（path+ratio 锚定，不按宽度比例换算）+ 数据层 500ms cooldown（colWidth 变化后丢弃 scheduleRecord），窗口尺寸变化不污染阅读进度。DB progress 与视觉焦点解耦。
- **跨卷三模式 off/auto/manual**（v0.1.0-module3.0.9，替换 v0.1.0-module2.0 拍板的 SWIPE）：v0.1.0-module2.0 写的"未来加 SWIPE 模式"在跨卷模块实施时**没**加——末页 Pager 越界 1/3 屏宽的 SWIPE 语义与桌面端键盘/鼠标交互耦合度高、ROI 低，本期省去。off/auto/manual 3 态覆盖 99% 场景。**未来如果用户反馈需要再补**（需配合 `useReaderWheel` 累计 1/3 屏宽，spec §12.3）。
- **A7 跨卷后 slideshow 续播 + jumped toast**（v0.1.0-module3.0.9）：spec §7.2 要求"auto/manual 共用 loadCrossVolume → openBook 后继续 slideshow"，E2E 发现原实现跨卷后 slideshow 被 `pause()` 但**没有 resume**——加了 `resumeSlideshow` opts 注入（Controller 在 `navigateResolvedTarget` 成功且 `wasSlideshowPlaying` 为 true 时调）。**manual 路径不续播**（用户主动确认，由 confirmManual 自己的 capsule 提示）。同时补任务 5 漏调的 `pushToast('reader.crossVolume.jumped', {title})`（spec §13 列了 4 类提示含"已跳转"但实现漏了）—— manual 仍不调（避免重复提示）。
- **目录身份 = SourceDescriptor + sourceRelativePath**（v0.1.0-module3.1.0-path-identity）：绝对路径**只允许**出现在 `SourceDescriptor.rootPath`；`currentPath`/`lastFetchedPath`/`browse_history.rel_path`/`library.absolute_path`（语义即 sourceRelPath，列名暂不改）/`shortcut.rel_path`/`thumbnail_cache.rel_path` **一律**必须相对 root，根目录用空串 `''`。任一写入这些字段的边界（navigate/up/fetch/createBook/recordHistory/createShortcut/listDirectory/thumbnail request）**必须**先过校验器：前端 `src/lib/relativePath.ts::validateSourceRelativePath`，Rust `algorithm::validate_source_relative`（双实现语义 1:1，改一边同步另一边）。校验失败不改前端导航状态、不发 IPC、不写库。切源用 `setRoot(newRoot)`（之后 relPath 从 `''` 开始），**绝不**靠把绝对路径塞进 `navigate()` 切根。
- **`fb.lastFetchedPath` 根目录 = `''` 不可 fallback**（v0.1.0-module3.1.0）：`getLastFetchedPath` 必须用 `fb.rootPath === null ? null : fb.lastFetchedPath` 区分「未加载 null」与「根目录 ''」。**禁** `fb.lastFetchedPath || fb.rootPath || ''` 这类 fallback —— 它把合法根目录 `''` 当 falsy 回退成绝对 rootPath，是本次污染首因。readFromImage 等消费方用 `=== null` 判未加载，不用 `!path`。
- **Rust 不信前端路径，join 前必校验**（v0.1.0-module3.1.0）：`LocalMediaSource::resolve_path` 与 `thumbnail::service::local_abs_path` 在 `Path::join` 前都调 `validate_source_relative`，失败返 `MediaSourceError::PathEscape` / `ThumbnailError::Invalid`。Windows `PathBuf::join(root, absoluteChild)` 会丢弃 root —— 这是 source 边界绕过的根因，**两个 join 点必须同步校验**，不能只修一处。写库 command（create_book/record_history/create_shortcut）把 descriptor 反序列化为 `SourceDescriptor` 校验后再序列化（规范 JSON），路径字段过校验。
- **快捷方式单一打开执行点**（v0.1.0-module3.1.0，spec §6.4）：`Shortcuts.vue onOpen` **只** `setActive(id) + router.push('/')`；实际 `setRoot + navigate` 在 `FileBrowser.vue::openShortcut(id)` 统一执行（watch activeId + onMounted 主动检查 + lastOpenedShortcutId 去重）。**禁**两处都 setRoot+navigate —— 会导致状态竞争。
- **异步 fetch 必带 requestId 防护**（v0.1.0-module3.1.0，spec §6.5）：`fileBrowser.fetch` 捕获 `myId = ++fetchRequestId`，`await listDirectory` 后 `myId !== fetchRequestId` 则丢弃回写（entries/lastFetchedPath/error/loading 都不写）；`setRoot` 开头 `++fetchRequestId` 失效所有在途请求（含 setRoot(null)）。改 fetch 时务必保留此守卫，否则跨 root/跨目录并发请求乱序返回会混合不同身份的 entries。
- **useReaderBookLoader 不留绝对路径兼容分支**（v0.1.0-module3.1.0）：移除 `isAlreadyAbs`（`/^[A-Za-z]:[\\/]/` 检测后直用绝对 absolutePath）。该分支是为污染数据开的逃生通道，让坏数据"仍能打开"掩盖问题（spec §4.3 兼容掩盖风险）。修复后 `absolutePath` 必须 source-relative，非法则显式抛错。Contributors 改 loader 时**禁**重新加回任何形式的"绝对路径容错"。

---

## 协作清单（开始新模块前）

- [ ] 读 `DESIGN.md` 对应章节
- [ ] 用 `brainstorming` skill 走需求 / 设计
- [ ] 用 `writing-plans` skill 写 plan（在 `C:\Users\jl0476\.claude\plans\`）
- [ ] 与用户确认范围（在 `AskUserQuestion` 里明确"不做"清单）
- [ ] `TDD`：先写测试 → 失败 → 实现
- [ ] `verification-before-completion`：跑 type-check + 单测 + 本地 build
- [ ] commit + tag + push，按 §5.3 流程
- [ ] 更新"当前状态"表格（本文件 + BUILD.md）
- [ ] 用户的反馈 → 记到 `MEMORY.md`（如果跨会话有用）