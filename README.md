# MiraPage Desktop

> 跨平台桌面漫画阅读器。基于 **Tauri 2.x**（Rust 后端）+ **Vue 3**（前端）+ **OpenSeadragon**（图像渲染）。

## 状态

**当前：Phase 0 — 项目骨架搭建**

完整设计文档：[`DESIGN.md`](./DESIGN.md)

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Rust + Tauri 2.x |
| 前端 | Vue 3 + TypeScript + Vite |
| 状态 | Pinia |
| 图像 | OpenSeadragon |
| 数据库 | SQLite (rusqlite) |
| 搜索 | fuse.js |
| i18n | vue-i18n |

## 阅读模式（本期）

- 单页（Single Page）
- 双页（Double Page，封面独占 + 奇数末页不并排）

**不做**：Webtoon / 横条模式 / 翻页动画

## 功能清单（按优先级）

P0：文件浏览器、阅读器、压缩包、书签、喜欢、阅读记录、书架收藏、i18n
P1：标签、搜索、跨卷连续阅读、幻灯片
P2：SMB、WebDAV

## 开发环境要求

- **Node.js** 18+（推荐 24+）
- **Rust** 1.75+（[rustup.rs](https://rustup.rs)）
- **macOS**：Xcode Command Line Tools
- **Windows**：WebView2 Runtime（Win11 自带）+ MSVC Build Tools
- **Linux**：webkit2gtk-4.1、libgtk-3-dev、libayatana-appindicator3-dev

## 快速开始

```bash
# 安装前端依赖
npm install

# 启动开发模式（需 Rust 工具链）
npm run tauri dev

# 构建发布版本
npm run tauri build
```

## 项目结构

```
mirapage-desktop/
├── src/                      ← Vue 前端
├── src-tauri/                ← Rust 后端
├── DESIGN.md                 ← 完整设计文档
├── README.md                 ← 本文件
├── package.json
└── ...
```

## 与 MiraPage Android 的关系

**完全独立的新项目**，不引用 Android 工程任何代码。`DESIGN.md` §7 / §13 列出了作为参考的 Android 文件清单，新代码用 Rust / TypeScript 重写对应算法。

## License

TBD