# 瀑布流布局设计

- **日期**: 2026-08-07
- **模块**: v0.1.0-module3.0.6-masonry
- **状态**: 设计中
- **参考实现**: `docs/reference/v3-waterfall-master/`（v3-waterfall 2.0.1 源码，MIT，仅供算法借鉴，不引入依赖）

---

## 1. 背景与目标

文件浏览器现有三种视图：list / grid / details。grid 视图用 CSS grid auto-fill，统一行高 132px，所有卡片同高。对图片目录而言，漫画图片宽高比差异大（竖长单页 vs 横宽跨页），统一行高的 grid 既无法展示真实比例，也浪费空间。

本模块新增 **瀑布流（masonry）视图**：图片按真实宽高比拉伸排列，贪心放最短列，节奏参差如 Pinterest / Eagle。

### 目标场景

- 图片目录的直接呈现（散图集合、封面目录）
- 大规模目录：实测目标 14949 entry 的 "AI" 目录
- 慢速 I/O 适配：Local 源挂载远程存储（SMB/NFS/WebDAV 网关）场景下，首次访问冷路径延迟高

### 非目标

- 不为文件夹目录/压缩包呈现瀑布流（这些走 details 视图）
- 不做无限滚动信息流（entries 已全量由 list_directory 返回）
- 不做图片编辑/裁剪功能

---

## 2. 核心决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| 卡片高度 | 自然宽高比 | 不裁切竖长漫画页；这才是瀑布流区别于 grid 的核心价值 |
| 虚拟化 | 像素级变高虚拟滚动 | 14000 图目录不能全量渲染 DOM |
| 尺寸来源 | Rust 读图片 header（SOF0/IHDR） | 预知尺寸才能算精确布局；首屏零闪烁 |
| 触发条件 | 仅 masonry viewMode 调 IPC | 其他视图零开销 |
| 尺寸查询策略 | 预读窗口（首屏可见 + 额外 N 屏预读，数量动态） | 不滚动不查；远程挂载场景按需 I/O |
| 列数策略 | 固定列数（用户调 2-8，默认 4） | 列宽随窗口自适应，列数稳定 |
| 布局参数设置（列数 + 列间/行间间隔） | 工具栏 ⚙ per-folder + Settings 全局默认 | 复用 directory_sort 的 locationKey 模式 |
| 视图体系 | 删 list + grid，只剩 details + masonry | list 与 details 信息重叠；grid 被 masonry 取代 |
| 视图切换 | 图标按钮直接切换（非下拉） | 只剩 2 个视图，下拉多余 |
| 无图目录 masonry | 按钮 disabled + 自动回落 details | 给用户明确信号 |

---

## 3. 视图体系变更

### 3.1 ViewMode 类型收窄

```ts
// src/stores/fileBrowser.ts
export type ViewMode = 'details' | 'masonry';  // 删 'list' | 'grid'
```

### 3.2 删除的组件/代码

- `ViewModeDropdown.vue` 整个删除（改用图标按钮直接切换）
- `VirtualRow.vue` 的 `row-view-list` 和 `row-view-grid` 两个 block + 对应 scoped CSS
- `FileList.vue` 的 grid 视图分支（`virt-grid-view`）
- `rowHeightByView` 里 list(29) / grid(132) 两项
- i18n 的 `viewList` / `viewGrid` 两个 key

### 3.3 新增视图切换控件

工具栏中原来的 `<ViewModeDropdown />` 替换为两个 `.tb-btn` 图标按钮：

```
[详情图标] [瀑布流图标]
```

- 详情图标在前（用户指定顺序）
- 当前 viewMode 对应按钮 active 态（`text-accent`）
- masonry 模式下，瀑布流按钮后追加 ⚙ 按钮（仅 masonry 出现）
- 进无图目录时，瀑布流按钮 `disabled`；若当前是 masonry 自动回落 details

**图标 SVG path**（复用现有 ViewModeDropdown 的内联 path 常量风格，不引入新依赖）：

