# MiraPage Desktop — 设计文档

> 桌面端漫画阅读器。基于 Tauri 2.x（Rust 后端）+ Vue 3（前端）+ OpenSeadragon（图像渲染）。
> 新独立仓库，与 MiraPage Android 工程完全独立，不引用其代码。
>
> ⚡ **实测状态快照（2026-08-14）**：本文档是设计意图，实际落地状态以当前代码和测试为准。最新里程碑为 `v0.1.0-module3.0.11-thumbnail-per-image-progress`；当前 HEAD 已包含 module3.0.11 收尾 hotfix（缩略图角标文字、请求保底节流、滚动加载修复、history descriptor canonical 化与 migration 013 存量去重）。

---

## 1. 项目目标与范围

### 1.1 目标

打造一款跨平台（macOS / Windows / Linux）桌面漫画阅读器，对标 MiraPage Android 的核心阅读体验。

### 1.2 阅读模式（本期范围）

- **单页阅读**（Single Page）：1 张图 / 屏
- **双页阅读**（Double Page）：2 张图 / 屏，封面独占、奇数末页不并排

**本期不做**：条漫 webtoon（连续竖向滚动）、横条模式（LazyRow 横向滚动）、翻页动画。

### 1.3 功能清单（本期必做，按实现优先级排序）

**核心（前期完成）**：
| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 1 | 文件浏览器 | 本地目录浏览；面包屑导航；自然排序 | P0 |
| 2 | 阅读器 | 单 / 双页；缩放、平移；键盘快捷键；进度持久化 | P0 |
| 5 | 压缩包 | CBZ / CBR / ZIP / RAR / 7z 直接阅读（不解压整包） | P0 |
| 6 | 书签 | 当前页添加书签；列表查看；跳转 | P0 |
| 7 | 喜欢 | 标记 / 取消标记；列表查看 | P0 |
| 8 | 阅读记录 | 进入阅读器自动记录；列表查看；点击重读 | P0 |
| 10 | 书架收藏 | 收藏标记；书架视图；按收藏 / 最近阅读筛选 | P0 |
| 11 | 标签 | 创建 / 删除标签；为书打标签；按标签筛选书架 | P1 |
| 12 | 搜索 | 文件名 / 书名 / 标签模糊搜索（fuse.js） | P1 |
| 13 | 跨卷连续阅读 | 读完一本自动跳到目录中下一本（OFF / AUTO / MANUAL） | ✅ `v0.1.0-module3.0.9-cross-volume` 14 commits |
| 9 | 幻灯片 | 定时自动翻页；间隔 / 方向 / 循环可配置；播放 / 暂停 | P1 |

**远程源（后期完成）**：
| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 3 | SMB | 添加账户；测试连接；浏览 SMB 共享；阅读 SMB 中图片 | P2 |
| 4 | WebDAV | 添加账户；测试连接；浏览 WebDAV 服务；阅读 WebDAV 中图片 | P2 |

**横切**：
| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 14 | i18n | 简体中文 / English 两种语言；运行时切换；跟随系统 | P0 |

> **设计原则**：Phase 1-2 即定义 `MediaSource` 抽象（`SourceDescriptor` + trait），LocalMediaSource 与 ArchiveMediaSource 在 P0 实现，SmbMediaSource 与 WebDavMediaSource 留接口 stub，P2 阶段填实现。**新增远程源不影响 UI 代码**。

### 1.4 非范围（本期不做）

- Webtoon 模式
- 横条模式
- 下载到本地
- 配置备份 / 导入（与 Android `.pvbackup` 互导为未来工作）
- **主题配色**（4 套色板 `color_theme`）：已存值，未接 Tailwind（v0.1.0-module3.0-settings 仅落地 `themeMode`）
- 缩略图网格
- 远程图加载进度条
- 缩略图网格（瀑布流 masonry 视图 v0.1.0-module3.0.6 已覆盖"图片目录可视化浏览"需求；预生成缩略图缓存网格 v0.1.0-module3.0.7 + 3.0.8 已落地——见下文 ✅）
- i18n：本期仅中 / 英两种语言，其他语言为未来工作

> ✅ **已落地**（v0.1.0-module3.0-settings）：
> - **主题明暗切换**（`theme_mode`：system/light/dark → `html.dark` class + Tailwind v4 `dark:` variant）
> - **浅色主题完整 token**（`tailwind.css` `:root:not(.dark)` 块，1:1 移植自 xplorer-next `apps/client/src/index.css:140-188`）：slate 文本 + 蓝点 accent + 白底 / slate-200 边框。基线仍是 Tokyo Night 暗色（CLAUDE.md §1.1 设计基线不变）
> - **视觉边框 token 化**（`src/styles/tailwind.css` @layer utilities）：`xp-bd / xp-bdt / xp-bdb / xp-bdl / xp-bdr / xp-bdy / xp-bdx / xp-bd-subtle / xp-divider-v` 替代散落的 `border-white/5` / `border-white/10` / `bg-white/10`（light 模式不可见）。dark: 白/10, light: slate-300
> - **阅读器默认值**：默认阅读模式 / 默认缩放 / 默认阅读方向 / 翻到末页后
> - **行为**：屏幕常亮 / 界面语言
> - **幻灯片**：间隔（秒）/ 方向 / 循环
> - **9 宫格触控方案**（11 动作 + master toggle `touch_zones_enabled`），对齐 PV `TouchScheme.DEFAULT` —— **已于 3.0.12 整体移除**（migration 014 清理 `touch_*` key）
> - **Settings 面板卡片化**（5 section + 锚点 nav + `gap-6` 间距替代 `<hr>` 分隔线）
> - **Breadcrumb 去掉内层圆角矩形框**（纯文字 + chevron，nav 仅 `xp-bdb` 分隔条）

> ✅ **已落地**（v0.1.0-module3.0.2-reader-polish，spec：`docs/superpowers/specs/2026-08-04-reader-polish-design.md`）：
> - **立即阅读入口（双击图片）** — `useReaderActions.readFromImage(image)` 用父目录合成 MediaEntry 调 `ensureBookId(favorite=false)`，路由 `?at=imageName` 携带起始图。ReaderView 解析 `route.query.at` 优先用该图所在 spread（显式选择不做末页钳位）。FileBrowser `canReadNow` 扩到图片（之前仅 isDirectory）。
> - **阅读器 UI 修复** — OSD `showNavigationControl:false` 修 #7 左上 X 图标 + #5 按钮拦截；`inputBindings.closeReader:['Escape']` + `useReaderHotkeys.dispatch → router.back()`（无 history 时 fallback `push('/')`）；`ReaderOverlay` pointer-events 修复（外层 `none` + 按钮 `auto`）；`chromeShow = chromeVisible && !autoHide && (hovered || hoveredVisible)`（`autoHide = slideshow.isPlaying`）实现 #8 幻灯片时隐藏 + hover 2s 临时显示；窗口 `minWidth 800→480, minHeight 600→360`。
> - **6 种缩放**（`fit-screen / fit-width / fit-height / original / full-screen / stretch`）— `useReaderScale` composable 监听 `settings.currentScaleMode` 变化 → `applyScale`（fit-* 用 OSD `fitBoundsWithAlignment`，`original` 1:1 + 居中，`stretch` 取 `max(widthRatio, heightRatio)`）。SinglePageViewer / DoublePageViewer `defineExpose({ getViewer/getBounds })` 暴露给父级。9 宫格 `fitWidth` 改调 `setScaleMode`（立即 apply + 持久化）。
> - **reader 排序与 file browser 一致** — `ReaderView.loadBook` 用 `useFileBrowserStore().effectiveSortField / .effectiveSortAscending`（含 per-folder override via `directorySort`）替代硬编码 `naturalSort(name)`，复用 `lib/fileSort.sortEntries`。`?at=` 仍按 name 找 spread index 不受排序影响。

> ✅ **已落地**（v0.1.0-module3.0.4-virtuallist，spec：`docs/superpowers/specs/2026-08-06-large-folder-perf-design.md`，plan：`docs/superpowers/plans/2026-08-06-virtuallist.md`，E2E：`docs/superpowers/reports/2026-08-06-virtuallist-e2e.md`）：
> - **手写 `useVirtualList` composable**（`src/composables/useVirtualList.ts`，~80 行无新依赖）：`visibleRange / visibleEntries / totalHeight` computed + `scrollToIndex(i, opts?)` (align: start/center/end) + `scrollToPath(path)` + `ResizeObserver + rAF` 节流 scroll + `watch(entries, { flush: 'post' })` clamp scrollTop 到 `[0, totalHeight - viewportHeight]`
> - **FileList 三视图统一虚拟化**（list/details 按 row 虚拟化；grid 不虚拟化，CSS grid auto-fill wrap 多列）
> - **viewMode 切换 DOM 复用**：三个 view block（list/grid/details）同时挂载，CSS `:not()` 显隐；切换不重建 DOM、不丢状态
> - **VirtualRow 子组件**（`src/components/filebrowser/VirtualRow.vue`）：`position: absolute; transform: translateY(N * rowHeight)` + `contain: layout style`（虚拟化定位 + GPU 合成层隔离）；行内 `iconType/iconClass` WeakMap 缓存
> - **算法层顺手修 4 个 O(n²) hot path**：
>   - `pathIndex: Ref<Map<path, index>>`（fileBrowser.ts）—— Shift+Click range select O(1) lookup
>   - `toggleSelection` in-place `Set.delete/add + triggerRef` —— Ctrl+Click 取消大选中 O(n²) → O(1)
>   - `readStatus.finishedSet: Set<string>` —— hideFinished=true 时 displayedEntries O(n×m) → O(n)
>   - `displayedEntries` 单次循环合并 hideFinished + searchQuery（fast path 两个 filter 都未启用时直接返回 sortedEntries 引用）
> - **a11y**：role="grid" + aria-rowcount + aria-rowindex + aria-selected + 6 键键盘导航（Arrow/PageUp/Down/Home/End）+ roving tabindex 焦点管理
> - **搜索兼容**：useVirtualList 对 entries 输入域透明（仅 slice 不影响 filter）；watch(entries) clamp 避免"滚到底后搜索 → 空白"
> - **11 hotfix（同 tag merge）**：删 searchFilter 孤儿 + 路径分隔符统一 `/` + row view block height:100% 撑满 + grid 视图多列 wrap + tooltip Teleport + tooltip 位置对齐 hotfix15 原版 + details 各列 truncate + name-cell display:block（span inline 不支持 ellipsis）等
> - **E2E 实测**（14949 entry "AI" 目录）：
>   - DOM 节点 194,485 → 1,284（**151×**）
>   - role="row" 14,957 → 43（**348×**）
>   - JS heap 167 MB → 32 MB（**5.3×**）
>   - 搜索 "page" 后 DOM 1,284 → 137（**1,415×**）
>   - hover 200 次 avg 0.002ms / longtask 0
>   - 滚到底 clamp 正确
>   - msedgewebview2 总内存预期 1.5 GB → 300-500 MB

> ✅ **已落地**（v0.1.0-module3.0.6-masonry，spec：`docs/superpowers/specs/2026-08-07-masonry-layout-design.md`，plan：`C:\Users\jl0476\.claude\plans\lovely-wandering-swan.md`，E2E：`docs/superpowers/reports/2026-08-07-masonry-e2e.md`）：
> - **瀑布流视图（masonry）**——图片按真实宽高比拉伸 + 贪心放最短列（借鉴 v3-waterfall `useLayout` 算法，源码存 `docs/reference/v3-waterfall-master/` 仅供借鉴不引入依赖）。**删 list/grid 视图**，ViewMode 收窄为 `details | masonry`，工具栏图标按钮直接切换（详情在前 + 瀑布流，非下拉）。无图目录 masonry 按钮 disabled + 自动回落 details。
> - **变高虚拟滚动**：扩展 `useVirtualList` 支持变高多列——`useMasonryLayout` composable（贪心放最短列 + 渐进式 totalHeight + visibleRange 基于 layout map top/height）。未测量 item 用估算宽高比（3:4）占位，随测量收敛。
> - **Rust 端读图片 header**：`algorithm/image_header.rs` 纯函数手写 JPEG/PNG/GIF/BMP 字节解析（无 image crate，纯 std，双实现 TS `lib/imageHeader.ts`）；`list_image_dimensions` command（tokio JoinSet + Semaphore 16 并发批量读 256B header）。**这是对 §6 "Rust 不调 IPC 拿 metadata" 的合理边界外推**——图片宽高是布局骨架必需数据，非详情面板装饰字段。
> - **预读策略**：不全量拉尺寸，借鉴图片懒加载——首屏可见 + 3 屏预读（动态），不滚动不查。适配本地挂载远程存储（SMB/NFS 网关）的慢速 I/O 冷路径。
> - **布局参数双层**：工具栏 ⚙ popup（仅 masonry 出现）per-folder override（`directory_masonry` 表，三列可 NULL + COALESCE 部分更新）+ Settings 页全局默认。列数 2-8 默认 4，列间距/行间距 0-24px 默认 8。复用 `directory_sort` 的 locationKey 模式。
> - **滚动锚定**：`applyMeasuredBatch`（上方 item 尺寸到达补偿 scrollTop）已实现于 C2；E1 MasonryView 简化为 visibleRange 重算（实测无跳动，大目录/慢速 I/O 若发现跳动再接入像素级补偿）。
> - **E2E 实测**（`D:\Wallpaper\normal` 224 entry）：虚拟化 224 → 10-28 DOM；列数 4→6 实时重排（width 254→169px）；⚙ popup 3 slider；滚动预读正常；双击图片进 reader 兼容。单测 539→582。
> - **待打磨**：像素级 scrollTop 锚定补偿接入、resolve in-flight cancel、hasImages 搜索态副作用。

