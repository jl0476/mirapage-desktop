# 跨卷连续阅读 — 设计规格

> 日期：2026-08-11
> 状态：已批准（v2，吸收设计审查报告 P0/P1 + 三轮架构精化）
> 关联：
> - [功能矩阵 §4 缺口 #3](../reports/2026-08-11-feature-matrix.md)
> - [设计审查报告](../reports/2026-08-11-cross-volume-reading-design-review.md)
> - [DESIGN.md §12.3](../../DESIGN.md) | [CLAUDE.md §0.5/§0.6](../../CLAUDE.md)
>
> **v2 变更摘要**（vs v1）：
> - 范围收窄为 **仅 Local 目录卷**（reader + masonry 都只选 `isDirectory`）。Archive / 远程源另立后续 spec。
> - 架构改为 **三层**：意图 → CrossVolumeController（决策+竞态）→ 统一 Book Loader（读+算不可变 Snapshot）→ route watch（唯一加载入口）。
> - **route 是当前卷身份唯一真值**：跨卷走 `ensureBookId → router.replace → route watch → loadBookById`，不"先加载再 replace"。
> - Loader **只返回不可变 Snapshot**，由 ReaderView 原子提交；加载失败不保留旧卷画面。
> - Controller 状态收窄为 `idle / resolving / awaiting-confirm / navigating`，`pendingCrossVolume` 只在 `awaiting-confirm` 非空。
> - `saveCurrentProgressNow` 归 reader store（读自身状态），不放 Loader。
> - Toast 纯 props/emits，不调 `useCrossVolume()`。
> - 删除 TS 镜像的虚假 `filter` 参数（收窄后无意义）。

---

## 1. 目标 & 范围

### 1.1 目标

填实 `find_next_volume` stub，打通"读完一卷自动/手动跳到下一卷"的完整链路。覆盖 **3 个触发场景**：

| 场景 | 触发源 | 路径 |
|---|---|---|
| reader 手动阅读 | 末页再向下（滚轮下/下键/Space/触控 MR）+ 9 宫格 `folder-next` / `Alt+→` | `maybeContinue` → `navigateToVolume` → route watch → Loader |
| 幻灯片播放 | `slideshow.tick` 末页 → `pendingNextVolume`（已有 flag） | 同上 |
| 瀑布流浏览 | MasonryView/FileBrowser 工具栏"下一卷"按钮（纯手动，独立路径） | `findNextVolume('next')` → `fb.navigate(relPath)` |

### 1.2 范围（确认决策）

| 决策 | 结论 |
|---|---|
| **卷类型范围** | **仅 Local 目录卷**。reader 与 masonry 都只选 `isDirectory`。Archive + WebDAV/SMB 另立后续 spec（等 archive 页面资源 URL/IPC 渲染链路完成）。`reader.loadBook` 现在显式拒绝非 Local descriptor（`ReaderView.vue:219`），本版不扩大渲染链路。 |
| 完整度 | reader 三模式（off/auto/manual）+ 瀑布流手动按钮 |
| 跳转起点 | **智能恢复**：查 progress，未读完→恢复 page/imageName；已读完或无记录→第 1 页/顶部 |
| manual UI | **底部胶囊**："继续读下一本《XXX》？"+ 跳转 + 关闭 |
| 末页触发时机 | **末页 + 再向下操作**，**非**翻到末页立即触发。序列语义：从倒数第二页 `nextPage` 翻到末页那次不跨卷；在末页再 `nextPage` 才触发跨卷意图。对齐 Android `atLastPageToggledToTrue`。不引入 ms 计时。 |
| prev 方向 | **先不触发**：Rust 算法对称实现（direction 参数），UI 只接 next |
| 无下一卷 | toast 提示 + 停（manual 不显示胶囊） |
| 循环 | **不做**，末卷无下一卷就停 |
| 统一 Book Loader | 独立 `useReaderBookLoader` composable，首次开卷 + 跨卷共用，公开 `loadBookById` 单一加载入口 |
| 路由身份 | **route 唯一真值**：跨卷 `router.replace(targetBookId)` → route watch → Loader |
| 状态所有权 | **ReaderView 单实例**：唯一调 `useCrossVolume()`，Toast 用 props/emits |

### 1.3 不做（YAGNI）

- ❌ Archive / 远程源跨卷（另立后续 spec）
- ❌ prev 方向的 UI 触发（9 宫格 bl / Alt+← 仍保留映射但本次不接跨卷）
- ❌ 瀑布流无限滚动追加 / 自动跨卷 / 过渡动画 / 循环到首卷

---

## 2. 背景（现状与问题）

### 2.1 已就绪（前端）

- `slideshow.pendingNextVolume` flag + `ReaderView` watch 通路（CLAUDE.md §0.6）
- `settings.continueToNextVolume: ContinueMode`（`'off'|'auto'|'manual'`，默认 `'manual'`，`stores/settings.ts:30`）
- 9 宫格 `br=folder-next` 映射 + `Alt+→` hotkey
- `useMasonryBrowsePosition` 瀑布流进度双写（image_name + page）+ restoreAndScroll 智能恢复
- `useReaderActions.readFromCurrentPath` 的 getProgress 智能恢复模式（可复用）

### 2.2 stub（待填）

- `commands/find_next_volume.rs` — `Ok(None)` 占位，返回 `Option<String>`，同步 fn，无 factory
- `lib/tauri.ts` `findNextVolume()` — 返回 `string|null`，无 filter 参数

### 2.3 设计审查发现的关键问题（v2 必须修复）

> 详见 [设计审查报告](../reports/2026-08-11-cross-volume-reading-design-review.md)。以下已在 v2 设计中处理。

| 问题 | 现状 | v2 处理 |
|---|---|---|
| **P0-1** 跨卷只调 `reader.openBook` 无效 | `ReaderView` 持有 `pageUrls`/`imageNames`/`book`/`status` 等 local ref，模板用 `ReaderView.pageUrls` 而非 `reader.pages`。`pages = images.map(e=>e.name)` 只是文件名不是 `convertFileSrc` URL。 | 统一 Loader 返回 Snapshot，ReaderView 原子提交所有 refs + store。 |
| **P0-2** composable 局部 ref 不共享 | ReaderView 和 Toast 各调一次 `useCrossVolume()`，两份 `pendingCrossVolume`。 | ReaderView 单实例所有权，Toast 纯 props/emits。 |
| **P0-3** 声称支持 Archive 但链路不支持 | `ReaderView.loadBook` 显式拒绝非 Local descriptor（`:219`）。Archive 构造是简化版，origin 未归一化，远程源压缩包不能只拼路径。 | 本版收窄为仅 Local 目录卷。 |
| **P0-4** 路由身份分裂 | 跨卷后 store.bookId 变新但 URL 仍是旧卷；刷新/复制链接/收藏/书签作用于旧卷。 | route 唯一真值：跨卷 `router.replace` 后 route watch 加载。 |
| **P1-1** `flushProgress` 只 flush 已有 pending | 用户未翻页或已 debounce 落盘时 flush 无效。 | `saveCurrentProgressNow()` 构造当前快照 await 写入。 |
| **P1-2** manual 缺并发守卫 | `bookSwapInFlight` 只守 load 不守 arm；远程源高延迟下旧请求覆盖。 | requestSeq + `sameBookIdentity` 结构化校验，arm 与 navigate 都守。 |
| **P1-3** 瀑布流无图目录后按钮消失 | 按钮绑 `viewMode==='masonry'`，自动回落 details 后消失，无法继续跳过。 | 按钮不绑 viewMode。 |
| **P1-4** 用 `currentPath` 而非 `lastFetchedPath` | `currentPath` 是导航目标（fetch 可能进行中），引入已修过的导航竞态。 | 用 `lastFetchedPath` + 结果落地前校验。 |
| **P1-5** 测试不验证真实行为 | Toast 测试未注入状态；`bookSwapInFlight` 测试留悬挂 Promise；Rust `pick_sibling` 返回过滤数组索引有歧义；TS `filter` 参数无行为。 | Toast props/emits 可直接测；deferred promise；`pick_sibling` 返回 entry；删 TS filter 参数。 |

---

## 3. 方案对比（保留 v1 选定 A）

| 方案 | find_next_volume | 触发机制 | 加载接线 | 评价 |
|---|---|---|---|---|
| **A（选定）** | Rust command（async + factory） | 统一 `maybeContinue(force, dir)` | 统一 Loader + route 唯一真值 | 对齐 Android + DESIGN.md §13.2 + 修复 P0-1~P0-4 |
| B | 前端算（已有 TS 镜像 + listDirectory） | 同 A | 同 A | 违反"算法双实现一致"，Rust stub 永留 |
| C | 同 A | 双 flag | reader.swapBook 原子 | 手动跨卷经 flag 有延迟 |

**选 A**：核心新增 = Rust 一个 command + 两个 composable（Loader + Controller）+ 一个 toast 组件 + 瀑布流工具栏按钮。前端 flag/settings/9 宫格/瀑布流进度机制全复用。

---

## 4. 架构总览（三层 + route 唯一真值）

### 4.1 职责分工（最终锁定）

| 层 | 职责 | 不做 |
|---|---|---|
| **CrossVolumeController**（`useCrossVolume.ts`） | 模式决策、查找目标、确认状态、竞态保护（requestSeq + identity 校验） | 不构造图片 URL、不复制 loadBook、不写 refs |
| **ReaderView**（编排层） | 当前会话编排、路由导航（navigateToVolume）、状态原子提交（commitBookSnapshot）、UI 生命周期（route watch、卸载清理） | 不在 composable 内做 IO |
| **useReaderBookLoader**（`useReaderBookLoader.ts`） | 读 route bookId，IO + 计算，返回不可变 `ReaderBookSnapshot` | 不写 ReaderView refs、不导航 |
| **route** | 当前卷身份唯一真值 | — |
| **ContinueNextVolumeToast** | 纯 props/emits 展示 | 不调 `useCrossVolume()` |

### 4.2 数据流（route watch 是唯一加载入口）

```
跨卷意图（3 源）
  ├─ reader 末页再向下（nextPage atLast → 回调写 slideshow.pendingNextVolume）
  ├─ slideshow tick 末页（已有 pendingNextVolume）
  └─ 显式 9 宫格/Alt+→（force=true，不看模式）
          ↓
CrossVolumeController.maybeContinue(force, dir)
  ├─ force=true / auto → resolveNext（findNextVolume）
  ├─ force=false + off → return + consumePending
  └─ force=false + manual → armManualToast（填 pendingCrossVolume + identityAtArm）
          ↓ NextVolumeTarget
CrossVolumeController.navigateResolvedTarget(target, expectedIdentity, seq)
  ① 验证当前 source identity（与 expectedIdentity 比较）
  ② reader.saveCurrentProgressNow()（trySave 包裹，失败 toast 不阻断；取消旧 debounce）
  ③ slideshow.pause()
  ④ 再次验证 source identity + requestSeq（navigateToVolume 前必须校验）
  → 调 opts.navigateToVolume(target)（注入的 ReaderView 回调，做 ensureBookId + replace）
          ↓
ReaderView.navigateToVolume(target)（Controller 注入的回调）
  ⑤ loader.ensureBookId(target)（异步边界：DB + createBook UPSERT）→ bookId
  ⑥ router.replace({ name:'reader', params:{bookId}, query:{} })（at 清空）
  → 返回 Controller
          ↓ Controller 继续 navigateResolvedTarget
  ⑦ clearPendingState()
  ⑧ phase = idle（finally）
          ↓ route.params.bookId 变化
route watch（唯一加载入口，immediate: true 替代 onMounted）
  bookLoadPhase: idle → loading → ready/error
  去重：bookId === lastLoadedBookId && phase === 'ready' 才跳过
  activeLoadSeq 守卫：旧卷晚返回丢弃
          ↓
useReaderBookLoader.loadBookById(bookId)
  1. getBook(bookId) → 解析 descriptor（非 Local → throw）
  2. listDirectory → filter 图片（!isDirectory && !isArchive && isImage）
  3. directorySort.resolve 排序
  4. imageNames + convertFileSrc pageUrls
  5. spreads + 智能恢复（explicitImageName → progress.imageName → progress.page → 0；finished → 0）
  6. 返回 ReaderBookSnapshot（局部变量，不写 refs）
          ↓
ReaderView.commitBookSnapshot(snapshot)（原子提交）
  成功：一次性写 book/pageUrls/imageNames refs + reader.openBook + reader.imageNames
  失败：route 已是新 bookId → 不保留旧卷 → reader.closeBook + 清 refs + error UI
```

**瀑布流场景（纯手动，不经 Controller/Loader）**：

```
MasonryView/FileBrowser 工具栏「下一卷」按钮（不绑 viewMode，details 回落后仍可达）
  → useMasonryBrowsePosition.flushNow()（立即 recordCurrentTop）
  → findNextVolume(descriptor, lastFetchedPath, 'next')
  → null → toast 无下一卷
  → 有 → fb.navigate(result.relPath) → MasonryView 重载 → 自动 restoreAndScroll
  结果落地前校验 lastFetchedPath === pathAtRequestStart
```

### 4.3 关键不变量

1. **route 唯一真值**：跨卷只 `router.replace(bookId)`，不"先加载再 replace"。Loader 只由 route watch 调用。
2. **watch immediate 唯一入口**：删 `onMounted(loadBook)`，首次挂载靠 `immediate: true`，无双加载。
3. **加载失败不保留旧卷**：route 变即 `visibleReader=false` 进 loading；失败清空 refs + reader.closeBook + error UI。
4. **去重看 phase**：`bookId === lastLoadedBookId && bookLoadPhase === 'ready'` 才跳过；失败/取消后可重试（`retryCurrentBook()`）。
5. **原子提交**：Loader 在局部变量完成所有计算，全部成功后 ReaderView 一次性提交 refs + store；不边加载边改 pageUrls。
6. **Controller loading 覆盖 route loader**：`busy = cv.phase !== 'idle' || bookLoadPhase === 'loading'`。router.replace resolve ≠ loader 完成。
7. **pendingCrossVolume 只在 awaiting-confirm 非空**：所有离开该状态的路径统一调 `clearPendingState`；toast close 调 `dismissManual`（只在 awaiting-confirm 生效 + 推 requestSeq 失效旧请求）。
8. **route.query.at**：跨卷 replace 时 `query: {}` 清空，旧卷图片名不影响新卷。
9. **pendingNextVolume**：off / 失败 / 无下一卷 / 关闭胶囊 / 导航成功 五处必须消费。
10. **saveCurrentProgressNow**：await saveProgress + 取消旧 debounce，防旧卷延迟写跨卷后落盘；保存失败不阻断跨卷（"取消旧写"与"本次保存成功"分离）。
11. **setOnAtLastNextAttempt(null)**：ReaderView 卸载清理回调，避免 Pinia store 持有旧组件闭包。

---

## 5. Rust 端 — `find_next_volume` 替换 stub

### 5.1 数据结构

```rust
// commands/find_next_volume.rs
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNextVolumeArgs {
    pub descriptor: serde_json::Value,   // 当前卷的 SourceDescriptor（本版实际只用 Local）
    pub current_path: String,            // 当前卷相对 rootPath 的完整路径（如 "comics/vol1"）
    pub direction: VolumeDirection,      // 强类型枚举（P2 修复），非法值在反序列化边界报错
}

/// P2 修复：强类型方向，非法 IPC 入参返回反序列化错误，不静默当作 next。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VolumeDirection {
    Next,
    Prev,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextVolumeResult {
    pub descriptor: serde_json::Value,   // 下一卷 SourceDescriptor（同源 Local，path 不同）
    pub rel_path: String,                // 下一卷相对 rootPath 的完整路径
    pub title: String,                   // 目录名
    // 注：本版不返回 is_archive —— 仅 Local 目录卷，避免调用方残留 if(is_archive) 分支
}
```

> **关于 `filter`**（P1-3 修复）：reader 和 masonry 在"仅 Local 目录卷"范围内语义一致（都只 `isDirectory`）。**v2 彻底删除 filter 参数**（Rust args / 前端 IPC / 所有调用），`pick_sibling` 只过滤 `is_directory`。未来 Archive 支持需要的不是一个 filter 字符串，而是目标联合类型 + 加载能力检测，届时重新增加强类型策略更安全。

### 5.2 算法（纯函数 + async command）

**纯函数 `pick_sibling`**（不依赖 IO，先测）：

```rust
/// 在 siblings 里按 natural sort 找 current 的 next/prev，只保留 is_directory。
/// 返回目标 entry 的克隆（不返回索引，避免过滤数组索引歧义 —— P1-5 修复）。
/// current 不在或越界返回 None。（direction 是 VolumeDirection enum，非法值在 serde 反序列化边界报错，不进入此函数。）
pub fn pick_sibling(
    siblings: &[MediaEntry],
    current_basename: &str,
    direction: VolumeDirection,
) -> Option<MediaEntry> {
    let mut dirs: Vec<&MediaEntry> = siblings
        .iter()
        .filter(|e| e.is_directory)
        .collect();
    if dirs.is_empty() { return None; }
    dirs.sort_by(|a, b| natural_compare(&a.name, &b.name));
    let pos = dirs.iter().position(|e| e.name == current_basename)?;
    let target_pos = match direction {
        VolumeDirection::Next => pos + 1,
        VolumeDirection::Prev => pos.checked_sub(1)?,
    };
    dirs.get(target_pos).map(|e| MediaEntry {
        name: e.name.clone(),
        path: e.path.clone(),
        is_directory: e.is_directory,
        is_archive: e.is_archive,
        size: e.size,
        modified_at: e.modified_at,
    })
}
```

**async command**：

```rust
#[tauri::command]
pub async fn find_next_volume(
    args: FindNextVolumeArgs,
    factory: State<'_, MediaSourceFactory>,
) -> Result<Option<NextVolumeResult>, String> {
    // 1. 强类型解析 descriptor（不在 command 内反复操作 serde_json::Value —— P1-5 修复）
    let descriptor: SourceDescriptor = serde_json::from_value(args.descriptor.clone())
        .map_err(|e| format!("invalid descriptor: {e}"))?;

    // 2. 本版只支持 Local（收窄决策）。非 Local 返回明确错误，不静默 fallback。
    //    只验证 variant —— root_path 不单独绑定（后续 factory.resolve(&descriptor) 用整体 descriptor，避免 unused variable）。
    if !matches!(descriptor, SourceDescriptor::Local { .. }) {
        return Err("find_next_volume: 非 Local 源暂不支持跨卷（见 spec §1.2）".into());
    }

    // 3. parent_path = current_path 的父目录；current_basename = 末段
    let parent_path = PathUtils::parent(&args.current_path);
    let current_basename = PathUtils::segments(&args.current_path)
        .last().cloned().unwrap_or_default();

    // 4. list parent + pick_sibling（只保留 is_directory）
    let source = factory.resolve(&descriptor);
    let siblings = source.list_directory(&parent_path).await.map_err(|e| e.to_string())?;
    let target = match pick_sibling(&siblings, &current_basename, args.direction) {
        Some(t) => t,
        None => return Ok(None),
    };

    // 5. 构造 NextVolumeResult（同源 Local descriptor，rel_path = parent + name）
    let rel_path = if parent_path.is_empty() {
        target.name.clone()
    } else {
        PathUtils::join(&parent_path, &target.name)
    };
    Ok(Some(NextVolumeResult {
        descriptor: serde_json::to_value(&descriptor).map_err(|e| e.to_string())?,
        rel_path,
        title: target.name,
    }))
}
```

### 5.3 依赖

- 复用 `algorithm::natural_compare`
- 复用 `algorithm::path::PathUtils::{parent, segments, join}`
- 复用 `source::MediaSourceFactory`（已 registered State）
- 不新增 crate

---

## 6. 前端 IPC + TS 镜像

### 6.1 `lib/tauri.ts` — findNextVolume 改返回类型

```typescript
export interface NextVolumeResult {
  descriptor: SourceDescriptor;   // 同源 Local，rootPath 不变
  relPath: string;                // 下一卷相对 rootPath 完整路径
  title: string;
  // 注：无 isArchive 字段（本版仅 Local 目录卷）
}

// P1-3 修复：删除 filter 参数（reader/masonry 在仅 Local 目录卷下语义一致）。
export async function findNextVolume(
  descriptor: SourceDescriptor,
  currentPath: string,
  direction: 'next' | 'prev',
): Promise<NextVolumeResult | null> {
  return invoke<NextVolumeResult | null>('find_next_volume', {
    args: { descriptor, currentPath, direction },
  });
}
```

### 6.2 TS 镜像 — 删除虚假 filter 参数（P1-5 修复）

`lib/findNextDirectory.ts` 保持原签名 `(siblings: string[], currentPath, direction) → string | null`，**不加 filter 参数**。v1 计划中的 filter 参数无行为价值（TS 接 string[] 不含 isDirectory 信息），v2 删除。若未来需要 Rust/TS 双实现校对，应将 TS 输入升级为带 `isDirectory` 的 entry 数组并真实过滤；本版不做。

---

## 7. Domain 类型契约

> 全部基于现有代码核对（`BookItem` / `ProgressItem` / `PageRange` / `SourceDescriptorLocal` / `CreateBookArgs` / `ContinueMode` 均已存在，复用）。

```typescript
// 放 src/composables/useCrossVolume.ts 顶部（或独立 crossVolumeTypes.ts）

/** 当前卷身份（竞态校验 + Controller 注入） */
export interface BookIdentity {
  descriptor: SourceDescriptorLocal;   // 仅 Local
  relPath: string;                      // 相对 rootPath 完整路径
  bookId: number;                       // 当前 library.id
}

/** find_next_volume 返回（NextVolumeResult 的 domain 版） */
export interface NextVolumeTarget {
  descriptor: SourceDescriptorLocal;    // 仅 Local 目录
  relPath: string;
  title: string;
  // 无 isArchive —— 避免调用方残留分支
}

/** loadBookById 可选入参（仅 explicit，progress 由 Loader 内部 getProgress 取） */
export interface LoadBookOptions {
  explicitImageName?: string;           // ?at=（仅首次开卷）
}

/** Loader 返回的不可变快照（ReaderView 原子提交） */
export interface ReaderBookSnapshot {
  book: BookItem;
  descriptor: SourceDescriptorLocal;
  relPath: string;
  imageNames: string[];                 // 卷内图片文件名（已排序）
  pageUrls: string[];                   // convertFileSrc(absDir, name)
  spreads: PageRange[];
  initialSpreadIndex: number;
}

/** 结构化身份比较（不 JSON.stringify，字段顺序无关） */
export function sameBookIdentity(
  a: BookIdentity | null,
  b: BookIdentity | null,
): boolean {
  return (
    a !== null && b !== null
    && a.bookId === b.bookId
    && a.relPath === b.relPath
    && a.descriptor.rootPath === b.descriptor.rootPath
  );
}
```

---

## 8. useReaderBookLoader composable

**职责**：读 route bookId，IO + 计算，返回不可变 Snapshot。不写 ReaderView refs，不导航。

```typescript
export function useReaderBookLoader() {
  /**
   * 唯一"读取并生成页面 Snapshot"的入口。
   * route watch 调用。全程不写 refs。
   *
   * 恢复优先级：explicitImageName → progress.imageName → progress.page → 0
   * progress.finished === true → 直接 0
   */
  async function loadBookById(
    bookId: number,
    opts?: LoadBookOptions,
  ): Promise<ReaderBookSnapshot>;

  /**
   * 仅建立持久化身份，不加载/不提交页面。
   * 跨卷前 ReaderView.navigateToVolume 调用（在 router.replace 之前）。
   * createBook UPSERT（UNIQUE(source_descriptor, absolute_path)）→ 返回 id。
   *
   * P2：CreateBookArgs 最小映射（target 只有 descriptor/relPath/title，其余字段本版接受 null/0，
   * 不扩大范围；createBook 对已存在行不更新封面/页数，本版接受此行为）：
   */
  async function ensureBookId(target: NextVolumeTarget): Promise<number> {
    return createBook({
      title: target.title,
      sourceDescriptor: target.descriptor,
      absolutePath: target.relPath,
      sourceType: 'Local',        // 仅 Local 目录卷（§1.2）
      favorite: false,            // 跨卷不自动入书库（对齐 useReaderActions.readNow 语义）
      coverEntryPath: null,       // 本版不探测封面
      coverEntryName: null,
      pageCount: 0,               // Loader 随后有完整枚举，但 createBook 对已存在行不更新；接受 0
    });
  }

  return { loadBookById, ensureBookId };
  // 注：无 saveCurrentProgressNow（归 reader store，见 §9）
}
```

**loadBookById 内部步骤**（现 `ReaderView.loadBook` 的逻辑抽取，无 Archive 分支）：

1. `getBook(bookId)` → 解析 descriptor；非 Local → throw（收窄）。
2. `listDirectory(descriptor, absDir)` → `filter(e => !e.isDirectory && !e.isArchive && isImage(e.name))`。
3. `directorySort.resolve(sd, relPath)` 排序（per-folder override fallback settings）。
4. `imageNames = sorted.map(e => e.name)`；`pageUrls = sorted.map(e => convertFileSrc(joinPath(absDir, e.name)))`。
5. `spreads = SpreadPlanner.plan(pageUrls.length, true, isSinglePage)`。
6. `initialSpreadIndex = resolveStart({ explicitImageName, getProgress(bookId), spreads, imageNames })`。
7. **返回 Snapshot**（局部变量，不调 reader.openBook，不写任何 ref）。

---

## 9. reader store 扩展

`stores/reader.ts` 新增：

- state `sourceDescriptor: Ref<SourceDescriptorLocal | null>`（openBook 时写入）
- state `currentRelPath: Ref<string>`（当前卷相对 rootPath 完整路径）
- `OpenBookPayload` 加可选 `sourceDescriptor?` + `currentRelPath?`
- `saveCurrentProgressNow(): Promise<void>`（**P1-1 修复**：构造当前快照 await 写入，不只 flush pending）
- `nextPage()` 扩展末页跨卷意图：**执行前**检查 `isAtLastSpread`，若已末页不翻页，调注入的 `onAtLastNextAttempt` 回调（ReaderView 注入，写 `slideshow.pendingNextVolume`）；否则正常 `currentSpreadIndex++`。序列边沿自动区分"翻到末页"与"末页再向下"。

```typescript
// reader.ts
async function saveCurrentProgressNow(): Promise<void> {
  if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (bookId.value === null || spreads.value.length === 0) return;
  const spread = spreads.value[currentSpreadIndex.value];
  const page = spread?.start ?? 0;
  const imageName = spread ? imageNames.value[spread.start] ?? null : null;
  const finished = currentSpreadIndex.value >= spreads.value.length - 1;
  await saveProgress(bookId.value, page, 'single', finished || undefined, imageName ?? undefined);
}

// nextPage 末页分支
let onAtLastNextAttempt: (() => void) | null = null;
function setOnAtLastNextAttempt(fn: (() => void) | null): void { onAtLastNextAttempt = fn; }
function nextPage() {
  if (status.value !== 'ready') return;
  if (currentSpreadIndex.value >= spreads.value.length - 1) {
    onAtLastNextAttempt?.();   // 末页再向下 → 写跨卷意图（不翻页）
    return;
  }
  currentSpreadIndex.value += 1;
  emitChanged();
}

// return 加：sourceDescriptor, currentRelPath, saveCurrentProgressNow, setOnAtLastNextAttempt
```

**循环依赖处理**：reader → slideshow 单向（reader 经回调写 flag，不直接 import slideshow）。回调由 ReaderView 注入，卸载时 `setOnAtLastNextAttempt(null)` 清理（不变量 11）。

---

## 10. useCrossVolume — CrossVolumeController

**职责**：模式决策、查找目标、确认状态、竞态保护。不构造图片 URL，不复制 loadBook，不写 refs。

```typescript
export function useCrossVolume(opts: {
  identity: () => BookIdentity | null;                              // 读当前卷身份（加载期返回 null，见 §11）
  navigateToVolume: (target: NextVolumeTarget) => Promise<void>;    // ReaderView 注入：ensureBookId+replace
  saveCurrentProgressNow: () => Promise<void>;                       // = reader.saveCurrentProgressNow
  pushToast: (key: string, params?: Record<string, unknown>) => void; // 注入真实 useToast
  getContinueMode: () => ContinueMode;                              // 注入 settings.continueToNextVolume（可测）
  pauseSlideshow: () => void;                                       // 注入 slideshow.pause
  consumePendingNextVolume: () => void;                             // 注入 slideshow.consumePendingNextVolume
  canStart: () => boolean;                                          // P1 修复：注入 bookLoadPhase==='ready'，加载期拒绝新跨卷
}) {
  const phase = ref<'idle' | 'resolving' | 'awaiting-confirm' | 'navigating'>('idle');
  const pendingCrossVolume = ref<NextVolumeTarget | null>(null);
  const busy = computed(() => phase.value !== 'idle');
  let identityAtArm: BookIdentity | null = null;   // 结构化（不 stringify）
  let requestSeq = 0;

  /** 集中收口：所有终止路径都走 settleIdle，保证 pending 不变量（pendingCrossVolume 只在 awaiting-confirm 非空）。P0-2 修复。 */
  function settleIdle(): void {
    clearPendingState();
    phase.value = 'idle';
  }

  /** 统一入口。P1 修复：加载期（bookLoadPhase!=='ready'）拒绝，防 route Loader 未完成时 Controller 再次发起跨卷。 */
  async function maybeContinue(force: boolean, dir: 'next' | 'prev'): Promise<void> {
    if (phase.value !== 'idle') return;
    if (!opts.canStart()) {
      // 加载期拒绝：消费已置位的 pendingNextVolume，防止 watch 消费失败后 flag 停留 true，
      // 后续末页再向下设 true 不产生新边沿 → 跨卷意图丢失。
      opts.consumePendingNextVolume();
      return;
    }
    const startIdentity = opts.identity();
    if (!startIdentity) return;

    // P0-1 修复：off 必须在 findNextVolume 之前处理，否则 off 模式仍会跨卷。
    const mode = force ? 'auto' : opts.getContinueMode();
    if (mode === 'off') {
      settleIdle();   // clearPendingState（含 consumePendingNextVolume）+ idle
      return;
    }

    const seq = ++requestSeq;
    phase.value = 'resolving';
    try {
      const result = await findNextVolume(startIdentity.descriptor, startIdentity.relPath, dir);
      if (seq !== requestSeq || !opts.canStart() || !sameBookIdentity(opts.identity(), startIdentity)) {
        settleIdle(); return;   // 陈旧/加载期变化，丢弃
      }
      if (!result) {
        opts.pushToast('reader.crossVolume.none');
        settleIdle(); return;
      }
      const target: NextVolumeTarget = {
        descriptor: result.descriptor as SourceDescriptorLocal,
        relPath: result.relPath, title: result.title,
      };
      if (mode === 'manual') {
        pendingCrossVolume.value = target;
        identityAtArm = startIdentity;       // 保存供 confirmManual 再校验
        phase.value = 'awaiting-confirm';
        return;
      }
      await navigateResolvedTarget(target, startIdentity, seq);
    } catch (e) {
      opts.pushToast('reader.crossVolume.failed');
      settleIdle();
    }
  }

  /** manual 点跳转。P1 修复：开头 phase 守卫，防双击启动两条确认流程（第二次直接 return）。 */
  async function confirmManual(): Promise<void> {
    if (phase.value !== 'awaiting-confirm') return;
    const target = pendingCrossVolume.value;
    const expected = identityAtArm;
    if (!target || !expected) {
      settleIdle();
      return;
    }
    const seq = ++requestSeq;
    await navigateResolvedTarget(target, expected, seq);
  }

  /** 实际导航（步骤对应 §4.2：① ② ③ ④ 在此层，⑤ ⑥ 在 navigateToVolume，⑦ ⑧ 在 finally）。所有终止路径用 settleIdle 保证 pending 不变量。 */
  async function navigateResolvedTarget(
    target: NextVolumeTarget, expected: BookIdentity, seq: number,
  ): Promise<void> {
    phase.value = 'navigating';
    // ① 初校验 identity（navigateToVolume 前确认当前卷未变）
    if (!sameBookIdentity(opts.identity(), expected)) { settleIdle(); return; }
    // ② trySave（失败 toast 不阻断，取消旧 debounce 与本次保存成功分离）
    await trySaveCurrentProgress();
    // ③ opts.pauseSlideshow()
    opts.pauseSlideshow();
    // ④ 再校验 identity + requestSeq（ensureBookId/replace 前必须校验）
    if (seq !== requestSeq || !sameBookIdentity(opts.identity(), expected)) {
      settleIdle(); return;
    }
    try {
      // ⑤ ⑥ 由 opts.navigateToVolume 做（ensureBookId + router.replace）
      await opts.navigateToVolume(target);
    } catch (e) {
      opts.pushToast('reader.crossVolume.failed');
      // 导航失败：目录/身份可能已变，清理（恢复 awaiting-confirm 供重试有风险，本版清理）
    } finally {
      settleIdle();   // ⑦ clearPendingState + ⑧ phase idle（成功/失败都清，保证 pending 不变量）
    }
  }

  /** 保存失败不进 navigate 失败分支（不变量 10） */
  async function trySaveCurrentProgress(): Promise<void> {
    try { await opts.saveCurrentProgressNow(); }
    catch (e) { opts.pushToast('reader.crossVolume.progressSaveFailed'); log('[crossVolume] save progress failed', e); }
  }

  /** 仅清数据 + slideshow flag，不动 phase（settleIdle / dismissManual 调） */
  function clearPendingState(): void {
    pendingCrossVolume.value = null;
    identityAtArm = null;
    opts.consumePendingNextVolume();
  }

  /** toast close 专用：只在 awaiting-confirm 生效 + 推 seq 失效旧请求 + settleIdle */
  function dismissManual(): void {
    if (phase.value !== 'awaiting-confirm') return;
    requestSeq += 1;
    settleIdle();
  }

  return { phase, pendingCrossVolume, busy,
           maybeContinue, confirmManual, dismissManual };
}
```

---

## 11. ReaderView 编排层

### 11.1 route watch 唯一入口（删 onMounted）

```typescript
// 删除：onMounted(loadBook) + onNextVolume 的旧逻辑
const lastLoadedBookId = ref<number | null>(null);
const bookLoadPhase = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const visibleReader = ref(false);
// P0-3 修复：非响应式局部变量（模板不消费），用 let。卸载时自增使在途 Loader 失效。
let activeLoadSeq = 0;

watch(
  () => Number(route.params.bookId),
  (bookId) => void loadRouteBook(bookId),
  { immediate: true },   // 首次挂载 = immediate，跨卷 = bookId 变化
);

async function loadRouteBook(bookId: number) {
  // 去重只对 ready 生效（失败/取消后可重试）
  if (bookId === lastLoadedBookId.value && bookLoadPhase.value === 'ready') return;

  const seq = ++activeLoadSeq;
  bookLoadPhase.value = 'loading';
  visibleReader.value = false;          // route 变即进 loading（失败不保留旧卷）

  try {
    const snapshot = await loader.loadBookById(bookId, {
      explicitImageName: route.query.at ? decodeURIComponent(route.query.at as string) : undefined,
    });
    if (seq !== activeLoadSeq) return;  // 旧卷晚返回丢弃
    commitBookSnapshot(snapshot);
    lastLoadedBookId.value = bookId;
    bookLoadPhase.value = 'ready';
    visibleReader.value = true;
  } catch (error) {
    if (seq !== activeLoadSeq) return;
    reader.closeBook();
    pageUrls.value = []; imageNames.value = []; book.value = null;
    bookLoadPhase.value = 'error';
    errorMessage.value = normalizeError(error);  // 显示新卷错误页
  }
}

/** 原子提交（可单测） */
function commitBookSnapshot(snapshot: ReaderBookSnapshot) {
  book.value = snapshot.book;
  pageUrls.value = snapshot.pageUrls;
  imageNames.value = snapshot.imageNames;
  reader.openBook({
    bookId: snapshot.book.id,
    title: snapshot.book.title,
    pages: snapshot.pageUrls,
    spreads: snapshot.spreads,
    initialSpreadIndex: snapshot.initialSpreadIndex,
    sourceDescriptor: snapshot.descriptor,
    currentRelPath: snapshot.relPath,
  });
  reader.imageNames = snapshot.imageNames;
}

/** 显式重试（失败/取消后） */
async function retryCurrentBook() {
  lastLoadedBookId.value = null;
  await loadRouteBook(Number(route.params.bookId));
}
```

### 11.2 navigateToVolume（Controller 注入）

```typescript
// §4.2 步骤 ⑤ ⑥：仅 ensureBookId + replace。
// ① ② ③ ④（identity 校验 + trySave + slideshow.pause + 再校验）已在 Controller.navigateResolvedTarget 完成。
async function navigateToVolume(target: NextVolumeTarget): Promise<void> {
  const bookId = await loader.ensureBookId(target);          // ⑤ 异步边界（DB + createBook UPSERT）
  await router.replace({ name: 'reader', params: { bookId }, query: {} });  // ⑥ at 清空
}

/** P1 修复：加载期（bookLoadPhase!=='ready'）或 store.bookId 与 route 不一致时返回 null。
 *  Controller.canStart + identity 双重保护：加载期 maybeContinue 直接 return，
 *  即使 hotkey/9宫格/watch 绕过 UI busy 检查也无法发起跨卷。 */
function currentIdentity(): BookIdentity | null {
  if (bookLoadPhase.value !== 'ready') return null;
  if (reader.bookId === null || reader.sourceDescriptor === null) return null;
  if (reader.bookId !== Number(route.params.bookId)) return null;   // route 与 store 分裂时拒绝
  return {
    descriptor: reader.sourceDescriptor,
    relPath: reader.currentRelPath,
    bookId: reader.bookId,
  };
}
```

### 11.3 Controller 实例化 + 触发接线

```typescript
const crossVolume = useCrossVolume({
  identity: currentIdentity,
  navigateToVolume,
  saveCurrentProgressNow: () => reader.saveCurrentProgressNow(),
  pushToast: (k, p) => useToast().push(t(k, p)),
  getContinueMode: () => settings.continueToNextVolume,
  pauseSlideshow: () => slideshow.pause(),
  consumePendingNextVolume: () => slideshow.consumePendingNextVolume(),
  canStart: () => bookLoadPhase.value === 'ready',   // P1：加载期拒绝
});

// 末页跨卷意图：reader.nextPage atLast → 写 slideshow.pendingNextVolume
reader.setOnAtLastNextAttempt(() => { slideshow.pendingNextVolume = true; });

// 单一 watch 消费 pendingNextVolume（手动末页 + slideshow 末页统一）
watch(() => slideshow.pendingNextVolume, (v) => {
  if (v) void crossVolume.maybeContinue(false, 'next');   // 看模式
});

// 显式跨卷（force=true，不看模式）
// 9 宫格 folder-next action（zoneActions.nextVolume）→ crossVolume.maybeContinue(true, 'next')
// Alt+→ hotkey：useReaderHotkeys 现有 folderNext 是 TODO no-op（useReaderHotkeys.ts:75），
//   需扩展 API 接受 actions 参数（P1-2 修复），见 §11.5。

onUnmounted(() => {
  reader.setOnAtLastNextAttempt(null);   // 不变量 11：清理回调
  activeLoadSeq += 1;                     // P0-3：使在途 Loader 失效，卸载后不执行提交
  void reader.saveCurrentProgressNow();   // 兜底
  slideshow.pause();
  reader.closeBook();
});
```

### 11.4 模板

```vue
<ContinueNextVolumeToast
  :target="crossVolume.pendingCrossVolume.value"
  :loading="crossVolume.phase.value === 'navigating'"
  @jump="crossVolume.confirmManual()"
  @close="crossVolume.dismissManual()"
/>
```

### 11.5 9 宫格 + Alt+→ 触发接线（P1-2 修复）

**9 宫格 folder-next**：现有 `ReaderView.zoneActions.nextVolume`（`ReaderView.vue:526`）当前调旧 `onNextVolume()`，改为调 `crossVolume.maybeContinue(true, 'next')`（force=true，不看模式）：

```typescript
const zoneActions = {
  // ... 现有
  nextVolume: () => { void crossVolume.maybeContinue(true, 'next'); },
};
```

**Alt+→ hotkey**：现有 `useReaderHotkeys()` 不接参数，`folderNext` 在 dispatch 内是 `// TODO` no-op（`useReaderHotkeys.ts:75`）。扩展 API 接受可选 actions（保持向后兼容，现有调用方不受影响）：

```typescript
// useReaderHotkeys.ts
export interface ReaderHotkeyActions {
  nextVolume?: () => void;
  prevVolume?: () => void;
}

export function useReaderHotkeys(actions: ReaderHotkeyActions = {}): void {
  // ... 现有 setup
  function dispatch(store, router, cmd: ReaderCommand): void {
    switch (cmd) {
      // ... 现有 case
      case 'folderNext':
        actions.nextVolume?.();   // 替换原 // TODO no-op
        break;
      case 'folderPrev':
        actions.prevVolume?.();
        break;
    }
  }
}

// ReaderView.vue
useReaderHotkeys({
  nextVolume: () => { void crossVolume.maybeContinue(true, 'next'); },
});
```

---

## 12. ContinueNextVolumeToast（纯 props/emits）

```vue
<script setup lang="ts">
defineProps<{
  target: NextVolumeTarget | null;
  loading?: boolean;
}>();
defineEmits<{ (e: 'jump'): void; (e: 'close'): void }>();
</script>
<template>
  <Teleport to="body">
    <div v-if="target" class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
         bg-surface/90 backdrop-blur-xl rounded-full px-3 py-1.5 flex items-center gap-3
         text-sm text-white shadow-xl" data-test="cross-volume-toast">
      <span>{{ t('reader.crossVolume.continuePrompt', { title: target.title }) }}</span>
      <button :disabled="loading" data-test="cross-volume-jump" @click="$emit('jump')">
        {{ t('reader.crossVolume.jump') }}
      </button>
      <button data-test="cross-volume-close" @click="$emit('close')">✕</button>
    </div>
  </Teleport>
</template>
```

复用 `SlideshowToast.vue` 胶囊样式。**不调 `useCrossVolume()`**（P0-2 修复）。

---

## 13. 通用 toast（useToast + ToastHost）

项目当前无通用 toast 组件。本次需要"无下一卷 / 已跳转 / 失败 / 进度保存失败"4 类短暂提示。

- `composables/useToast.ts`：单例 ref 队列（上限 1，后者替换）+ `push(message)` + 1500ms 自动隐藏 + `dismiss()`。
- `components/common/ToastHost.vue`：`<Teleport to="body">` 渲染队列，`role="status" aria-live="polite"`。
- Controller 经注入的 `pushToast(key, params)` 调（key 是 i18n key，ReaderView 在注入时 `t(k, p)` 转成文案）。

---

## 14. 瀑布流跨卷（独立路径）

### 14.1 工具栏按钮（不绑 viewMode — P1-3 修复）

```vue
<!-- P1-3 修复：disabled 不含 !hasImages（无图目录回落 details 后仍可点跳过）。
     仅在 swapping / 无 rootPath / 无 lastFetchedPath（根目录自身不能作为"卷"起点）时禁用。 -->
<button
  class="tb-btn"
  :disabled="swapping || !fb.rootPath || !fb.lastFetchedPath"
  @click="onCrossNextVolume"
>
  <svg .../><!-- ICON_NEXT_VOLUME -->
  <span>{{ t('fileBrowser.nextVolume') }}</span>
</button>
```

**不绑 `viewMode === 'masonry'`**：跳到无图目录自动回落 details 后，按钮仍可点继续跳过（P1-3）。**disabled 不含 `!hasImages`**：无图目录 hasImages===false，含它会让按钮禁用，P1-3 实际未修复（P0-4）。仅在 `swapping` / 无 `fb.rootPath` / 无 `fb.lastFetchedPath` 时禁用（根目录自身不能作为"卷"起点，`lastFetchedPath===''` 禁用合理）。

### 14.2 加载流程（用 lastFetchedPath — P1-4 修复）

> **P1-1 转发链**：`useMasonryBrowsePosition` 实例在 `MasonryView.vue` 内，`FileBrowser.vue` 无法直接调 `flushNow`。现有层级 `FileBrowser → FileList → MasonryView → browsePosition` 已有 `defineExpose` 转发模式（`MasonryView` 暴露 `browsePosition`/`jumpToLast` 等，`FileList` 经 `masonryRef` 转发并 `defineExpose`，`FileBrowser` 经 `fileListRef` 调）。本次扩展现有模式补 `flushNow` 转发，详见 §14.4。

```typescript
// FileBrowser.vue
// 注：fb 是 Pinia store，setup store refs 经 store proxy 自动解包 —— 不写 .value（现有代码一律 fb.rootPath/fb.lastFetchedPath）。
//     descriptor 用现有 computed masonryDescriptor（FileBrowser.vue:124，非 descriptor.value）。
const swapping = ref(false);
async function onCrossNextVolume() {
  if (swapping.value) return;
  const pathAtRequestStart = fb.lastFetchedPath;          // 稳定路径（非 currentPath）
  const rootAtRequestStart = masonryDescriptor.value.rootPath;
  if (!pathAtRequestStart || !rootAtRequestStart) return;
  swapping.value = true;
  try {
    await fileListRef.value?.masonryFlushNow();           // 经 FileList→MasonryView 转发（§14.4），立即 recordCurrentTop
    const result = await findNextVolume(masonryDescriptor.value, pathAtRequestStart, 'next');
    // 结果落地前校验：期间用户可能已切目录 或 切到另一个 root（新旧 root 下可能恰好有相同 relPath）
    if (fb.lastFetchedPath !== pathAtRequestStart || masonryDescriptor.value.rootPath !== rootAtRequestStart) return;
    if (!result) { pushToast(t('reader.crossVolume.none')); return; }
    await fb.navigate(result.relPath);
    pushToast(t('reader.crossVolume.jumped', { title: result.title }));
  } catch (e) {
    pushToast(t('reader.crossVolume.failed'));
  } finally {
    swapping.value = false;
  }
}
```

**智能恢复已自动**：`fb.navigate` 后 `useMasonryBrowsePosition.start()` → `restoreAndScroll()` → `getProgress` → `scrollToEntry(imageName)`。

### 14.3 useMasonryBrowsePosition.flushNow

```typescript
async function flushNow(): Promise<void> {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  await recordCurrentTop();
}
```

### 14.4 flushNow 转发链（P1-1 修复）

现有 `MasonryView` 已 `defineExpose({ ..., browsePosition, jumpToLast })`，`FileList` 已有 `masonryRef` + `defineExpose({ ..., scrollToIndex })`。本次扩展：

```typescript
// MasonryView.vue —— defineExpose 加 flushBrowsePosition
defineExpose({
  // ... 现有（regenerate / jumpToLast / browsePosition / scrollToEntry ...）
  flushBrowsePosition: () => browsePosition.flushNow(),
});

// FileList.vue —— 加 masonryFlushNow + defineExpose
async function masonryFlushNow(): Promise<void> {
  await masonryRef.value?.flushBrowsePosition();
}
defineExpose({
  // ... 现有（scrollToIndex / regenerate / retry / jumpToLastBrowse ...）
  masonryFlushNow,
});

// FileBrowser.vue —— 经 fileListRef 调（onCrossNextVolume 内，见 §14.2）
await fileListRef.value?.masonryFlushNow();
```

---

## 15. 边界处理

| 场景 | 行为 |
|---|---|
| 无下一卷（findNextVolume null） | toast none + clearPendingState + phase idle |
| 加载失败（listDirectory/getBook 异常） | route 已是新 bookId → reader.closeBook + 清 refs + error UI（**不保留旧卷**） |
| 跨卷中再触发 | `busy = phase!=='idle' \|\| bookLoadPhase==='loading'` 阻断 |
| current 不在 siblings（目录被移走） | findNextVolume null → "无下一卷" |
| 末卷 | toast + 停（manual 不显示胶囊） |
| 跳到无图目录（瀑布流） | 自动回落 details，按钮仍可点继续跳过 |
| 进度保存失败 | toast progressSaveFailed + **不阻断跨卷**（取消旧 debounce 与本次保存成功分离） |
| 陈旧请求（A 发起 find，切到 B，A 晚返回） | requestSeq + sameBookIdentity 校验，旧结果丢弃 |
| route 快速变化 | Loader activeLoadSeq 守卫，旧卷晚返回丢弃 |
| 非 Local descriptor | Rust 返回明确错误；Loader throw；显示新卷错误页 |
| 首页未翻页直接强制下一卷 | saveCurrentProgressNow 仍构造快照写入 |

---

## 16. i18n keys（zh-CN + en-US 同步）

新增 `reader.crossVolume.*` + `fileBrowser.nextVolume`：

| key | zh-CN | en-US |
|---|---|---|
| `reader.crossVolume.none` | 无下一卷 | No next volume |
| `reader.crossVolume.jumped` | 已跳转《{title}》 | Jumped to 《{title}》 |
| `reader.crossVolume.failed` | 跳转失败 | Failed to jump |
| `reader.crossVolume.progressSaveFailed` | 进度保存失败，已继续跨卷 | Progress save failed, continued anyway |
| `reader.crossVolume.continuePrompt` | 继续读下一本《{title}》？ | Continue to next volume 《{title}》? |
| `reader.crossVolume.jump` | 跳转 | Jump |
| `fileBrowser.nextVolume` | 下一卷 | Next volume |

7 key × 2 locale。`i18n-keys.test.ts` 守护对齐。

---

## 17. 测试计划（TDD）

### 17.1 Rust（pick_sibling 纯函数 + command 集成）

**pick_sibling 纯函数**（返回 entry，不返回索引 — P1-5）：
- next/prev 取相邻；current 在首/末（边界）；current 不在 siblings（None）；空 siblings；natural sort（page2 在 page10 前）。

**command 集成**（mock MediaSourceFactory 或 in-memory）：
- Local 目录跨卷（parent listDirectory → next dir）；越界返回 None；current 不存在；Windows/POSIX 分隔符；非 Local descriptor 返回明确错误。

### 17.2 前端（Vitest + happy-dom）

**useReaderBookLoader**：
- loadBookById 返回 Snapshot（不写 refs）；非 Local throw；filter 图片（排除 dir/archive/非图）；排序 per-folder override；智能恢复（explicit → imageName → page → 0；finished → 0）；ensureBookId UPSERT 返回 id。

**useCrossVolume**（注入 opts，mock findNextVolume）：
- maybeContinue(force=true) 直接 navigate；force=false + off return + consumePending；+ auto navigate；+ manual 填 pending + identityAtArm，不 navigate。
- confirmManual 再校验 identity（identity 已变 → 丢弃）。
- dismissManual 只在 awaiting-confirm 生效 + 推 requestSeq。
- 陈旧请求：A 发起 find，切到 B，A 晚返回 → 丢弃。
- 保存失败：trySaveCurrentProgress toast + 不进 navigate 失败分支。
- 用 deferred promise，测试末尾 resolve/reject（无悬挂任务 — P1-5）。

**reader store**：
- saveCurrentProgressNow 构造快照 await（有/无 pending debounce；首页未翻页；末页 finished=true）。
- nextPage atLast 调 onAtLastNextAttempt（不翻页）；非末页正常 ++。
- setOnAtLastNextAttempt(null) 清理。

**ContinueNextVolumeToast**（props/emits，不调 useCrossVolume — P1-5）：
- target null → 不渲染；target 有值 → 显示标题；点 jump → emit jump；点 close → emit close；loading=true → jump disabled。

**ReaderView.loadRouteBook + commitBookSnapshot**：
- 去重（同 bookId + ready 跳过）；失败不保留旧卷（closeBook + 清 refs + error）；stale 丢弃；commitBookSnapshot 原子提交。
- retryCurrentBook 重置 lastLoadedBookId 重载。

**useToast + ToastHost**：push 显示 + 1500ms 隐藏；队列上限 1。

**findNextDirectory.ts**：现有用例（不加 filter 参数）。

### 17.3 E2E 手测清单（验证不变量）

- [ ] Local 目录跨卷：auto 末页再向下 → 自动跳下一目录
- [ ] manual 末页再向下 → 胶囊 → 点跳转 → 跳下一卷
- [ ] off 末页再向下 → 不跳
- [ ] 9 宫格 folder-next / Alt+→ → 即时跨（不看模式）
- [ ] 末页触发时机：倒数第二页 nextPage 翻到末页不触发；末页再向下才触发
- [ ] 跨卷后画面/标题/总页数/imageName/bookId/URL 全属新卷（不变量 1）
- [ ] 跨卷后刷新仍打开新卷
- [ ] 跨卷后收藏/喜欢/书签作用于新卷
- [ ] manual 胶囊显示，关闭后不因旧请求重新出现（dismissManual 推 seq）
- [ ] 连续快速触发只加载一次（busy）
- [ ] 从 A 发起 find、切到 B、A 晚返回 → 结果丢弃
- [ ] 瀑布流从有图目录跳到无图目录后仍可继续下一卷（按钮不绑 viewMode）
- [ ] 首页未翻页直接强制下一卷 → 当前进度仍保存
- [ ] 加载失败 → 显示新卷错误页，不停留旧卷
- [ ] 智能恢复：读过一半的卷 → 恢复 page；已读完 → 第 1 页

---

## 18. 有意差异 vs Android / DESIGN.md

| 点 | 桌面端 | Android / DESIGN.md |
|---|---|---|
| continue 模式 | `off/auto/manual` 3 态 | Android 含 SWIPE（桌面删） |
| prev 方向 | 算法实现，UI 先不触发 | Android 双向触发 |
| 瀑布流跨卷 | 工具栏按钮（纯手动） | Android 无瀑布流视图 |
| 卷类型范围 | 仅 Local 目录（v2 收窄） | Android dir+archive |
| 循环 | 不做 | Android 不做 |

---

## 19. 实现顺序提示（plan）

1. 抽取统一 Loader：先为现有 `ReaderView.loadBook` 写表征测试，抽 `useReaderBookLoader`（首次开卷行为不变，返回 Snapshot）。
2. Rust `find_next_volume` 替换 stub（`pick_sibling` 纯函数 + async command，仅 Local）+ `NextVolumeResult` + `tauri.ts` 改返回类型。
3. reader store 扩展（sourceDescriptor / currentRelPath / saveCurrentProgressNow / nextPage atLast 回调 / setOnAtLastNextAttempt）。
4. `useCrossVolume` Controller（状态机 + requestSeq + sameBookIdentity + trySave + clearPendingState/dismissManual）。
5. ReaderView 编排层（route watch immediate + loadRouteBook + commitBookSnapshot + retryCurrentBook + navigateToVolume + 触发接线 + 卸载清理）。
6. `useToast` + `ToastHost`。
7. `ContinueNextVolumeToast`（props/emits）。
8. 瀑布流工具栏按钮（不绑 viewMode + lastFetchedPath + flushNow）。
9. i18n 7 key × 2 locale。
10. 全测 + type-check + 本地 build + E2E 手测。
