/res/# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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

## 当前状态（Phase 1-8 主体完成，3.0.x / 3.1.x 持续打磨）

| Phase | 内容 | 状态 |
|---|---|---|
| 1 | Tauri 骨架 + SQLite + `algorithm/` 纯函数 | ✅ |
| 2 | OpenSeadragon 阅读器 + 文件浏览器 + 阅读器路由 | ✅ `v0.1.0-module2.0`：`ReaderView` / `ReaderMainMenu` / 滚轮 / 轮播（9 宫格触控已于 3.0.12 移除） |
| 3 | 压缩包（CBZ/ZIP） | 🟡 ZIP ✅；RAR/7z 占位（`unrar`/`sevenz-rust` 注释未启） |
| 4 | 书签/喜欢/历史/书架/标签/搜索 | ✅ 10 个 commands + 9 个 Pinia stores；列表页已统一搜索、分页与快捷方式行样式 |
| 4.5 | 书库 / 阅览记录 / directory_sort（Android schema 对齐） | ✅ `v0.1.0-module3.0`：`library` 11 列 + `browse_history` folder-level + `directory_sort` per-folder |
| 5 | 跨卷连续阅读 + 幻灯片 | ✅ `findNextDirectory` + `slideshow` store |
| 6 | i18n（中/英） | ✅ TDD 双语一致性 |
| 7 | SMB 协议层 | ✅ `v0.1.0-module3.3.0-smb` 真实现（`source/smb/` 模块：`source` 5 方法实装 / `connection` TTL 懒回收 + 凭据解析 + 重建重试 / `real_transport` share_connect + query + read_block + 错误映射 / `mock_transport` 测试桩 / `transport` TransportError 分类 / `path` UNC 拼接 + share 根契约）；旧 `smb_impl.rs` 已删；accounts CRUD + keyring 凭据 + `test_connection` 沿用 M1（module3.2.0）。**待实机手测**：本机无 NAS/凭据管理器访问，spec §8 六项验收 spike 未实机跑（自动化 404 lib / 12 integration / 1126 前端单测 0 回归 + 编译/契约锁已覆盖） |
| 8 | WebDAV 协议层 | ✅ 真实现（`reqwest` + PROPFIND + Range GET） |
| 9 | 跨平台分发 | 🟡 CI 自动化 ✅；代码签名 / macOS `.dmg` / Linux `.AppImage` / 自动更新 ❌（`updater` 插件占位） |
| 3.0+ | 设置面板完整化 | ✅ `v0.1.0-module3.0-settings`：Settings.vue 重写（5 section + 锚点 nav）+ 9 宫格触控方案 + theme 切换 + i18n 45 keys（spec：`docs/superpowers/specs/2026-08-03-settings-panel-design.md`） |
| 3.0.2 | 阅读器打磨 + 立即阅读入口 | ✅ `v0.1.0-module3.0.2-reader-polish` 3 cluster（spec：`docs/superpowers/specs/2026-08-04-reader-polish-design.md`）：<br>**A 立即阅读入口** — `useReaderActions.readFromImage(image)` 双击图片 / 选中图片立即阅读（从该图开始）；`?at=imageName` query 携带起始图；FileBrowser `canReadNow` 扩到图片；ReaderView `route.query.at` 解析后优先用该图所在 spread（不做末页钳位）<br>**B 阅读器 UI 修复** — OSD `showNavigationControl: false` 修 #7 左上 X 图标 + #5 按钮被拦截；`inputBindings.closeReader: ['Escape']` + `useReaderHotkeys.dispatch` → `router.back()`；`ReaderOverlay` pointer-events 修复（外层 `pointer-events-none` + 按钮 `pointer-events-auto`）；`chromeShow = chromeVisible && !autoHide && (hovered || hoveredVisible)`（autoHide = isPlaying）实现 #8 幻灯片时隐藏 + hover 2s 临时显示；`tauri.conf.json` `minWidth: 800→480, minHeight: 600→360`<br>**C 6 种缩放** — `useReaderScale` composable + `settings.currentScaleMode` + `setScaleMode(mode)` 持久化为 `scale_mode` DB key；SinglePageViewer / DoublePageViewer `defineExpose({ getViewer/getBounds })` 给父级取 OSD 实例；6 mode 全接（fit-screen / fit-width / fit-height / original / full-screen / stretch）；9 宫格 `fitWidth` 改调 `setScaleMode`（立即 apply + 持久化）<br>Bugfix: `8c04c34` 恢复 `status.value = 'ready'`（被 Cluster A 改动误删，导致"加载中...卡住"）；`83cc3d0` reader 排序与 file browser 一致（`effectiveSortField` + `sortEntries`，含 per-folder override；`?at=` 按 name 找 index 不受排序影响） |
| 3.0.3 | 文件浏览器内搜索 | ✅ `v0.1.0-module3.0.3-search`（spec：`docs/superpowers/specs/2026-08-06-filebrowser-inline-search-design.md`）：Windows 风格——toolbar 常驻 SearchInput（150ms 防抖），输入即时过滤当前目录列表（仅当前层、非递归、子串匹配、大小写不敏感）；面包屑搜索态切静态文本"搜索结果 > 文件夹名"；状态栏显示"找到 N 项"；X 清除 / ESC 清空+失焦；进目录自动清空 query。复用 fileBrowser store 已有 searchQuery ref + setSearchQuery；新增 `lib/searchFilter.ts filterByQuery` 纯函数；displayedEntries 在 hotfix17 hideFinished 过滤上叠加 searchQuery 过滤。删除旧全局 `/search` 数据库元数据搜索全套（Search.vue / search store / 路由 / tauri.ts SearchHit / 后端 search 命令 / search.* i18n / 侧栏项）。残留孤儿（settings.ts SearchMode/search_mode、fileBrowser.search='搜索' 单 key）留后续清理。 |
| 3.0.4 | 文件浏览器虚拟列表 | ✅ `v0.1.0-module3.0.4-virtuallist`（spec：`docs/superpowers/specs/2026-08-06-large-folder-perf-design.md`）：手写 `useVirtualList` composable（~80 行）+ FileList 三视图统一虚拟化 + viewMode 切换 DOM 复用（CSS `:not()` 显隐）+ 算法层顺手修 4 个 O(n²) hot path（`pathIndex` O(1) / `toggleSelection` in-place + `triggerRef` / `readStatus.finishedSet` O(1) / `displayedEntries` 单次循环合并 fast path）。**E2E 实测**：14949 entry "AI" 目录 DOM 节点 194,485 → 1,284（**151×**）；JS heap 167 MB → 32 MB（**5.3×**）；搜索 "page" 后 DOM 1,284 → 137（**1,415×**）；hover 200 次 avg 0.002ms / longtask 0；滚动到底 clamp 正确。msedgewebview2 总内存预期 1.5 GB → 300-500 MB。完整 E2E 报告 `docs/superpowers/reports/2026-08-06-virtuallist-e2e.md`（commit b6ad078）。<br>**11 hotfix（同 tag，已 merge）**：<br>(1) `17ed8ea` 删孤儿 `lib/searchFilter.ts`（v0.1.0-module3.0.3 内联后无 caller）<br>(2) `fff103d` statusbar 路径分隔符统一 `/` + VirtualRow 选区 outline 不再三重叠<br>(3) `b54eb98` row view block `height: 100%` 撑满 29px row host（消除 11px 空白）<br>(4) `9f05db1` `formatDateTime` 加时分秒显示<br>(5) `04aea4c` 文件列表字体颜色加深（secondary → primary）<br>(6) `2082813` grid 视图用 CSS grid auto-fill 多列 wrap<br>(7) `3b25a9e` 全名浮窗 tooltip 恢复（Teleport to body）<br>(8) `915de53` tooltip gap 6px → 2px（紧贴）<br>(9) `4a9bca7` tooltip 对齐 hotfix15 原版（下方 4px + 左对齐）<br>(10) `d7f0aad` details 各数据列 truncate + scoped CSS 兜底<br>(11) `71c7730` name-cell `display: block`（span inline 不支持 ellipsis） |
| 3.0.5 | 快捷方式跨源 + 子目录 | ✅ `v0.1.0-module3.0.5-shortcut-cross-source`：对齐 MiraPage Android `ShortcutEntity`——schema 从 `(id, root_path UNIQUE, label, created_at)` 升级到 `(id, source_descriptor_json, rel_path, alias, icon_hint, created_at, UNIQUE(source_descriptor_json, rel_path))`，跨源（Local/Smb/WebDav/Archive）+ 支持子目录快捷方式。migration 007 用「重建表」标准模式 + Rust 行级迁移旧 root_path → Local descriptor JSON（避免 SQL 字符串拼接反斜杠畸形）。iconHint 本地派生（Rust `icon_hint_for` / TS `iconHintFor` 双实现，按 descriptor.type_str）。UI 图标 ⭐ STAR → 📌 PushPin（对齐 PV 教训：Star 被多次误解为书签，见 specs/2026-07-29-like-feature-design.md:301）。打开子目录 shortcut 走两步模式 setRoot+navigate(relPath)，复用 History.vue openEntry 模式。保留独立 `/shortcuts` 页面 + activeId 概念作为有意差异（Android 是 sheet 嵌入式无状态）。**有意差异 vs Android**：保留 INSERT OR IGNORE（不跟 Android 的 REPLACE，保留旧 alias 更友好）；保留独立页面；保留 activeId。前置依赖零新增：Rust SourceDescriptor 已 derive Serialize/Deserialize、TS 类型完整、list_directory 命令早已走完整 descriptor——shortcut 是唯一还在用裸路径字符串的异类，本次对齐到其他 4 个表范式。单测 535→539（+12 shortcut store/migration、+2 子目录用例，-10 旧 rootPath 用例调整）。 |
| 3.0.6 | 文件浏览器瀑布流 | ✅ `v0.1.0-module3.0.6-masonry`（spec：`docs/superpowers/specs/2026-08-07-masonry-layout-design.md`）：图片目录瀑布流视图——图片按真实宽高比拉伸 + 贪心放最短列（借鉴 v3-waterfall useLayout 算法，源码存 `docs/reference/v3-waterfall-master/` 仅供借鉴不引入依赖）+ 变高虚拟滚动扩展现有 `useVirtualList`。**删 list/grid 视图**，ViewMode 收窄为 `details \| masonry`，工具栏图标按钮直接切换（详情在前 + 瀑布流，非下拉）。**Rust 端**：新增 `algorithm/image_header.rs` 纯函数手写 JPEG/PNG/GIF/BMP header 字节解析（无 image crate，纯 std，双实现 TS `lib/imageHeader.ts`）+ `list_image_dimensions` command（tokio JoinSet + Semaphore 16 并发批量读 header，只读 256B）+ migration 008 `directory_masonry` 表（per-folder 列数/列间距/行间隔，三列可 NULL + COALESCE 部分更新）。**预读策略**：不全量拉尺寸，借鉴图片懒加载——首屏可见 + 3 屏预读，未测量用估算宽高比（3:4）占位，渐进式 totalHeight。**滚动锚定** applyMeasuredBatch（上方 item 尺寸到达补偿 scrollTop，E1 简化为 visibleRange 重算，实测无跳动）。**布局参数双层**：工具栏 ⚙ popup（仅 masonry 出现）per-folder override + Settings 页全局默认，复用 directory_sort 的 locationKey 模式。**慢速 I/O 适配**：Local 挂载远程存储场景，按需预读 + img lazy 字节按需 fetch。无图目录 masonry 按钮 disabled + 自动回落 details。**E2E 实测**（D:\Wallpaper\normal 224 entry）：虚拟化 224 → 10-28 DOM；列数 4→6 实时重排（width 254→169px）；⚙ popup 3 slider；滚动预读正常；双击图片进 reader 兼容。单测 539→582。**待打磨**（留后续）：像素级 scrollTop 锚定补偿、resolve in-flight cancel、hasImages 搜索态副作用、var(--ease-out) 残留（FileList.details-header/FileBrowser.tb-btn 预存在未定义变量）。 |
| 3.0.7 | 缩略图缓存（消除 4K 渲染卡顿）| ✅ `v0.1.0-module3.0.7-masonry-thumbnail-cache` 任务1-13 已完成（实时帧时间待本地实跑）（spec：`docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md`，plan：`docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md`，报告：`docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md`）。**根因**：4K 图 paint/decode + GPU 纹理（基线 max 313ms / 5 次 >100ms 掉帧；隐藏 img -> 18.6ms / 0，确认非 JS/图层），`new Image()` 原图预读不降像素量无效。**方案**：Rust 按列宽生成 WebP 缩略图（EXIF Orientation 1-8 像素归一化 + 像素预算 + 原子写），asset protocol 加载，图片字节不进 IPC。**Rust `thumbnail/`**：policy（尺寸档位/阈值/预算/并发纯函数 28 测）/ orientation（1-8 四角颜色集成测）/ generator（WebP 管线 + .tmp 原子写）/ key（SHA-256 cache_key，缓存根不参与）/ index（thumbnail_cache DAO + LRU + 文件一致性 + ensure_schema）/ scheduler（tokio actor：优先队列+in-flight 去重+worker/内存预算+stale 取消+cancel_all+老化 11 测）/ service（classify/evict/事件/迁移）/ migration（FsOps+manifest 状态机+copy/verify/resume/cancel/commit/rollback 7 测）/ commands（14 命令）。migration 009。**前端**：useMasonryLayout `selectPathsInPixelWindow` 像素窗口四组（半开区间，0px gap 不重不漏，设置驱动 ahead/idle）/ useMasonryThumbnails（去重 batch+80ms debounce+epoch+事件+retry，sourceRelPath/uiPath 路径模型）/ MasonryThumbnail（6 状态卡片，纯 transform spinner+120ms 淡入+失败重试 stopPropagation）/ MasonryView 移除 `new Image()` 接入队列（源码守卫，list_image_dimensions EXIF 方向归一化）/ settings 9 key（预设/custom 联动+runtime 推送+缓存位置迁移 UI）。**代码审查 P1/P2 全修**（路径模型/完成事件 key/LRU 保护/设置控制运行/EXIF 布局/Standard max_bucket/索引元数据/清空协调/EnumRow/提交完整性）。**验证**：前端 665 测试 0 error；Rust 缩略图 94 单测 + 4 管线集成 + 8 生成器集成全绿。**待跑**：本地 `npm run tauri:dev` 采集改造后实时 rAF 帧时间填报告。 |
| 3.0.8 | 瀑布流浏览位置 = 阅读进度 + 缩略图延续打磨 | ✅ `v0.1.0-module3.0.8-masonry-browse-position` / `v0.1.0-module3.0.8-thumbnail-polish`（两 tag 同点 `4f783ad`，其后 11 hotfix commit 待收尾打 tag）（spec：`docs/superpowers/specs/2026-08-10-masonry-browse-position-design.md`，报告：`docs/superpowers/reports/2026-08-10-masonry-policy-hit-rate.md`）：<br>**A 瀑布流浏览位置 = progress** - migration 010 `progress` 加 `image_name` 列（不动 page 兜底）；migration 013 对 history descriptor 做 canonical 化并清理存量重复记录；`save_progress` 改固定参数化 SQL + `COALESCE`/`CASE WHEN`（无 `format!`）保 4 组合语义（finished/image_name 各 Some/None）；`mark_finished` 不动 image_name（spec §2.2.4 P0）。`useMasonryBrowsePosition` composable：300ms debounce 写顶部可见图 + 同图去重 + bookId 30s 缓存 in-flight 去重 + activeStartSeq/writeSeq 双竞态保护 + sameDir 比 descriptor+path。topmostImage 3 级优先级（相交>上方>下方，过滤文件夹），page=`canonicalImageNames.indexOf`（来自 `fb.sortedEntries` 过滤图片，不受 UI 过滤）。`MasonryView.scrollToEntry` 渐进校正（立即跳估算位 + watch `layout.map.get(path).top` 最多 5 次/3s 静止停）。reader 恢复 `imageName->page->0` fallback 链。toolbar「↶ 跳到上次」按钮（仅 masonry，enable 绑 `lastBrowseProgress.imageName`）；顶栏「立即阅读」无选中走 `readFromCurrentPath(cachedProgress)`。Settings `fileBrowser` section + 2 BooleanRow（`fb_record_browse_position`/`fb_restore_browse_position_on_enter`）。**enabled 只控制"写"不控制"读"**（按钮永远能根据 progress 记录 enable）。转发链 FileBrowser->FileList->MasonryView->composable。spec v4 修 14 个 P0/P1/P2。<br>**B 缩略图延续打磨** - Rust `thumbnail/` 完整日志（service/scheduler/generator 走 main.log）+ worker `catch_unwind`（panic 不卡死队列）；`Priority` enum 加 `Display` impl（防御 `{}` 静默空字符串）；`classify` CACHED 决策前 `verify_disk_file`（索引不一致降级 GENERATE，修磁盘文件删但索引还在的脏命中）；worker 上限 4->16（设置驱动）。前端 `useMasonryThumbnails` 5 日志点（reqid 关联 + path 截断 + state event 采样防 flood）+ `listen()` catch `isTauriEnv` 防御（happy-dom 静默）。policy 命中率实测报告（620 张 5.76MP 手机照 100% Required，根因 `HARD_MAX_PIXELS=4MP`，渲染需求 0.22MP=26× 冗余；IO 不是问题，接受现状 D）。<br>**C resize 视觉焦点漂移修复** - `captureMasonryViewportAnchor`/`restoreMasonryViewportAnchor`（useMasonryLayout 纯函数：捕"穿顶线且 top 最大"图 + ratio 钳位[0,1]，恢复 `item.top+height×ratio`）+ MasonryView ResizeObserver 触发 anchor 捕获/恢复 + resizeSeq 防竞态 + 150ms 释放；`useMasonryBrowsePosition` 500ms cooldown（colWidth 变化后丢弃 scheduleRecord）。视觉层 anchor + 数据层 cooldown 双层解耦，窗口尺寸变化不污染阅读进度。**11 个 tag 后 hotfix**：`restoreAndScroll 受/不受 enabled 控制` 反复（最终 `d98695c` 不受，audit-fix P1 还原原意）、scrollToEntry watch 清理（corrections 局部+超限主动 stop+自校正起算 timeout）、4 unhandled rejection 源头（listen 防御）、resize 不触发 recordCurrentTop。**验证**：前端 665->717 测试（+52），Rust 缩略图 94->105 单测（+11，含 CACHED 一致性降级 4 测）+ progress 6 测 + migration 010 2 测全绿；type-check 0 error。**待跑**：本地 `npm run tauri:dev` 实时 rAF 帧时间填 `docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md`。 |
| 3.0.9 | Library → Likes 合并 | ✅ `v0.1.0-module3.0.9-likes-merge`（spec：`docs/superpowers/specs/2026-08-13-library-to-likes-merge-design.md`，plan：`docs/superpowers/plans/2026-08-13-library-to-likes-merge.md`）：去掉冗余"书库"+ 死表 `like`，统一为"喜欢"单一概念。**注：模块号 3.0.7→3.0.9（racyan 机器已占 3.0.7=thumbnail-cache + 3.0.8=browse-position）**。**数据层**：migration 011 `UPDATE library SET is_favorite=1 WHERE id IN (SELECT book_id FROM \`like\`)` 先合并数据再 DROP `like` 表（不丢用户数据；`like.book_id` 必有对应 `library.id`，UPDATE 安全）。**视图层**：删 `Library.vue` + `/library` 路由改为 `redirect: '/likes'`；重写 `Likes.vue` 用 `useLibraryStore.favorites` + 行内 ❤️ toggle；`router/index.test.ts` 新增（`push+isReady+fullPath` 验证 redirect，不用 `resolve()`）。**Reader**：删主菜单"加入书库"按钮；新增 `onToggleLike` 本地 handler + in-flight guard 防 round-4 P1 并发竞态；`ReaderView.test.ts` 新增连续 toggle + in-flight 测试。**SideNav**：删 library 项，likes 提到第 3 位。**FileBrowser 三入口**：文案 `fileBrowser.addToLibrary` → `reader.like`。**i18n**：删 `nav.library` / `library.*` / `reader.menu.library` / `fileBrowser.{,contextMenu.}addToLibrary` / 孤儿 `fileBrowser.inLibrary`。**4 轮代码审查 10 条反馈全闭环**：R1（migration 011 非 009 + 数据合并 + commands/mod.rs 删 + SideNav.test 改 + Reader book ref 同步 + Likes reader params）；R2（ReaderView.test 加连续 toggle + /library redirect）；R3（redirect 测试用 push 不用 resolve）；R4（onToggleLike in-flight guard 防并发竞态）。**预存在不修**：RowContextMenu.onResetProgress 查 book_id 落空；FileBrowser 入口按钮无"已喜欢"状态联动。 |
| 3.0.10 | Likes 页打磨：取消喜欢 + 浏览跳转瀑布流 | ✅ `v0.1.0-module3.0.10-likes-browse-jump`（spec：`docs/superpowers/specs/2026-08-13-likes-browse-jump-design.md`，plan：`docs/superpowers/plans/2026-08-13-likes-browse-jump.md`）：**A 取消喜欢明确化** — 行内 ❤️ 图标 toggle → 「取消喜欢」文本按钮（复用 `likes.toggleOff`，删孤儿 `likes.toggleOn`），点击后行消失语义不变。**B 浏览跳转瀑布流** — fileBrowser store 新增 `pendingOpenLocation` 一次性意图（`requestOpenLocation` 写入时清 `savedNavigationContext` + `shortcuts.clearActive()` 两类陈旧导航意图，防旧上下文滞留/shortcut 重挂载重放）；FileBrowser onMounted 在 `loadLayout()` 之后、`restoreNavigationContext()` 之前消费（校验 relPath → setRoot → navigate → setViewMode('masonry') 持久化；无图目录现有守卫回落 details）；Likes 每行「浏览」按钮写意图 + push('/')，非 Local 防御不渲染。对齐 shortcut activeId 收敛模式（2026-08-12 路径身份修复方向）。消费点后置结构性避开 loadLayout 覆盖 viewMode 的 IPC 时序竞争。单测 901→912（+11）。 |
| 3.0.11 | 单图缩略图生成阶段进度 | ✅ `v0.1.0-module3.0.11-thumbnail-per-image-progress`（spec：`docs/superpowers/specs/2026-08-14-thumbnail-per-image-progress-design.md`，plan：`docs/superpowers/plans/2026-08-14-thumbnail-per-image-progress.md`，**三轮审查 13 项闭环后实施**）：**Rust** — `GenPhase` 枚举（queued/decoding/resizing/encoding/writing，Serialize lowercase）+ `GenerationJob.on_progress: Option<Arc<dyn Fn(GenPhase,u64)>>`（不改 `GenerateFn` 签名；手写 Debug 跳过闭包字段）+ `generate_thumbnail` 4 阶段边界回调（复用 t0，elapsed 不含排队）+ `progress_closure_for` 注入（request/resubmit 两处）emit `thumbnail://progress`（非阻塞 `let _ =`）。**前端** — `ThumbnailState.generating` 扩展（phase/startedAt/generationStartedAt/timings）+ `pendingProgress` 竞态缓冲 + queued 回包 cacheKey 顺序守卫（防事件先到被降级/丢 phase）+ `progressSnapshots` 失败快照 + progress 监听 disposed 迟到解绑守卫；`MasonryThumbnail` 顶部居中阶段角标（generating 5 phase 图标 + **failed 错误角标**＝失败详情唯一事后入口）点击直传 DOM 元素（无 querySelector）+ `badgeInteractive` prop 下传（disabled + handler 双保险）；`ThumbnailProgressPopover`（`lib/thumbnailPosition.positionFor` 右→左→下→上 + anchorRect 补算 right/bottom + 失败 snapshot 时间线 + 外部 mousedown/ESC/切目录/toggle 关闭）；settings `fb_thumbnail_detail_popover` 开关（Settings fileBrowser section）。i18n `thumbnail.*` 13 keys 双语。**测试**：前端 912→950（+38）；Rust thumbnail 单测 +5（gen_phase×2/on_progress 顺序/progress 契约）。**已知**：cargo lib 1 个预存在失败（webdav parse_propfind，与本模块无关）。 |
| 3.0.12 | 移除阅读器 9 宫格触控 | ✅ `v0.1.0-module3.0.12-touch-zones-removal`（spec：`docs/superpowers/specs/2026-08-14-touch-zones-removal-design.md`，plan：`docs/superpowers/plans/2026-08-14-touch-zones-removal.md`）：**纯删除模块**——9 宫格触控整体移除（桌面端滚轮/快捷键/菜单/右键菜单已全覆盖，且全屏点击易误触）。删 3 整文件（`useReaderTouchZones.ts` + 23 测、`TouchRegionsOverlay.vue`）+ `readerSettings.ts` touch 类型体系（`TouchZone`/`TouchAction`/`DEFAULT_TOUCH_SCHEME` 等，引用面封闭无隐藏耦合）+ settings store `touchScheme`/`touchZonesEnabled`/`setTouchAction`/`resetTouchScheme` + Settings.vue Touch section（8→7 section）+ ReaderView `zoneActions` 10 回调 + ReaderScreen/ReaderMainMenu/ReaderOverlay 接线 + 主菜单「显示触控区」按钮。migration 014 `DELETE FROM settings WHERE key LIKE 'touch_%'`（含 001 大写枚举死数据 seed，+2 Rust 测）。**顺带清理**：`inputBindings.mouseRegionCommand` 半死代码（3×3 鼠标分区从未接线，`InputContext` 收窄 keyboard/wheel，`resolveHotkey` 删 ctx 参数）+ 16 个孤儿 `reader.*` i18n key + `settings.touch.*`/`touchAction.*`/`showTouchRegions` 双 locale。**行为影响**：`folder-prev` 失去唯一入口（原为 TODO 空实现可接受，跨卷 prev 留独立模块）；其余动作入口无损失。**测试**：前端 965→929（-36）；Rust lib 294 passed（migration 版本断言 13→14 两处同步）。 |
| 3.0.13 | 跨卷与阅读体验打磨（5 hotfix 直推 main，未打 tag） | ✅ 2026-08-15/16 实机 CDP 调试驱动：**A 瀑布流滚到底标 finished**（`b2a7b2d`）— `MasonryView.atBottom` computed 读非响应式 `el.scrollTop`，缩略图全缓存命中（布局在滚到底前已收敛）时 computed 永不重算、缓存冻结 false →「滚到底停留 1.2s（STABLE_MS）写 finished=true」从不触发（缓存命中率越高越必现）；改用 useVirtualList 响应式 `scrollTop.value` 参与判定，+2 组件级用例。**B 幻灯片跨卷自动续播**（`310dc02`）— 根因 `tick` 末页先 `pause()` 再置 flag，`maybeContinue` 入口读 isPlaying 恒 false → A7 `wasSlideshowPlaying` 永假不续播；修法 slideshow store 加 `pendingNextVolumeFromSlideshow`（置 flag 前捕获来源，consume 一并复位）+ `navigateToVolume` await `nextTick()+activeLoadPromise`（新卷 commit 后返回）+ resume 守卫式 start（phase ready 且 bookId=路由）；+4 用例，实机 E2E TIER1→TIER2 续播验证。**C 自动跨卷跳过已读完**（`a98d779`）— `find_next_volume` 加 `skip_finished`：`pick_sibling` 泛化 `pick_sibling_where(pred)` 方向迭代 + `sibling_is_finished`（(descriptor 序列化, validate_source_relative 归一路径) 查 library.id→progress.finished；无行=未读不跳）；仅自动路径（非 force 且 auto 档）传 true，manual 确认与 Alt+→ force 不跳；全读完=None；Rust +8 测。**D 跨卷排序与父目录生效排序一致**（`283cf34`）— 兄弟目录原硬编码 name 升序；现按父目录 `directory_sort` 覆盖（location_key 复用 directory_sort 命令的 Value 序列化，提取 pub(crate)）?? settings `fb_sort_*` 全局 ?? name 升序；`cmp_sibling` 镜像 TS `fileSort`（modifiedAt None 升序排末尾/降序反转到最前的怪癖一致）；Rust 端自动解析前端零改动（4 调用方天然一致），+8 测（find_next_volume 41 用例）。**E 跨卷记阅览记录**（`bf82c7e`）— recordHistory 原只在 useReaderActions/瀑布流入口，跨卷走 navigateToVolume→router.replace→loadRouteBook 漏记；修法 loadRouteBook 提交成功后统一 recordHistory（幂等 upsert，失败静默），+1 用例；实机佐证：修复前 TIER2 历史行停在跨卷前 23.5h。前端 929→937。 |
| 3.0.14 | 小件打包（9 项） | ✅ `v0.1.0-module3.0.14`（spec：`docs/superpowers/specs/2026-08-16-module3.0.14-small-fixes-design.md`）：**A** verify.yml 补 `cargo test` 步骤（Rust 回归不再静默）；**B** webdav `parse_propfind` 修复（`local_name()` 剥命名空间前缀 + Empty/展开式 collection 双路径，main 上红数月用例转绿）；**C** useCrossVolume `identity===null` 早退前消费 `pendingNextVolume`（对齐 canStart 分支）；**D** 新命令 `reset_progress_by_location`（descriptor JSON + `validate_source_relative` 归一精确匹配 library 行；清 `finished=0+page=0+image_name=NULL`，无行 no-op 不 upsert；图片项书=所在目录 `lastFetchedPath`）；**E** 新命令 `get_book_status` + FileBrowser 统一喜欢状态表（locationKey=`descriptorId+''+absPath` 防跨源串状态；per-key epoch 守卫防 in-flight 旧查询覆盖 toggle 终态；喜欢成功直写终态不回查）三入口（工具栏/详情面板/右键菜单）完整 toggle；**F** `var(--ease-out)` 清理 4 处（DESIGN 记 2 实测 4）；**G** DESIGN §16 / AGENTS 同步；**H** 右键删「重试缩略图」菜单项+死转发链（失败卡片 ↻ 原位按钮保留）；**I** 瀑布流选中描边环改 `::after` 置顶（`z-index:3`+`pointer-events:none`，3.0.7 缩略图卡片层盖住 outline 的视觉回归）。前端 937→945，Rust 全绿（+5 用例）。**I 项实机验证已过**（2026-08-16 devtools：选中环 ::after opacity 1 / accent 蓝实线 / z-index 3，pointer-events:none 不挡点击与双击进 reader，缩略图缓存 8/8 命中）。 |