> ✅ **已落地**（v0.1.0-module3.0.11-thumbnail-per-image-progress，spec：`./superpowers/specs/2026-08-14-thumbnail-per-image-progress-design.md`）：
> - **单图生成阶段进度**：Rust 生成管线通过 `GenPhase`（queued / decoding / resizing / encoding / writing）发出 `thumbnail://progress` 事件；不改变 `GenerateFn` 签名，回调不阻塞生成队列。
> - **前端反馈**：`MasonryThumbnail` 展示阶段角标和失败入口；`ThumbnailProgressPopover` 提供阶段时间线、耗时和失败快照；支持外点、ESC、切目录和开关关闭。
> - **设置与兼容**：Settings 新增 `fb_thumbnail_detail_popover`；前端 950 测试，Rust 缩略图单测新增 5 项。后续修复包含 500 ms 请求保底节流、滚动后缩略图加载、history descriptor canonical 化及 migration 013 存量去重。

> ✅ **已落地**（v0.1.0-module3.0.7 + 3.0.8，spec：`./superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md` + `./superpowers/specs/2026-08-10-masonry-browse-position-design.md`）：
> - **缩略图缓存全栈**（v3.0.7）—— 4K 图 paint/decode 卡顿根因（基线 max 313ms / 5 次 >100ms 掉帧），Rust 按列宽生成 WebP 缩略图（EXIF Orientation 1-8 像素归一化 + 像素预算 + 原子写）。`thumbnail/` 子系统 9 文件 4529 行（policy / orientation / generator / key / index / scheduler / service / migration / mod），零 `todo!()`。migration 009。前端 `useMasonryThumbnails`（去重 batch+80ms debounce+epoch+事件+retry）+ `MasonryThumbnail` 6 状态卡片 + Settings 9 key。
> - **缩略图 polish**（v3.0.8 thumbnail-polish）—— ThumbnailCacheSettings.vue 完整化（EnumRow 串联 mode/quality/cacheLimit + cacheUsed/clear + 缓存位置迁移 validate/migrate/resume/cancel/rollback/recovery + advanced toggle 4 key）。P0/P1 修复一波。benchmark `2026-08-09-thumbnail-generation-bench.md` + 代码审查 + policy hit-rate 4 套报告。
> - **浏览位置 = 阅读进度**（v3.0.8 masonry-browse-position）—— migration 010 `progress.image_name` 列（瀑布流滚动锚点，NULL 走 page fallback）。`useMasonryBrowsePosition` composable（滚动监听 + 竞态保护 + 缓存）+ `scrollToEntry` 渐进校正。FileBrowser 工具栏「↶ 跳到上次」按钮 + canonicalImageNames + canReadNow 扩展。Settings masonry section + `recordBrowsePosition` / `restoreBrowsePositionOnEnter` 2 BooleanRow + fileBrowser section。
> - **完整日志** — Rust `thumbnail/{service,scheduler,generator}` + worker panic `catch_unwind` 写到 `main.log`；前端 `useMasonryThumbnails` 加 5 个关键日志点 + `listen()` catch `isTauriEnv` 判断。
> - **实测**：单测 582→**717** 前端 / Rust thumbnail 100 单测 + 12 集成 + 3 bench。Rust lib 179 测试 177 pass / **2 fail**（详见 `2026-08-11-feature-matrix.md` §1.5；CI 不跑 cargo test，2 个失败用例永远抓不到）。

---

## 2. 技术栈

### 2.1 后端（Rust）

| 组件 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 框架 | Tauri | 2.x | 原生窗口 + WebView |
| 异步运行时 | tokio | 1.x | features = ["full"] |
| HTTP | reqwest | 0.12.x | features = ["stream", "rustls-tls"] |
| SMB | smb-rs | 0.6.x | 异步原生客户端 |
| ZIP / CBZ | zip | 2.x | 流式读取 |
| RAR | unrar | 0.7.x | RAR4 / RAR5 |
| 7z | sevenz-rust | 0.6.x | 末尾索引需整包读 |
| 数据库 | rusqlite | 0.32.x | features = ["bundled"] |
| 凭据 | keyring | 3.x | 系统 keystore 跨平台 |
| 序列化 | serde / serde_json | 1.x | |
| 错误处理 | thiserror / anyhow | 1.x | |
| 日志 | tracing | 0.1.x | |

### 2.2 前端（Vue 3 + TypeScript）

| 组件 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 框架 | Vue | 3.4+ | Composition API + `<script setup>` |
| 构建 | Vite | 5.x | |
| 语言 | TypeScript | 5.x | strict mode |
| 状态管理 | Pinia | 2.x | |
| 路由 | Vue Router | 4.x | 可选 |
| 图像渲染 | OpenSeadragon | 5.x | MIT 开源 |
| Tauri IPC | @tauri-apps/api | 2.x | |
| 模糊搜索 | fuse.js | 7.x | 列表搜索 |

### 2.3 系统依赖

- **macOS**：Xcode Command Line Tools（rust 编译 + DMG 打包）
- **Windows**：WebView2 Runtime（Win11 自带；Win10 需 v1803+）；MSVC Build Tools
- **Linux**：webkit2gtk-4.1、libgtk-3-dev、libayatana-appindicator3-dev

---

## 3. 项目结构

```
mirapage-desktop/
├── src-tauri/                    ← Rust 后端
│   ├── src/
│   │   ├── main.rs               ← Tauri 入口
│   │   ├── commands/             ← Tauri command handlers（前端通过 IPC 调用）
│   │   │   ├── mod.rs
│   │   │   ├── file_browser.rs   ← 本地 / SMB / WebDAV 目录枚举
│   │   │   ├── reader.rs         ← 文件 / 条目读取（含 Range）
│   │   │   ├── archive.rs        ← 压缩包列表 + 条目读取
│   │   │   ├── accounts.rs       ← 账户 CRUD + 测试连接
│   │   │   ├── bookmarks.rs      ← 书签 CRUD
│   │   │   ├── likes.rs          ← 喜欢 toggle
│   │   │   ├── history.rs        ← 阅读记录 CRUD
│   │   │   ├── progress.rs       ← 进度读写
│   │   │   └── settings.rs       ← 设置 KV
│   │   ├── db/                   ← rusqlite + migrations
│   │   │   ├── mod.rs
│   │   │   ├── migrations/       ← 001_init.sql 等
│   │   │   └── dao/              ← 各表 DAO
│   │   ├── smb/                  ← smb-rs 封装
│   │   │   ├── mod.rs
│   │   │   └── client.rs
│   │   ├── webdav/               ← reqwest + PROPFIND
│   │   │   ├── mod.rs
│   │   │   └── client.rs
│   │   ├── archive/              ← 压缩包读取（Phase 3 实现）
│   │   │   ├── mod.rs
│   │   │   ├── zip.rs
│   │   │   ├── rar.rs
│   │   │   └── sevenz.rs
│   │   ├── source/               ← MediaSource 抽象（Phase 1 定义并贯穿全周期）
│   │   │   ├── mod.rs
│   │   │   ├── descriptor.rs     ← SourceDescriptor enum
│   │   │   ├── trait.rs          ← MediaSource trait
│   │   │   ├── factory.rs        ← MediaSourceFactory
│   │   │   ├── local.rs          ← LocalMediaSource（Phase 1）
│   │   │   ├── archive_impl.rs   ← ArchiveMediaSource（Phase 3）
│   │   │   ├── smb_impl.rs       ← SmbMediaSource（Phase 1 stub，Phase 7 实现）
│   │   │   └── webdav_impl.rs    ← WebDavMediaSource（Phase 1 stub，Phase 8 实现）
│   │   ├── credentials/          ← 凭据加密
│   │   │   ├── mod.rs
│   │   │   └── keystore.rs       ← keyring + PBKDF2 fallback
│   │   └── model/                ← 内部数据模型
│   │       ├── mod.rs
│   │       └── source_descriptor.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                          ← Vue 前端
│   ├── components/
│   │   ├── reader/
│   │   │   ├── SinglePageViewer.vue
│   │   │   ├── DoublePageViewer.vue
│   │   │   ├── ReaderOverlay.vue
│   │   │   ├── SlideshowControls.vue
│   │   │   └── ProgressBar.vue
│   │   ├── filebrowser/
│   │   │   ├── FileList.vue
│   │   │   ├── Breadcrumb.vue
│   │   │   └── LocationSwitcher.vue
│   │   ├── library/
│   │   │   ├── BookmarksList.vue
│   │   │   ├── LikesList.vue
│   │   │   └── HistoryList.vue
│   │   ├── settings/
│   │   │   ├── SlideshowSettings.vue
│   │   │   └── AccountManager.vue
│   │   └── common/               ← 按钮 / 输入框 / 列表项
│   ├── stores/                   ← Pinia
│   │   ├── reader.ts
│   │   ├── slideshow.ts
│   │   ├── settings.ts
│   │   └── library.ts
│   ├── composables/              ← Vue composition functions
│   │   ├── useSlideshow.ts
│   │   ├── useReaderHotkeys.ts
│   │   └── useImageUrl.ts
│   ├── lib/
│   │   ├── tauri.ts              ← IPC 桥 + 类型定义
│   │   ├── naturalSort.ts
│   │   └── sourceDescriptor.ts
│   ├── router/                   ← Vue Router 配置（可选）
│   │   └── index.ts
│   ├── App.vue
│   └── main.ts
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 4. 数据库 Schema（SQLite）

7 张表，存于 `~/.local/share/mirapage-desktop/mirapage.db`（macOS / Linux）或 `%APPDATA%/mirapage-desktop/mirapage.db`（Windows）。

```sql
-- 核心 6 张表 + 1 张 settings KV

CREATE TABLE book (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_descriptor TEXT NOT NULL,    -- JSON: 与 MiraPage Android SourceDescriptorJson 字节级一致
  last_read_at INTEGER,
  is_favorite INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE progress (
  book_id INTEGER PRIMARY KEY,
  page INTEGER NOT NULL DEFAULT 0,
  reader_mode TEXT NOT NULL,          -- 'single' | 'double'
  updated_at INTEGER NOT NULL
);

CREATE TABLE bookmark (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  page INTEGER NOT NULL,
  position REAL,                      -- 缩放 / 滚动偏移
  label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE like (
  book_id INTEGER PRIMARY KEY,
  liked_at INTEGER NOT NULL
);

CREATE TABLE browse_history (
  book_id INTEGER PRIMARY KEY,
  source_descriptor TEXT NOT NULL,
  last_page INTEGER,
  last_read_at INTEGER NOT NULL
);

CREATE TABLE account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'smb' | 'webdav'
  host TEXT,
  port INTEGER,
  share TEXT,
  username TEXT,
  encrypted_password TEXT             -- keyring / PBKDF2 加密后的字符串
);

CREATE TABLE tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,                         -- 可选 hex 颜色
  created_at INTEGER NOT NULL
);

