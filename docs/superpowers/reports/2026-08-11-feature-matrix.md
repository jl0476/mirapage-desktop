# 项目整体功能矩阵(实测基线 2026-08-11)

> 基于实际代码扫描 + `npm test --run` + `cargo test` 实测数据,**不是文档声称**。
> 4 个并行 Explore agent 调研结果汇总,每个结论带 grep / 实测证据。

---

## 0. 一句话总览

**主体功能完工度约 90%**。

- 前端 64 个测试文件 / **717 用例全绿**(29.3s)
- Rust 端 191 用例 / **2 失败**(且 CI 永远抓不到——只 `cargo check`)
- 已实现:Local 源 + ZIP 压缩包 + WebDAV 真实现 + 瀑布流 + 缩略图缓存全栈 + 浏览位置 = 阅读进度
- **未实现:SMB 真实协议、RAR/7z 解压、跨卷连续阅读、accounts.testConnection、SMB/WebDAV 凭据 lookup**

| 维度 | 数字 |
|---|---|
| **前端测试文件** | 64 `.test.ts` / 0 `.spec.ts` |
| **前端测试用例** | **717 passed / 0 failed** |
| **Rust lib 单元** | **177 passed / 2 failed**(179 total) |
| **Rust 集成测试** | 12 passed / 0 failed(`thumbnail_generator` 8 + `thumbnail_pipeline` 4) |
| **Rust benchmark** | 3 个,全部 `#[ignore]`,需手动 `--ignored --nocapture` |
| **总 Rust 用例** | 189 passed / 2 failed(179 + 12 + 0 bench = 191,2 失败) |
| **CI 跑 Rust test** | ❌ **不跑**(verify.yml 只 `cargo check`) |

---

## 1. 后端(Rust)现状

### 1.1 ✅ 已实现(实测)

| 模块 | 状态 | 行数 / 备注 |
|---|---|---|
| **算法 5 件** | 100% | natural_sort / mime / path / spread_planner / image_header,均纯函数,有单测,**0 个 `todo!`** |
| **LocalMediaSource** | 100% | `tokio::fs` + Range 读字节,`test()` 校验路径 |
| **ArchiveMediaSource** | ZIP ✅ | `zip::ZipArchive` 真解压,自然排序条目 |
| **WebDavMediaSource** | 100% | reqwest + quick_xml,PROPFIND + Range GET,HEAD 探活 |
| **Thumbnail 子系统** | 100% | service/scheduler/policy/index/generator/key/migration/orientation,**4529 行,0 个 `todo!/unimplemented!`** |
| **DB migrations 1~10** | 100% | 7 核心表 → library 重命名 → browse_history 重写 → shortcut 跨源 → directory_masonry → thumbnail_cache → progress.image_name |
| **Settings / IPC 桥** | 100% | `get_setting` / `set_setting` 双命令,统一 `tauri::generate_handler!` 55 个 |

### 1.2 ⚠️ 部分实现 / 占位(中严重度)

| 位置 | stub 内容 | 影响 |
|---|---|---|
| `archive_impl.rs` | RAR / 7z 分支 `NotImplemented`(line 62-67, 118-120) | 🟡 中:CBR/RAR/7z 压缩包不可读 |
| `webdav_impl.rs:279` | `let _ = account_id; // reserved for auth lookup` | 🟡 中:任何 URL 都能 HEAD 通过测试 |
| `accounts.rs:99-104` | `test_connection` 恒返 `Ok(false)` + TODO | 🟠 高:连接测试功能是死的 |
| `find_next_volume.rs:15-21` | 恒返 `Ok(None)` + TODO | 🟠 高:**跨卷连续阅读完全缺失** |
| `keep_screen_on.rs` | macOS / Linux no-op | 🟢 低(只 Windows 真实现) |

### 1.3 ❌ 完全 stub(高严重度)