| 3.1.0 | 竖条漫（webtoon）阅读模式 | ✅（spec：`docs/superpowers/specs/2026-08-17-reader-webtoon-design.md`，冒烟报告：`docs/superpowers/reports/2026-08-17-webtoon-smoke.md`）：第三种阅读模式 `single | double | webtoon`——原生滚动单列虚拟化（`webtoonLayout` 纯函数 ±2.5 屏窗口 + `list_image_dimensions` 渐进测量 epoch 防陈旧）+ Ctrl+滚轮鼠标锚点缩放 1–4× / 双击 1↔上次 + rAF 自动滚动（播放中滚轮临时变速 ±20% 2s 回落）+ 到底 停止→稳定 1.2s→标完成功→跨卷 autoEnd 状态机（四重校验五取消点）+ 进度双写防护（`useWebtoonProgress.flushNow` 串行写链，writeTail 恒 resolved）+ 模式切换 flush 屏障（三入口收口）+ Overlay/主菜单/右键/Settings 无效控件禁用。零 Rust 零 migration。3 轮代码审查闭环；实机冒烟全过（heap 恒定 14MB / 0 longtask / 幻灯片回归含 single tick+末页 toast+Space toggle）。前端 946→1023。 |
| 3.1.1 | 书签与列表页打磨 | ✅ 书签添加/跳转入口补齐并统一页码语义；Bookmarks/History/Likes/Shortcuts 四列表页复用搜索与分页组件，快捷方式采用统一行样式；新增窗口大小、位置、最大化状态退出记忆（`tauri-plugin-window-state`）。 |
| 3.1.2 | 阅览记录导出 JSON | ✅ `v0.1.0-module3.1.2-browse-history-export`（spec：`docs/superpowers/specs/2026-08-18-browse-history-export-design.md`，plan：`docs/superpowers/plans/2026-08-18-browse-history-export.md`）：数据结构对齐 Android MiraPage 导出 schema **v2（30 字段平铺命名空间）**，逻辑按桌面端 schema 重写——`commands/history_export.rs` 的 `build_export_doc` 纯函数（browse_history LEFT JOIN library[is_favorite→liked 布尔] / progress[pageIndex/finished/readerMode]，`last_visited_at DESC`；smb_host 与 archive_origin_host 联 account 表防 N+1；id 用导出序号[复合主键无自增]；sevenz→"7z"；readerMode 映射 single→SINGLE/double→DOUBLE/webtoon→VERTICAL_WEBTOON[对齐实际样本大写，未知值原样大写]；scaleMode/readDirection 恒 null[无 per-book 数据]；不适字段 null 但 key 保留；损坏 descriptor / origin=WebDav/Archive 跳过记 warnings）+ `export_browse_history` command（dialog 插件 Rust API blocking_save_file，取消返回 exported=false 非错误）+ `to_string_pretty`（2 空格 LF）+ `std::fs::write`。前端：`useHistoryExport` 状态机 composable（idle/exporting/done/failed + 3s 回落 + 取消静默，History 工具栏 + Settings maintenance 双入口共享）+ `lib/format.ts` 新建（本地时间戳文件名，规避 Rust 无 chrono）+ tauri.ts 封装 + i18n 6 keys。TDD 全程：Rust +12 用例（六 descriptor 变体逐字段断言/联表组合/warnings/顶层格式）前端 +11（format 3 + composable 5 + History 2 + Settings 1）；type-check 0 err / 前端 1096 / Rust 337 全绿。实机冒烟 7 项全过（2026-08-18 CDP：导出文件 30 字段序与参考样本 keys_unsorted 完全一致 / blocking dialog 不死锁 / 取消静默回 idle / 双入口）。 |