CREATE TABLE book_tag (
  book_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (book_id, tag_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 初始 settings 默认值
INSERT INTO settings (key, value) VALUES
  ('reader_default_mode', 'single'),
  ('slideshow_interval_ms', '3000'),
  ('slideshow_direction', 'forward'),
  ('slideshow_loop', '1'),
  ('slideshow_default_on_entry', '0'),
  ('continue_to_next_volume', 'manual'),  -- 'off' | 'auto' | 'manual'
  ('locale', 'system'),                  -- 'zh-CN' | 'en-US' | 'system'
  ('search_mode', 'fuzzy');              -- 'substring' | 'fuzzy'
```

---

## 5. 实施阶段

### Phase 1 — Tauri 骨架 + SQLite + 文件选择器（1.0 人月）

**含 `MediaSource` 抽象定义（远程源预留）**

- 用 `npm create tauri-app@latest` 创建 Vue + TypeScript + Vite 模板
- 配 `tauri.conf.json`（窗口尺寸、最小尺寸、bundle 标识、应用图标）
- 引入 `rusqlite` + migrations 系统
- 实现 settings 表 CRUD + `get_setting` / `set_setting` Tauri command
- 接入 `tauri-plugin-dialog` 选本地目录
- **定义 `MediaSource` 抽象**（关键，决定后续远程源接入成本）：
  ```rust
  // src-tauri/src/source/mod.rs
  pub trait MediaSource: Send + Sync {
      async fn list_directory(&self, path: &str) -> Result<Vec<MediaEntry>, String>;
      async fn read_file(&self, path: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>, String>;
      async fn file_count(&self, path: &str) -> Result<u64, String>;  // 压缩包页数等
  }

  pub enum SourceDescriptor {
      Local { root_path: String },
      Archive { archive_path: String, entry_prefix: String, format: ArchiveFormat },
      Smb { account_id: i64, share: String, path: String },  // Phase 7 实现
      WebDav { account_id: i64, base_url: String, path: String },  // Phase 8 实现
  }

  pub struct MediaSourceFactory {
      local: Arc<LocalMediaSource>,
      archive: Arc<ArchiveMediaSource>,
      smb: Arc<SmbMediaSourceStub>,       // P2 填实现
      webdav: Arc<WebDavMediaSourceStub>, // P2 填实现
  }

  impl MediaSourceFactory {
      pub fn resolve(&self, desc: &SourceDescriptor) -> Arc<dyn MediaSource> {
          match desc {
              SourceDescriptor::Local { .. } => self.local.clone(),
              SourceDescriptor::Archive { .. } => self.archive.clone(),
              SourceDescriptor::Smb { .. } => self.smb.clone(),
              SourceDescriptor::WebDav { .. } => self.webdav.clone(),
          }
      }
  }
  ```
- 实现 `LocalMediaSource`（基于 `tokio::fs`）
- `SmbMediaSourceStub` / `WebDavMediaSourceStub`：trait 已实现，所有方法返回 `Err("not implemented yet".into())`

**交付**：能打开本地目录，列表显示文件名（占位 UI），设置能读写；`MediaSource` 抽象与所有 stub 已就位。

### Phase 2 — OpenSeadragon 阅读器 + 文件浏览器（2.0 人月）

- `SinglePageViewer.vue`：1 个 OpenSeadragon 实例，tile source = 单图 URL
- `DoublePageViewer.vue`：1 个 OpenSeadragon 实例，viewport 宽 = 2 张图宽度
- 双页规划算法（封面独占 + 奇数末页不并排）
- `ReaderOverlay.vue`：顶栏（页码 / 模式切换）+ 底栏（缩放 / 跳页 / 翻页按钮）
- 键盘快捷键：`←` / `→` / `Space` / `Home` / `End` / `Esc`
- `useReaderHotkeys.ts` composable
- 进度持久化：翻页防抖 500ms 写 `progress` 表
- **通过 `MediaSource` 抽象读取页面**：UI 不感知 Local / Archive / Smb / WebDav 的差异
- 加载等待：远程源图片未加载时翻页按钮禁用 + 加载指示

**交付**：能本地打开漫画文件夹，单 / 双页切换，键盘翻页，进度持久化；远程源接入预留接口已 verify（stub 调用链路通）。

### Phase 3 — 压缩包（CBZ / CBR / ZIP / RAR / 7z）（1.5 人月）

- `source/archive/zip.rs`：`zip` crate 列条目 + 按需解压条目
- `source/archive/rar.rs`：`unrar` crate（RAR5 部分包可能失败，记录并跳过）
- `source/archive/sevenz.rs`：`sevenz-rust` crate（7z 末尾索引，**必须整包读**；后续 P2 阶段 SMB / WebDAV 需先下载到 `cacheDir` 再读）
- 把 `ArchiveMediaSourceStub` 升级为 `ArchiveMediaSource`，注册到 `MediaSourceFactory`
- UI：文件浏览器点击 `.cbz` / `.cbr` / `.zip` / `.rar` / `.7z` 时走 `SourceDescriptor::Archive` 路径
- Tauri command `list_archive_entries` / `read_archive_entry`（可保留为 `MediaSource` 内部实现细节，UI 只调 `factory.resolve(desc).read_file(path, range)`）

**交付**：能打开 CBZ / CBR / ZIP / RAR / 7z 漫画；`MediaSource::Archive` 分支实装。

### Phase 4 — 书签 / 喜欢 / 阅读记录 / 书架收藏 / 标签 / 搜索（3.0 人月）

- `bookmarks` 表 CRUD + UI 列表 + 添加 / 删除
- `like` toggle
- `browse_history`：进入 reader 时自动 upsert
- 书架视图：`is_favorite = 1` 的书 + 按 `last_read_at` 倒序
- 标签：`tag` + `book_tag` 表 CRUD；UI 标签选择器 + 书架标签筛选
- 搜索：fuse.js 集成；搜索框在文件浏览器顶部 + 书架顶部；模糊匹配文件名 / 书名 / 标签
- UI：侧边栏 4 个 tab（书签 / 喜欢 / 历史 / 书架）

**交付**：书签 / 喜欢 / 历史 / 书架可查看与操作；标签可创建、打标、筛选；文件名 / 书名 / 标签可模糊搜索。

### Phase 5 — 跨卷连续阅读 + 幻灯片（2.5 人月） ✅ v0.1.0-module3.0.9-cross-volume

**跨卷连续阅读**（已落地，spec v2：`docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md` + 计划：`docs/superpowers/plans/2026-08-11-cross-volume-reading.md`）：
- 新算法（Rust 端）：`pick_sibling` 纯函数 + `VolumeDirection` 强类型 enum + `find_next_volume` async command（仅 Local，非 Local 明确 Err；`MediaSourceFactory` 集成测试用 tempdir + LocalMediaSource，codebase 首例 factory 集成测试）
- 设置 `continue_to_next_volume`：**off / auto / manual 3 态**（不含 PV 的 SWIPE，详见 §12.3）
- 11 条不变量端到端闭环（spec §4.3）：route 唯一真值 / watch immediate 唯一入口 / 失败不保留旧卷 / 去重看 phase=ready / 原子提交 / busy 覆盖 loader / pendingCrossVolume 只在 awaiting-confirm 非空 / route.query.at 清空 / pendingNextVolume 五处消费 / saveCurrentProgressNow await+取消旧 debounce / setOnAtLastNextAttempt(null) 卸载清理
- 三层架构：意图（4 入口：末页再向下/slideshow/Alt+→/瀑布流按钮）→ CrossVolumeController（模式决策 + requestSeq 竞态 + sameBookIdentity 结构化校验 + canStart 加载期守卫 + settleIdle 集中收口）→ 统一 Book Loader `useReaderBookLoader.loadBookById(bookId)` 返回不可变 `ReaderBookSnapshot`（不写 refs、不调 reader.openBook）→ ReaderView.commitBookSnapshot 原子提交（9 宫格入口已随 3.0.12 移除）
- 通用 toast（useToast 单例 ref 队列 + ToastHost Teleport 到 body）+ ContinueNextVolumeToast manual 模式底部胶囊（纯 props/emits **不调 useCrossVolume()**）+ ToastHost 挂在 `src/App.vue` 顶层（最终审查 I1 修复 FileBrowser 路径下 toast 也能渲染）
- `ProgressItem.finished` 跨边界 gap 修复：Rust `get_progress_inner` SQL 加 finished 列 + row 解析 `!= 0`；TS `ProgressItem` 加字段；Loader 去掉 `& { finished?: boolean }` 死代码交叉类型——"已读完→首页"端到端打通
- A7 修复（E2E 后发现）：auto/force 跨卷成功 → resume slideshow（仅当调用前 isPlaying=true）+ `pushToast('reader.crossVolume.jumped', {title})` 短暂反馈
- 14 commits（任务 0-10 实施 + 任务5审查修复 + 最终审查I1 + A7两补）：0baa8d0/20bc8ed/aef174f/9559198/2fd7a6c/3f4963c/3d62669/0deb1c2/a81e3b0/48607c9/c4dcf3f/6a2a3fd/3a57e63/fb29346

**幻灯片**：
- `stores/slideshow.ts`：状态 + actions
- `composables/useSlideshow.ts`：`setInterval` + `advancePage` + 末页处理（loop / 暂停）
- 加载等待策略：图片未加载完时跳过本 tick，下一 tick 再试
- `SlideshowControls.vue`：顶栏播放 / 暂停按钮
- 设置页：间隔滑块（1-30s）、方向切换、循环开关
- 键盘 `P` 切换播放 / 暂停（OpenSeadragon 不占用 P 键）

**交付**：跨卷连续阅读三种模式可配置；幻灯片完整功能。

### Phase 6 — i18n（中 / 英）（1.0 人月）

- 引入 `vue-i18n` 9.x
- 配置 `zh-CN` + `en-US` 两个 locale，运行时可切换
- 设置页加语言切换（zh-CN / en-US / 跟随系统）
- 全文案抽取到 `src/locales/zh-CN.ts` + `src/locales/en-US.ts`
- 抽取原则：所有用户可见字符串（含按钮、菜单、提示、错误信息、设置项、对话框标题等）必须走 `$t()`
- 数字 / 日期 / 文件大小格式化（vue-i18n 内置）
- **i18n 工作应在每个 Phase 同步进行**（每个新功能从一开始就用 `$t()`），本阶段只做最后清理 + locale 切换 UI + 完整翻译

**交付**：两种语言完整翻译；运行时可切换；设置跟随系统默认。

### Phase 7 — SMB 协议层（P2，1.5 人月）

- `smb-rs` 封装：`connect` / `authenticate` / `list_directory` / `open_file` / `read_range`
- `accounts` 表 CRUD + 凭据加密（keyring）
- `test_connection` command（保存前连通性测试）
- 实现 `SmbMediaSource`，替换 stub，注册到 `MediaSourceFactory`
- `tauri.conf.json` 注册自定义 protocol `smb://`
- 前端用 `convertFileSrc()` 拼 URL
- **UI 无需改动**：`LocationSwitcher` 增加 SMB 账户入口即可

**交付**：能添加 SMB 账户，列出 SMB 目录，打开 SMB 中图片阅读。`MediaSource::Smb` 分支实装。

### Phase 8 — WebDAV 协议层（P2，1.0 人月）

- reqwest + 手写 PROPFIND（Depth: 1）
- 复用 Phase 7 的账户管理框架
- 实现 `WebDavMediaSource`，替换 stub，注册到 `MediaSourceFactory`
- `list_webdav_directory` / `read_webdav_file` commands（含 Range header）
- **UI 无需改动**：`LocationSwitcher` 增加 WebDAV 账户入口即可

**交付**：能连接 WebDAV 服务器并阅读。`MediaSource::WebDav` 分支实装。

### Phase 9 — 跨平台分发（1.5 人月）

- macOS DMG（`cargo-bundle` + Developer ID 签名 + notarization）
- Windows MSI（SignTool + EV 证书）
- Linux DEB + AppImage
- 应用图标（1024×1024 主图 + 各平台尺寸）
- `tauri-plugin-updater` 自动更新
- CI：GitHub Actions matrix（ubuntu-latest / windows-latest / macos-latest）

**交付**：三平台安装包 + 自动更新。

---

## 6. 工作量合计

| Phase | 内容 | 优先级 | 人月 |
|---|---|---|---|
| 1 | Tauri 骨架 + SQLite + 文件选择器 + `MediaSource` 抽象 | P0 | 1.0 |
| 2 | OpenSeadragon 阅读器 + 文件浏览器（走 `MediaSource`） | P0 | 2.0 |
| 3 | 压缩包（CBZ / CBR / ZIP / RAR / 7z） | P0 | 1.5 |
| 4 | 书签 / 喜欢 / 历史 / 书架 / 标签 / 搜索 | P0/P1 | 3.0 |
| 5 | 跨卷连续阅读 + 幻灯片 | P1 | 2.5 |
| 6 | i18n（中 / 英）+ 全文案清理 | P0 | 1.0 |
| 7 | SMB（填 `MediaSource::Smb` stub） | P2 | 1.5 |
| 8 | WebDAV（填 `MediaSource::WebDav` stub） | P2 | 1.0 |
| 9 | 跨平台分发 | — | 1.5 |
| **合计** | | | **15.0 人月** |

乐观 11、现实 15、悲观 22 人月。

**MVP 截点**：完成 Phase 1-6（含 i18n）即可发布 v0.1 核心版本，约 11 人月。SMB / WebDAV 在 v0.2 增量发布，UI 无改动。

---

## 7. MiraPage Android 参考索引（按 Phase 分组）

MiraPage Android 工程（`F:\WorkSpaceCollection\git\perfect-viewer`）作为**只读参考**，**不引用、不复制**任何 Kotlin/Java 源文件。

本节按 Phase 列出每个阶段需要查阅的 Android 文件 + 关键行号。

> **使用方式**：实现 Phase X 时，打开 IDE 第二个窗口加载 Android 工程，按本节列出的文件与行号查参考。`DESIGN.md` §13 描述了算法语义；具体实现细节按本节定位。

### 7.0 全局基础设施

| 路径 | 用途 | 桌面端对应 |
|---|---|---|
| `app/src/main/java/top/racyan/MainActivity.kt` | Activity 入口 + 音量键拦截（44-84） + KeepScreenOn / Brightness Effect | **不复制**——桌面端无 Activity，删 KeepScreenOn / Brightness（macOS/Windows 替代品有限） |
| `app/src/main/AndroidManifest.xml` | SAF / INTERNET / configChanges 声明 | **不复制**——Tauri 自动生成 `tauri.conf.json` 的 capabilities |
| `app/src/main/java/top/racyan/SystemWindowEffects.kt` | 屏幕常亮 + 亮度调节 | **不实现**（桌面无系统级亮度控制） |
| `app/src/main/res/values/strings.xml` + `values-zh/strings.xml` | 全部 UI 文案 + 中文翻译 | `src/locales/zh-CN.ts` + `src/locales/en-US.ts`（已建） |
| `app/src/main/java/top/racyan/di/` | Hilt 模块（DataModule / MediaSourceModule / DatabaseModule） | **不复制**——Tauri 端用 `lib.rs::run()` 手写初始化 |

### 7.1 Phase 1 —— 骨架 + MediaSource 抽象

| 路径 | 关键行 | 用途 |
|---|---|---|
| `data/source/MediaSource.kt:1-45` | 接口签名 | `trait_def.rs::MediaSource`（已建）镜像设计 |
| `data/source/MediaSourceFactory.kt:1-12` | `fun interface` factory | `source/factory.rs::MediaSourceFactory`（已建） |
| `data/source/MediaSourceResolver.kt:1-23` | `@IntoSet` multi-binding | **参考**：Tauri 端用 `HashMap<Type, Arc<dyn MediaSource>>` 等价 |
| `data/source/LocalMediaSourceFactory.kt:1-28` | Factory 注册模式 | 参考；Tauri 端在 `factory.rs::new()` 内硬编码 4 个实例 |
| `domain/model/SourceDescriptor.kt:1-60` | 4 个 sealed variant + `id` 计算 | `source/descriptor.rs`（已建）**字节级兼容 JSON schema** |
| `data/local/entity/SourceDescriptorJson.kt:1-77` | JSON 编解码（org.json） | `serde_json` 重写但字段名/嵌套完全一致 |
| `data/local/MiraPageDatabase.kt:1-77` | Room 注解 + 10 个 DAO | `db/migrations.rs`（已建）映射为 9 张 SQLite 表 |
| `data/local/prefs/SettingsRepository.kt:45-85` | 33 个 settings key + 默认值 | `db/migrations.rs::apply_001_init`（已建）+ `stores/settings.ts`（已建） |
| `data/local/entity/LibraryEntity.kt` 等 10 entity | 字段定义 | `db/migrations.rs`（已建）字段一一对应 |

### 7.2 Phase 2 —— OpenSeadragon 阅读器 + 文件浏览器

**读者核心（最高优先级）**：

| 路径 | 关键行 | 用途 |
|---|---|---|
| `ui/reader/ReaderViewModel.kt:374-401` | `onPageChanged` 触发 + 500ms 防抖 | `stores/reader.ts::onPageChanged` |
| `ui/reader/ReaderViewModel.kt:200, 382-389` | `atLastPage` / `atFirstPage` 判断 | 同上 |
| `ui/reader/ReaderViewModel.kt:734-817` | `maybeContinue(force, dir)` 跨卷触发 | Phase 5 用，Phase 2 也需要 `atLastPage` 通知 |
| `ui/reader/ReaderViewModel.kt:312-313` | `history.record` 触发时机 | 进入 Ready 状态时一次 |
| `ui/reader/ReaderViewModel.kt:557-570, 892-893` | `schedulePrefetch()` (AHEAD=BEHIND=3) | Phase 2 也可用（paged 模式预取前后页） |
| `ui/reader/ReaderViewModel.kt:597-599` | `saveImmediately()` ON_STOP | 桌面端映射为 `window.onCloseRequested` |
| `ui/reader/ReaderUiState.kt:1-100` | State 定义（Loading / Ready / Error） | `stores/reader.ts::ReaderState` 镜像 |
| `ui/reader/ReaderViewModel.kt:251` | `withTimeout(30_000L)` 超时 | 远程源 30s 超时 |
| `ui/reader/ReaderViewModel.kt:325, 353-372` | `Error.kind` + 重新授权按钮 | `ErrorKind` enum（已建） |
| `ui/reader/container/SinglePageContainer.kt:36-115` | Pager + tap region + chrome 显隐 | `components/reader/SinglePageViewer.vue` |
| `ui/reader/container/DoublePageContainer.kt:43-137` | 双页 Pager + Spread 应用 | `components/reader/DoublePageViewer.vue` |
| `ui/reader/container/HorizontalStripContainer.kt:1-203` | LazyRow + 跨卷（**只做参考**，桌面不做） | 不实现 |
| `ui/reader/container/VerticalWebtoonContainer.kt:1-194` | Webtoon View 系统（**只做参考**，桌面不做） | 不实现 |
| `ui/reader/page/CoilImage.kt:1-191` | Coil 2 + Android Context | 替换为 Coil 3 + WebView URL |
| `ui/reader/VolumeKeyBus.kt:1-24` | 键盘 / 音量键事件流 | `composables/useReaderHotkeys.ts` |
| `ui/reader/ReaderScreen.kt:1-637` | 整体阅读器组合 + chrome 切换逻辑 | `components/reader/ReaderScreen.vue` 顶层 |

**阅读器 UI 元素**：

| 路径 | 关键行 | 用途 |
|---|---|---|
| `ui/reader/ReaderLabels.kt` | 页码格式化 (`第 X / Y 页`) | `composables/usePageIndicator.ts` |
| `ui/reader/BookSwapTarget.kt` | 跨卷事件 payload | Phase 5 用 |
| `ui/reader/overlay/ReaderMainMenu.kt:78-188` | 全屏菜单栏（顶栏 / 导航组 / 阅读组 / 库与工具） | `components/reader/ReaderMainMenu.vue` |
| `ui/reader/overlay/ReaderOverlay.kt:31-89` | `JumpPageDialog`（Slider + TextField） | `components/reader/JumpPageDialog.vue` |
| `ui/reader/ContinueNextVolume.kt:20-94` | paged 模式跨卷手势（`PointerEventPass.Initial`） | Phase 5 重写为键盘 + 鼠标拖动 |
| `ui/reader/container/SpreadPlanner.kt`（domain） | 已迁移到 `algorithm/spread_planner.rs`（已建） | 直接用 |

**文件浏览器**：

| 路径 | 关键行 | 用途 |
|---|---|---|
| `ui/filebrowser/FileBrowserScreen.kt:1-798` | 完整文件浏览器（搜索 / 排序 / 面包屑 / 列表） | `components/filebrowser/FileBrowser.vue` |
| `ui/filebrowser/FileBrowserViewModel.kt:1-843` | 列表 / 排序 / 搜索 / 选择状态机 | `stores/fileBrowser.ts` + `views/FileBrowser.vue` |
| `ui/filebrowser/FileBrowserUiState.kt` | State 定义 | 镜像到 Pinia |
| `ui/filebrowser/LocationSwitcherSheet.kt:45-151` | 本地根 / SMB 账户切换器 | `components/filebrowser/LocationSwitcher.vue` |
| `ui/filebrowser/ShortcutSheet.kt:39-127` | 快捷方式面板 | `components/filebrowser/ShortcutSheet.vue` |
| `ui/filebrowser/BrowseHistoryScreen.kt` | 历史视图 | `views/History.vue`（占位） |
| `ui/components/OpenDocumentTreeAtInitial.kt:1-40` | SAF 自定义 Contract | **不实现**——桌面用 `tauri-plugin-dialog` |

### 7.3 Phase 3 —— 压缩包（CBZ/CBR/ZIP/RAR/7z）

| 路径 | 关键行 | 用途 |
|---|---|---|
| `data/source/ArchiveMediaSource.kt:1-311` | libarchive 封装（mmap / 流式两种模式） | 用 `zip` / `unrar` / `sevenz-rust` crate 重写 |
| `data/source/ArchiveMediaSource.kt:51-120` | mmap 模式（Open + Os.mmap） | 桌面端用 `tokio::fs::File` 替代（无需 mmap） |
| `data/source/ArchiveMediaSource.kt:120-310` | 流式模式（SMB 直读） | Phase 7 远程源需要时再实现 |
| `data/source/ArchiveCache.kt:33-120` | 压缩包缓存（LRU + SHA-256 key） | 桌面端可简化或直接复用 `PageCacheManager` |
| `data/source/RandomAccessReader.kt:12-33` | 随机读接口 | `source/trait_def.rs::ByteRange`（已建） |
| `data/source/SmbMediaSource.kt:228-254` | `SmbRandomAccessReader` 实现 | Phase 7 参考 |
| `data/source/WebDavRandomAccessReader.kt:23-84` | WebDAV Range GET 实现 | Phase 8 参考 |
| `data/source/MediaSource.kt:30-44` | `downloadTo` + `supportsRangeRead` | 桌面端不需要 downloadTo，但 `supportsRangeRead` 可保留 |

### 7.4 Phase 4 —— 书签 / 喜欢 / 历史 / 书架 / 标签 / 搜索

**UI 页面**：

| 路径 | 关键行 | 用途 |
|---|---|---|
| `ui/bookmarks/BookmarksScreen.kt` + `BookmarksViewModel.kt` | 书签列表 + 添加 / 删除 | `views/Bookmarks.vue` + `stores/bookmarks.ts` |
| `ui/likes/LikesScreen.kt` + `LikesViewModel.kt` | 喜欢列表 + toggle | `views/Likes.vue` + `stores/likes.ts` |
| `ui/library/LibraryScreen.kt:1-271` + `LibraryViewModel.kt` | 书架视图（收藏 + 最近阅读） | `views/Library.vue` + `stores/library.ts` |
| `ui/library/LibraryUiState.kt` | State 定义 | 镜像到 Pinia |
| `ui/filebrowser/BrowseHistoryScreen.kt` | 历史列表 | `views/History.vue`（已建占位） |
| `core/util/SearchFilter.kt` | 子串过滤（substring） | `lib/search.ts::substringFilter`（fuse.js 升级为模糊） |

**Repository + Entity**（镜像到 `db/` + `src-tauri/src/db/dao/`）：

| 路径 | 用途 |
|---|---|
| `data/repository/BookmarkRepository.kt` | 书签 CRUD + 列表 |
| `data/repository/LikeRepository.kt` | 喜欢 toggle + 列表 |
| `data/repository/LibraryRepository.kt` | 收藏 / 导入 / 删除 + 临时合成 LibraryEntity |
| `data/repository/BrowseHistoryRepository.kt` | 阅览记录（唯一索引 `(descriptor, relPath)` 去重 + 刷新 lastVisitedAt） |
| `data/local/entity/BookmarkEntity.kt` | 字段映射 |
| `data/local/entity/LikeEntity.kt` | 同上 |
| `data/local/entity/LibraryEntity.kt` | `id` + `sourceDescriptorJson` + `isFavorite` + `pageCount` + `cover` |
| `data/local/entity/BrowseHistoryEntity.kt` | 同上 |
| `data/repository/ShortcutRepository.kt` + `entity/ShortcutEntity.kt` | 快捷方式（跨源） |
| `data/local/entity/Tag.kt`（如不存在 → 自定义） | 标签 |
| `data/repository/DirectorySortRepository.kt` + `entity/DirectorySortEntity.kt` | per-directory 排序覆盖 |

### 7.5 Phase 5 —— 跨卷连续阅读 + 幻灯片

| 路径 | 关键行 | 用途 |
|---|---|---|
| `domain/usecase/FindNextDirectoryUseCase.kt:50-209` | 完整算法（见 §13.2） | `usecase/find_next_directory.rs` 重写 |
| `ui/reader/ContinueNextVolume.kt:20-94` | paged 模式跨卷手势（1/3 屏阈值） | 桌面端映射为键盘 / 鼠标拖动 |
| `ui/reader/container/HorizontalStripContainer.kt:107-149` | 横条幻灯片（animateScrollBy + loop） | **只做参考**——桌面不做横条 |
| `ui/reader/container/VerticalWebtoonContainer.kt:138-192` | 条漫 Choreographer 帧驱动幻灯片 | **只做参考**——桌面不做条漫 |
| `data/slideshow/SlideshowController.kt` | paged 模式 Flow 定时器 + 翻页事件 | `composables/useSlideshow.ts` |
| `data/slideshow/SlideshowSettings.kt` | 间隔 / 方向 / 循环 | `stores/slideshow.ts` |
| `ui/reader/ReaderViewModel.kt:404-420` | `nextPage()` 末页触发 SWIPE 二次 nudge | 同上 |
| `ui/reader/ReaderViewModel.kt:734-817` | `maybeContinue` 完整实现（含 `bookSwapInFlight` 守卫） | `stores/reader.ts::maybeContinue` |

### 7.6 Phase 6 —— i18n（中/英）

| 路径 | 关键行 | 用途 |
|---|---|---|
| `app/src/main/res/values/strings.xml` | **完整 UI 文案清单**（必读） | 复制到 `src/locales/zh-CN.ts` 与 `src/locales/en-US.ts` |
| `app/src/main/res/values-zh/strings.xml` | 中文翻译 | 直接参考 |
| `ui/theme/Theme.kt` | themeMode + colorTheme 切换逻辑 | `src/theme/` 对应实现（Phase 1 不需要，Phase 6 加） |
| `ui/theme/Color.kt` | 4 套预设色板（BLUE/PURPLE/AMBER/NEUTRAL） | 镜像到 TS |

### 7.7 Phase 7 —— SMB

| 路径 | 关键行 | 用途 |
|---|---|---|
| `data/source/SmbMediaSource.kt:1-254` | 完整实现（连接 / 列表 / 读 / Range） | `source/smb_impl.rs` 用 `smb-rs` crate 重写 |
| `data/remote/smb/SmbSessionPool.kt:13-106` | 引用计数池（**只做参考**——Desktop 单进程无需池） | 直接 `connect` / `disconnect` |
| `data/remote/smb/SmbConnectionTester.kt:1-48` | 测试连接 | `commands/accounts::test_connection` |
| `data/security/CredentialCipher.kt:10-16` | 接口 | `credentials/cipher.rs::CredentialCipher` |
| `data/security/AndroidKeystoreCredentialCipher.kt:1-77` | **必须重写**——AndroidKeyStore → `keyring` | macOS Keychain / Windows Credential Vault / Linux Secret Service + PBKDF2 fallback |
| `data/repository/AccountRepository.kt` | 账户 CRUD + 凭据加解密 | `commands/accounts.rs` |
| `data/local/entity/AccountEntity.kt` | 字段映射 | `db/migrations.rs`（已建） |
| `ui/accounts/AccountsScreen.kt:1-383` + `AccountsViewModel.kt` | 账户管理 UI（添加 / 测试 / 编辑 / 删除） | `views/Accounts.vue` + `stores/accounts.ts` |
| `ui/accounts/AccountsUiState.kt` | State 定义 | 镜像 |
| `ui/accounts/AccountsViewModel.kt:130-160` | 测试连接流程（`testConnection` 调用） | Phase 7 command handler |
| `data/local/prefs/SettingsRepository.kt:130-145` | `smb_archive_strategy` 设置 | 已建 `db/migrations.rs` |

### 7.8 Phase 8 —— WebDAV

| 路径 | 关键行 | 用途 |
|---|---|---|
| `data/source/WebDavMediaSource.kt` | 完整实现 | `source/webdav_impl.rs` 用 `reqwest` + PROPFIND 重写 |
| `data/remote/webdav/WebDavClient.kt:1-268` | OkHttp + XmlPullParser 客户端 | 镜像为 `reqwest` + `xmlpull` |
| `data/remote/webdav/WebDavConnectionTester.kt:18-38` | 测试连接 | 同 SMB |
| `data/source/WebDavRandomAccessReader.kt:23-84` | Range GET 实现 | 镜像 |

### 7.9 Phase 9 —— 跨平台分发

| 路径 | 用途 |
|---|---|
| `data/backup/BackupCrypto.kt` | PBKDF2 + AES-GCM（已建，复用） |
| `data/backup/BackupJson.kt` | 备份 JSON schema |
| `data/backup/BackupRepository.kt` | 备份导入导出 |
| `data/export/BrowseHistoryExporter.kt` + `HistoryExportJson.kt` + `HistoryExportData.kt` | 历史导出为 JSON |
| `app/src/main/res/mipmap-*/` | 应用图标 | 已用 Python 生成占位（需用户本地替换为正式图标） |
| `app/build.gradle.kts:60-67` | Tauri config 字段参考（图标尺寸、签名、bundles） | 镜像到 `tauri.conf.json`（已建） |

### 7.10 关键非参考（桌面端明确不做）

| Android 路径 | 不实现的原因 |
|---|---|
| `ui/reader/container/VerticalWebtoonContainer.kt` + `WebtoonFrame.kt` + `WebtoonRecyclerView.kt` + `WebtoonAdapter.kt` | 桌面不做条漫 |
| `ui/reader/container/HorizontalStripContainer.kt` | 桌面不做横条 |
| `data/download/DownloadManager.kt` + `DownloadPaths.kt` + `DownloadTaskState.kt` | 桌面不做"下载到本地" |
| `data/local/entity/LocalRootEntity.kt` + `LocalRootDao.kt` + `LocalRootRepository.kt` | 桌面不需要 SAF tree Uri（用 `java.io.File`） |
| `data/cache/PrefetchQueue.kt` + `WarmDecoderFactory.kt` + `WarmImageRegionDecoder.kt` + `RegionDecoderPool.kt` + `LoadingProgressTracker.kt` | 这些都是 `android.graphics.Bitmap` 专属；桌面端用 Skia/ImageIO |
| `data/coil/SourceFetcher.kt` + `SourceImage.kt` + `SourceKeyer.kt` | Coil 2 Android 专属反射；桌面端用 Coil 3 公开 API |
| `MainActivity.kt`（Activity 入口） + `SystemWindowEffects.kt` | 桌面无 Activity / 系统亮度 / 屏幕常亮 |
| `data/source/SmbSessionPool.kt` | 桌面单进程无需连接池 |
| `data/security/AndroidKeystoreCredentialCipher.kt` | Android KeyStore 专属 |
| `app/src/main/AndroidManifest.xml` | Tauri 自动生成 capabilities |

---

## 7.11 实施时查阅顺序（推荐流程）

1. **Phase 1**：打开 IDE 双窗口（左 Android / 右 Desktop），从 §7.1 表格对照
2. **Phase 2**：先看 `ReaderViewModel.kt` 的状态机（最长），再看 4 个容器（单/双页 2 个要做，webtoon/strip 2 个跳过）
3. **Phase 3**：只看 `ArchiveMediaSource.kt`，其他压缩包相关都是辅助
4. **Phase 4**：按 §7.4 表格逐个 UI 页面 + Entity + Repository 对应实现
5. **Phase 5**：先看 `FindNextDirectoryUseCase.kt`（核心算法），再看 `SlideshowController.kt`（paged 模式就够）
6. **Phase 6**：复制 `strings.xml` + `values-zh/strings.xml` 到 `src/locales/`
7. **Phase 7-8**：先看接口签名（`MediaSource.kt`），再看具体实现（`SmbMediaSource.kt` / `WebDavMediaSource.kt`）
8. **Phase 9**：打包配置，无 Android 直接参考

---

---

## 8. 关键代码示例

### 8.1 Tauri command 注册（Rust）

```rust
// src-tauri/src/commands/file_browser.rs
use tauri::command;
use crate::source::{MediaSourceFactory, SourceDescriptor};

#[command]
async fn list_directory(
    factory: tauri::State<'_, MediaSourceFactory>,
    descriptor: SourceDescriptor,
    path: String,
) -> Result<Vec<MediaEntry>, String> {
    // UI 不感知 Local / Archive / Smb / WebDav 差异
    let source = factory.resolve(&descriptor);
    source.list_directory(&path).await
}

#[command]
async fn read_file(
    factory: tauri::State<'_, MediaSourceFactory>,
    descriptor: SourceDescriptor,
    path: String,
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<Vec<u8>, String> {
    let source = factory.resolve(&descriptor);
    source.read_file(&path, offset.zip(length)).await
}

// main.rs 注册
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file_browser::list_directory,
            commands::file_browser::read_file,
            commands::accounts::upsert_account,
            commands::accounts::delete_account,
            commands::accounts::test_connection,
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::delete_bookmark,
            commands::likes::toggle_like,
            commands::history::record_history,
            commands::progress::save_progress,
            commands::settings::get_setting,
            commands::settings::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 8.2 单页阅读器（Vue 3）

```vue
<!-- src/components/reader/SinglePageViewer.vue -->
<script setup lang="ts">
import OpenSeadragon from 'openseadragon';
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps<{ imageUrl: string }>();

const containerRef = ref<HTMLDivElement | null>(null);
let viewer: OpenSeadragon.Viewer | null = null;

onMounted(() => {
  if (!containerRef.value) return;
  viewer = OpenSeadragon({
    element: containerRef.value,
    tileSources: { type: 'image', url: props.imageUrl },
    showNavigator: false,
    gestureSettingsMouse: { scrollToZoom: true },
    animationTime: 0.3,
  });
});

watch(() => props.imageUrl, (url) => {
  viewer?.open({ type: 'image', url });
});

onBeforeUnmount(() => {
  viewer?.destroy();
});
</script>

<template>
  <div ref="containerRef" class="w-full h-full" />
</template>
```

### 8.3 幻灯片 composable（Vue 3）

```typescript
// src/composables/useSlideshow.ts
import { ref, watch, onUnmounted } from 'vue';
import { useSlideshowStore } from '@/stores/slideshow';

export function useSlideshow(
  currentPage: Ref<number>,
  pageCount: Ref<number>,
  advancePage: (next: number) => Promise<void>,
) {
  const slideshow = useSlideshowStore();
  let timerId: number | null = null;

  function computeNextPage(): number | null {
    const step = slideshow.direction === 'forward' ? 1 : -1;
    const next = currentPage.value + step;
    if (next < 0 || next >= pageCount.value) {
      if (slideshow.loop) {
        return slideshow.direction === 'forward' ? 0 : pageCount.value - 1;
      }
      return null;
    }
    return next;
  }

  async function tick() {
    const next = computeNextPage();
    if (next === null) {
      slideshow.pause();
      return;
    }
    await advancePage(next);
  }

  watch(
    () => slideshow.isPlaying,
    (playing) => {
      if (playing) {
        timerId = window.setInterval(tick, slideshow.intervalMs);
      } else if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    if (timerId !== null) clearInterval(timerId);
  });
}
```

### 8.4 Pinia store 示例

```typescript
// src/stores/slideshow.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';

export type SlideshowDirection = 'forward' | 'backward';

export const useSlideshowStore = defineStore('slideshow', () => {
  const isPlaying = ref(false);
  const intervalMs = ref(3000);
  const direction = ref<SlideshowDirection>('forward');
  const loop = ref(true);

  function start() { isPlaying.value = true; }
  function pause() { isPlaying.value = false; }
  function togglePlayPause() { isPlaying.value = !isPlaying.value; }
  function setIntervalMs(ms: number) {
    intervalMs.value = Math.max(1000, Math.min(30000, ms));
  }
  function setDirection(dir: SlideshowDirection) {
    direction.value = dir;
  }
  function setLoop(l: boolean) { loop.value = l; }

  return {
    isPlaying, intervalMs, direction, loop,
    start, pause, togglePlayPause,
    setIntervalMs, setDirection, setLoop,
  };
});
```

### 8.5 自然排序（TypeScript）

```typescript
// src/lib/naturalSort.ts
/**
 * 自然排序：page2.jpg < page10.jpg（不是字典序）
 * 参考 MiraPage Android 的 NaturalSortComparator 重写。
 */
export function naturalCompare(a: string, b: string): number {
  const regex = /(\d+|\D+)/g;
  const aParts = a.match(regex) ?? [];
  const bParts = b.match(regex) ?? [];
  const len = Math.min(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    const aNum = Number(aPart);
    const bNum = Number(bPart);

    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      if (aPart !== bPart) return aPart < bPart ? -1 : 1;
    }
  }
  return aParts.length - bParts.length;
}

export function naturalSort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)));
}
```

---

## 9. 关键风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `smb-rs` 不支持 SMB3 加密 | SMB 连接失败 | 评估 `pavao` / `sambamba` 备选；或降级到 NTLM |
| OpenSeadragon 大图（>5000px）翻页卡顿 | 用户体验 | 启用 ImageBitmap 异步解码；评估 `createImageBitmap` resize |
| `unrar` 对 RAR5 部分包失败 | 部分 CBR 打不开 | 文档说明；评估 `unrar-rs` |
| macOS 公证延期 | 分发受阻 | Phase 8 提前 2 周申请 Apple Developer ID |
| Linux 无 DBus 时 keyring 失败 | 凭据保存失败 | PBKDF2 master password fallback（UI 显式提示"未启用硬件凭据存储"） |
| Tauri 2.x 协议稳定性 | API 变动 | 锁定 minor 版本；CI 跑 `cargo update --dry-run` 告警 |
| 双页 OpenSeadragon viewport 控制精度 | 双页对齐偏移 | 用 `viewer.viewport.imageToViewportRectangle()` + 反复调试 |

---

## 10. 验证（每阶段交付前必跑）

### 10.1 单元测试

- **Rust**：`cargo test` 覆盖 SMB / WebDAV / archive / db / naturalSort
- **TypeScript**：`vitest` 覆盖 stores / composables / spread planner / naturalSort

### 10.2 端到端手测脚本

### Phase 2 完成时**：
- [ ] 打开本地目录，显示图片列表
- [ ] 单页阅读：滚轮缩放、拖拽平移、键盘翻页
- [ ] 双页阅读：封面单独 / 末页奇数不并排
- [ ] 进度持久化：关闭再打开恢复页码与模式
- [ ] UI 通过 `MediaSource` 抽象访问文件（grep 代码无 LocalMediaSource 直接调用）

**Phase 3 完成时**：
- [ ] 打开 CBZ（ZIP 容器）压缩包
- [ ] 打开 CBR（RAR 容器）压缩包（RAR4 + 部分 RAR5）
- [ ] 打开独立 ZIP 文件
- [ ] 打开 RAR / 7z 压缩包

**Phase 4 完成时**：
- [ ] 当前页添加书签，列表显示
- [ ] 切换喜欢状态，列表显示
- [ ] 进入 reader，历史自动记录
- [ ] 历史点击跳转到对应页
- [ ] 书架视图显示收藏的书
- [ ] 创建标签，为书打标签
- [ ] 按标签筛选书架
- [ ] 搜索框输入模糊匹配文件名 / 书名 / 标签

**Phase 5 完成时**：
- [ ] 顶栏播放按钮可切换播放 / 暂停
- [ ] 间隔滑块（1-30s）实时生效
- [ ] 方向切换（forward / backward）生效
- [ ] 循环开关：末页 loop=true 回首页、loop=false 暂停
- [ ] 远程源图片加载慢时翻页正确等待
- [ ] 跨卷连续阅读：`off` 模式末页停住
- [ ] 跨卷连续阅读：`auto` 模式末页自动跳下一本
- [ ] 跨卷连续阅读：`manual` 模式末页弹提示确认跳转
- [ ] 跨卷连续阅读：从压缩包末页跳到目录中下一本
- [ ] 跨卷连续阅读：从目录末页跳到父目录下一本

**Phase 6 完成时**：
- [ ] 设置页切换 zh-CN / en-US
- [ ] 所有 UI 文案（含错误信息、对话框标题）完整翻译
- [ ] 跟随系统 locale 默认行为正确
- [ ] locale 切换无需重启立即生效

**Phase 7 完成时**：
- [ ] 添加 SMB 账户（含测试连接）
- [ ] 列出 SMB 目录，含图片与非图片分类
- [ ] 打开 SMB 中图片，进度写入
- [ ] UI 无需改动即支持 SMB（`MediaSource` 抽象生效）

**Phase 8 完成时**：
- [ ] 添加 WebDAV 账户
- [ ] 浏览 WebDAV 目录
- [ ] 打开 WebDAV 中图片

**Phase 9 完成时**：
- [ ] macOS DMG 安装、启动、升级
- [ ] Windows MSI 安装、启动、升级
- [ ] Linux DEB / AppImage 安装、启动

---

## 11. 完整设置项参考（与 MiraPage Android v0.2.0 对齐）

桌面端需实现全部 33 个设置项（与 Android `SettingsRepository.kt:45-85` 镜像）。持久化于 SQLite `settings` 表（key-value）。DataStore 名称 `"settings"`。

> ✅ **落地状态**（v0.1.0-module3.0-settings，2026-08-03）：Settings.vue 重写为 5 section + 左侧锚点导航 + 9 宫格可视化编辑器。**已落地 12 项**（标 ✅ ），**已存 store 但 UI 未暴露 1 项**（`color_theme`，no UI），**未实现 20 项**（SMB/WebDAV/Cache/Download/Backup 等 Desktop 不适用子系统）。spec：`docs/superpowers/specs/2026-08-03-settings-panel-design.md`
>
> ✅ **v0.1.0-module3.0.2-reader-polish 增量**（spec：`docs/superpowers/specs/2026-08-04-reader-polish-design.md`）：
> - `scale_mode` DB key 新增（与 `default_scale_mode` 区分；runtime scale 由 `setScaleMode(mode)` 持久化）
> - reader 排序与 file browser 一致：`ReaderView.loadBook` 用 `useFileBrowserStore().effectiveSortField / .effectiveSortAscending`（含 per-folder override via `directorySort`）替代硬编码 `naturalSort(name)`
> - 6 种缩放全接（fit-screen / fit-width / fit-height / original / full-screen / stretch）通过 `useReaderScale` composable 应用
> - 立即阅读入口（双击图片）：`useReaderActions.readFromImage(image)` + 路由 `?at=imageName`

| 分组 | Key | 类型 / 默认值 | 文案（中文） | UI 入口 | 控制的行为 | 落地 |
|---|---|---|---|---|---|---|
| **外观** | `theme_mode` | String/Enum, `SYSTEM` | 主题（跟随系统 / 浅色 / 深色） | 设置 → 外观 | `html.dark` class + Tailwind v4 `dark:` variant | ✅ |
| 外观 | `color_theme` | String/Enum, `BLUE` | 主题配色（科技蓝 / 优雅紫 / 暖琥珀 / 中性灰） | **无 UI**（仅 store 存值） | 色相（与 themeMode 正交；未接 Tailwind） | 🟡 |
| 外观 | `brightness` | Float, `-1f` (=跟随系统) | 屏幕亮度 | `BrightnessRow` 滑块 | Tauri window `set_brightness`（仅阅读器） | ❌ |
| 外观 | `keep_screen_on` | Boolean, `true` | 阅读时保持屏幕常亮 | 设置 → 行为 | Tauri thread execution_state | ✅ |
| **阅读默认** | `reader_default_mode` | String/Enum, `SINGLE_PAGE` | 默认阅读模式（单 / 双） | 设置 → 阅读器 | 首次开卷初始化容器模式 | ✅ |
| 阅读默认 | `default_scale_mode` | String/Enum, `FIT_SCREEN` | 默认缩放（6 mode） | 设置 → 阅读器 | OpenSeadragon `homeFillsViewport`（store 存，下开卷生效） | ✅ |
| 阅读默认 | `default_read_direction` | String/Enum, `LEFT_TO_RIGHT` | 默认阅读方向（LTR / RTL） | 设置 → 阅读器 | Pager `reverseLayout` | ✅ |
| 阅读默认 | `volume_key_paging` | Boolean, `true` | 键盘快捷键翻页（桌面端含义：保留作为全局开关） | `SwitchRow` | 监听键盘 / 鼠标侧键 | ❌（无硬件音量键） |
| **启动** | `startup_screen` | String/Enum, `FILE_BROWSER` | 启动时打开（文件浏览器 / 书架） | `EnumList` | 冷启动路由目标 | ❌ |
| **跨目录** | `continue_to_next_directory` | String/Enum, `SWIPE` | 接续下一文件夹（关闭 / 自动 / 手动） | 设置 → 阅读器 → "翻到末页后" | `ReaderViewModel.maybeContinue` 触发条件 | ✅（桌面端用 off/auto/manual 3 态，**不**含 PV 的 SWIPE） |
| **幻灯片** | `slideshow_interval_ms` | Long, `3000` (≥500) | 自动推进间隔（1-30 秒） | 设置 → 幻灯片 | `useSlideshow` `setInterval` | ✅ |
| 幻灯片 | `slideshow_direction` | String/Enum, `FORWARD` | 幻灯片方向（正向 / 反向） | 设置 → 幻灯片 | 自动翻页方向 | ✅ |
| 幻灯片 | `slideshow_loop` | Boolean, `true` | 循环播放 | 设置 → 幻灯片 | 末页行为（停止 vs 回首页） | ✅ |
| **文件浏览器** | `fb_sort_field` | String/Enum, `NAME` | 默认排序（名称 / 日期 / 大小） | `EnumList` | `compareBy`（存在 `fileBrowser` store，未在 Settings 暴露） | 🟡 |
| 文件浏览器 | `fb_sort_ascending` | Boolean, `true` | 升序排列 | `SwitchRow` | 同上 | 🟡 |
| **SMB / WebDAV** | `smb_archive_strategy` | String/Enum, `DOWNLOAD` | SMB 压缩包加载（下载整包 / 流式） | `CacheSettingsSection` | `ArchiveMediaSource` 加载模式（Phase 7） | ❌ |
| SMB / WebDAV | `webdav_archive_strategy` | String/Enum, `STREAM` | WebDAV 压缩包加载 | `EnumList` | 同上（Phase 8） | ❌ |
| SMB / WebDAV | `webdav_stream_buffer_kb` | Int, `256` (64-2048) | WebDAV 流式缓冲 (KB) | `NumberInputRow` | Range GET 大小（Phase 8） | ❌ |
| SMB / WebDAV | `concurrent_downloads` | Int, `3` (1-10) | 并发下载数 | `NumberInputRow` | `PageCacheManager.setMaxConcurrentDownloads` | ❌ |
| **缓存 / 预读** | `page_cache_size_mb` | Int, `512` (100-4096) | 缓存大小（MB） | `NumberInputRow` + chips（显示磁盘占用） | `PageCacheManager.resize` | ❌（无 page cache） |
| 缓存 / 预读 | `prefetch_budget_mb` | Int, `8` (0-100) | 预读预算（MB） | `NumberInputRow` | `PrefetchPlanner` 总预算 | ❌ |
| 缓存 / 预读 | `archive_cache_size_mb` | Int, `2048` (512-8192) | 压缩包缓存大小（MB） | `NumberInputRow` | `ArchiveCache.resize`（LRU 淘汰） | ❌ |
| **下载** | `download_directory` | String?（绝对路径） | 下载目录 | `DownloadSettingsSection` | Phase 5+ 落盘到本地副本 | ❌（无下载管理器） |
| 下载 | `download_directory_display_name` | String? | 下载目录显示名 | 同上 | UI 文本 | ❌ |
| 下载 | `auto_delete_after_finished` | Boolean, `false` | 全部阅读后自动删除 | `SwitchRow` | `DownloadManager` 末态清理 | ❌ |
| 下载 | `download_concurrency` | Int, `4` (1-10) | 下载并发数 | `NumberInputRow` | `DownloadManager.setConcurrency` | ❌ |
| **i18n** | `locale` | String, `system` | 语言（zh-CN / en-US / 跟随系统） | 设置 → 行为 | `vue-i18n` locale 切换 | ✅ |
| **搜索** | `search_mode` | String/Enum, `fuzzy` | 搜索模式（模糊 / 子串） | 无 UI（仅 store，Search.vue 直接读写） | fuse.js threshold 配置 | 🟡 |

**触控 3×3 映射已移除**（v0.1.0-module3.0.12-touch-zones-removal）：9 宫格触控方案（`TouchZone`/`TouchAction`/`touchScheme` + Settings Touch section + `TouchRegionsOverlay` 可视化）整体删除，migration 014 清理 `touch_*` settings key。原 9 区动作全部有桌面端等价入口（`W`/`B`/`End`/`←→`/`M`/`P`/`Alt+→`，见 §15.9 键位表）；唯 `folder-prev`（`Alt+←`）失去入口——原为 TODO 空实现，跨卷 prev 留独立模块。

**i18n 文案**（全部走 `$t()`，新增 `settings.*` namespace 参考 `docs/superpowers/specs/2026-08-03-settings-panel-design.md` §4.5）：
- `slide.range`（间隔滑块标签）
- `slide.direction.forward` / `reverse`
- `slide.loop`
- `app.theme.mode.{system,light,dark}`
- `app.color.{blue,purple,amber,neutral}`
- `reader.mode.{single,double}`（桌面端仅这两个）
- `reader.dir.{ltr,rtl}`
- `reader.scale.{fitScreen,fitWidth,fitHeight,original}`
- `fb.sort.{name,date,size}` + `fb.sort.ascending`
- `cache.size.{page,prefetch,archive}`
- `cache.concurrent`
- `account.smb.archive.{download,stream}`
- `account.webdav.archive.{download,stream}`
- `reader.continue.{off,auto,swipe,manual}`（桌面端用 `off/auto/manual` 3 态，**不**含 SWIPE）
- `lang.{zh,en,system}`

> v0.1.0-module3.0-settings 起，**设置面板**新增 namespace `settings.*`（45 keys），全文走 `t('settings.*')`。详见 [`docs/superpowers/specs/2026-08-03-settings-panel-design.md` §4.5](./superpowers/specs/2026-08-03-settings-panel-design.md)。

---

## 12. 阅读器交互与状态机

桌面端需复刻 Android 阅读器的所有交互语义，但**只用单页 + 双页两种模式**（不做 webtoon / 横条）。

### 12.1 单页容器 (`SinglePageViewer.vue`)

- **底层**：`HorizontalPager`（desktop 用一个支持键盘 + 鼠标拖拽的 pager 组件或 `swiper.js`），`reverseLayout = direction == RTL`
- **初始页**：`initialPage = currentIndex.coerceIn(0, lastIndex)`
- **点击**：桌面端鼠标点击不承载翻页/缩放语义（9 宫格已于 3.0.12 移除）
- **翻页触发**：
  - Pager 拖动 → `pagerState.currentPage` 变化 → `watch(currentPage)` → `onPageChanged(newPage)` → ViewModel
  - 键盘 / 鼠标侧键 → `useReaderHotkeys` 拦截 → `viewModel.nextPage()/previousPage()` → 更新 `_currentIndex` → `watch(currentIndex)` → `pagerState.scrollToPage(currentIndex)`
  - 翻页按钮 → `viewModel.nextPage()` / `previousPage()`
- **Chrome 显隐**：paged 模式默认显示；按 `Esc` / `M` / `C` 切换；webtoon / strip 模式（不做）自动隐藏
- **进度条**：复用 `JumpPageDialog.vue`，含 Slider + TextField 输入页码

### 12.2 双页容器 (`DoublePageViewer.vue`)

- **底层**：`HorizontalPager`，`pageCount = spreads.size`（注意是 spread 数，不是页数）
- **初始页**：`initialPage = SpreadPlanner.spreadIndexForPage(currentIndex, spreads)`
- **Spread 合并规则**（由 `SpreadPlanner.plan(pageCount, coverStandalone=true)` 重写为 TS / Rust）：
  - `pageCount == 0` → `[]`
  - `pageCount == 1` → `[0..0]`（单页无论 coverStandalone）
  - `pageCount > 1 && coverStandalone` → `[0..0]` + `[1..2]` + `[3..4]` + ... + 余单页 `[i..i]`
  - `coverStandalone == false` → 两两配对
- **翻页策略**：一次翻 1 个 spread（= 2 页）
- **进度以 spread 为单位报告**（同 Android）
- **RTL**：LTR 时 N 在左 N+1 在右；RTL 时 N+1 在左 N 在右（`reverseLayout` 整体镜像）
- **跨卷触发**：复用 `ContinueNextVolume` composable（按 spread 末尾 + 1/3 屏阈值）

### 12.3 跨卷连续阅读（桌面端 3 模式）✅ v0.1.0-module3.0.9-cross-volume

设置 `continue_to_next_volume`（v0.1.0-module3.0-settings 起 + 跨卷模块实施，桌面端用 3 态简化，**不**含 PV 的 SWIPE——v0.1.0-module2.0 拍板的"未来加 SWIPE"在跨卷模块实施时没加，详见 CLAUDE.md §6 决策记录）：

| 模式 | 行为 |
|---|---|
| `off` | 末页停住，无任何提示 |
| `auto` | 末页自动跳下一本（不等用户操作）；跨卷成功后恢复 slideshow 播放（A7 修复）+ 短暂 toast"已跳转《XXX》" |
| `manual` | 末页弹底部药丸"继续读下一本《XXX》？" + 跳转/✕；点跳转才换书；manual **不**续播 slideshow（用户主动确认，confirmManual 自己的 capsule 提示） |

**4 触发入口**（9 宫格入口已随 3.0.12 移除）：
1. reader 末页再向下（滚轮/下键/双击）→ 末页再向下 `reader.nextPage()` 触发 onAtLastNextAttempt → 写 `slideshow.pendingNextVolume=true` → ReaderView watch → `crossVolume.maybeContinue(false, 'next')` 看模式
2. slideshow tick 末页 → 同一 flag
3. Alt+→ → `crossVolume.maybeContinue(true, 'next')`（force=true 不看模式）
4. 瀑布流工具栏"下一卷"按钮 → 独立 `onCrossNextVolume`（fileListRef.masonryFlushNow → findNextVolume → 双重陈旧校验 path+root → fb.navigate；不走 Controller/Loader）

**末页再向下触发语义**：从倒数第二页 nextPage 翻到末页那次**不**触发跨卷（序列边沿自动区分"翻到末页"与"末页再向下"），在末页再向下才触发（spec §1.2 末页触发时机）。

**11 条不变量端到端闭环**（spec §4.3）：
- **route 唯一真值** — 跨卷走 `navigateToVolume(ensureBookId+router.replace)` → route watch 触发 `loadRouteBook` 加载新卷；不"先加载再 replace"（那是双入口）
- **watch immediate 唯一入口** — 删 `onMounted(loadBook)`，改 `watch(() => Number(route.params.bookId), loadRouteBook, { immediate: true })`
- **失败不保留旧卷** — route 变即 `visibleReader=false` 触发 loading；loadBookById throw → `reader.closeBook() + pageUrls/imageNames/book 清空 + bookLoadPhase=error`；ReaderScreen 渲染 reader-error UI（`bookId=null, status=idle`），不残留旧画面
- **去重看 phase** — `if (bookId === lastLoadedBookId.value && bookLoadPhase.value === 'ready') return;`；`retryCurrentBook` 通过置 null 跳过去重重载
- **原子提交** — loadBookById 全程不写 refs、不调 reader.openBook；commitBookSnapshot 一次性写 book/pageUrls/imageNames + reader.openBook + reader.imageNames
- **busy 覆盖 loader** — `busy = phase !== 'idle' || bookLoadPhase === 'loading'`；Controller 入口 `if (!opts.canStart()) consumePendingNextVolume(); return;` 阻断
- **pendingCrossVolume 只在 awaiting-confirm 非空** — `settleIdle()` 集中收口（clearPendingState + phase=idle）；navigateResolvedTarget finally 调 settleIdle
- **route.query.at 清空** — `router.replace({ name: 'reader', params: { bookId }, query: {} })`
- **pendingNextVolume 五处消费** — off 失败 / find 失败 / 导航成功 / 关闭胶囊 / Controller 内部 clearPendingState
- **saveCurrentProgressNow await+取消旧 debounce** — reader store 实现取消 timer + await saveProgress，trySave 失败 toast 不阻断跨卷
- **setOnAtLastNextAttempt(null) 卸载清理** — onUnmounted 调 null，避免 Pinia store 持有旧组件闭包

**Rust 算法**（由 `FindNextDirectoryUseCase` 重写为 Rust，跨卷模块 spec §5.2）：
- 输入 `(descriptor, currentPath, direction)` → `Result<Option<NextVolumeResult>>`
- 强类型解析 descriptor（不在 command 内反复操作 `serde_json::Value`）
- **仅 Local**（非 Local 返回明确 Err，不静默 fallback）
- 解析父目录 → `factory.resolve(&descriptor).list_directory(&parent_path)` → `pick_sibling`（仅过滤 `is_directory`，按 natural_compare 排序，取 next/prev）
- 构造 `NextVolumeResult { descriptor（同源 Local），rel_path，title }`（**无 is_archive 字段**）
- `VolumeDirection` 强类型 enum（`Next` / `Prev`）；非法 IPC 入参 serde 反序列化报错，不静默当 next

**TS 镜像**（spec §5.1）：`NextVolumeResult` 字段 `{ descriptor: SourceDescriptor; relPath: string; title: string }`（**无 isArchive**），Rust/TS 字节级 camelCase 一致；`findNextVolume(descriptor, currentPath, direction)` **无 filter 参数**（P1-3 删除——reader/masonry 在仅 Local 目录卷下语义一致）。

### 12.4 阅读器核心状态机

```rust
// Tauri state machine, 简化版
enum ReaderState {
    Loading,
    Ready {
        bookId: i64,
        pages: Vec<String>,        // page URLs
        spreads: Vec<IntRange>,    // SpreadPlanner.plan()
        currentSpreadIndex: usize,
        isAtFirstPage: bool,
        isAtLastPage: bool,
        continueSwipePull: f32,    // 0.0-1.0 累计
    },
    Error {
        kind: ErrorKind,
        isPermissionRevoked: bool,
        onReauthorize: Option<fn()>,
    },
}