| 位置 | stub 内容 |
|---|---|
| `smb_impl.rs:55-66` `list_directory` | `NotImplemented("SMB 完整实现:smb 0.11 API ...")`,只有注释 + 伪代码草稿 |
| `smb_impl.rs:68-83` `read_file` | 同上,`OpenFile + read_all 待接` |
| `smb_impl.rs:97-132` `test()` | **只 TCP 握手**(不验证 SMB/凭据/share,会误报成功) |
| `smb_impl.rs` 源码 | **未 import `smb` crate**;`smb = "0.11"` 已加 Cargo.toml 但未启用 |

### 1.4 后端规模

- **17 个 commands 文件 / 55 个 `#[tauri::command]`**(全部已在 `tauri::generate_handler!` 注册)
- **10 个 migrations**
- thumbnail 9 文件 / **4529 行**
- 总 Rust 代码约 **13k+ 行**(含 thumbnail)

### 1.5 ⚠️ Rust 测试失败(2 个)

实际跑 `cargo test --lib`:

| 模块 | 用例 | 现象 |
|---|---|---|
| `algorithm/path.rs:112` | `test_crumbs` | `crumbs("Root", "docs/comics/x")` 期望 3 段,实际返回 4 |
| `source/webdav_impl.rs:318` | `parse_propfind_extracts_collection_and_files` | 期望解析出 2 条目(collection + file),实际返回 0 |

**这两个失败 CI 永远抓不到**——`verify.yml` 步骤 9 是 `cargo check --manifest-path src-tauri/Cargo.toml`,**只编译不测试**。

---

## 2. 前端(Vue + TS)现状

### 2.1 ✅ 已实现(全部"完整",无占位/空)

| 类别 | 数量 | 备注 |
|---|---|---|
| **Pinia stores** | 12 | bookmarks / directorySort / fileBrowser / history / library / likes / readStatus / reader / settings / shortcuts / slideshow / tags |
| **Routes + views** | 9 | 全实装,`Accounts.vue` 唯一仍用 scoped hex 风格 |
| **IPC 桥(`tauri.ts`)** | 55 函数 + 15 类型 | 与后端 55 个 command 1:1 |
| **lib/ 工具模块** | 14 | 算法 1:1 TS 镜像 + 缩略图协议 + readerSettings + inputBindings |
| **Components** | 28 | filebrowser 15 / reader 8 / settings 4 / layout 1,**0 个占位/空文件** |
| **i18n** | 292 keys × 2 locale | **完全对齐,零缺失**(17 namespace) |
| **持久化** | 100% SQLite(IPC) | **前端零 localStorage / sessionStorage / pinia-persist** |

### 2.2 ⚠️ 不一致(技术债)

| 位置 | 问题 |
|---|---|
| `settings/EnumRow.vue` | 仍用原生 `<select>`(与 §1.3 "禁用原生 select" 规范冲突) |
| `settings/NumberRow.vue` | 仍用原生 `<input type=number>` |
| `views/Accounts.vue` | scoped CSS 写 hex 颜色(`#2a2a2a` input bg / `#444` border) |
| `FileList.details-header button` / `FileBrowser.tb-btn` | 预存在 `var(--ease-out)` 残留(变量在 tailwind.css 未定义) |

### 2.3 测试覆盖(实测)

| 目录 | 测试文件数 |
|---|---|
| `src/stores/` | 11 |
| `src/composables/` | 13 |
| `src/components/filebrowser/` | 13(含 1 个 `MasonryThumbnail.integration.test.ts`) |
| `src/components/reader/` | 7 |
| `src/components/layout/` | 1(SideNav) |
| `src/lib/` | 10 |
| `src/views/` | 4(History / ReaderView / Settings / Shortcuts) |
| `src/locales/` + `src/styles/` | 3 |
| **合计** | **64 文件 / 717 用例 / 0 失败** |

---

## 3. 按 Phase 看完成度