| 3.2.0 | M1 通用显示层（media:// 统一协议） | ✅ `v0.1.0-module3.2.0-media-display`（spec：`docs/superpowers/specs/2026-08-18-smb-remote-media-design.md` §3，plan：`docs/superpowers/plans/2026-08-18-media-display-m1.md`，9 轮审查 rev4-rev9）：`media://` 异步自定义协议（`register_asynchronous_uri_scheme_protocol`，图片字节不进 IPC；URL 单段 encode/decode 恰好一次 + 六形态固定段数 + 结构化路径校验；GET/HEAD/Range 200/206/416/403/404/502 + no-store）+ trait 新增 `stat()`（Local fs::metadata / WebDAV HEAD+Content-Length+Last-Modified / Archive ZIP 条目解压后 size；SMB M2）+ WebDAV Basic Auth（账户行 + keyring 密码）与 Range 强契约（206 或 200 恰等长，防 M3 分块污染）+ keyring 凭据（CredentialStore 抽象 + 新建失败回滚/type 不可变/删除先凭据后 DB+warning + `keyring = "3"` 启用 + Accounts.vue 密码框/type 锁定/残留 warning + 修 upsertAccount IPC key 误传 acct）+ `test_connection` 实装（webdav 真握手/smb 明确报错）+ 阅读器去 Local-only（parseSourceDescriptor 按 type 判别 + 四类源统一 mediaUrl + 类型拓宽 SourceDescriptor）+ History/Likes/快捷方式打开防御放开 + 浏览跳转 descriptor 化（`pendingOpenLocation {descriptor,relPath}` + `openDescriptorAt`，Likes 远程源「浏览」跳瀑布流可达）+ 本地 ZIP 全链路（双击 CBZ 进条目视图 `openArchive`/`exitArchive`/面包屑 ZIP 名点击退出/`up()` 顶层退出，archivePath 绝对路径）+ 瀑布流通用化（`masonryDescriptor` currentDescriptor 优先；remote 取源 actor：try_submit 非阻塞 + 并发 4/在途 64MB 双闸 + epoch 双检查 + PreparedRemoteTask 分类时刻完整快照）+ WebDAV 跨卷（`listing_kind` Local+WebDAV 放行 factory 列目录，SMB/Archive 明确报错）+ 远程图片预读预载（`media_cache.rs` 手写 LRU 256MB head=最新 + warm 会话协议 `advance_warm_session`/`warm_media_urls` 命令 + ReaderView openBook 后 await advance + 翻页预取后 3 张 + 卸载作废 + 账户变更整表清空）。**架构**：`Db` 内部改 `Arc<Mutex<Connection>>` + Clone（State<Db> 零改动，factory/WebDav 源持句柄取凭据）。**mediaUrl 直拼 URL**（convertFileSrc 对已编码 segment 二次 encodeURIComponent 双重编码，实测实锤后弃用）。前端 1096→1119（+23），Rust 337→371（+34），type-check 0 err，build 过。**手测清单 8 项待实机**（spec §3.7：本地三模式回归/本地 CBZ/远程 masonry/WebDAV 全能力矩阵/预读预载/Range 206·416/URL 攻击面/keyring 目检）。M2（SMB）/M3（远程 Archive 物化）另有计划。 |