enum ErrorKind {
    Unreachable,         // 网络/文件不可达
    Timeout,             // 30s withTimeout 超时
    PermissionRevoked,   // SAF Uri 权限丢失（桌面端映射：本地路径无权限 / 远程认证失败）
    DecodingError,       // 图片解码失败
    Empty,               // 目录为空
}
```

**关键事件流**：

```
ReaderViewModel.init:
  1. reopenBook(bookId, withTimeout(30s))
  2. on Success:
     - browse_history.record(descriptor, relPath)
     - state = Ready(...)
  3. on Failure:
     - state = Error(kind)
     - if PermissionRevoked → UI 提供"重新选择文件"按钮
```

```
onPageChanged(newIndex):
  1. _currentIndex = newIndex
  2. pageChangeTicker.emit()  // 触发 500ms 防抖
  3. atLastPage = (newIndex >= lastIndex)
  4. if atLastPage && atLastPageToggledToTrue:
     - maybeContinue(force=false, dir=NEXT)
  5. schedulePrefetch()  // AHEAD=3, BEHIND=3, 按 prefetchBudgetMb 截断
```

```
maybeContinue(force, dir):
  1. if OFF → return
  2. bookSwapInFlight guard（@Volatile）
  3. if SWIPE && !force → _swapping = true, return（仅 arm，不查目录）
  4. findNextDirectory(...) → null 时 toast "无下一卷" / "无上一卷"
  5. persistProgress(writeFinished=false)
  6. _bookSwap.emit(BookSwapTarget{descriptor, relPath, title})
  7. bookSwapInFlight = false (finally)
