# GitHub Actions CI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 GitHub Actions 上为 MiraPage Desktop 建立两阶段 CI——push/PR 跑编译验证，打 tag / 手动触发产出 Windows 安装包（MSI + NSIS）并发布。

**架构：** 两个独立 workflow 文件：`verify.yml`（push/PR → windows-latest → 前端 type-check/test/build + `cargo check`）和 `release.yml`（tag `v*` / 手动 → windows-latest → `tauri-apps/tauri-action` 打包；tag 自动建 Release 上传 MSI/NSIS，手动时 tauri-action 只构建，由 `actions/upload-artifact` 上传 bundle）。npm 走 `setup-node` 缓存，cargo 走 `swatinem/rust-cache`。

**技术栈：** GitHub Actions、`actions/checkout@v4`、`actions/setup-node@v4`、`dtolnay/rust-toolchain@stable`、`swatinem/rust-cache@v2`、`tauri-apps/tauri-action@v0`、`actions/upload-artifact@v4`。

**规格来源：** [docs/superpowers/specs/2026-07-30-github-actions-ci-design.md](../specs/2026-07-30-github-actions-ci-design.md)

---

## 前置条件

- GitHub 仓库 `jl0476/mirapage-desktop` 已与本地连通：`github` remote 已配置，已成功 force-push（HEAD `9c1bb60`）。
- 本地 `main` 与 `github/main` 同步。
- 推送权限：Windows 凭据管理器已存 GitHub 凭据（此前 push 成功验证过）。
- 内网 `origin`（192.168.50.168）因服务器端 `getrandom` 故障暂不可用，本计划全部走 `github` 远程；origin 同步见任务 3 步骤 4。
- 可选：安装 `gh` CLI（`winget install GitHub.cli` + `gh auth login`）以便命令行查看 CI 状态；不装则到 https://github.com/jl0476/mirapage-desktop/actions 网页查看。

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `.github/workflows/verify.yml` | push/PR 触发的编译验证（前端 type-check/test/build + cargo check） | 创建 |
| `.github/workflows/release.yml` | tag `v*` / 手动触发的 Windows 打包与发版 | 创建 |

两文件职责完全分离。GitHub Actions 不便抽取共享 yaml 片段，少量触发/缓存配置的重复可接受。

---

## 任务 1：verify.yml（push/PR 编译验证）

**文件：**
- 创建：`.github/workflows/verify.yml`
- 验证方式：push 到 main 自动触发，到 Actions 页面看 run 变绿

- [ ] **步骤 1：创建 `.github/workflows/verify.yml`**

完整内容：

```yaml
name: verify

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install frontend deps
        run: npm ci

      - name: Type-check
        run: npm run type-check

      - name: Test
        run: npm test

      - name: Build frontend
        run: npm run build

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo
        uses: swatinem/rust-cache@v2
        with:
          workspaces: 'src-tauri -> target'

      - name: Cargo check
        run: cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **步骤 2：commit**

```bash
git add .github/workflows/verify.yml
git commit -m "ci: 新增 verify workflow（push/PR 编译验证）"
```

- [ ] **步骤 3：push 到 GitHub**

```bash
git push github main
```

push 到 `main` 会自动触发 verify workflow。

- [ ] **步骤 4：验证 CI run 全绿**

到 https://github.com/jl0476/mirapage-desktop/actions 查看 "verify" run。
- 预期：checkout → setup-node → npm ci → type-check → test → build → rust-toolchain → rust-cache → cargo check 全绿。
- 首次 cargo check 需拉取 git 源依赖（`tauri-plugin-fs`/`dialog` 走 `plugins-workspace` 仓库）并编译 Tauri 全栈，预计 **10-15 分钟**；rust-cache 命中后降至 3-5 分钟。
- 失败排查：① `npm ci` 红 → 确认 `package-lock.json` 在仓库根（已确认存在）；② `cargo check` 红 → 按 [BUILD.md](../../../BUILD.md) §6 排错，schemars/indexmap 修复已在 `src-tauri/Cargo.toml` `[build-dependencies]`。

- [ ] **步骤 5：若失败，修复后重新 push**

```bash
git add <改动的文件>
git commit -m "ci: 修复 verify <具体问题>"
git push github main
```

每次 push 到 main 重新触发 verify。

---

## 任务 2：release.yml（手动触发产 artifact）

**文件：**
- 创建：`.github/workflows/release.yml`
- 验证方式：workflow_dispatch 手动触发，确认 artifact 可下载

**关键技术点（与规格的修正）：** `tauri-action` 官方文档明确——当 `tagName`/`releaseName`/`releaseId` 均不提供（或 tagName 为空字符串）时，action **只构建、不上传任何资产**。因此手动触发场景必须自行加 `actions/upload-artifact@v4` 上传 `src-tauri/target/release/bundle/`，否则产物拿不到。

- [ ] **步骤 1：创建 `.github/workflows/release.yml`**

完整内容：

```yaml
name: release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install frontend deps
        run: npm ci

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo
        uses: swatinem/rust-cache@v2
        with:
          workspaces: 'src-tauri -> target'

      - name: Build & release (tauri-action)
        id: tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          # tag 触发 → tagName=版本号 → tauri-action 自动建 Release 并上传 MSI/NSIS
          # 手动触发 → tagName=空字符串 → tauri-action 只构建不上传（下方 upload-artifact 接管）
          tagName: ${{ github.ref_type == 'tag' && github.ref_name || '' }}
          releaseName: 'MiraPage ${{ github.ref_name }}'
          releaseDraft: false
          prerelease: false

      - name: Upload bundle as artifact (manual trigger only)
        if: github.ref_type != 'tag'
        uses: actions/upload-artifact@v4
        with:
          name: mirapage-windows-bundles
          path: src-tauri/target/release/bundle/