**构建**：见 [`BUILD.md`](./BUILD.md)。Rust ≥ 1.96 需 `Cargo.toml` 的 `indexmap` 修复（schemars/indexmap 兼容性，详见 BUILD.md §2）。

**CI 自动化**：GitHub Actions 已端到端验证打包链路——`.github/workflows/verify.yml`（push/PR 触发：前端 type-check + test + build + 后端 `cargo check`）和 `.github/workflows/release.yml`（push `v*` tag 或手动触发：完整 release 构建 + 上传 portable exe 到 GitHub Release）。4 个 Release tag 已发布：`v0.1.0-ci-test`（MSI + NSIS 安装包）、`v0.1.0-ci-portable-v2`（portable 单 exe，当前可用）、`v0.1.0-module3.0-settings`、`v0.1.0-module3.0.2-reader-polish`。完整描述、产物路径、tag 发版命令见 [BUILD.md §5.3](./BUILD.md)。

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

**0.3 桌面端滚轮（`useReaderWheel.ts`）**

- `passive: false` 才能 `preventDefault()` 阻止页面滚动 + OSD 内部缩放。
- 250ms 节流避免 Mac 触控板惯性事件一次触发多页。
- `deltaY > 0` 下滚 = 下一页，`deltaY < 0` 上滚 = 上一页（与 Android 音量键一致）。
- 不区分水平滚轮（`deltaX`）—— 桌面端水平滚轮少见。
- `useReaderHotkeys` 也接管 `wheel`（走 `inputBindings.resolveHotkey`），二者并存：hotkey 走全局，wheel composable 走 containerRef，**只在 ReaderView 容器范围**生效。