```

**进度保存策略**（与 Android 一致）：
- **500ms 防抖**：`pageChangeTicker.debounce(500ms) → persistProgress()`
- **窗口关闭时立即保存**：`window.onCloseRequested → saveImmediately()`
- **跨卷前 flush**：`maybeContinue` 内调 `persistProgress(writeFinished=false)`
- **finished 语义**：`finished = (currentIndex >= lastIndex) || existing?.finished == true`（sticky，永不翻回）

### 12.5 阅读器 UI 持久元素（`ReaderOverlay`）

| 元素 | 位置 | 触发 | 显示条件 |
|---|---|---|---|
| 页码指示器 | 右下角 | — | 常驻 |
| 预读状态 | 左下角 | — | chrome 隐藏时 |
| 跨卷进度药丸 | 底部居中（bottom 100dp） | `continuePull > 0` | 滑动到末页继续向 NEXT 方向划 |
| 跨卷切换 | 底部居中 | `_swapping == true` | 切换进行中 |
| 切换 toast | 底部居中（bottom 72dp） | 模式/方向/缩放切换 | 切换后 1.5s |
| 主菜单 | 全屏遮罩 | `Esc` / `M` | 用户触发 |
| 跳页对话框 | 全屏 | 顶栏跳页按钮 / `Ctrl+G` | 用户触发 |

---

## 13. Domain 算法清单（待移植）

以下算法必须从 Kotlin 1:1 移植到 Rust / TypeScript，保持语义完全一致。**纯函数部分（不依赖 IO）放 `src-tauri/src/algorithm/`；IO 边界部分（依赖 MediaSource / Repository）放 `src-tauri/src/usecase/`**。

### 13.1 纯函数（直接 1:1 移植）

| 算法 | 文件（参考） | 签名 | 关键语义 |
|---|---|---|---|
| `SpreadPlanner.plan` | `domain/reader/SpreadPlanner.kt:17` | `plan(pageCount: i32, coverStandalone: bool = true) -> Vec<IntRange>` | 双页规划；首张独占 + 奇数尾页单成 |
| `PrefetchPlanner.plan` | `domain/reader/PrefetchPlanner.kt:23` | `plan(idx, pageCount, aheadCount, behindCount, scrollingUp) -> Vec<i32>` | 预取页序；behind 优先（向上滚时） |
| `syntheticBookIdOf` | `domain/usecase/OpenBookUseCase.kt:164` | `(descriptor, relPath) -> i64` | `UUID.nameUUIDFromBytes(desc.toString()+"\|"+relPath)` → `-abs(mostSignificantBits)` |
| `archiveKeyParts` | `domain/usecase/OpenBookUseCase.kt:175` | `(source, absPath) -> (SourceDescriptor, String)` | Archive 归一化到 `(origin, archiveRelPath)`；否则原样 |
| `progressKeyForLocal` | `domain/usecase/OpenBookUseCase.kt:186` | `(localDesc, localRel, mapping) -> i64` | 本地副本进度映射到远程源 |
| `NaturalSortComparator.compare` | `core/util/NaturalSortComparator.kt:11` | `(a, b) -> i32` | `page2.jpg < page10.jpg`；数字段长度优先 + 前导零归一 |
| `PathUtils.{segments, normalize, join, parent, crumbs}` | `core/util/PathUtils.kt:12` | 字符串处理函数 | 反斜杠→`/`、去空段、面包屑累积 |
| `MimeUtils.{isImage, isArchive, mimeFromName, supportedExtensions}` | `core/util/MimeUtils.kt:7` | 扩展名映射函数 | jpg/jpeg/png/gif/webp/bmp/heic/heif；压缩包 cbz/cbr/zip/rar/7z |
| `image_header::image_dimensions` | 桌面端原创（无 Android 对应） | `(bytes: &[u8]) -> Option<(u32,u32)>` | 手写 JPEG SOF0 / PNG IHDR / GIF LSD / BMP DIB header 字节解析（纯 std 无 image crate）；TS 双实现 `lib/imageHeader.ts`。仅 masonry viewMode 经 `list_image_dimensions` command 调用 |

### 13.2 IO 边界函数（需要 async + DI 重组）

| 函数 | 签名 | 关键逻辑 |
|---|---|---|
| `FindNextDirectoryUseCase.invoke` | `async fn (descriptor, currentPath, direction, defaultSort) -> Result<Option<String>>` | parent → listDirectory → 过滤 dir/archive → natural sort → 取 next/prev（见 §12.3） |
| `OpenBookUseCase.invoke(bookId)` | `async fn (i64) -> Result<BookOpenResult>` | 从 LibraryRepository 取书 → resolveSource → listDirectory → sort → archiveKeyParts → syntheticBookId → 读 progress |
| `OpenBookUseCase.openTemp(descriptor, relPath, title, sort=DEFAULT)` | 同上 | **不写 LibraryEntity**；Local 时先查 downloadRepository 构 mapping → progressKeyForLocal；否则直接 archiveKeyParts + syntheticBookId；构造合成 LibraryEntity（id=负数） |

### 13.3 关键重写注意事项

- **`syntheticBookIdOf` 的负数语义**：必须严格保持 `-abs(msb)`，否则与 Android 端备份互导时 progressKey 会冲突
- **`archiveKeyParts` 的归一化条件**：`source is Archive && origin != null && archiveRelPath != null` 才归一化；否则原样
- **`progressKeyForLocal` 的 mapping**：必须在 openTemp 阶段就构好 mapping，不能到 saveProgress 阶段临时查
- **`SortOptionComparator` 的 override 优先级**：`DirectorySortRepository.resolveSort` 必须 per-dir override > 全局 default（这是 Android 修过的 #4 bug）

> 注：`TouchScheme.touchRegion`（3×3 分区算法）曾随 v0.1.0-module3.0-settings 落地，v0.1.0-module3.0.12 随 9 宫格功能整体移除（桌面端点击不承载翻页语义）。

---

## 14. 桌面端键盘快捷键映射

Android 端的触控 3×3 区域 + 音量键翻页 + 触屏手势，在桌面端映射为键盘 + 滚轮（原 3×3 鼠标分区点击已随 9 宫格功能于 3.0.12 移除——桌面端鼠标点击不承载翻页语义，避免与 chrome 按钮误触冲突）：

### 14.1 通用阅读器键位（与 MiraPage Android 1:1 对齐）

| 桌面输入 | 动作 | Android 等价 |
|---|---|---|
| `←` / `PageUp` | 上一页（PREV_PAGE） | 触控 ML 区 / 音量键 |
| `→` / `PageDown` / `Space` | 下一页（NEXT_PAGE） | 触控 MR 区 / 音量键 |
| `Home` | 跳到首页（JUMP_FIRST） | — |
| `End` | 跳到末页（JUMP_LAST） | 触控 TR 区 |
| `Esc` / `M` | 切换主菜单（OPEN_MAIN_MENU） | 触控 MC 区 |
| `C` / `Ctrl+H` | 切换 chrome 显隐（TOGGLE_CHROME） | — |
| `W` | 适宽缩放（FIT_WIDTH） | 触控 TL 区 |
| `B` | 打开文件浏览器（OPEN_FILE_BROWSER） | 触控 TC 区 |
| `Alt+→` | 下一卷（FOLDER_NEXT） | 触控 BR 区 |
| `Alt+←` | 上一卷（FOLDER_PREV） | 触控 BL 区（桌面端待实现） |
| `P` / `F5` | 切换幻灯片（SLIDESHOW_TOGGLE） | 触控 BC 区 |
| `1` / `2` | 单页 / 双页模式 | — |
| `L` | LTR / RTL 切换 | — |
| `Ctrl+G` | 跳页对话框 | — |
| `Ctrl+F` | 搜索 | — |
| `F11` | 全屏切换 | — |

### 14.2 鼠标映射

| 鼠标输入 | 动作 |
|---|---|
| 左键拖动 | Pager 翻页（桌面端比触屏更精确） |
| 滚轮上 / 下 | PREV_PAGE / NEXT_PAGE（paged）或滚动（已不做 webtoon / strip） |
| 右键 | 上下文菜单（`ReaderContextMenu`，v0.1.0-module3.0.2 已实现） |

### 14.3 跨卷触发（桌面端）

- **paged** 模式：末页静默 arm；继续 `→` 按键累计 3 次 → 触发（与 Android 1/3 屏宽等价）
- **manual** 模式：末页弹药丸 + `Enter` 键确认 / `Esc` 取消

---

## 15. 桌面端输入设备与手势映射（从 Android 触控到桌面输入）

MiraPage Android 的核心交互是**触屏**（单击 / 双击 / 双指 pinch / 划动 / 长按）。桌面端没有触屏，需要把**每一种手势**映射到**鼠标 / 键盘 / 触控板**的等价操作。

### 15.1 输入设备矩阵

桌面端必须支持以下 4 类输入设备，按优先级排序：

| 设备 | 必选 | 适配要点 |
|---|---|---|
| **键盘** | ✅ | 全部快捷键必须可工作；参考 §14.1 |
| **鼠标** | ✅ | 左 / 右 / 中键 + 滚轮 + 侧键（部分鼠标 4-5 键 + 水平滚轮） |
| **触控板** | ✅（macOS 必备） | macOS 全手势（双指滚动 / 双指捏合 / 三指滑动 / 四指切换桌面） |
| **触屏**（Win11 2-in-1 / Surface） | ⭕ 可选 | 与 Android 触控语义最接近，可作为高级模式启用 |

### 15.2 Android 手势 → 桌面操作映射

| Android 手势 | 桌面等价（鼠标 / 键盘 / 触控板） | 触发逻辑 |
|---|---|---|
| **单击左 1/3** | 鼠标左键单击左 1/3 区域 | `@click` + 区域判定 |
| **单击中区** | 鼠标左键单击中间 1/3 / `Esc` / `M` | 同上 |
| **单击右 1/3** | 鼠标左键单击右 1/3 区域 | 同上 |
| **双击** | 鼠标左键双击 | `onDblClick` → FIT_WIDTH ↔ 1:1 |
| **双指 pinch** | `Ctrl + 滚轮`（光标处缩放） / 触控板捏合 | OpenSeadragon zoom API |
| **双指 drag** | `Shift + 拖动` / 触控板双指拖动 | OpenSeadragon pan API |
| **单指拖动** | 鼠标左键拖动 | Pager 翻页 |
| **划动到边界继续划** | 末页继续向 NEXT 方向 `→` 3 次 / 拖动越界后继续拖 1/3 屏宽 | 跨卷触发 |
| **长按** | 鼠标右键 / 长按左键 500ms | 右键菜单（暂不实现，预留接口） |
| **3 指 / 4 指上滑** | 触控板手势（macOS） | 隐藏 chrome / 退出 reader |
| **音量键** | `↑` / `↓` 键（替代音量键翻页） | 与 `→` / `←` 同等（可通过 `volume_key_paging` 设置开关） |
| **触屏长按截图** | 暂不实现 | — |

### 15.3 鼠标按键分配（详细）

桌面端鼠标按键丰富，需充分利用：

| 按键 | 默认动作 | 可自定义 |
|---|---|---|
| **左键单击左 1/3** | PREV_PAGE | ✅（设置 → 输入） |
| **左键单击右 1/3** | NEXT_PAGE | ✅ |
| **左键单击中区** | TOGGLE_CHROME | ✅ |
| **左键单击顶 1/3** | OPEN_FILE_BROWSER | ✅ |
| **左键单击底 1/3** | OPEN_MAIN_MENU | ✅ |
| **左键双击** | FIT_WIDTH ↔ 1:1 | ✅ |
| **左键拖动**（paged 模式） | Pager 翻页 | 否（内置） |
| **左键长按** | 预留（未来上下文菜单） | — |
| **中键** | OPEN_MAIN_MENU | ✅ |
| **右键** | 预留（未来上下文菜单） | — |
| **侧键 4**（前进） | NEXT_PAGE | ✅ |
| **侧键 5**（后退） | PREV_PAGE | ✅ |
| **滚轮上** | PREV_PAGE | ✅ |
| **滚轮下** | NEXT_PAGE | ✅ |
| **水平滚轮左 / 右** | 单页切换到邻页 / 横条模式（不做） | ✅ |

### 15.4 触控板手势（macOS 必备，Windows precision 可选）

macOS 用户**主要**通过触控板操作，必须适配：

| 触控板手势 | 动作 |
|---|---|
| 双指滚动 | paged：PREV/NEXT_PAGE（按方向） |
| 双指捏合（pinch in / out） | OpenSeadragon zoom |
| 双指双击 | 智能缩放（OpenSeadragon `gestureSettingsTouch.pinchToZoom`） |
| 三指上滑 | 隐藏 chrome |
| 三指下滑 | 显示 chrome |
| 四指左右滑 | 上一卷 / 下一卷（**仅** SWIPE 模式生效） |
| 双指 force click | 预留（未来 OCR 选词等） |

Windows Precision Touchpad 大部分行为与 macOS 类似，可复用同一套逻辑（通过 `PointerEvent` 类型 + `OS_IOS` 判断 platform）。

### 15.5 键盘修饰符 + 多键组合

Android 没有键盘，桌面端需要系统化处理：

| 修饰键 | 用例 |
|---|---|
| `Shift` | 与翻页键组合 = 一次翻 5 页（`Shift+→` / `Shift+←`） |
| `Ctrl` | 与滚轮组合 = 缩放；与 G 组合 = 跳页 |
| `Alt` | 与 `→` / `←` 组合 = 跨卷（替代 SWIPE 触屏手势） |
| `Cmd` (macOS) | 与 `Q` 组合 = 退出；与 `,` 组合 = 设置 |
| `Meta` (Windows 键) | 暂不绑定（系统占用） |
| `Tab` | 在 UI 焦点间切换（无障碍） |

**多键组合 vs 单键**：单键无修饰符优先匹配；冲突时按"更长组合 > 更短组合"优先级（如 `Ctrl+G` 优于 `G`）。

### 15.6 触屏设备（Windows 2-in-1 / Surface）— 可选高级模式

桌面端若运行在触屏设备上，应**自动检测**并启用触屏语义：

```rust
// src-tauri/src/input/mod.rs
fn detect_touch_capable() -> bool {
    // Tauri 2.x 暂未直接暴露；可通过 webview userAgent + screen DPR + 系统设置启发
    // 或让用户在设置页手动启用「触屏模式」
}
```

触屏模式下：
- 单指 = 鼠标左键单击（自动）
- 双指 = 鼠标中键拖动（自动，OpenSeadragon pan）
- 划动 = 鼠标左键拖动（paged 翻页）

设置页提供开关「启用触屏语义」（默认关闭）。

### 15.7 键位自定义（用户级配置）

桌面端**必须**支持用户自定义键位，因为默认映射无法覆盖所有用户习惯。设计要点：

1. **数据模型**（v0.1.0-module3.0.12 起：3×3 触控方案已移除，`touch_*` key 由 migration 014 清理；键盘 / 鼠标 / 触控板 的键位自定义**仍待**）：
   ```typescript
   // src/stores/inputBindings.ts（**待** Phase 6+ 落地）
   interface InputBindings {
     // 键盘键位
     keyboard: Record<ReaderCommand, string[]>;   // action → 多组快捷键
     // 鼠标按键
     mouseButtons: Record<MouseButton, ReaderCommand>;
     // 滚轮
     wheelUp: ReaderCommand;
     wheelDown: ReaderCommand;
     // 触控板手势
     trackpad: Record<TrackpadGesture, ReaderCommand>;
   }
   ```

2. **持久化**：作为 JSON 字符串存入 settings 表的 `input_bindings` key

3. **设置页 UI**：分组展示「键盘快捷键 / 鼠标按键 / 触控板手势」，每项提供按键选择器 + "录制新键位"按钮 + "恢复默认"按钮

4. **冲突检测**：录制新键位时检测与已绑定动作冲突，弹冲突列表

5. **平台差异**：
   - macOS 显示 `Cmd`（而非 `Ctrl`）
   - Windows 显示 `Ctrl`
   - 通过 `navigator.platform` 检测

> **当前落地**（v0.1.0-module3.0.12）：键盘默认映射由 `inputBindings.defaultKeyBindings` 提供（`useReaderHotkeys` 消费）；3×3 触控方案已移除。键盘 / 鼠标 / 触控板 的完整自定义编辑器仍在 roadmap。

### 15.8 输入事件总线（架构）

桌面端输入最终统一到一个命令式总线，避免每个组件重复注册：

```typescript
// src/composables/useReaderInput.ts
import { onMounted, onBeforeUnmount } from 'vue';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { resolveAction } from '@/lib/inputBindings';