- details 图标：复用现有 `ICON_DETAILS = 'M3 4h18M3 9h18M3 14h18M3 19h18'`（多行横线，表示多列布局）
- masonry 图标：新增 `ICON_MASONRY = 'M3 21V10h5v11M10 21V4h5v17M17 21v-7h4v7'`（三根不等高柱子，体现瀑布流参差特征；区别于已删除的 `ICON_GRID` 等大四宫格）

### 3.4 兼容旧持久化值

`loadLayout()` 里 `fb_view_mode` 已存的 'list' / 'grid' 老值 fallback 到 'details'：

```ts
if (vm === 'list' || vm === 'grid') viewMode.value = 'details';
```

---

## 4. 布局参数设置（列数 + 间隔）

### 4.1 双层设置

三个布局参数（列数 / 列间间隔 / 行间间隔）共用同一套双层机制：

| 层级 | 入口 | 存储 | 含义 |
|---|---|---|---|
| 全局默认 | Settings 页面 masonry section | settings 表 `fb_masonry_default_cols` / `fb_masonry_default_h_gap` / `fb_masonry_default_v_gap` | 未修改过的目录用此值 |
| 当前目录 override | 工具栏 ⚙ 弹出面板 slider | directory_masonry 表 per-folder | 仅记录修改过的目录 |

优先级：per-folder > 全局默认。未修改过的目录不写 DB（用全局默认），改过的才写 per-folder。三个参数独立判断——只改列数就只写 col_count 一列，不写间隔列。

### 4.2 directory_masonry 表 schema

复用 v0.1.0-module3.0 `directory_sort` 的 locationKey 模式：

```sql
CREATE TABLE directory_masonry (
  location_key TEXT PRIMARY KEY,   -- JSON.stringify(sourceDescriptor) + "|" + relPath
  col_count   INTEGER,             -- 用户设置的列数 (2-8), NULL = 用全局默认
  h_gap       INTEGER,             -- 列间间隔 px, NULL = 用全局默认
  v_gap       INTEGER              -- 行间间隔 px, NULL = 用全局默认
);
```

三列均可 NULL——未修改的维度不写，读时 fallback 到全局默认。新增 migration 008（追加版本号，不改已发布内容）。

### 4.3 参数范围

| 参数 | 默认值 | 范围 | slider 步进 |
|---|---|---|---|
| 列数 | 4 | 2-8 | 1 |
| 列间间隔 (h_gap) | 8 | 0-24 | 1 |
| 行间间隔 (v_gap) | 8 | 0-24 | 1 |

### 4.4 工具栏 ⚙ 弹出面板

仅 masonry viewMode 时出现在工具栏（details 模式消失）。结构：

```
[⚙ 按钮] → 点开弹出面板:
  列数: [4]     ← 当前值
  [=====●=====]   ← slider 2-8
  列间距: [8px]
  [====●======]   ← slider 0-24
  行间距: [8px]
  [====●======]   ← slider 0-24
  当前目录独立设置；未修改的目录用全局默认值
  [列1][列2][列3][列4]   ← 列数预览
```

click-outside 关闭（Xplorer OperationBar 模式）。

### 4.5 Settings 页面

新增 masonry section（在现有 section 之后）：

```
瀑布流
  默认列数: [slider 2-8, 默认 4]
  默认列间距: [slider 0-24px, 默认 8px]
  默认行间距: [slider 0-24px, 默认 8px]
```

---

## 4.6 兼容已有功能（破坏性改动守卫）

删 list/grid 是破坏性改动，以下已发布功能在 masonry 视图下必须同样生效，不得退化：

### 4.6.1 持久化值兼容

- `fb_view_mode` 老值 'list' / 'grid' → `loadLayout()` fallback 到 'details'（第 3.4 节）
- `fb_sort_field` / `fb_sort_ascending` / `fb_hide_finished` 与视图无关，masonry 同样遵守：masonry 下的图片按 `effectiveSortField` 排序后分列（复用 `displayedEntries`，已含 sort + hideFinished + searchQuery 过滤）