**0.4 轮播 store（`useSlideshowStore`）**

- 运行时：`isPlaying / intervalMs / direction / loop` + `pendingNextVolume` ref。
- `start()` / `pause()` / `toggle()` 控制 setInterval。
- `reset()` —— 用户翻页/点击/滚轮时调用，**不影响 isPlaying** 仅重启 timer。
- `tick(onAdvance, onPrev, atLast)` 是回调式（**不直接调 reader store**，避免循环依赖）。
- 末页触发（v0.1.0-module3.0.13 语义）：`tick` 末页分支**先**记 `pendingNextVolumeFromSlideshow = true`（先于 pause()——续播判定靠来源标记，事后读 isPlaying 已是 false）→ `pause()` → `pendingNextVolume = true` → ReaderView 单一 watch 消费 → `crossVolume.maybeContinue(false, "next")`。
- `setInterval` 在 Node / happy-dom 返回类型不一致（`Timeout` vs `number`）—— `let timerId: any = null` 绕过。
- **v0.1.0-module3.0-settings 起**：interval / direction / loop **全部经 Settings 页 UI 改写**（§11 设置面板），不再是 ReaderMainMenu 单独的临时控件入口。

**0.5 跨卷意图 flag**

- `slideshow.pendingNextVolume` 是 ref，ReaderView 单一 `watch` 消费（手动末页 + slideshow 末页统一）→ `crossVolume.maybeContinue(force, dir)`（`useCrossVolume` 状态机：idle/resolving/awaiting-confirm/navigating + requestSeq/sameBookIdentity 竞态校验 + canStart 加载期守卫）。
- 处理完后调 `consumePendingNextVolume()` 清 flag + 清 `pendingNextVolumeFromSlideshow` 来源标记。
- 模式：settings `continue_to_next_volume` off/manual/auto 三态；Alt+→ force 直跳（不看档位）。
- **3.0.13 打磨**：① 幻灯片发起的跨卷在新卷 ready 后自动续播（来源标记捕获 + navigateToVolume await 加载完成 + 守卫式 start）；② 自动路径 `skipFinished=true` 跳过已读完相邻卷（manual/force 不跳，全读完=没有下一卷）；③ 兄弟排序=父目录生效排序（directory_sort 覆盖 ?? fb_sort_* 全局，Rust 端自动解析前端零传参）；④ 所有进 reader 的路径（含跨卷/直接 URL/重试）在 loadRouteBook 提交成功后统一 recordHistory（幂等，失败静默）。

