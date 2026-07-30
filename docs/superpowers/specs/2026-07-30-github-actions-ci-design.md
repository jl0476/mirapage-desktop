# GitHub Actions CI 设计 — MiraPage Desktop

- **日期**: 2026-07-30
- **状态**: 已批准（待规格审查）
- **相关**: [BUILD.md](../../../BUILD.md) §2 / §5（schemars/indexmap 修复与打包进度）

## 1. 背景与目标

MiraPage Desktop 的后端 Tauri 全栈此前**从未在本地完整编译过**——schemars/indexmap 阻塞已修复（BUILD.md §2）但未端到端验证，本地 Windows 环境配置（Rust MSVC + VS 2022 Build Tools，约 6 GB）成本高、首次跑通门槛大。

**目标**：用 GitHub Actions 在云端完成「编译验证」与「Windows 打包」，绕过本地环境配置，首次跑通整条打包链路，并为后续 Phase 9 跨平台分发铺路。

**非目标**：本地构建替代、代码签名、自动更新分发（均属 Phase 9）。

## 2. 核心决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| CI 范围 | **两阶段**（验证 + 打包） | push/PR 快速反馈，tag 才正式打包，省额度、反馈快 |
| 平台范围 | **仅 Windows**（MSI + NSIS） | 聚焦当前核心诉求（绕过本地 Windows 环境），Phase 9 再扩 macOS/Linux |
| 打包触发 | **手动 + tag 双触发** | 手动（workflow_dispatch）产 artifact 供日常验证；push `v*` tag 自动建 Release 发版 |
| 仓库可见性 | **公开** | GitHub Actions 公开仓库 Windows runner 无限免费 |

## 3. 方案选择

采用**方案 B：两个 workflow 文件 + `tauri-apps/tauri-action`**。

候选方案与取舍：

| 方案 | 结构 | 取舍 |
|---|---|---|
| A. 单文件两 job | 一个 `.yml`，verify + release 用 `if` 区分 | 紧凑，但 push/PR 与 tag/手动触发条件混在一起，`if` 逻辑乱 |
| **B. 两文件 + tauri-action**（选定） | `verify.yml` + `release.yml`，用官方 action | 职责分离、边界清晰；action 封装产物发现/Release 上传；Phase 9 扩平台改动最小 |
| C. 两文件 + 纯手动脚本 | 同 B 拆分，但 `npm run tauri:build` + 手动 upload/release | 最透明，但产物路径/Release 创建全自己写，未来扩平台改动大 |

**选 B 的理由**：两种触发条件（push/PR vs tag/手动）完全不同，分文件比 `if` 分支更易读；`tauri-apps/tauri-action` 是 Tauri 官方维护、社区标准，当前「仅 Windows + 无 updater」配置极简，Phase 9 扩矩阵时只改 action 参数。

## 4. 详细设计

### 4.1 文件结构

```
.github/workflows/
├── verify.yml     # push/PR：快速编译验证（不打包）
└── release.yml    # tag v* / 手动：完整打包 + 发版
```

### 4.2 `verify.yml`（验证阶段）

- **触发**：`push` 到 `main` + `pull_request` 到 `main`
- **运行环境**：`windows-latest`（必须 Windows，才能验证 Windows 下的 `cargo check`）
- **步骤**：
  1. `actions/checkout`
  2. `actions/setup-node@v4`（Node 20，`cache: 'npm'`）
  3. `npm ci`
  4. `npm run type-check`（vue-tsc）
  5. `npm test`（vitest run）
  6. `npm run build`（前端 vue-tsc + vite build）
  7. `Swatinem/rust-cache@v2`（cargo 缓存）
  8. `cargo check --manifest-path src-tauri/Cargo.toml`
- **预期时长**：约 3-5 分钟（缓存命中后更快）
- **目的**：确保 Windows 下前后端均可编译、测试通过

### 4.3 `release.yml`（打包发版阶段）

- **触发**：`push` tag `v*` + `workflow_dispatch`（手动）
- **运行环境**：`windows-latest`
- **权限**：`permissions: contents: write`（创建 Release、上传资产需要）
- **核心步骤**：
  1. `actions/checkout`
  2. `actions/setup-node@v4`（Node 20，`cache: 'npm'`）
  3. `npm ci`
  4. `Swatinem/rust-cache@v2`
  5. `tauri-apps/tauri-action@v0`（`GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`）
- **触发分支逻辑**（同一 job，按上下文区分）：
  - **tag 触发**（`github.ref_type == 'tag'`）：`tagName: ${{ github.ref_name }}` → action 自动创建 GitHub Release 并上传 MSI + NSIS
  - **手动触发**：`tagName` 留空 → action 不建 Release，构建产物作为 **workflow artifact** 上传（保留 90 天）供下载验证
- **产物来源**：`tauri.conf.json` 的 `bundle.targets: "all"` 在 Windows 默认产 MSI + NSIS，无需改配置
- **构建链**：`tauri-action` 内部调 `cargo tauri build`，其 `beforeBuildCommand: "npm run build"` 会自动先构建前端，一条链产出安装包

### 4.4 缓存策略

- **npm**：`actions/setup-node` 的 `cache: 'npm'`（按 `package-lock.json`）
- **cargo**：`Swatinem/rust-cache@v2`（按 `src-tauri/Cargo.lock` 哈希）
- git 源依赖（`tauri-plugin-fs`/`dialog` 走 `plugins-workspace` git 仓库）首次拉取后进入 cargo git 缓存，`rust-cache` 会一并覆盖

### 4.5 权限与额度

- **权限**：`release.yml` 需 `contents: write`；`verify.yml` 用默认只读即可
- **额度**：公开仓库 Windows runner 无限免费，无需省量优化；若将来转私有，verify 阶段可把前端 test/type-check 拆到 ubuntu runner（Windows 2x 计费）

## 5. YAGNI 明确排除（不在本次做）

- ❌ macOS / Linux 构建矩阵 → Phase 9
- ❌ 代码签名（无证书，产未签名包）→ Phase 9
- ❌ updater `latest.json`（`tauri.conf.json` 的 `createUpdaterArtifacts: false`）
- ❌ ESLint / 依赖漏洞扫描 / 覆盖率上传 → 聚焦编译验证

## 6. 验收标准

1. **verify.yml** 在 push / PR 上跑通：`type-check` + `test` + `build` + `cargo check` 全绿
2. **release.yml 手动触发**：产出 MSI + NSIS artifact，可从 Actions 页面下载
3. **release.yml tag 触发**（push `v*`）：自动创建 GitHub Release 并附带 MSI + NSIS
4. **缓存命中**：第二次起的构建时间显著下降（cargo 编译增量）
5. **失败可观测**：任一步骤失败时 Actions 页面清晰标红

## 7. 风险与回退

| 风险 | 处理 |
|---|---|
| `tauri-action` 在 `tagName` 留空时未按预期上传 artifact | 回退：手动触发分支改用显式 `actions/upload-artifact` 上传 `src-tauri/target/release/bundle/{msi,nsis}/*` |
| git 源依赖（plugins-workspace）拉取慢/失败 | 已有 cargo git 缓存；失败时锁定到具体 commit 替代 branch |
| `schemars/indexmap` 修复在 CI 的 rustc 版本下复现问题 | BUILD.md §2 的 `[build-dependencies] indexmap std` 修复已验证推过该阶段；CI rustc（stable）若不同则按 BUILD.md §6 排错 |

## 8. 开放问题

无。核心决策已在 brainstorming 阶段全部敲定。