### 4.6.2 阅读器交互（v0.1.0-module3.0.2 Cluster A/B/C）

masonry 卡片必须支持与 list/grid/details 一致的事件：

- **双击图片** → `useReaderActions.readFromImage(entry)`（从该图开始阅读，`?at=imageName` query）
- **单击选中图片** → toolbar 立即阅读按钮可点（`canReadNow` 扩展到图片，已在 FileBrowser.vue:349 实现）
- **右键菜单** → readNow / addToLibrary（复用 RowContextMenu）
- masonry 的卡片组件转发 click / dblclick / contextmenu / keydown 事件给 FileList，与 VirtualRow 现有事件签名一致

### 4.6.3 选中态 + 多选

- 单击选中、Ctrl/Shift 多选、`selectedPaths: Set<string>`（key 用 entry.path）
- masonry 卡片有 `.is-selected` 状态 + outline（复用 VirtualRow scoped CSS 模式）
- masonry 下 1 选中时显示 EntryDetailPanel（与 grid 一致）；details 视图因列已展示属性，panel 隐藏

### 4.6.4 阅读状态标记

- reading/finished badge 在 masonry 卡片显示（复用 `readStatus.marks` / `finishedSet`）
- markByPath 预算逻辑复用（FileList 已有），masonry 卡片接收 mark prop

### 4.6.5 面包屑 + 搜索态

- searchQuery 启用时 masonry 仍过滤当前目录（复用 displayedEntries）
- search-breadcrumb 静态文本切换逻辑不动

### 4.6.6 viewMode 切换保留滚动位置

- 现有 FileList `watch(viewMode)` 切换时抓 focused row path → 切换后 scrollToPath 滚回
- details ↔ masonry 切换保留此行为；但变高布局下 path→index 映射走 useMasonryLayout 的 layout Map（而非 sortedEntries 的 pathIndex），实现时适配

### 4.6.7 目录导航上下文恢复

- `restoreNavigationContext` / `saveNavigationContext`（reader 退出恢复 currentPath）与视图无关，不动

### 4.6.8 StatusBar + 工具栏按钮

- StatusBar 显示 displayedEntries 计数 + 选中数 + 路径（与视图无关）
- toolbar 的立即阅读/加入书库/下载/隐藏已读按钮在 masonry 下保持现有行为

---

## 5. 布局算法

### 5.1 借鉴 v3-waterfall 的部分

从 `docs/reference/v3-waterfall-master/lib/` 源码分析，仅借鉴两点：

**贪心放最短列**（`useLayout.ts:48-51`）：
```ts
const indexOfMinTop = topOfEveryColumn.indexOf(Math.min(...topOfEveryColumn))
topOfEveryColumn[indexOfMinTop] += height + bottomGap
left = (colWidth + gap) * indexOfMinTop
```

**absolute + transform 定位模式**：现有 useVirtualList 已有此骨架，不重新发明。

### 5.2 不借鉴的部分（v3-waterfall 不适配本场景）

| v3-waterfall 做法 | 问题 | 本设计替代 |
|---|---|---|
| `<img>` onload 实测高度（渲染隐藏 div 等图片加载） | 远程挂载下慢；无法预知 totalHeight | Rust 读 header 预知尺寸 |
| 全量遍历 filter 虚拟过滤（O(n)，14000 次/滚） | 性能差；作者自己标 TODO 待优化 | 现有 useVirtualList O(1) visibleRange 扩展 |
| setTimeout 400ms 后置节流 | 滚动停半秒才更新，卡顿感强 | 现有 rAF 节流，流畅 |
| IntersectionObserver 触底加载更多 | 本场景 entries 全量已知，不追加 | 不需要 |
| 无真正滚动锚定 | 上方尺寸到达时视口会跳 | 自研锚定补偿 scrollTop |

