# BUILD.md — 构建与打包指南

> 本文档记录 MiraPage Desktop 的构建环境、依赖兼容性修复、打包流程与已知坑。
> 与 [README.md](./README.md)（项目概览）、[DESIGN.md](./DESIGN.md)（架构设计）互补。

## TL;DR

- **开发/构建环境：Windows 原生**（Rust MSVC + VS Build Tools + WebView2）。
- **不要在 WSL `/mnt/f`（Windows 文件系统 9p 挂载）上构建 Tauri 全栈**——会连环撞墙，详见 [§3](#3-不推荐wsl-构建)。
- Rust 工具链若为 **1.96+**，需要 [§2](#2-依赖兼容性修复schemars--indexmap重要) 的 `indexmap` 修复（**已写入 `Cargo.toml`**）。

---

## 1. 推荐环境：Windows 原生

### 1.1 必装组件

| 组件 | 用途 | 安装 |
|---|---|---|
| Rust（MSVC stable） | 编译 Rust 后端 | `winget install Rustlang.Rustup` |
| VS 2022 Build Tools + C++ 工作负载 | MSVC `cl.exe` + Windows SDK（Tauri 链接 / C 依赖编译） | 见下方命令 |
| WebView2 Runtime | Tauri webview 渲染 | Win10/11 通常自带 |
| Node.js 18+（推荐 24+） | 前端构建 | [nodejs.org](https://nodejs.org) |

VS Build Tools（**管理员 PowerShell**，约 6 GB）：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

装完**重开终端**，验证：

```powershell
rustup default stable-msvc
cargo --version    # 应输出版本号
```

### 1.2 构建

```bash
npm install                # 前端依赖
npm run tauri:dev          # 开发模式（Vite :1420 + Tauri IPC）
npm run tauri:build        # 生产构建（产出 MSI / NSIS 安装包）
```

> `tauri:dev` 必须用，单跑 `npm run dev` 只启 Vite、无 Rust IPC。

---

## 2. 依赖兼容性修复：schemars / indexmap（重要）

### 现象

Rust 工具链 **≥ 1.96** 时，`cargo check` / `cargo build` 在编译 `schemars 0.8.x` 时报：

```
error[E0107]: struct takes 3 generic arguments but 2 generic arguments were supplied
  --> schemars-0.8.x/src/lib.rs:12:32
12 | pub type Map<K, V> = indexmap::IndexMap<K, V>;
```

### 根因

依赖链 `tauri-build → schemars 0.8.x → indexmap 1.9.3`，**三者均无升级路径**：

1. `indexmap 1.9.3`（1.x 终版，1.x 到此终结）的 `build.rs` 在未启用 `std` feature 时，用 `autocfg` 探测 sysroot 的 `std` crate：
   ```rust
   match std::env::var_os("CARGO_FEATURE_STD") {
       Some(_) => autocfg::emit("has_std"),
       None => autocfg::new().emit_sysroot_crate("std"),  // ← rustc 1.96 下失效
   }
   ```
2. 该探测在 **rustc 1.96** 下失效 → `has_std` cfg 不 emit。
3. 于是编译走 `IndexMap<K, V, S>`（`S` 无默认值）分支，而非 `IndexMap<K, V, S = RandomState>`。
4. `schemars 0.8.x` 的 `pub type Map<K, V> = indexmap::IndexMap<K, V>;` 依赖 `S = RandomState` 默认值，缺省即报 E0107。

> `tauri-build` 锁定 `schemars 0.8.x`，故无法通过升级 schemars（0.9 / 1.x）解决。

### 修复（已写入 `src-tauri/Cargo.toml`）

```toml
[build-dependencies]
tauri-build = { version = "2", features = [] }
# 强制启用 std feature，让 indexmap build.rs 走 CARGO_FEATURE_STD 分支直接 emit has_std
indexmap = { version = "1.9", features = ["std"] }
```

启用 `std` feature 让 `indexmap` 的 `build.rs` 直接 `emit("has_std")`，绕开失效的 autocfg 探测。

**必须放在 `[build-dependencies]`**：Cargo **resolver v2**（edition 2021 默认）将 build-deps 与 normal-deps 的 feature **分离解析**。`schemars` 经 `tauri-build`（build-dep）引入，放在 `[dependencies]` 的 `indexmap/std` 无法传到这条 build-deps 链——已用 `cargo tree -e features -i indexmap@1.9.3` 实测确认会出现两个独立 feature 实例。**已验证该修复使编译推过 schemars 阶段。**

---

## 3. 不推荐：WSL 构建

在 WSL（`/mnt/f` Windows 文件系统 9p/DrvFs 挂载）上用 Linux rustc 构建 Tauri **桌面**应用，会连环撞墙：

| 阶段 | 错误 | 原因 |
|---|---|---|
| `zstd-sys` build.rs | `fs::copy` → `EACCES`（PermissionDenied） | DrvFs 对文件复制权限操作拒绝 |
| `tauri-build` | 创建 `app-manifest` → `EPERM`（os error 1） | DrvFs 权限限制 |
| 链接阶段 | 大概率缺 `webkit2gtk-4.1` / `libgtk-3-dev` | WSL 默认未装 Linux GUI 系统库 |

把 `CARGO_TARGET_DIR` 指向 WSL 原生 ext4 仅能绕过前两项，链接阶段仍需系统库。

**结论**：Tauri 桌面应用的 Linux 构建产物对 Windows 用户意义有限。如确需在 WSL 构建，须把**源码整体移到 WSL 原生 ext4**（`~/projects/`）并装齐 Linux 系统库：

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

---

## 4. 测试

### 4.1 后端算法纯函数（独立工程，绕开 Tauri 全栈链路）

```bash
cargo test --manifest-path src-tauri-algorithm-tests/Cargo.toml
```

`algorithm/*` 是无 IO 的纯 std 模块（`natural_sort` / `mime` / `path` / `spread_planner`），独立测试工程可秒级验证，不拉 Tauri 依赖图。

### 4.2 后端全量

```bash
cd src-tauri && cargo test     # 需完整 Tauri 环境（见 §1）
```

### 4.3 前端

```bash
npm test                       # Vitest + happy-dom
npm run type-check             # vue-tsc
```

---

## 5. 打包进度与产物

### 5.1 当前进度

> **⚠️ 尚未成功产出过任何安装包。** 打包链路从未跑通。

| 项 | 状态 |
|---|---|
| 后端完整编译（`cargo check` / `cargo build`） | 🟡 schemars/indexmap 阻塞已修（[§2](#2-依赖兼容性修复schemars--indexmap重要)），待 Windows 原生环境首次验证 |
| `npm run tauri:dev` 开发运行 | ❌ 未验证（依赖上一项） |
| `npm run tauri:build` 生产打包 | ❌ 未验证 |
| Phase 9 跨平台分发（安装包签名、macOS `.dmg`、Linux `.AppImage`、自动更新） | ❌ 未启动；`tauri-plugin-updater` 在 `package.json` 占位未启用 |

**历史背景**：后端 Tauri 全栈此前从未在本地完整编译过（`algorithm` 测试拆独立工程绕开，见 `Cargo.toml` 末注释），故打包链路从未跑通。本次修复（[§2](#2-依赖兼容性修复schemars--indexmap重要)）解除了编译阻塞，但完整 `cargo build` 仍需在 Windows 原生环境（[§1](#1-推荐环境windows-原生)）下首次验证后，才能进入打包验证。

### 5.2 产物路径（预期）

`npm run tauri:build` 在 Windows 上产出：

- `src-tauri/target/release/bundle/msi/*.msi`
- `src-tauri/target/release/bundle/nsis/*-setup.exe`

Phase 9 启用后将补 macOS `.dmg` / Linux `.AppImage`。

---

## 6. 排错速查

| 现象 | 处理 |
|---|---|
| `E0107 IndexMap 泛型参数` | 确认 `Cargo.toml` `[build-dependencies]` 有 `indexmap = { version = "1.9", features = ["std"] }`（[§2](#2-依赖兼容性修复schemars--indexmap重要)） |
| `error: linker 'link.exe' not found` / MSVC 缺失 | 装 VS Build Tools + C++ workload（[§1.1](#11-必装组件)） |
| WebView2 相关错误 | 确认 WebView2 Runtime 已装（Win11 自带） |
| WSL 编译 `PermissionDenied` / `EPERM` | 改用 Windows 原生，或源码移 WSL ext4（[§3](#3-不推荐wsl-构建)） |
| Vite 端口冲突 | `vite.config.ts` 固定 `port: 1420, strictPort: true`，勿改 |