**0.6 竖条漫 webtoon（v0.1.0-module3.1.0）**

- 完整设计见 DESIGN §12.6 + spec（`docs/superpowers/specs/2026-08-17-reader-webtoon-design.md`）。两条硬约束：
- **slideshow mode-aware**：webtoon 下 ReaderScreen 的 slideshow 接线 advance/prev 短路 no-op、`setIsAtLast` 恒 false——interval tick 完全不参与结束/跨卷，rAF autoEnd 状态机独占（否则 spread 不可见推进 + atLast 与滚动位置无关的错误时机跨卷）。Contributors 改 ReaderScreen 接线时务必保留此守卫。
- **进度双写防护**：webtoon 下卸载 / 跨卷 trySave / 模式切换必须走 `useWebtoonProgress.flushNow()`（串行写链，writeTail 恒 resolved），不得调 `reader.saveCurrentProgressNow()`（硬编码 'single' + 过期 spread 位置会覆盖 image_name）；阅读器内三个模式切换入口（ReaderScreen toggle-mode / MainMenu cycle-mode / ContextMenu cycle-mode）统一走 `onToggleReaderMode` flush 屏障。滚轮临时变速仅在播放中生效（未播放滚动不得改 factor）。

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
- **域枚举 / 默认值**（v0.1.0-module3.0-settings 起）：阅读器相关枚举（`ScaleMode / ReadDirection`）+ 默认值（`DEFAULT_SCALE_MODE` / `DEFAULT_READ_DIRECTION`）放 `src/lib/readerSettings.ts`，**无 Vue / Pinia / Tauri 依赖**，可独立 vitest。让 store 与 view 都依赖这一个模块，避免重复定义。

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
- ❌ 在 commits 里写 `🤖 Generated with Codex`。
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
- 单测跑：220 → 259 → 393 → 397 → 462 → 535 → 582 → 965 → 929 → **937** 用例（3.0.12 -36 移除 9 宫格；3.0.13 +8：atBottom 响应式 2 + slideshow 续播 3 + ReaderView 跨卷集成断言 1 + skipFinished 1 + 阅览记录 1），目标 0 fail。
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
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"