### 5.3 列宽计算（固定列数 → 列宽）

与 v3-waterfall 相反——用户给列数，列宽派生：

```ts
function computeColWidth(containerWidth: number, cols: number, gap: number): number {
  return (containerWidth - (cols - 1) * gap) / cols;
}
```

### 5.4 变高虚拟滚动核心数据结构

扩展现有 `useVirtualList`，新增变高多列支持：

```ts
interface MasonryItem {
  entry: MediaEntry;
  width: number;      // 列宽（所有 item 同宽）
  height: number;     // 精确高度 = colWidth / aspectRatio + cardPadding
  top: number;        // 该 item 在容器内的绝对 top
  left: number;       // 该 item 的 left
  col: number;        // 所属列号
}
```

布局输出：`Map<path, MasonryItem>`。

### 5.5 渐进式 totalHeight

不要求一开始知道所有 item 高度。totalHeight 动态增长：

```
已测量 item → 精确高度累加
未测量 item → 用估算宽高比（默认 3:4）占位
totalHeight = 已测量部分的精确 top + 未测量部分的估算高度
```

随 header 预读推进，totalHeight 收敛到真实值。

---

## 6. 尺寸数据来源

### 6.1 Rust 端新增 command

```rust
// src-tauri/src/commands/image_dimensions.rs (新增)
#[tauri::command]
pub async fn list_image_dimensions(
    descriptor: SourceDescriptor,
    paths: Vec<String>,    // 子集 paths, 非全量
) -> Result<Vec<ImageDim>, String> {
    // resolve source → 并发读 header (semaphore 限流)
    // JPEG: 解析 SOF0 marker; PNG: 解析 IHDR chunk; GIF: logical screen descriptor
    // 不解码像素, 只读 header 几十字节
}
```

```rust
struct ImageDim {
    path: String,
    width: u32,
    height: u32,
}
```

### 6.2 算法层纯函数

```rust
// src-tauri/src/algorithm/image_header.rs (新增, 纯函数, 可单测)
pub fn parse_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> { ... }
pub fn parse_png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> { ... }
pub fn parse_gif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> { ... }
```

直接 port 自 Android 同名算法（DESIGN.md §13 真值源对齐原则）。

### 6.3 为什么不算违反"Rust 不拿 metadata"约定

CLAUDE.md §6 决策记录："Rust 端不调 IPC 拿 metadata（如 `get_detailed_file_properties`）" 的本意是**不为详情面板的可选装饰字段单独加 IPC 导致命令膨胀**。

图片宽高的性质不同：
- 不是 MediaEntry 主字段扩展（struct 保持 6 字段不变）
- 是瀑布流视图的**布局骨架必需数据**（无它虚拟滚动无法工作）
- 与 `list_directory` 返回的 `size` / `modifiedAt` 同性质——列表渲染必需数据随查询返回
- 仅 masonry viewMode 触发，其他视图零开销

这是对"详情面板装饰性 metadata"约束的合理边界外推，不违反"不扩 MediaEntry 字段"的本意。

---

## 7. 预读策略

### 7.1 不全量拉尺寸

借鉴图片懒加载思路——header 也当懒加载资源：