export function useReaderInput() {
  const reader = useReaderStore();
  const slideshow = useSlideshowStore();
  let detachHandlers: (() => void)[] = [];

  function handleCommand(cmd: ReaderCommand) {
    switch (cmd) {
      case ReaderCommand.NextPage:
        reader.nextPage(); break;
      case ReaderCommand.PrevPage:
        reader.previousPage(); break;
      case ReaderCommand.ToggleChrome:
        reader.toggleChrome(); break;
      case ReaderCommand.ToggleSlideshow:
        slideshow.togglePlayPause(); break;
      case ReaderCommand.JumpFirst:
        reader.jumpToPage(0); break;
      case ReaderCommand.JumpLast:
        reader.jumpToPage(reader.pageCount - 1); break;
      case ReaderCommand.OpenMainMenu:
        reader.showMainMenu = !reader.showMainMenu; break;
      case ReaderCommand.OpenFileBrowser:
        reader.navigateToFileBrowser(); break;
      case ReaderCommand.FitWidth:
        reader.fitWidth(); break;
      case ReaderCommand.FolderNext:
        reader.continueToNextVolume(); break;
      case ReaderCommand.FolderPrev:
        reader.continueToPreviousVolume(); break;
    }
  }

  function dispatch(event: InputEvent) {
    const bindings = useInputBindingsStore();
    const action = resolveAction(event, bindings);
    if (action) handleCommand(toCommand(action));
  }

  onMounted(() => {
    // 注册键盘
    const kbHandler = (e: KeyboardEvent) => dispatch({ kind: 'keyboard', key: e.key, modifiers: extractModifiers(e) });
    window.addEventListener('keydown', kbHandler);
    detachHandlers.push(() => window.removeEventListener('keydown', kbHandler));

    // 注册鼠标
    const mClickHandler = (e: MouseEvent) => dispatch({ kind: 'mouseClick', button: e.button, x: e.clientX, y: e.clientY, w: window.innerWidth, h: window.innerHeight });
    const mWheelHandler = (e: WheelEvent) => dispatch({ kind: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ctrlKey: e.ctrlKey });
    window.addEventListener('mousedown', mClickHandler);
    window.addEventListener('wheel', mWheelHandler);
    detachHandlers.push(() => { window.removeEventListener('mousedown', mClickHandler); window.removeEventListener('wheel', mWheelHandler); });

    // 注册触控板（macOS）
    if (navigator.platform === 'MacIntel') {
      const tHandler = (e: TouchEvent) => dispatch({ kind: 'touch', touches: e.touches.length, ...});
      window.addEventListener('touchstart', tHandler);
      detachHandlers.push(() => window.removeEventListener('touchstart', tHandler));
    }
  });

  onBeforeUnmount(() => detachHandlers.forEach(fn => fn()));
}
```

### 15.9 桌面端键盘快捷键完整映射表（与 Android 触控 1:1 对齐）

| TouchAction | 桌面默认（macOS） | 桌面默认（Win/Linux） | 用户可改 |
|---|---|---|---|
| `NEXT_PAGE` | `→` / `PageDown` / `Space` | 同 | ✅ |
| `PREV_PAGE` | `←` / `PageUp` | 同 | ✅ |
| `OPEN_MAIN_MENU` | `Esc` / `M` | 同 | ✅ |
| `TOGGLE_CHROME` | `C` / `Cmd+H` | `C` / `Ctrl+H` | ✅ |
| `JUMP_FIRST` | `Home` / `Cmd+↑` | `Home` / `Ctrl+Home` | ✅ |
| `JUMP_LAST` | `End` / `Cmd+↓` | `End` / `Ctrl+End` | ✅ |
| `SLIDESHOW_TOGGLE` | `P` / `F5` | 同 | ✅ |
| `FIT_WIDTH` | `W` | 同 | ✅ |
| `FOLDER_NEXT` | `Alt+→` / `Cmd+] ` | `Alt+→` | ✅ |
| `FOLDER_PREV` | `Alt+←` / `Cmd+[` | `Alt+←` | ✅ |
| `OPEN_FILE_BROWSER` | `B` / `Cmd+Shift+O` | `B` / `Ctrl+O` | ✅ |

---

## 16. 后续可扩展方向（不在本期范围）

- Webtoon 模式（连续竖向滚动）
- 横条模式（连续横向滚动）
- 下载到本地
- 配置备份 / 导入（与 Android `.pvbackup` 互导）
- 主题切换（深 / 浅 + 4 套色板）
- 缩略图网格视图
- 远程图加载进度条
- i18n：本期仅中 / 英两种语言；其他语言（日 / 韩 / 法等）为未来工作