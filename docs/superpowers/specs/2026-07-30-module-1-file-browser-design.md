# 模块 #1 文件浏览器 — MiraPage Desktop

- **日期**: 2026-07-30
- **状态**: 已批准（待规格审查）
- **相关**: [DESIGN.md](../../../DESIGN.md) §1.3 (#1 文件浏览器 P0) + §7.4 (ShortcutRepository 参考)

## 1. 背景与目标

MiraPage Desktop 当前 `/` 路由仍是 placeholder（Home.vue 仅一个"选择目录"按钮，无导航反馈）；用户**多根目录**场景普遍（如不同漫画家分文件夹、Windows 多盘），每次打开都需手动选根。

DESIGN.md §7.4 Android 端有 `ShortcutRepository` + `ShortcutEntity` 的对应实现，桌面端需要对齐重写。

**目标**：

1. 提供稳定的本地文件浏览器主屏（Home.vue），能浏览目录、选目录、刷新、上级
2. 支持**多个根目录**作为"快捷方式"持久化到 DB，独立 CRUD + 路由 `/shortcuts` 管理
3. FileBrowser 顶部下拉快速切换 active shortcut
4. 设置（settings 表）只用于 SideNav 折叠等轻量配置；快捷方式独立表

**非目标**：

- 跳 reader（模块 #2）
- 远程源 SMB/WebDAV（模块 #3-4）
- 搜索、排序选项、缩略图
- 拖拽重排、快捷方式重命名（用 DELETE + CREATE 替代）

## 2. 核心决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| 数据层 | 独立 `shortcut` 表（非 settings JSON） | 唯一性约束、外键一致性、未来加 metadata（last_used_at 等）可平迁 |
| 快捷方式 UI | 路由 `/shortcuts` 独立视图 + FileBrowser 顶部下拉双入口 | 满足"管理"和"快速切换"两类需求 |
| 多根切换 UX | dropdown 列出所有 shortcut + 「无」选项（回到空状态） | 比 SideNav 多层导航更轻 |
| 持久化"上次根" | **不保留**——settings.file_browser_last_root 弃用；用户明确通过 shortcut 切换 | shortcut 即 root 标识，比 last_root 更结构化 |
| Pick Root 后行为 | 不自动保存为 shortcut；用户显式点「⭐ Save as shortcut」 | 避免无意识创建大量重复条目 |
| 双击交互 | 单击 = 选中高亮；双击 = open | 与现有 FileList.vue 的 emit('open') 模式对齐 |
| Open 兜底 | App.vue shell 临时 `console.log('open', entry)`（模块 #2 接 reader） | 模块边界清晰，本批不动 reader |
| SideNav 项数 | 7 → 8（加 nav.shortcuts） | 唯一根变化，保持平铺风格 |
| TDD 流程 | 严格 RED → GREEN，新增测试 + 既有测试无回归 | 项目惯例 |

## 3. 方案选择

采用**方案 A：独立 FileBrowser 组件 + 独立 shortcuts 表 + 独立 /shortcuts 视图**。

候选方案：

| 方案 | 结构 | 取舍 |
|---|---|---|
| **A. 独立组件 + DB 表 + 路由 /shortcuts**（选定） | FileBrowser.vue + shortcuts.ts store + Shortcuts.vue + commands::shortcuts + DB 表 | 边界清晰；快捷方式独立管理；FileBrowser 顶部下拉与 /shortcuts 视图双入口；模块边界干净，远程源模块可复用 FileBrowser |
| B. 单文件塞 Home.vue + settings JSON 列表 | settings JSON 字段存根列表 | 轻量但无独立 metadata、迁移困难、不符合 DESIGN §7.4 |
| C. 单根 + 无快捷方式（保持原方案 1） | 单 file_browser_last_root 设置 | 与用户"多根 + 快捷方式"明确需求不符 |

**选 A 的理由**：用户明确要求多根 + 快捷方式持久化；DB 表模式与 DESIGN §7.4 桌面版对齐；FileBrowser 组件独立方便未来模块 #3 接入远程源。

## 4. 详细设计

### 4.1 DB migration（新增 002）

```rust
// src-tauri/src/db/migrations.rs
fn apply_002_shortcuts(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(r#"
        CREATE TABLE shortcut (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          label TEXT,
          created_at INTEGER NOT NULL
        );
    "#)?;
    Ok(())
}

// 在 run() 加：
if current < 2 { apply_002_shortcuts(conn)?; ... }
```

### 4.2 Rust commands（`src-tauri/src/commands/shortcuts.rs` 新文件）

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutItem {
    pub id: i64,
    pub root_path: String,
    pub label: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShortcutArgs {
    pub root_path: String,
    pub label: Option<String>,
}

#[tauri::command]
pub fn list_shortcuts(db: tauri::State<crate::db::Db>) -> Result<Vec<ShortcutItem>, String> { ... }

#[tauri::command]
pub fn create_shortcut(
    args: CreateShortcutArgs,
    db: tauri::State<crate::db::Db>,
) -> Result<i64, String> {
    // INSERT OR IGNORE — 重复 root_path 返回已存在 id（用 SELECT id 取）
}

#[tauri::command]
pub fn delete_shortcut(id: i64, db: tauri::State<crate::db::Db>) -> Result<(), String> { ... }
```

`lib.rs::generate_handler!` 注册 3 个新 command（**注意：模块 #2 review 时曾发现 record_history/upsert_account/find_next_volume 用了 `args: X` 包裹需展开。本批从源头避免此陷阱——直接用 camelCase 嵌套 struct 通过 `#[serde]` 接收，不用 Tauri 拆 args 参数**）。

### 4.3 Frontend IPC 桥（`src/lib/tauri.ts` 加 3 个函数）

```ts
export interface ShortcutItem {
  id: number;
  rootPath: string;
  label: string | null;
  createdAt: number;
}
export async function listShortcuts(): Promise<ShortcutItem[]> { ... }
export async function createShortcut(rootPath: string, label: string | null): Promise<number> { ... }
export async function deleteShortcut(id: number): Promise<void> { ... }
```

### 4.4 Pinia store（`src/stores/shortcuts.ts` 新文件）

```ts
export const useShortcutsStore = defineStore('shortcuts', () => {
  const items = ref<ShortcutItem[]>([]);
  const activeId = ref<number | null>(null);
  const loading = ref(false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try { items.value = await listShortcuts(); } finally { loading.value = false; }
  }

  async function add(rootPath: string, label: string | null = null): Promise<number> {
    const id = await createShortcut(rootPath, label);
    await refresh();
    return id;
  }

  async function remove(id: number): Promise<void> {
    await deleteShortcut(id);
    if (activeId.value === id) activeId.value = null;
    await refresh();
  }

  function setActive(id: number | null): void {
    activeId.value = id;
  }

  const active = computed<ShortcutItem | null>(() =>
    items.value.find((s) => s.id === activeId.value) ?? null,
  );

  return { items, activeId, active, loading, refresh, add, remove, setActive };
});
```

### 4.5 FileBrowser store 扩展（`src/stores/fileBrowser.ts` 新文件）

```ts
interface FileBrowserState {
  rootPath: string | null;
  currentPath: string;
  entries: MediaEntry[];
  loading: boolean;
  error: { kind: 'notFound' | 'permissionDenied' | 'io'; message: string } | null;
}

// actions
async function pickRoot(): Promise<void> // tauri-plugin-dialog → setRoot → saveShortcut 触发
async function navigate(path: string): Promise<void> // listDirectory({type:'local', rootPath}, path)
async function refresh(): Promise<void>
async function up(): Promise<void> // parent of currentPath
async function setRoot(rootPath: string | null): Promise<void>
```

### 4.6 FileBrowser 组件模板（`src/components/filebrowser/FileBrowser.vue` 新文件）

```
┌──────────────────────────────────────────────────────────────────┐
│ [↑ Up] [🔄 Refresh]  [📂 ▼ shortcut1 ▼] [📁 Pick Root] [⭐ Save]│  ← 工具栏
├──────────────────────────────────────────────────────────────────┤
│ Root / comics / naruto / vol-1                                 │  ← Breadcrumb
├──────────────────────────────────────────────────────────────────┤
│ 📁 ..              ← ─                                            │
│ 📁 chapter-1                                                     │  ← FileList
│ 📁 chapter-2                                                     │     - 单击 = select
│ 🗜 manga.cbz                                                     │     - 双击 = open/navigate
│ 🖼 cover.jpg                                                     │
└──────────────────────────────────────────────────────────────────┘
```

**empty state**（无 active shortcut）：居中大按钮「📁 请选择一个快捷方式或 Pick Root」+「前往快捷方式」链接到 `/shortcuts`
**error state**：顶部 toast + Retry 按钮

### 4.7 Shortcuts 视图（`src/views/Shortcuts.vue` 新文件）

列表 + CRUD：
- 空状态：「还没有快捷方式」+ 「去文件浏览器」链接 → `/`
- 列表行：显示名（label 或 root_path basename）+ 「打开」+ 「删除」
- 「新建」按钮：跳 / 顶部操作

### 4.8 路由 + SideNav

**`src/router/index.ts`** 加：
```ts
{
  path: '/shortcuts',
  name: 'shortcuts',
  component: () => import('@/views/Shortcuts.vue'),
},
```

**`src/components/layout/SideNav.vue`** items 数组加（位置：文件浏览后、书架前）：
```ts
{ to: '/shortcuts', icon: '⭐', labelKey: 'nav.shortcuts' },
```

### 4.9 Home.vue 改造

`src/views/Home.vue` 简化为 thin wrapper：
```vue
<script setup lang="ts">
import FileBrowser from '@/components/filebrowser/FileBrowser.vue';
</script>
<template>
  <main class="file-browser-view">
    <FileBrowser />
  </main>
</template>
```

### 4.10 i18n（zh-CN + en-US 各加 10 个 key）

| key | zh-CN | en-US |
|---|---|---|
| `nav.shortcuts` | 快捷方式 | Shortcuts |
| `shortcuts.title` | 快捷方式 | Shortcuts |
| `shortcuts.empty` | 还没有快捷方式 | No shortcuts yet |
| `shortcuts.add` | 添加 | Add |
| `shortcuts.open` | 打开 | Open |
| `shortcuts.delete` | 删除 | Delete |
| `shortcuts.confirmDelete` | 删除该快捷方式？ | Delete this shortcut? |
| `fileBrowser.saveAsShortcut` | 保存为快捷方式 | Save as shortcut |
| `fileBrowser.shortcutLabel` | 快捷方式名称（可选） | Shortcut name (optional) |
| `fileBrowser.shortcutSaved` | 快捷方式已保存 | Shortcut saved |
| `fileBrowser.noShortcut` | 未选快捷方式 | No shortcut selected |
| `fileBrowser.goShortcuts` | 前往快捷方式 | Go to shortcuts |

## 5. 测试策略（TDD）

### Rust 单测（`src-tauri/src/commands/shortcuts.rs`）
- create → list 包含
- create 重复 root_path → 不报错，返回已存在 id
- delete → list 不再包含
- delete 不存在的 id → Err

### Vitest 单测

**`stores/shortcuts.test.ts`**（4 个）：
- refresh → items 填充
- add 后 refresh → items +1
- remove 后 refresh → items -1
- remove 当前 active → activeId 变 null

**`views/Shortcuts.vue.test.ts`**（3 个）：
- 空状态 / 列表状态渲染
- 点击「打开」→ router.push('/') + setActive
- 点击「删除」→ confirm + store.remove

**`components/filebrowser/FileBrowser.test.ts`**（5 个新增）：
- mount 后工具栏 5 元素可见
- dropdown 显示所有 shortcuts + 「无」
- 切换 dropdown → rootPath / entries 跟着变
- 「Save as shortcut」rootPath=null 时禁用
- 单击 FileList 行 → 选中态（class 切换）
- 双击 FileList 行（dir）→ navigate

**`components/layout/SideNav.test.ts`**（改 1 个）：
- hrefs 断言加 '/shortcuts'

### Manual 验证
1. 启动 app → SideNav 8 项（文件浏览 / 快捷方式 / 书架 / ...）
2. / 路由显示空状态「请选择快捷方式」
3. 点「Pick Root」选目录 → 列表加载
4. 点「⭐ Save as shortcut」→ 输入 label → 提交
5. /shortcuts 路由 → 新条目出现
6. 切回 / → dropdown 选刚加的 → 列表自动加载
7. /shortcuts 删除 → dropdown 消失该条
8. 双击图片行 → console.log('open', {...}) 出现（DevTools）
9. 设置页切语言 → 所有新文案跟随

## 6. 文件改动清单

| 文件 | 状态 | 行数估计 |
|---|---|---|
| `src-tauri/src/db/migrations.rs` | 改 | +20 |
| `src-tauri/src/commands/shortcuts.rs` | NEW | ~80 |
| `src-tauri/src/commands/mod.rs` | 改 | +1 |
| `src-tauri/src/lib.rs` | 改 | +3 |
| `src/lib/tauri.ts` | 改 | +25 |
| `src/stores/shortcuts.ts` | NEW | ~60 |
| `src/stores/shortcuts.test.ts` | NEW | ~80 |
| `src/stores/fileBrowser.ts` | NEW | ~100 |
| `src/views/Home.vue` | 改 (thin wrapper) | -30 +5 |
| `src/views/Shortcuts.vue` | NEW | ~120 |
| `src/views/Shortcuts.vue.test.ts` | NEW | ~80 |
| `src/components/filebrowser/FileBrowser.vue` | NEW | ~150 |
| `src/components/filebrowser/FileBrowser.test.ts` | NEW | ~150 |
| `src/router/index.ts` | 改 | +5 |
| `src/components/layout/SideNav.vue` | 改 | +1 (item) |
| `src/components/layout/SideNav.test.ts` | 改 | +1 (href) |
| `src/locales/zh-CN.ts` | 改 | +12 |
| `src/locales/en-US.ts` | 改 | +12 |
| `src/components/filebrowser/FileList.vue` | 不动（emit 'open' 已存在） |
| `src/components/filebrowser/Breadcrumb.vue` | 不动 |

**总计**：2 NEW（Rust）+ 5 NEW（前端）+ 9 改

## 7. 验证清单（模块 #1 完成时）

| # | 命令 | 期望 |
|---|---|---|
| V1 | `cargo test` | 全过（含新增 shortcuts 单测） |
| V2 | `npm run type-check` | 0 error |
| V3 | `npm test` | 全过（既有 176 + 新增 12+ ≈ 188） |
| V4 | `npm run build` | 前端 vite build 干净 |
| V5 | `cargo check && cargo build` | 通过（本机如无 Rust 跳过，靠 CI） |
| V6 | push tag → CI release → 下载 exe → 跑 manual 9 步 | 全过 |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Rust commands 用 `args: X` 包裹导致 IPC 失败 | 命令静默 fail | 本批**直接定义嵌套 struct**（camelCase），Tauri 拆嵌套字段，不引入 args 包裹陷阱（吸取 #2 review 教训） |
| `tauri-plugin-dialog` 在 happy-dom 测试环境不可用 | pickRoot 测试复杂 | 测试 mock 整个 pickRoot action，stub 成直接调 setRoot |
| FileBrowser.vue 过大 | 单文件过 200 行 | 主屏组件允许略大（≤150 行）；如超过拆工具栏子组件 |
| SideNav 8 项导致视觉拥挤 | UX 降级 | 当前 200px 宽度 8 项仍可放下；如不行模块 #4 之后引入分组 |
| `INSERT OR IGNORE` 不返回已存在 id | API 行为不一致 | 捕获后用 SELECT id WHERE root_path=? 取已存在 id |

## 9. 不在本模块范围

- 搜索框 / 排序选项 / 缩略图
- 远程源（SMB/WebDAV）入口
- 跳 reader（模块 #2 接管）
- /shortcuts 视图拖拽重排、rename
- settings.file_browser_last_root 兼容（旧逻辑不保留）