首屏可见区:    实际可见的 item 数 (列数 × 可见行数, 动态)
预读区:        额外 N 屏的 item 数 (N 默认 3)
→ 首次只查 (首屏可见 + N 屏预读) 数量的 header
```

注意：首屏可见数取决于列数（用户设置 2-8）和窗口高度，是动态值，不硬编码。预读屏数 N 是固定配置（默认 3）。

### 7.2 预读窗口驱动

现有 `useVirtualList` 的 `visibleRange` 同时驱动两件事：
1. 渲染窗口（哪些 DOM 挂载）
2. 测量窗口（哪些 header 要查）

```ts
// 当 visibleRange.end 接近已测量边界时, 触发下一批 header 查询
if (visibleRange.end > measuredCount - PREFETCH_THRESHOLD) {
  const nextBatch = entries.slice(measuredCount, measuredCount + BATCH_SIZE);
  await listImageDimensions(descriptor, nextBatch);
}
```

- `PREFETCH_THRESHOLD`: 约一屏的 item 数（动态：列数 × 估算可见行数）
- `BATCH_SIZE`: 首屏可见 + 预读屏数 × 每屏 item 数（动态，默认预读 3 屏）

### 7.3 占位估算

未测量 item 用估算宽高比占位：
- 默认宽高比：3:4（漫画常见竖长比例）
- 动态校正：随已测量 item 增多，取实际平均宽高比更新估算值

### 7.4 图片字节按需 fetch

虚拟列表只渲染可见区 DOM → viewport 外的 `<img>` 不挂载 → 浏览器不 fetch `convertFileSrc(url)` 字节。14000 张图首屏只 fetch 可见的 ~30 张。这是虚拟列表对慢速 I/O 的天然适配。

---

## 8. 滚动锚定

### 8.1 问题场景

尺寸 header 异步分批到达。用户已滚到中段时，上方某批尺寸到达、高度从估算变精确，会让下方所有内容位移 → 视口跳动。

固定行高虚拟列表无此问题（所有行同高）。变高瀑布流必须处理。

### 8.2 锚定算法

当上方 item 高度变化时，反向补偿 scrollTop：

```ts
// 某批 header 到达, 上方 N 个 item 高度从估算→精确
// delta = 新高度总和 - 原高度总和
// 如果这些 item 在当前 scrollTop 上方:
if (item.top < scrollTop) {
  scrollTop += delta;
  containerRef.scrollTop += delta;
}
```

仅处理"紧邻可见区上方"的批次到达——下方批次不影响视口。锚定逻辑局部、简单。

v3-waterfall 无此机制（它假设 onload 实测、全量 filter，跳动问题被 setTimeout 节流掩盖）。本设计自研实现。

---

## 9. 数据流总览

```
用户切到 masonry viewMode
  ↓
FileList watch(viewMode === 'masonry')
  ↓ 判断 displayedEntries 含图片?
  ↓ 是:
    useMasonryLayout 初始化:
      columns = effectiveColCount (per-folder > 全局默认)
      colWidth = computeColWidth(containerWidth, columns, gap)
      首批 paths = displayedEntries.slice(0, BATCH_SIZE).filter(isImage)
      ↓ invoke list_image_dimensions(descriptor, paths)
      ↓ Rust 并发读 header → 返回 Vec<ImageDim>
    收到尺寸 → 算每张精确高度 → 贪心放最短列 → 更新 layout Map
    totalHeight 渐进式增长 → 渲染可见区 VirtualRow
    
用户滚动:
  useVirtualList visibleRange 更新 (rAF 节流)
    ↓ 渲染新进入可见区的 row (<img loading=lazy> fetch 字节)
    ↓ visibleRange.end 接近 measuredCount - PREFETCH_THRESHOLD?
        触发下一批 header 查询 → 更新布局 → 滚动锚定补偿
    
切到 details:
  清空 masonry layout state (内存缓存尺寸 Map 可保留供下次复用)
```

---

## 10. 组件结构

### 新增文件

```
src/
├── composables/
│   ├── useMasonryLayout.ts        # 变高多列布局 + 预读 + 滚动锚定
│   └── useMasonrySettings.ts      # per-folder 布局参数读写: 列数 + 列间/行间间隔 (复用 directory_masonry)
├── components/filebrowser/
│   ├── MasonrySettingsPopup.vue   # 工具栏 ⚙ 弹出面板 (列数 + 列间距 + 行间距 slider)
│   └── MasonryView.vue            # 瀑布流视图容器 (替代 grid 分支)
└── lib/
    └── imageHeader.ts             # TS 版尺寸解析 (与 Rust algorithm/image_header 对齐)