# 注: tauri-build-portable.bat 自 v0.1.0-module3.0-settings 起已 fix + commit 进 git.
#   - 自动识别 CARGO_TARGET_DIR (env 设了走 D:\compile\rust_target, 否则 src-tauri\target)
#   - 启动时检查旧 mirapage-desktop.exe 进程, 存在则 abort
#   - copy 失败不再静默吞错, 改 errorlevel 判断 + 明确错误

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

> `tauri-build-portable.bat` **例外**：自 v0.1.0-module3.0-settings 起 commit 进 git（带 `CARGO_TARGET_DIR` 适配 + 旧进程检测 + 错误可见性）。早期版本曾不入仓（"临时脚本写到 D:\compile"），现已统一入仓便于跨机复用。

### 6. 决策记录（用户拍板）

- **CLI 风格 vs GitHub 风格**：用户偏好简洁中文 commit，**不要**保留 `🤖 Generated with Codex` co-author 提示。
- **编辑类功能**：用户明确不做（新建 / 重命名 / 删除 / 复制 / 粘贴 / 拖放）。后续 plan 不规划这些。
- **每个模块集中一个 milestone tag**（不要按子功能打多个 tag）。
- **本地构建优先**（BUILD.md §1.0）：Rust 改动先本地 `cargo check` + `cargo test`，再 push CI 验证。
- **不做百分比进度**（Xplorer / Perfect-Viewer 都用枚举三态）：阅读状态只用 `reading / finished / none` 离散值。
- **plan 文件位置**：`docs/superpowers/plans/<YYYY-MM-DD>-<topic>.md`（工程内，跟 `specs/` + `reports/` 平级）。**不要**写到 `~/.Codex/plans/`（本机临时目录，无法跨机器同步）。每次 plan 完整覆盖（不再 plan 旧内容，diff 友好）。
- **Rust 端不调 IPC 拿 metadata**（如 `get_detailed_file_properties`）—— 全部由前端 `extensionOf / mimeFromName / formatBytes` 派生，避免 Rust 端命令膨胀。
- **numbering 范围**：MediaEntry 字段就 6 个（`name / path / isDirectory / isArchive / size / modifiedAt`），不要为了详情面板扩字段（`createdAt / accessedAt / mime / extension` 等由前端派生）。
- **library 只显示 is_favorite=1**（v0.1.0-module3.0）：用户反馈明确；Android LibraryScreen 模式扩展（Android UI 仍列全部，桌面端过滤更严）；temp row 用于 progress 持久化但不显示
- **history 重写为 folder-level**（v0.1.0-module3.0）：Android BrowseHistory 直接对齐；旧 per-book 行丢弃
- **`book` 表重命名为 `library`**（v0.1.0-module3.0）：与 Android LibraryEntity 字节级镜像，简化 backup/restore 对接
- **per-folder 排序覆盖**（v0.1.0-module3.0）：Android DirectorySortEntity 对齐；`locationKey = JSON.stringify(sourceDescriptor) + "|" + relPath`
- **移除 9 宫格触控**（v0.1.0-module3.0.12-touch-zones-removal）：`useReaderTouchZones` / `TouchZone` / `TouchAction` / `touchScheme` / `touchZonesEnabled` / TouchRegionsOverlay / Settings Touch section 整体删除；桌面端翻页/菜单/缩放/跨卷由滚轮 + 快捷键 + 顶栏/主菜单/右键菜单承载。migration 014 清理 `touch_*` settings key（含 001 的死数据 seed）。`folder-prev` 因此失去唯一入口（原为 TODO 空实现），跨卷 prev 留独立模块；`inputBindings.mouseRegionCommand` 半死代码一并删除。
- **breadcrumb 不要内层圆角矩形**（v0.1.0-module3.0-settings）：nav 用 `bg-surface xp-bdb px-3 py-1.5` 即可，**不要** inner `xp-bd rounded` 框，段间 chevron + 段按钮 `text-text-muted hover:bg-surface-light hover:text-text-primary` 即可。validation 反馈改用 `inset 2px 0 0 0 var(--color-success|error)` box-shadow 左侧条。
- **Settings section 卡片化**（v0.1.0-module3.0-settings）：5 个 section 各自 `bg-surface-1 xp-bd rounded-lg p-6`，parent `flex flex-col gap-6 max-w-[800px]` 自带间距；删 `<hr class="border-white/5 my-8">` 暗色专用分隔（light 不可见）。
- **Bookmarks / 旧 scoped CSS 视图迁移**（v0.1.0-module3.0-settings）：所有 `<style scoped>` 里 hardcoded hex CSS（`#2a2a2a` input bg / `#444` border 等）必须改用 Tailwind utility + xp-bd token。逐个迁移：Bookmarks.vue 已重写。
- **light theme token 1:1 迁移自 xplorer-next**（v0.1.0-module3.0-settings）：`tailwind.css` 在 `@theme` 块定义暗色 Tokyo Night token，在 `:root:not(.dark)` 块覆写浅色 xplorer-next `.theme-light` 同款 token（`#ffffff` bg、`#1e293b` text-primary、`#3b82f6` accent 等）。`useThemeSync` 切换 `html.dark` class。基线仍是 Tokyo Night 暗色（AGENTS.md §1.1 设计基线不变）。
- **reader 排序与 file browser 一致**（v0.1.0-module3.0.2-reader-polish, `83cc3d0`）：`ReaderView.loadBook` 用 `useFileBrowserStore().effectiveSortField / .effectiveSortAscending` 替代硬编码 `naturalSort(name)`，复用 `lib/fileSort.sortEntries`；含 per-folder override（`directorySort` store 自动 resolve）。`?at=` 仍按 name 找 spread index，不受排序影响。**不要**在 reader 里单独定义 `sortEntries` 逻辑，**必须**复用 fileSort。
- **status.value = 'ready' 不能漏**（v0.1.0-module3.0.2-reader-polish, `8c04c34` 修复）：`openBook` 之后必须 `status.value = 'ready'`，否则 ReaderScreen v-else-if 永远不挂载。AGENTS.md §0.1 注释强调过此约束（"给 openBook 之前准备 holds，openBook 之后立刻 ready"）。Contributors 改 loadBook 时务必保留此行。
- **瀑布流视图删 list/grid**（v0.1.0-module3.0.6-masonry）：ViewMode 收窄为 `details | masonry`。grid 被 masonry（图片真实宽高比）取代，list 与 details 信息重叠删除。工具栏视图切换用图标按钮直接切换（详情 ICON_DETAILS 在前 + 瀑布流 ICON_MASONRY），**不用下拉**（只剩 2 个视图）。老持久化值 'list'/'grid' 在 `loadLayout` fallback 到 'details'。
- **瀑布流布局参数双层**（v0.1.0-module3.0.6-masonry）：列数 / 列间距 / 行间距三个参数，per-folder override（工具栏 ⚙ popup，仅 masonry 出现）> 全局默认（Settings 页 masonry section）。复用 `directory_sort` 的 locationKey 模式（`directory_masonry` 表，三列可 NULL + COALESCE 部分更新，只写用户改过的维度）。默认列数 4（范围 2-8），默认间距 8px（范围 0-24）。
- **图片尺寸 Rust 读 header**（v0.1.0-module3.0.6-masonry）：新增 `list_image_dimensions` command 读图片 header（手写 JPEG/PNG/GIF/BMP 字节解析，纯 std 无 image crate）返回宽高。**这是对 §6 "Rust 不调 IPC 拿 metadata" 约定的合理边界外推**——该约束本意是"不为详情面板装饰字段加 IPC"，图片宽高是瀑布流布局骨架必需数据（无它虚拟滚动无法工作），与 `list_directory` 返回 size/modifiedAt 同性质。仅 masonry viewMode 触发，不进 MediaEntry 主字段。
- **瀑布流尺寸预读不全量**（v0.1.0-module3.0.6-masonry）：header 当懒加载资源，首屏可见 + 3 屏预读（动态，不硬编码 120 张），未测量用估算宽高比（3:4）占位，渐进式 totalHeight。适配本地挂载远程存储的慢速 I/O——不滚动不查。
- **resize 视觉焦点双层解耦**（v0.1.0-module3.0.8）：视觉层 `captureMasonryViewportAnchor`/`restoreMasonryViewportAnchor`（path+ratio 锚定，不按宽度比例换算）+ 数据层 500ms cooldown（colWidth 变化后丢弃 scheduleRecord），窗口尺寸变化不污染阅读进度。DB progress 与视觉焦点解耦。
- **Library → Likes 合并**（v0.1.0-module3.0.9）：删 `like` 表(死表,前端 Likes.vue 不读只 Reader ❤️ 写) + 整套 likes 后端/前端/store/IPC;视图层 Library 改名为 Likes(`useLibraryStore.favorites`),❤️ 一以贯之;Reader 主菜单删"加入书库"按钮(跟 ❤️ 数据语义重叠合并为单一入口);migration 011 `UPDATE library SET is_favorite=1 WHERE id IN (SELECT book_id FROM \`like\`)` 先合并数据再 DROP(不丢用户数据)。
- **自动跨卷跳过已读完的卷**（v0.1.0-module3.0.13，用户拍板 2026-08-16）：自动路径（幻灯片末页 / auto 档末页再翻）跳过方向上所有 `progress.finished=1` 的相邻卷，落到第一个未读卷；manual 档 toast 目标由用户确认、Alt+→ force 是显式跳卷，均**不跳**；方向上全读完视为没有下一卷（toast）；从未打开（无 library 行）或无 progress 行 = 未读不跳。判定在 Rust `find_next_volume`（`sibling_is_finished`），前端仅自动路径传 `skipFinished: true`。
- **跨卷排序与父目录生效排序一致**（v0.1.0-module3.0.13）：find_next_volume 按父目录 `directory_sort` 覆盖 ?? settings `fb_sort_*` 全局排兄弟目录（name/modifiedAt/size × 升降序），与文件浏览器视觉顺序一致；Rust 端自动解析（前端不传参，useCrossVolume/FileBrowser 手动按钮/prefetch 天然一致）；比较语义镜像 TS `fileSort`（含 modifiedAt 缺失值升序排末尾、降序反转到最前的怪癖）。
- **进阅读器统一记阅览记录**（v0.1.0-module3.0.13）：`loadRouteBook` 提交成功后统一 recordHistory，覆盖自动跨卷/直接 URL/失败重试等所有路径（此前只有 useReaderActions 打开动作 + 瀑布流进入目录）；与 actions 入口重复无害（record_history 幂等 upsert 只刷 last_visited_at）；失败静默不阻断阅读。
- **幻灯片跨卷续播语义**（v0.1.0-module3.0.13）：slideshow tick 发起的跨卷在新卷 ready 后自动续播；手动翻页发起且当时正在播放也续播；manual confirm 不续播（用户主动确认）。续播判定用 `pendingNextVolumeFromSlideshow` 来源标记（tick 内先于 pause() 捕获），不依赖入口时机的 isPlaying。