| Phase | 内容 | 状态(基于代码) | tag |
|---|---|---|---|
| 1 | Tauri 骨架 + SQLite + 算法 | ✅ | `v0.1.0-module1.NN` 系列 |
| 2 | OpenSeadragon 阅读器 + 文件浏览器 + 路由 | ✅ | `v0.1.0-module2.0` |
| 3 | 压缩包 | 🟡 ZIP ✅ / **RAR ❌ / 7z ❌** | — |
| 4 | 书签 / 喜欢 / 历史 / 书架 / 标签 / 搜索 | ✅ | 10 commands + 12 stores |
| 4.5 | 书库 / browse_history / directory_sort(Android schema 对齐) | ✅ | `v0.1.0-module3.0` |
| 5 | 跨卷连续阅读 + 幻灯片 | 🟡 幻灯片 ✅ / **跨卷 ❌ find_next_volume stub** | — |
| 6 | i18n(中/英) | ✅ | TDD 双语一致性 |
| 7 | **SMB 协议层** | ❌ 整个 source stub,test 只 TCP 握手 | — |
| 8 | WebDAV 协议层 | ✅ 真实现(凭据 lookup 预留) | — |
| 9 | 跨平台分发 | 🟡 CI ✅ / macOS `.dmg` ❌ / Linux `.AppImage` ❌ / 代码签名 ❌ / 自动更新 ❌ | 4 release tag 已发布 |
| 3.0+ | 设置面板完整化 | ✅ | `v0.1.0-module3.0-settings` |
| 3.0.2 | 阅读器打磨 + 立即阅读入口 | ✅ | `v0.1.0-module3.0.2-reader-polish` |
| 3.0.3 | 文件浏览器内搜索 | ✅ | `v0.1.0-module3.0.3-search` |
| 3.0.4 | 文件浏览器虚拟列表 | ✅ | `v0.1.0-module3.0.4-virtuallist` |
| 3.0.5 | 快捷方式跨源 + 子目录 | ✅ | `v0.1.0-module3.0.5-shortcut-cross-source` |
| 3.0.6 | 瀑布流视图 + 缩略图预读 | ✅ | `v0.1.0-module3.0.6-masonry` |
| 3.0.7 | 缩略图缓存全栈 | ✅ | `v0.1.0-module3.0.7-masonry-thumbnail-cache` |
| 3.0.8 | 缩略图 polish + 浏览位置 = 阅读进度 | ✅ | `v0.1.0-module3.0.8-thumbnail-polish` + `v0.1.0-module3.0.8-masonry-browse-position` |

---

## 4. 主要缺口(按优先级)

| # | 缺口 | 影响 | 修复成本 |
|---|---|---|---|
| 1 | **CI 不跑 cargo test** | 2 个失败用例永远抓不到 | 🟢 1 行:`cargo test --lib` 加进 verify.yml |
| 2 | SMB 整个 source stub | Windows 文件共享不可用 | 🟠 中:Cargo.toml 已加 `smb = "0.11"` 依赖但未启用;填 list_directory + read_file + 真 test |
| 3 | 跨卷连续阅读 stub | 末页翻下一卷的 UX 是死的 | 🟠 中:find_next_volume.rs 实实现 + slideshow 接线 |
| 4 | accounts.testConnection 恒 false | "测试连接"按钮点了没反应 | 🟡 中:reqwest + smb 真连接 |
| 5 | 2 个 Rust 失败用例 | 实际功能回归 | 🟢 小:`test_crumbs` + `parse_propfind` 修复 |
| 6 | RAR/7z 不支持 | 部分压缩包读不了 | 🟠 中:用 `unrar` / `sevenz-rust` crate 实接 archive_impl.rs |
| 7 | WebDAV 凭据 lookup 缺失 | 任何 URL 都能 HEAD 通过 | 🟡 中:从 accounts 表查 host/username 拼 Authorization |
| 8 | settings 原生 `<select>`/`<input>` | 与 §1.3 规范冲突 | 🟢 小:纯样式改造 |

---

## 5. CI 验证 vs 实际能跑(实测)

`.github/workflows/verify.yml` 触发:`push` / `PR` 到 `main`,Runner `windows-latest`。