```

- [ ] **步骤 2：commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: 新增 release workflow（tag 发版 + 手动 artifact）"
```

- [ ] **步骤 3：push 到 GitHub**

```bash
git push github main
```

push 到 main **不会**触发 release（仅 tag / workflow_dispatch 触发）。

- [ ] **步骤 4：手动触发 release**

网页：https://github.com/jl0476/mirapage-desktop/actions/workflows/release.yml → "Run workflow" → 选 `main` → Run。
或装了 gh CLI：

```bash
gh workflow run release.yml -R jl0476/mirapage-desktop --ref main
```

- [ ] **步骤 5：验证 artifact 产出**

run 完成（首次约 **15-25 分钟**，含完整 release 构建并打包 MSI/NSIS）后，在该 run 页面底部 "Artifacts" 区应出现 `mirapage-windows-bundles`。下载解压应含：
- `nsis/MiraPage_0.1.0_x64-setup.exe`（NSIS 安装程序）
- `msi/MiraPage_0.1.0_x64_en-US.msi`（MSI 安装包）

文件名中的版本号取自 `tauri.conf.json` 的 `version: "0.1.0"`。
- 失败排查：① "Build & release" 步骤红 → 看 tauri-action 日志（常见：图标路径、`bundle.targets` 配置；本项目图标齐全、targets="all" 应正常）；② upload-artifact 红 → 说明上游构建未产出 bundle，先修构建步骤。

---

## 任务 3：tag 触发自动发 Release

**文件：**
- 无新增（release.yml 已含 tag 触发分支）
- 验证方式：push 测试 tag → Releases 页面出现新 Release

- [ ] **步骤 1：打测试 tag 并推送**

```bash
git tag v0.1.0-ci-test
git push github v0.1.0-ci-test
```

push `v*` tag 自动触发 release workflow，走 `tagName` 非空分支 → tauri-action 创建 Release 并上传 MSI/NSIS。

- [ ] **步骤 2：验证 Release 创建**

到 https://github.com/jl0476/mirapage-desktop/releases 查看：
- 预期：出现 "MiraPage v0.1.0-ci-test" Release，Assets 含 MSI + NSIS。
- 或装 gh：

```bash
gh release view v0.1.0-ci-test -R jl0476/mirapage-desktop
```

- 注意：产物**未签名**（无代码签名证书），Windows 首次安装会弹 SmartScreen 警告——属预期，Phase 9 加签名后消除。

- [ ] **步骤 3：清理测试 tag / Release（可选）**

```bash
# 删除远程测试 tag
git push github :refs/tags/v0.1.0-ci-test
# 删除本地测试 tag
git tag -d v0.1.0-ci-test
# 删除 GitHub 上的测试 Release（网页删除，或）：
gh release delete v0.1.0-ci-test -R jl0476/mirapage-desktop --yes
```

- [ ] **步骤 4：同步内网 origin（服务器修复后）**

内网 origin（192.168.50.168）此前因服务器端 `unable to get random bytes` 故障推送失败。服务器管理员修复后：

```bash
git push origin main
git push origin --tags   # 如需同步 tag
```

若仍报同样错误，提示服务器侧排查 `/dev/urandom` 或容器 getrandom 限制。

---

## 自检

**1. 规格覆盖度：**
- §4.2 verify.yml → 任务 1 ✓
- §4.3 release.yml（tag + 手动）→ 任务 2（手动 artifact）+ 任务 3（tag Release）✓
- §4.4 缓存（npm + cargo）→ 两 yaml 均含 ✓
- §4.5 权限 `contents: write` → release.yml 含 ✓
- §6 验收标准 1-4 → 任务 1 / 2 / 3 覆盖 ✓
- §7 风险（tauri-action 空 tagName 不上传）→ 任务 2 已用 upload-artifact 落地回退方案 ✓

**2. 占位符扫描：** 无 TODO/待定/模糊；两个 yaml 均为完整可粘贴内容；命令含确切路径与预期产物名。

**3. 一致性：**
- 两 workflow 的 `setup-node`（node 20、`cache: 'npm'`）、`rust-toolchain`、`rust-cache`（`workspaces: 'src-tauri -> target'`）参数一致。
- artifact 名 `mirapage-windows-bundles` 仅在任务 2（手动触发）使用；任务 3（tag）走 Release 不上传 artifact——无冲突。
- 远程统一用 `github`（origin 不可用已在任务 3 步骤 4 说明）。

**修正记录（与规格的差异）：**
- 规格原估 verify "约 3-5 分钟"；实际首次含 cargo check 约 **10-15 分钟**（拉 git 源依赖 + Tauri 全栈首次编译），缓存命中后才降到 3-5 分钟——已在任务 1 步骤 4 更正。
- 规格原写"手动触发时 tauri-action 上传 artifact"；查证 tauri-action 官方文档后确认空 tagName 时**只构建不上传**，必须自行 `upload-artifact`——已在任务 2 修正实现并加 `if: github.ref_type != 'tag'` 条件。
