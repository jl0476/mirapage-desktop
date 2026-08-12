# 文件浏览器路径身份修复方案

- 状态：已定位，待实现
- 日期：2026-08-12
- 范围：本地数据源的文件浏览器、立即阅读、历史、快捷方式与缩略图缓存

## 1. 问题现象

用户将本地目录作为根目录浏览时，应用界面、实际访问目录与数据库中记录的 source 身份可能不一致。典型现象是：

```text
界面/数据库 rootPath：F:\WallPaper\normal
实际访问目录：         F:\WallPaper\raw\竖版
```

数据库中表现为同一条记录同时包含不匹配的根和绝对“相对路径”：

```yaml
source_descriptor:
  type: local
  rootPath: F:\WallPaper\normal
rel_path: F:/WallPaper/raw/竖版
```

这条记录在 Windows 上仍然能够打开正确的物理目录，因此故障不一定立即表现为打不开文件；但 source 身份已损坏，后续历史恢复、书库去重、进度、目录配置和缩略图缓存都会以错误身份继续写入。

用户可见的具体表现包括：

- 快捷方式看似保存为 `WallPaper`，实际保存为 `rootPath=normal + relPath=F:/WallPaper`；打开后根目录标签仍是 `normal`，内容却来自 `WallPaper`。
- 根目录图片立即阅读后，书库出现 `title=normal`，且 `library.absolute_path` 与 `rootPath` 相同，而不是根目录应有的空路径。
- 从这类历史或快捷方式进入后，“向上”按钮被错误启用；连续向上可能显示 `F:/WallPaper`、`F:`，尽管当前 source root 仍是 `F:\WallPaper\normal`。
- 瀑布流缩略图缓存的 `thumbnail_cache.rel_path` 被写成 `F:/WallPaper/raw/竖版/图片名` 等绝对路径，而不是相对 source root 的路径。
- 相同物理目录可能在 library/history/progress/cache 中形成多个不兼容身份，导致阅读进度、收藏状态、目录排序或瀑布流设置无法稳定命中。

## 2. 正确的数据模型与错误数据

目录身份的唯一模型是：

```text
DirectoryIdentity = SourceDescriptor + sourceRelativePath
actualPath = descriptor.rootPath + sourceRelativePath
```

其中 `sourceRelativePath` 必须相对 `rootPath`；根目录以空字符串 `''` 表示。绝对路径只允许出现在 `SourceDescriptor.rootPath`，不得出现在 `currentPath`、`lastFetchedPath`、`browse_history.rel_path`、`library.absolute_path`（该字段实际语义为相对路径）、`shortcut.rel_path` 或 `thumbnail_cache.rel_path`。

本次数据污染的首因是根目录图片的“立即阅读”入口：

```ts
// FileBrowser.vue，现状
getLastFetchedPath: () => fb.lastFetchedPath || fb.rootPath || ''
```

在根目录，`fb.lastFetchedPath === ''` 是合法值；但 `||` 将其当作“缺失”，替换成绝对 `fb.rootPath`。随后 `useReaderActions.readFromImage()` 将该值作为目录相对路径传给 `createBook` 和 `recordHistory`。

已确认的首个坏数据（id=36/对应 history）：

```yaml
descriptor.rootPath: F:\WallPaper\normal
library.absolute_path: F:\WallPaper\normal  # 正确值应为 ''
history.rel_path: F:\WallPaper\normal       # 正确值应为 ''
```

对应的正确表示是：

```yaml
source_descriptor:
  type: local
  rootPath: F:\WallPaper\normal
rel_path: ''
```

而对实际目录 `F:\WallPaper\raw\竖版`，正确身份应为：

```yaml
source_descriptor:
  type: local
  rootPath: F:\WallPaper\raw
rel_path: 竖版
```

不能用 `rootPath=normal + relPath=F:/WallPaper/raw/竖版` 表达跨根目录跳转。

## 3. 最小复现与经日志验证的传播链

```text
根目录图片立即阅读
  '' 被替换为 F:\WallPaper\normal
  ↓
library/history 写入绝对“相对路径”
  ↓
从 history 恢复：setRoot(normal) + navigate(F:\WallPaper\normal)
  ↓
状态被误判为位于 root 下的子目录，向上可用
  ↓
up()：F:\WallPaper\normal -> F:/WallPaper
  ↓
保存快捷方式：root=normal, relPath=F:/WallPaper（id=8）
  ↓
打开坏 shortcut 后继续进入 raw/竖版
  ↓
history、library、thumbnail_cache 全部继承绝对路径
```

