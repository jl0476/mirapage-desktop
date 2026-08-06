# 文件浏览器内搜索 + 定位（Windows 风格）

> 日期：2026-08-06
> 替换：现有全局 `/search` 数据库元数据搜索（Phase 4 半成品 stub）
> 参考：Perfect Viewer `SearchFilter.filter` + Windows 资源管理器搜索语义

## 背景

现有搜索功能（`src/views/Search.vue` + `/search` 路由 + `search` store + 后端 `search` 命令）搜的是 SQLite 三表（library/bookmark/tag）元数据，不是文件系统；且是半成品——fuzzy 模式未实现、mode 切换无效、结果项点击 dead end、snippet 不渲染。

用户要的是**文件浏览器内的搜索**：在当前浏览的目录列表里按文件名过滤，对齐 Windows 资源管理器 + Perfect Viewer 的语义。旧的全局搜索功能整体删除。

## 目标

在 FileBrowser toolbar 加常驻搜索输入框，输入即时过滤当前目录列表（非递归），对齐 Windows 资源管理器交互。

## 需求（用户拍板）

| 项 | 决定 |
|---|---|
| 搜索范围 | **仅当前目录**（非递归），纯前端过滤 `fb.entries` |
| 匹配 | 子串匹配（`name.toLowerCase().includes(query.toLowerCase())`），大小写不敏感 |
| 触发 | toolbar 常驻窄搜索输入框，输入即时过滤（150ms 防抖） |
| 结果展示 | 原地替换列表（复用 FileList 行组件），不弹独立结果页 |
| 单击结果 | 选中该行（保持过滤态，不退出搜索） |
| 双击结果 | 执行默认动作（进目录 / 打开阅读器，与正常行一致） |
| 清空 / X | 清空输入框 → 恢复完整列表 |
| ESC | 清空 query + 失焦 |
| 面包屑 | 搜索态（query 非空）替换为静态文本"搜索结果 > {当前文件夹名}"，不可点；清空后恢复可点击 Breadcrumb |
| 状态栏 | 搜索态左段显示"找到 N 项"替代"共 X 项" |
| loading 态 | 不需要（已加载列表过滤是瞬时的） |
| 旧功能 | 全删（见下"清理清单"） |

## 不做（YAGNI）

- ❌ 递归子目录搜索（仅当前层）
- ❌ 流式进度 / spinner（瞬时）
- ❌ 相对路径列（只搜当前层，路径=文件名本身）
- ❌ fuzzy 模糊匹配（子串匹配足够）
- ❌ 搜索历史
- ❌ 区分文件类型过滤（目录/图片/压缩包一视同仁进结果）

## 架构

纯前端过滤，不动后端。复用 `fileBrowser` store 已有的 `searchQuery` ref + `setSearchQuery` action（目前是 stub，未接线）。

```
SearchInput.vue (toolbar 常驻)
  → fb.setSearchQuery(q)  (150ms 防抖)
  → FileBrowser.displayedEntries computed:
      sortedEntries
        .filter(e => !readStatus.isFinished(e))        // hideFinished (hotfix17 已有)
        .filter(e => e.name.toLowerCase().includes(q)) // searchQuery (本次新增)
  → FileList :entries="displayedEntries"
```

### 过滤管线叠加

`displayedEntries` 已在 hotfix17 实现 hideFinished 过滤。本次在其后叠加 searchQuery 过滤。两道过滤独立叠加，互不干扰：
- query 空 + hideFinished off → 全量
- query 空 + hideFinished on → 剔已读完
- query 有 + hideFinished off → 按名过滤
- query 有 + hideFinished on → 先剔已读完再按名过滤

## 组件拆分

### 新增：`src/components/filebrowser/SearchInput.vue`

toolbar 内常驻窄搜索输入框。

- **props**：无（直接读写 `useFileBrowserStore`）
- **行为**：
  - 输入即时 `fb.setSearchQuery(value)`，150ms 防抖
  - 右侧 X 清除按钮：query 非空时显示，点击 = `setSearchQuery('')` + 聚焦回输入框
  - ESC 键 = 清空 query + 失焦
- **样式**：遵循 §1.2 工具栏规范——`.tb-btn` 同尺寸高度，窄宽度（`w-48` 左右），`xp-bd` 边框 token，左侧放大镜 SVG 图标（12px，内嵌 path data），右侧 X 按钮。dark/light 双主题。
- **data-test**：`search-input`（输入框）、`search-clear`（X 按钮）
- **图标**：内嵌 SVG（`ICON_SEARCH` / `ICON_X`），不用 lucide 包