---

## 协作清单（开始新模块前）

- [ ] 读 `DESIGN.md` 对应章节
- [ ] 用 `brainstorming` skill 走需求 / 设计
- [ ] 用 `writing-plans` skill 写 plan（在 `docs/superpowers/plans/`，工程内）
- [ ] 与用户确认范围（在 `AskUserQuestion` 里明确"不做"清单）
- [ ] `TDD`：先写测试 → 失败 → 实现
- [ ] `verification-before-completion`：跑 type-check + 单测 + 本地 build
- [ ] commit + tag + push，按 §5.3 流程
- [ ] 更新"当前状态"表格（本文件 + BUILD.md）
- [ ] 用户的反馈 → 记到 `MEMORY.md`（如果跨会话有用）

---

## 禁用技能

本项目**不使用** AI 代码采纳率追踪。以下 skill 全部禁用，任何场景下不得调用：

- `zz-ai-adoption` / `zz-claude-ai-adoption` / `zz-Codex-ai-adoption`（及任何 `.bak` 变体）

具体约束：
- **禁止调用**上述 skill（即使触发词命中"commit""提交代码""采纳率"等）。
- **禁止在 commit message 里添加**采纳率备注、AI 生成标记、co-author 行。
- **禁止创建或维护 `.patch/` 目录**（该目录是 skill 的快照产物，本项目不需要）。
- `.patch/` 已加入 `.gitignore`，如已存在可安全删除。