日志已记录以下连续状态：

```text
rootPath=F:\WallPaper\normal, path=F:\WallPaper\normal
rootPath=F:\WallPaper\normal, path=F:/WallPaper
```

`up()` 的 `split(/[\\/]/).pop().join('/')` 正好产生第二个值。快捷方式 id=8 不是首因，而是将已有污染永久化并可重复重放。

Windows 的 `PathBuf::join(root, absoluteChild)` 会忽略 `root`，因此表面上能够浏览 `F:\WallPaper\raw\竖版`，持久化 descriptor 却仍错误地保留 `normal`。

## 4. 影响范围

### 4.1 受影响的数据表和持久化键

| 范围 | 错误字段 | 后果 |
| --- | --- | --- |
| `library` | `absolute_path`（实际是 source-relative path） | 同一物理目录以错误 descriptor 创建 book；封面、页数、收藏、进度关联错位或重复。 |
| `browse_history` | `rel_path` | 历史恢复会重放错误绝对路径，持续污染当前导航状态。 |
| `shortcut` | `rel_path` | 错 shortcut 成为可重复执行的污染入口；当前 id=8 属于此类。 |
| `progress` / `read_status` | 间接通过错误 `book_id` | 阅读进度、已读/读完状态可能绑定到错误 book 身份。 |
| `directory_sort` | descriptor + relPath key | 排序覆盖可能写入或读取错误目录。 |
| `directory_masonry` | descriptor + relPath key | 瀑布流列数和间距配置可能串到错误目录。 |
| `thumbnail_cache` | `rel_path`、基于它计算的 key | 会生成冗余/错误身份的缓存；当前已检测到绝对 relPath 行。 |

### 4.2 受影响的运行路径

- 根目录图片双击、选中图片立即阅读、无选中“立即阅读”。
- 从书库、历史和快捷方式恢复阅读/浏览。
- 文件浏览器的向上、刷新、面包屑、双击目录和导航上下文恢复。
- 瀑布流尺寸预取、缩略图请求、浏览位置保存。
- 后端 Local source 的目录列举、文件读取和缩略图原图读取。

### 4.3 风险等级

- **P0，数据身份完整性**：root 与 relPath 不再唯一定位同一目录，数据库记录的语义错误。
- **P0，边界绕过**：Local source 的 `join` 接受绝对子路径时可忽略 descriptor root，破坏 source 隔离。
- **P1，持续扩散**：坏 history/shortcut 可以在后续启动和点击中持续生成新坏 library/history/cache 行。
- **P1，兼容掩盖**：Reader loader 对 `library.absolute_path` 的绝对路径兼容分支会让坏数据“仍能工作”，降低发现概率并阻止自然修复。

## 5. 修复目标

1. 根目录图片可以立即阅读，且持久化路径始终为 `''`。
2. `navigate()` 只接收标准化的 source-relative path。
3. 任一错误历史、快捷方式或 IPC 调用都不能逃逸当前 source root。
4. 已经污染的行可被识别、预览和安全清理；不得猜测跨根路径的目标 root。
5. 目录请求的异步乱序不得把不同 root/path 的 `entries` 和路径状态混合。

## 6. 实现方案

### 6.1 区分“根目录”与“没有已加载快照”

将 `lastFetchedPath` 保持为相对路径，根目录返回 `''`，不再 fallback 至 `rootPath`。

`readFromImage()` 当前以 `if (!parentPath)` 判断是否有可用目录；这会误把根目录当作未加载。改为由独立快照或可空状态表达：

```ts
type DirectorySnapshot = {
  descriptor: SourceDescriptor;
  relPath: string; // 允许 ''
};

// 未完成 fetch：null；完成的根目录：{ relPath: '' }
const snapshot: DirectorySnapshot | null = getLoadedDirectorySnapshot();
if (snapshot === null) return;
```

`enumerateCover`、`createBook`、`recordHistory` 共享同一 snapshot；任一 `await` 后不得重新读取可变的 root/path。