src-tauri/src/
├── commands/
│   └── image_dimensions.rs        # list_image_dimensions command
└── algorithm/
    └── image_header.rs            # 纯函数 JPEG/PNG/GIF header 解析 (+单测)
```

### 改动文件

```
src/stores/fileBrowser.ts          # ViewMode 类型收窄 + loadLayout fallback
src/components/filebrowser/FileBrowser.vue        # ViewModeDropdown → 图标按钮 + masonry 守卫
src/components/filebrowser/FileList.vue           # grid 分支删 + masonry 分支接 MasonryView
src/components/filebrowser/VirtualRow.vue         # 删 row-view-list/grid block, 加 row-view-masonry block (或独立 MasonryRow)
src/components/filebrowser/ViewModeDropdown.vue   # 删除整个文件 或 改造为 ViewModeToggle
src/views/Settings.vue             # 加 masonry section (全局默认列数)
src/lib/tauri.ts                   # 加 listImageDimensions 包装
src/locales/zh-CN.ts, en-US.ts     # 删 viewList/viewGrid key, 加 viewMasonry 等 key
src-tauri/src/lib.rs               # generate_handler! 加 list_image_dimensions
src-tauri/src/db/migrations.rs     # migration 008 (directory_masonry 表)
```

---

## 11. 测试策略

遵循 TDD：先写测试再实现。

### Rust 单测（cargo test）

```
algorithm/image_header.rs:
  - parse_jpeg_dimensions: 合法 JPEG header → 正确宽高
  - parse_png_dimensions: 合法 PNG IHDR → 正确宽高
  - parse_gif_dimensions: 合法 GIF LSD → 正确宽高
  - 边界: 截断 header / 非图片字节 / 无 SOF0 marker → None

commands/image_dimensions.rs:
  - 批量 paths → 批量 ImageDim 返回顺序一致
```

### 前端单测（Vitest）

```
lib/imageHeader.test.ts:
  - TS 版解析与 Rust 一致性回归 (参考 descriptor.rs:171-187 现有模式)

composables/useMasonryLayout.test.ts:
  - computeColWidth: 容器宽度 / 列数 / gap 计算正确性
  - 贪心放最短列: 给定 item 高度数组 → 落点正确 (与 v3-waterfall useLayout 对齐)
  - 渐进式 totalHeight: 已测量+未测量混合 → 动态增长正确性
  - 预读触发: visibleRange.end 接近边界 → 触发下一批查询条件成立
```

composables/useMasonrySettings.test.ts:
 - per-folder 写入: 调过参数才写 DB; 未调过不写; 三个参数独立判断 (只改列数只写 col_count, 不改间隔列)
 - locationKey 构造: JSON.stringify(descriptor) + "|" + relPath 一致性
 - NULL fallback: 未设置的维度返回全局默认值

组件:
 MasonrySettingsPopup: 三个 slider 改值 → emit; click-outside 关闭

目标单测总数：539 → ~560+。

### E2E 验证标准

复用 v0.1.0-module3.0.4 的实测口径，对目标目录 "AI"（14949 entry）验证：

- **DOM 节点数**：虚拟化生效后 < ~150（仅可见区 + buffer），对比不虚拟化的 ~14949 × N 卡片节点
- **JS heap**：首屏加载后 < ~80 MB（含尺寸 Map + 布局计算），对比全量渲染的预期 >300 MB
- **滚动流畅度**：rAF 节流下滚动 longtask ≈ 0；无明显掉帧
- **首屏延迟**：仅首批（首屏可见 + 预读屏）header 查询完成后布局稳定；剩余在后台流入不阻塞交互
- **滚动锚定**：上方批次 header 到达时视口不跳动（用户可见内容位置不变）
- **慢速 I/O 模拟**：Local 挂载远程存储场景下，用户不滚动不触发额外 header 查询

完整 E2E 报告写入 `docs/superpowers/reports/2026-MM-DD-masonry-e2e.md`。
