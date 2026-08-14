# BUILD.md — 构建与打包指南

> 本文档记录 MiraPage Desktop 的构建环境、依赖兼容性修复、打包流程与已知坑。
> 与 [README.md](./README.md)（项目概览）、[DESIGN.md](./DESIGN.md)（架构设计）互补。

## TL;DR

- **开发/构建环境：Windows 原生**（Rust MSVC + VS Build Tools + WebView2）。
- **不要在 WSL `/mnt/f`（Windows 文件系统 9p 挂载）上构建 Tauri 全栈**——会连环撞墙，详见 [§3](#3-不推荐wsl-构建)。
- Rust 工具链若为 **1.96+**，需要 [§2](#2-依赖兼容性修复schemars--indexmap重要) 的 `indexmap` 修复（**已写入 `Cargo.toml`**）。

---

## 1. 推荐环境：Windows 原生

### 1.0 优先级：本地构建优先于 CI

> **v0.1.0-module1.21 起，本地 Windows 原生 Cargo 1.97.1 + MSVC BuildTools 14.51 工具链已端到端验证通过**（migration 003 + 全部 commands + lib.rs 注册）。后续模块（#2-#13）改动后，**优先在本地跑 `cargo check --manifest-path src-tauri/Cargo.toml` + `cargo test --manifest-path src-tauri/Cargo.toml` 验证 Rust 端**，再 push 触发 CI。这样迭代速度更快、错误信息更本地化。
>
> CI (`verify.yml`) 仍作为最终验证关口，但不再是唯一验证手段。

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

### 1.2 自定义路径：D:\compile 布局（推荐）

如果不想把工具链装在 C 盘（占空间），已验证以下布局可工作：

```
D:\compile\
├── .cargo\bin\cargo.exe, rustc.exe     # CARGO_HOME/bin
├── .rustup\toolchains\stable-x86_64-pc-windows-msvc\  # RUSTUP_HOME
└── vs\BuildTools\
    ├── VC\Tools\MSVC\14.51.36231\      # MSVC 编译器 + linker
    └── VC\Auxiliary\Build\vcvars64.bat # MSVC 环境变量设置脚本
```

**Git Bash 调用要点**（cargo check 全量需要 MSVC 工具链）：

```bash
# 1. 设 Rust 环境变量指向 D:\compile
export PATH="/d/compile/.cargo/bin:$PATH"
export RUSTUP_HOME="D:\\compile\\.rustup"
export CARGO_HOME="D:\\compile\\.cargo"

# 2. Bash 直跑 cargo 会失败 — Git Bash PATH 里的 MSYS `link` 命令
#    会被 MSVC 的 link.exe 误用,报 "extra operand ... cgu.0.rcgu.o"
#    必须用 cmd.exe 套 vcvars64.bat 套壳
```

**推荐做法：写个 bat wrapper 一键调用**：

```bat
@echo off
REM cargo-check.bat — 本地 cargo check 全套 (D:\compile 布局)
call "D:\compile\vs\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set PATH=D:\compile\.cargo\bin;%PATH%
set RUSTUP_HOME=D:\compile\.rustup
set CARGO_HOME=D:\compile\.cargo
cd /d F:\WorkSpaceCollection\git\mirapage-desktop\src-tauri
cargo check 2>&1
```

调用：

```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\cargo-check.bat"
```

或单独跑测试：

```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\src-tauri\\cargo-test-db.bat"
```

**踩坑记录**（v0.1.0-module1.21 验证时）：
1. `rustup` 默认 home 在 `C:\Users\<user>\.rustup`，复制到 D 盘后必须显式 `RUSTUP_HOME` 指向新位置，否则 `rustup toolchain list` 显示空
2. Git Bash 不能直接 `cargo check` —— MSYS 的 `link` 命令（coreutils）在 PATH 里，先于 MSVC `link.exe` 被发现，Rust 调用 `link.exe` 时参数被当成文件路径。**必须用 cmd.exe + vcvars64.bat**
3. Bash 里 `cmd.exe //C` 的反斜杠要双写 (`\\`)，否则 cmd 解析路径错

### 1.3 构建

```bash
npm ci                     # 按 lockfile 安装前端依赖（更新依赖时才用 npm install）
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

如果用 §1.2 的 D:\compile 布局，用 bat wrapper（避免 Git Bash link 冲突）：

```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\cargo-test.bat"
```

**已知失败的 1 个测试**（当前实测，与本模块无关，先记着后续修）：
- `source::webdav_impl::tests::parse_propfind_extracts_collection_and_files`（预存在）

CI workflow 只跑 `cargo check`，不会因此失败；本地完整 `cargo test` 仍会红 1 条预存在用例。

### 4.3 前端

```bash
npm test                       # Vitest + happy-dom
npm run type-check             # vue-tsc
npm run build                  # vue-tsc + Vite 生产构建
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 5. 打包与发布

### 5.1 本地打包命令

项目支持两种打包方案,通过 Tauri CLI flag 切换：

| 方案 | 命令 | 产物 | 适用场景 |
|------|------|------|---------|
| **A. 安装包** | `npm run tauri:build` | MSI + NSIS 安装程序 | 正式分发、Start Menu 集成、卸载面板 |
| **B. Portable** | `npm run tauri -- build --no-bundle` | 单 exe 自包含（约 17–18 MB） | 朋友试用、截图分享、绿色运行 |

两种方案都依赖 [§1 推荐环境](#1-推荐环境windows-原生)。

> **关键技术点：必须用 `tauri build`，不能用 `cargo build --release`。**
> Tauri CLI 在 Windows 上会向 WebView2 注册 `http://tauri.localhost/` 协议 handler；
> `cargo build` 漏掉这一步,webview 把 `tauri.localhost` 当真实 HTTP 连接,失败后
> 显示 Edge 的 ERR_CONNECTION_REFUSED 白屏（项目首次 CI 完整打包时踩过此坑）。

### 5.2 推荐：PowerShell 一键脚本（v0.1.0-module3.0.1+）

`scripts/build-portable.ps1` 把方案 B 的 `npm run build` + `tauri build --no-bundle` + 复制到本地副本的流程封装成幂等脚本，包含三项本地打包常见痛的解法：

| 痛点 | 脚本处理 |
|------|---------|
| **本地旧 exe 正在运行** → `cp` 报 `Device or resource busy` | 步骤 [1/5] 用 `Get-Process mirapage-desktop` 检测 → `Stop-Process -Force` → `Start-Sleep 2` → 二次确认退出（最多 3 次重试）|
| **Windows 防病毒/索引器占用文件** → 复制中途失败 | 步骤 [4/5] 用 `Remove-Item` + `Copy-Item` 重试 3 次，每次间隔 2s |
| **复制后不知道是否对得上** | 步骤 [5/5] 计算源 + 副本 MD5 对比，不一致报错退出 |

**用法**（Git Bash）：

```bash
powershell.exe -ExecutionPolicy Bypass -File "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\scripts\\build-portable.ps1"
```

或直接双击 PowerShell 文件（默认会用 PowerShell ISE 或 pwsh 打开）。

**参数化**（覆盖默认值）：

```powershell
.\scripts\build-portable.ps1 `
  -ProjectDir "F:\WorkSpaceCollection\git\mirapage-desktop" `
  -RustTarget "D:\compile\rust_target\release\mirapage-desktop.exe" `
  -LocalExeName "mirapage-desktop-local.exe"
```

**典型输出**（成功）：

```text
[1/5] Detect mirapage-desktop running instance
      [OK] no running instance
[2/5] npm run build (vue-tsc + vite)
      [OK] dist/ generated
[3/5] tauri build --no-bundle (Rust release)
      [OK] Rust release complete
[4/5] Copy to F:\...\mirapage-desktop-local.exe
      [OK] copy complete
[5/5] MD5 verification
      src   7673AC7D0604EA032F027FE039BC2B14  17.15 MB
      local 7673AC7D0604EA032F027FE039BC2B14  17.15 MB

=== DONE ===
Output: F:\...\mirapage-desktop-local.exe

Next: double-click .exe to run, OR
  git tag vX.Y.Z && git push github vX.Y.Z   # trigger CI release
```

**脚本踩坑记录**（v0.1.0-module3.0.1+ 实测）：

| 坑 | 现象 | 解决 |
|---|------|------|
| `cmd.exe /c "... && ..."` 中的 `&&` | PowerShell 5.1 报"该版本的语句分隔符无效" | cmd.exe 调用链封装到 `scripts\build-tauri-inner.bat`，PowerShell 只 `cmd.exe /c <bat>` |
| `2>&1` stderr→stdout 重定向 | `& cmd.exe ... 2>&1` 在 PowerShell 5.1 中 `2>&1` 被解释成 stderr 字符串传给 cmd.exe，cmd 报"找不到命令" | 直接 foreground `cmd.exe /c $InnerBat`，靠 `$LASTEXITCODE` 判断 |
| `Start-Process` + `RedirectStandardOutput` | cargo 输出 ~1000 行，4 KB pipe buffer 填满后子进程阻塞，父进程 `WaitForExit()` 永远等 | foreground 直接跑，输出直接到 PowerShell 终端（用户看到 cargo 实时输出，体验也更好）|
| UTF-8 文件 + 中文字符串 + 双引号变量插值 | PowerShell 5.1 解析器在 `Write-Host "中文${var}英文"` 处报"字符串缺少终止符" | 脚本消息体全部用 ASCII（`[OK]` / `[WARN]` / `[FAILED]`），注释里的中文 OK |

最终脚本采用 `Start-Process` 之前那种"最朴素的 foreground 调用 + `$LASTEXITCODE` 校验"模式，反而比 Start-Process 更快（无 IPC 开销）+ 实时输出 + 无 deadlock。

### 5.3 产物路径

```text
src-tauri/target/release/
├── mirapage-desktop.exe                  ← 方案 B 的单 exe
└── bundle/                                ← 方案 A
    ├── msi/MiraPage_0.1.0_x64_en-US.msi
    └── nsis/MiraPage_0.1.0_x64-setup.exe
```

- 前端 `dist/` 由 `tauri::generate_context!()` 在编译时嵌入二进制，**无需任何外部资源**
- Windows 10/11 自带 WebView2 Runtime；Windows 7/8 用户需手动装（[WebView2 Evergreen Standalone](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)）
- 未签名 exe 首次运行会弹 SmartScreen —— 右键 exe → 属性 → 勾选「解除锁定」→ 应用即可
- **本地副本** `mirapage-desktop-local.exe` 在项目根目录，保留 .git 黑名单（按 [CLAUDE.md §5.4](../CLAUDE.md)）—— 是脚本的复制目标，便于双击运行

### 5.4 CI 自动打包（GitHub Actions）

`.github/workflows/` 下两个 workflow（当前前端基线为 74 个测试文件、965 个测试全部通过）：

| Workflow | 触发器 | 用途 |
|----------|--------|------|
| `verify.yml` | push main / PR | 前端 type-check + test + build + 后端 `cargo check` 端到端验证 |
| `release.yml` | push `v*` tag / workflow_dispatch | `tauri -- build --no-bundle` 生成 portable exe；tag 触发上传 GitHub Release，手动触发仅上传 workflow artifact |

**手动触发 release 测试产物：**

```bash
gh workflow run release.yml -R jl0476/mirapage-desktop --ref main
```

**通过 tag 发版：**

```bash
git tag v0.1.0
git push github v0.1.0
```

仅 tag 触发会自动创建 GitHub Release 并上传 `mirapage-desktop.exe`；`workflow_dispatch` 只保留 workflow artifact。

**当前已发布的 Release：**

| Tag | Asset | 备注 |
|-----|-------|------|
| `v0.1.0-ci-test` | `MiraPage_0.1.0_x64-setup.exe` + `MiraPage_0.1.0_x64_en-US.msi` | MSI + NSIS 安装包（参考） |
| `v0.1.0-ci-portable` | `mirapage-desktop.exe` | 初版 portable,因协议注册缺失导致白屏,已废弃 |
| `v0.1.0-ci-portable-v2` | `mirapage-desktop.exe` | 修复后 portable（用 `tauri build --no-bundle`）,当前可用 |
| `v0.1.0-module1.17` | `mirapage-desktop.exe` | Tokyo Night 配色 + Tailwind v4 落地 |
| `v0.1.0-module1.20` | `mirapage-desktop.exe` | Xplorer NavigationBar / OperationBar 视觉对齐 |
| `v0.1.0-module1.21` | `mirapage-desktop.exe` | 阅读状态染色 (Reading/Finished) + 重置 + 隐藏过滤 |
| `v0.1.0-module2.0` | `mirapage-desktop.exe` | 阅读器接线（路由 + 9 宫格 + 滚轮 + 轮播） |
| `v0.1.0-module2.1` | `mirapage-desktop.exe` | Tauri 2 IPC 嵌套 args + asset protocol + history sourceDescriptor 修复 |
| `v0.1.0-module3.0` | `mirapage-desktop.exe` | 书库 / 阅览记录 / directory_sort 重写（Android schema 对齐） |
| `v0.1.0-module3.0.1` | `mirapage-desktop.exe` | 3 个反馈 bug 修复（history 仅 reader 触发 / readStatus 走 history∩progress / Library 路由 path param） |
| `v0.1.0-module3.0-settings` | `mirapage-desktop.exe` | Settings 5 section + 9 宫格触控方案 + theme 切换 + i18n 45 keys |
| `v0.1.0-module3.0.2-reader-polish` | `mirapage-desktop.exe` | 阅读器打磨 3 cluster：立即阅读入口（双击图片 + `?at=`）+ UI 修复（OSD nav 关闭 / ESC closeReader / chrome autoHide / pointer-events / 窗口 480×360）+ 6 种缩放 + reader 排序与 file browser 一致 |
| `v0.1.0-module3.0.11-thumbnail-per-image-progress` | `mirapage-desktop.exe` | 单图缩略图生成阶段进度、详情 popover、失败快照与全局开关 |
| `v0.1.0-module3.0.12-touch-zones-removal` | `mirapage-desktop.exe` | 移除阅读器 9 宫格触控（migration 014 清理 touch_* key；顺带清理 mouseRegionCommand 与 16 个孤儿 i18n key） |

> **当前状态**：本地 `tauri -- build --no-bundle` 流程已端到端验证通过（17.95 MB / MD5 一致，参考 §5.1 末段命令）。后续模块首选本地构建验证，CI 作为最后一道关。
>
> **v0.1.0-module3.0.2-reader-polish 关键 fix 记录**：
> - `8c04c34` 恢复 `status.value = 'ready'`（Cluster A 改动误删，导致"加载中...卡住"）
> - `83cc3d0` reader 排序改用 `useFileBrowserStore().effectiveSortField` + `sortEntries`（与 file browser 完全一致，含 per-folder override）
> - 前端单元测试：965 全过（含 module3.0.11 阶段进度与 hotfix 回归测试）
> - 本地 exe MD5 `1f753a594d026a8c303697b4e375930c`

---

## 6. 排错速查

| 现象 | 处理 |
|---|---|
| `E0107 IndexMap 泛型参数` | 确认 `Cargo.toml` `[build-dependencies]` 有 `indexmap = { version = "1.9", features = ["std"] }`（[§2](#2-依赖兼容性修复schemars--indexmap重要)） |
| `error: linker 'link.exe' not found` / MSVC 缺失 | 装 VS Build Tools + C++ workload（[§1.1](#11-必装组件)） |
| Git Bash 跑 `cargo check` 报 `link: extra operand ... cgu.0.rcgu.o` | MSYS `link` 干扰，用 cmd.exe 套 vcvars64.bat（[§1.2](#12-自定义路径dcompile-布局推荐)） |
| `rustup toolchain list` 显示 "no installed toolchains" 但 `D:\compile\.rustup\toolchains` 有内容 | rustup home 默认指向 C 盘，设 `RUSTUP_HOME=D:\compile\.rustup` |
| `Could not compile ... linking with link.exe failed: exit code: 1` 且错误是文件路径当 link 参数 | 同 Git Bash `link` 干扰问题；cmd.exe + vcvars64.bat 解决 |
| `vswhere.exe 不是内部或外部命令` 警告 | vcvars64.bat 找不到 VS，常见原因是 VS BuildTools 路径不在 `D:\compile\vs\BuildTools\`；警告级别，不影响 cargo check |
| WebView2 相关错误 | 确认 WebView2 Runtime 已装（Win11 自带） |
| WSL 编译 `PermissionDenied` / `EPERM` | 改用 Windows 原生，或源码移 WSL ext4（[§3](#3-不推荐wsl-构建)） |
| Vite 端口冲突 | `vite.config.ts` 固定 `port: 1420, strictPort: true`，勿改 |