### 6.2 建立统一的相对路径校验器

新增前端纯函数和 Rust 对等函数，语义一致：

- 接受：`''`、`a`、`a/b`、`a\\b`（持久化前统一为 `/`）。
- 拒绝：盘符路径（`F:` / `F:/a` / `F:\\a`）、以 `/` 或 `\\` 开头的路径、UNC、任何 `..` 段、NUL。

校验边界：

- `fileBrowser.navigate`、`up`、`refresh`、恢复导航上下文；
- 快捷方式和历史记录的创建、打开；
- 阅读器写 library/history、瀑布流浏览位置、目录排序和 masonry 设置；
- thumbnail 的 `sourceRelPath`；
- Rust 的 `create_book`、`record_history`、`create_shortcut` 与 Local/thumbnail 的实际 join 前。

校验失败必须不改变前端导航状态，并显示/记录“路径越出数据源根”。不能通过把绝对路径传给 `navigate()` 来切换根目录；切源必须使用 `setRoot(newRoot)`，之后相对路径从 `''` 开始。

### 6.3 后端最终边界

`LocalMediaSource::resolve_path` 与缩略图的 `local_abs_path` 在 `join` 前校验 source-relative path。Rust 不再信任前端，也不再让 Windows `join` 的绝对 RHS 覆盖 descriptor root。

所有写库 command 将 descriptor 反序列化为 `SourceDescriptor` 后再序列化，并校验路径。`library.absolute_path` 先保持 schema 兼容，但在 Rust/TS 类型和注释中改称 `sourceRelPath`；后续单独安排 schema rename migration。

### 6.4 快捷方式只保留一个打开执行点

目前 `Shortcuts.vue` 直接 `setRoot+navigate`，`FileBrowser.vue` 又监听 `activeId` 重复执行。保留一个统一 `openShortcut()`；另一个位置只设置路由/激活状态。打开前校验 descriptor 和 relPath。

### 6.5 异步导航身份防护

在 fileBrowser store 为 fetch 增加递增 `requestId`，捕获 `{ requestId, descriptor, relPath }`。仅最新请求可提交 entries、lastFetchedPath、error 与 loading；`setRoot(null)` 也必须使在途请求失效。

这不是本次绝对路径首因，但能阻止旧请求回写导致另一类 descriptor/path 组合错误。

## 7. 存量数据处理

代码先上线阻断新污染，再提供“扫描—预览—确认清理”工具：

1. `library.absolute_path === descriptor.rootPath`：可确定修为 `''`（包括 id=36）。
2. `history.rel_path === descriptor.rootPath`：可确定修为 `''`。
3. `rel_path` 为绝对路径或含 `..`：标记损坏；不能自动推断正确 root。
4. shortcut id=8 及同类绝对 `rel_path`：删除/标记损坏，用户从正确根重新保存。
5. thumbnail_cache 中绝对 `rel_path`：删除索引行及对应缓存文件，后续按正确身份重建。
6. 对 `F:\WallPaper\raw\竖版`，正确重建形式为：

```yaml
rootPath: F:\WallPaper\raw
relPath: 竖版
```

旧 migration 005 加列留下的 library 默认字段属于独立历史数据问题，不与本次自动修复混合处理。

## 8. 测试与验收

前端：

- 根目录 `lastFetchedPath=''` 双击图片：createBook/history 的相对路径均为 `''`。
- 未有已加载 snapshot 时双击图片：安全中止；与根目录行为不同。
- `navigate('F:/WallPaper')`、`navigate('F:\\WallPaper')`、`navigate('../x')`、UNC 均拒绝且 state 不变。
- 恢复坏 history/shortcut：拒绝，且不发 listDirectory IPC。
- 保存快捷方式前对 currentPath 校验；绝对值不写库。
- deferred Promise 覆盖跨 root fetch 乱序，旧请求不能回写。

Rust：

- Local source 与 thumbnail 对绝对/UNC/`..` 子路径返回错误，且未访问 root 外文件。
- create_book、record_history、create_shortcut 对非法相对路径拒绝。

验收命令：

```powershell
npx vitest run src/stores/fileBrowser.test.ts src/composables/useReaderActions.test.ts src/composables/useMasonryThumbnails.test.ts
npm run type-check
npm test
cd src-tauri; cargo test
```