| 步骤 | 命令 | 状态 |
|---|---|---|
| 1-3 | checkout + setup-node + npm ci | ✅ |
| 4 | `npm run type-check` | ✅ |
| 5 | `npm test`(= `vitest run`) | ✅ 抓前端 |
| 6 | `npm run build`(= `vue-tsc -b && vite build`) | ✅ 但**type-check 重复执行** |
| 7-8 | rust-toolchain + rust-cache | ✅ |
| 9 | `cargo check --manifest-path src-tauri/Cargo.toml` | ⚠️ **只编译不测试** |
| 10+ | (无) | ❌ **cargo test 没跑** |

`release.yml`: `v*` tag push / `workflow_dispatch` → `tauri build --no-bundle` → 上传 portable exe。

### 建议改动

```yaml
# .github/workflows/verify.yml step 9 后追加
- name: Cargo test
  working-directory: src-tauri
  run: cargo test --lib --no-fail-fast --quiet
```

立即把当前 2 个失败用例暴露到 PR 检查里。

---

## 6. 有意差异(CLAUDE.md §6 用户拍板"不做")

- ❌ 编辑类功能(新建/重命名/删除/复制/粘贴/拖放)
- ❌ 百分比进度(只用 reading/finished/none 三态)
- ❌ Rust 端不调 IPC 拿 metadata(详情面板字段全前端派生)
- ❌ Light theme + 4 套色板(`color_theme` 存值未接 Tailwind)
- ❌ Webtoon / 横条模式
- ❌ 下载到本地
- ❌ 配置备份 / 导入(与 Android `.pvbackup` 互导)

---

## 7. 单文件规模参考

| 文件 | 行数 | 备注 |
|---|---|---|
| `src-tauri/src/thumbnail/service.rs` | **1457** | 最大 Rust 文件,Tauri managed state + scheduler 串联 |
| `src-tauri/src/thumbnail/scheduler.rs` | 860 | tokio actor(优先队列+in-flight 去重+epoch+worker/内存预算) |
| `src-tauri/src/thumbnail/policy.rs` | 548 | 纯函数策略(尺寸档位/阈值/预算/并发)+ 33 单测 |
| `src-tauri/src/thumbnail/migration.rs` | 495 | 缓存目录迁移(8 phase state machine + FsOps trait 注入) |
| `src/components/filebrowser/FileBrowser.vue` | **925** | 最大 Vue 文件,工具栏 + 视图切换 + 守卫 + 阅读/书库 actions 转发 |
| `src/views/ReaderView.vue` | **700** | 阅读器路由 wrapper + 9 宫格接线 + 右键菜单 + 跳页 dialog |

---

## 8. 引用的 spec / plan / report

| 文档 | 路径 |
|---|---|
| 缩略图缓存设计 spec | `docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md` |
| 浏览位置设计 spec | `docs/superpowers/specs/2026-08-10-masonry-browse-position-design.md` |
| 缩略图缓存 plan | `docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md` |
| 缩略图性能报告 | `docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md` |
| 缩略图代码审查 | `docs/superpowers/reports/2026-08-08-masonry-thumbnail-code-review.md` |
| 缩略图生成 benchmark | `docs/superpowers/reports/2026-08-09-thumbnail-generation-bench.md` |
| masonry policy hit-rate | `docs/superpowers/reports/2026-08-10-masonry-policy-hit-rate.md` |
| 虚拟列表 E2E | `docs/superpowers/reports/2026-08-06-virtuallist-e2e.md` |
| 瀑布流 E2E | `docs/superpowers/reports/2026-08-07-masonry-e2e.md` |

---

## 9. 调研元数据

- **调研日期**:2026-08-11
- **commit**: `83a0c52`(`83a0c5238c2523b2023f9d9b057df2ac56bc5f20`)
- **tag**: 3 个 v0.1.0-module3.0.x 系列均已就位
- **调研 agent**: 4 个 Explore 并行(后端 Rust / 前端 store+router+views / 前端组件 / 测试覆盖)
- **实测命令**:
  - `npm test -- --run --reporter=basic`
  - `cd src-tauri && cargo test --no-fail-fast --quiet`
