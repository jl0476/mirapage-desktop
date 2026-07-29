# CLAUDE.md

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
npm run tauri:build

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

---

## 当前状态（Phase 0 — 项目骨架）

- ✓ Tauri 骨架 + Vue 3 + Vite + Pinia + vue-i18n + Vue Router
- ✓ `MediaSource` trait + 4 个实现骨架（`LocalMediaSource` 实装，其他 stub 返回 `NotImplemented`）
- ✓ `MediaSourceFactory::resolve` 分发
- ✓ `commands::settings::{get_setting, set_setting}` + `commands::file_browser::{list_directory, read_file}`
- ✓ SQLite + 001_init 迁移（7 张表 + 默认 settings 行 + 触控 3×3 默认映射）
- ✓ `algorithm/` 4 个纯函数模块 + 单测（`cargo test` 全过）
- ✗ 压缩包实装 / OpenSeadragon 阅读器 / 视图业务逻辑 — 见 DESIGN.md §5 Phase 2-8
- ✗ SMB / WebDAV 协议层