### 改：`src/components/filebrowser/FileBrowser.vue`

- **toolbar**：在 `ViewModeDropdown` 之后加 `<SearchInput />`（靠右，前面加分隔条 `<span class="xp-divider-v" />`）
- **displayedEntries computed**：扩展，叠加 searchQuery 过滤
- **Breadcrumb 区域**：`v-if="fb.searchQuery"` 显示静态文本"搜索结果 > {rootLabel 或当前段名}"，`v-else` 显示原 `<Breadcrumb />`
- **状态栏左段**：搜索态显示 `t('fileBrowser.searchResults', { count: N })` 替代 `t('fileBrowser.statusBar.items', ...)`

### 改：`src/components/filebrowser/FileList.vue`

不动行渲染逻辑。现有 `@click`(select) + `@dblclick`(open) 行为在搜索态下保持一致——单击=选中、双击=执行默认动作。无需改动。

### 新增纯函数：`src/lib/searchFilter.ts`

把过滤逻辑提取为纯函数，便于单测：

```ts
export function filterByQuery(
  entries: MediaEntry[],
  query: string,
): MediaEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}
```

参考 PV `SearchFilter.filter`（21 行 Kotlin，语义一致）。无 Vue / Pinia 依赖，可独立 vitest。

### 改：`src/stores/fileBrowser.ts`

- `searchQuery` ref + `setSearchQuery` action 已存在（stub），本次接线使用，无需新增。
- 进目录时自动清空 query（对齐 PV `LaunchedEffect(location, relPath)`）——在 `navigate()` 和 `setRoot()` 里调 `searchQuery.value = ''`（用户主动换目录时清空，避免旧 query 过滤新目录列表）。`fetch()` 不单独清（它被前两者调用，避免重复）。

## i18n

`fileBrowser.*` 下新增：

| key | zh-CN | en-US |
|---|---|---|
| `searchPlaceholder` | 搜索当前文件夹 | Search this folder |
| `searchResults` | 找到 {count} 项 | {count} results |
| `searchCurrent` | 搜索结果 | Search results |

同时删除 `search.*` 段（见清理清单）。

## 测试

### 纯函数 `src/lib/searchFilter.test.ts`

- 空 query 返回原列表（不重建、保持引用）
- 大小写不敏感（"ABC" 匹配 "abc.txt"）
- 无匹配返回空数组
- 含目录和文件混合过滤
- query 前后空白 trim

### `src/components/filebrowser/FileBrowser.test.ts`

新增测试：
- 输入 query 后列表过滤（只剩匹配项）
- 清空 query 恢复完整列表
- 搜索态面包屑显示静态文本、清空后恢复可点击 Breadcrumb
- 状态栏搜索态显示"找到 N 项"
- 单击结果行 = 选中（保持过滤态）
- 双击结果行 = 执行默认动作（进目录 / 打开）
- 进目录自动清空 query

### 清理后回归

删除 search store / Search.vue / 后端 search 命令后，跑全套测试确认无残留引用：
- `npm run type-check`
- `npm test -- --run`

## 清理清单（旧全局搜索全删）

| 文件 | 动作 |
|---|---|
| `src/views/Search.vue` | 删除文件 |
| `src/router/index.ts` | 删 `/search` 路由 + name=`search` |
| `src/stores/search.ts` | 删除文件 |
| `src/stores/search.test.ts` | 删除文件 |
| `src/lib/tauri.ts` | 删 `tauriSearch()` 函数 + `SearchHit` 接口 + `SearchMode` 类型 |
| `src-tauri/src/commands/search.rs` | 删除文件 |
| `src-tauri/src/commands/mod.rs` | 删 `pub mod search;` + `pub use search::*;` |
| `src-tauri/src/lib.rs` | 从 `invoke_handler![...]` 删 `commands::search::search` |
| `src/locales/zh-CN.ts` | 删 `search: { ... }` 段 |
| `src/locales/en-US.ts` | 删 `search: { ... }` 段 |
| SideNav / 路由配置里侧栏"搜索"项 | 删 nav 项 + `nav.search` i18n key |

## 验证

1. 纯函数单测 + FileBrowser 组件测试全绿
2. type-check 通过
3. 全套测试无回归
4. debug 实例实测：输入 query 列表实时过滤、清空恢复、面包屑切换、单击选中、双击打开、进目录清空 query
