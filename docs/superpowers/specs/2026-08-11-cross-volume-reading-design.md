# 跨卷连续阅读 — 设计规格

> 日期:2026-08-11
> 状态:已批准(待 spec 审查)
> 关联:[功能矩阵 §4 缺口 #3](../reports/2026-08-11-feature-matrix.md) | [DESIGN.md §12.3](../../DESIGN.md) | [CLAUDE.md §0.5/§0.6](../../CLAUDE.md)

---

## 1. 目标 & 范围

### 1.1 目标

填实 `find_next_volume` stub,打通"读完一卷自动/手动跳到下一卷"的完整链路。覆盖 **3 个触发场景**:

| 场景 | 触发源 | 路径 |
|---|---|---|
| reader 手动阅读 | 末页 `atLastSpread` watch + 9 宫格 `folder-next` / `Alt+→` | `maybeContinue` → `loadCrossVolume` |
| 幻灯片播放 | `slideshow.tick` 末页 → `pendingNextVolume`(已有 flag) | 同上 |
| 瀑布流浏览 | MasonryView 工具栏"下一卷"按钮(纯手动) | 独立路径 → `fileBrowser.setRoot+navigate` |

### 1.2 范围(确认决策)

| 决策 | 结论 |
|---|---|
| 完整度 | **完整实现**:reader 三模式(off/auto/manual)+ 瀑布流手动按钮 |
| 跳转起点 | **智能恢复**:查 progress,未读完→恢复 page/scroll;已读完或无记录→第 1 页/顶部 |
| manual UI | **底部胶囊**:"继续读下一本《XXX》?"+ 跳转 + 关闭 |
| prev 方向 | **先不触发**:Rust 算法对称实现(direction 参数),UI 只接 next(prev 留接口) |
| 无下一卷 | toast 提示 + 停(manual 不显示胶囊,因为无目标) |
| 循环 | **不做**,末卷无下一卷就停 |

### 1.3 不做(YAGNI)

- ❌ prev 方向的 UI 触发(9 宫格 bl / Alt+← 仍保留映射但本次不接跨卷,留给后续)
- ❌ 瀑布流无限滚动追加(改 masonry 布局 + 虚拟化合并多目录,过重)
- ❌ 瀑布流自动跨卷(浏览场景自动跳打扰)
- ❌ 跨卷过渡动画
- ❌ 循环到首卷

---

## 2. 背景(现状)

**已就绪**(前端):
- `slideshow.pendingNextVolume` flag + `ReaderView` watch 通路(CLAUDE.md §0.6)
- `settings.continueToNextVolume: ContinueMode`('off'|'auto'|'manual',默认 'manual',`stores/settings.ts:30`)
- 9 宫格 `br=folder-next` 映射 + `Alt+→` hotkey
- `useMasonryBrowsePosition` 瀑布流进度双写(image_name + page)+ restoreAndScroll 智能恢复
- `useReaderActions.readFromCurrentPath` 的 getProgress 智能恢复模式(可复用)

**stub**(待填):
- `commands/find_next_volume.rs:16` — `Ok(None)` 占位,返回 `Option<String>`,同步 fn,无 factory
- `lib/tauri.ts:475` `findNextVolume()` — 返回 `string|null`,无 filter 参数

**TS 镜像** `lib/findNextDirectory.ts` — 纯函数版(接收 siblings 字符串数组),与 Rust command(自 listDirectory)语义层不同。本次校对 filter 逻辑一致,不强制签名镜像。

---

## 3. 方案对比

| 方案 | find_next_volume | 触发机制 | 加载接线 | 评价 |
|---|---|---|---|---|
| **A(选定)** | Rust command(async + factory) | 统一 `maybeContinue(force, dir)` | 复用 reader.openBook / fileBrowser.navigate | 对齐 Android + DESIGN.md §13.2 + 最小侵入 |
| B | 前端算(已有 TS 镜像 + listDirectory) | 同 A | 同 A | 违反"算法双实现一致"约定,Rust stub 永留 |
| C | 同 A | 双 flag(pendingNext/Prev) | reader.swapBook 原子操作 | 手动跨卷经 flag 有延迟 |

**选 A**:核心新增只在 Rust 一个 command + 一个 composable + 一个 UI 组件 + 瀑布流工具栏按钮。前端 flag/settings/9 宫格/瀑布流进度机制全复用。

---

## 4. 架构总览

```
reader 场景(三触发源 → maybeContinue → 三模式):
  手动末页 atLastSpread watch  ─┐
  slideshow pendingNextVolume  ┼→ maybeContinue(force=false, next) → 看模式
  9 宫格 folder-next / Alt+→   ─→ maybeContinue(force=true,  next) → 直接跨
                                      ↓
                                 loadCrossVolume('next'):
                                   1. flush 当前 page progress
                                   2. findNextVolume(filter='reader')
                                   3. null → toast 无下一卷 + return
                                   4. getProgress 智能恢复 startPage
                                   5. reader.openBook(新卷, startPage)

瀑布流场景(纯手动,不经 mode 控制):
  MasonryView 工具栏「下一卷」按钮
    → findNextVolume(filter='masonry')
    → null → toast 无下一卷
    → 有 → fileBrowser.setRoot(parent) + navigate(relPath)
           → MasonryView 重载 → useMasonryBrowsePosition.start() 自动智能恢复 scroll
           (当前目录 scroll position 已由 recordCurrentTop 持续 debounce 写入,跳转前自然已 flush)
```

**统一守卫**:跨卷加载中(`bookSwapInFlight=true`)再触发跨卷直接 return,防重复(对齐 Android `@Volatile`)。

---

## 5. Rust 端 — `find_next_volume` 替换 stub

### 5.1 数据结构

```rust
// commands/find_next_volume.rs

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNextVolumeArgs {
    pub descriptor: serde_json::Value,   // 当前卷的 SourceDescriptor
    pub current_path: String,             // 当前卷相对 rootPath 的完整路径(如 "comics/vol1");parent_path = PathUtils.parent(this)
    pub direction: String,                // "next" | "prev"(算法对称,UI 只接 next)
    pub filter: String,                   // "reader"(dir|archive) | "masonry"(只 dir),默认 "reader"
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextVolumeResult {
    pub descriptor: serde_json::Value,   // 下一卷完整 SourceDescriptor(Archive 时归一化为 Archive variant)
    pub rel_path: String,                 // 下一卷在 parent 的相对路径
    pub title: String,                    // 显示名(目录名 / 压缩包名)
    pub is_archive: bool,
}
```

### 5.2 算法

```rust
#[tauri::command]
pub async fn find_next_volume(
    args: FindNextVolumeArgs,
    factory: State<'_, MediaSourceFactory>,
) -> Result<Option<NextVolumeResult>, String> {
    // 1. 解析 parent:
    //    - Local/WebDav: parent_path = current_path 的父目录;parent_descriptor = 同源
    //    - Archive: archiveKeyParts 归一化 → origin descriptor + archiveRelPath;
    //      parent = origin 的包所在目录
    // 2. siblings = factory.resolve(&parent_descriptor).list_directory(&parent_path).await?
    // 3. 过滤(filter 参数):
    //    - "reader":  保留 is_directory || is_archive
    //    - "masonry": 保留 is_directory
    // 4. natural_sort(siblings)  // 复用 algorithm::natural_sort
    // 5. idx = siblings.iter().position(|s| s.name == current_basename)
    //    current_basename = current_path 末段(PathUtils.parent 取)
    // 6. next → siblings[idx+1..] 首个;prev → siblings[..idx].rev() 首个
    // 7. 构造 NextVolumeResult:
    //    - 目标是目录 → descriptor = parent_descriptor 同源, rel_path = parent_path + name
    //    - 目标是 archive → descriptor = Archive { origin, archive_path, ... }(归一化)
    // 8. 返回 Some(result) 或 None(越界 / current 不在 siblings)
}
```

**纯函数抽取**:把"过滤 + sort + 取 next/prev"抽成纯函数 `fn pick_sibling(siblings: &[MediaEntry], current: &str, dir: &str, filter: &str) -> Option<usize>`,便于单测(不依赖 IO)。

### 5.3 依赖

- 复用 `algorithm::natural_sort::natural_sort`
- 复用 `algorithm::path::PathUtils::{parent, segments, join}`
- 复用 `source::MediaSourceFactory`(已 registered State)
- 不新增 crate

---

## 6. TS 镜像校对

`lib/findNextDirectory.ts` 当前签名:`(siblings: string[], currentPath, direction) → string|null`。

**校对**:加 `filter` 参数,语义对齐 Rust `pick_sibling`(纯函数,接收已过滤或未过滤的 siblings)。

```ts
export function findNextDirectory(
  siblings: string[],
  currentPath: string,
  direction: Direction,
  filter: 'reader' | 'masonry' = 'reader',
): string | null
```

**注**:TS 镜像接收 string[](名字),不含 is_directory/is_archive 信息,filter 在调用方做(调用方 listDirectory 后按 filter 过滤再传入)。所以 TS 镜像的 filter 参数主要用于"记录意图 + 文档",实际过滤在调用方。spec 标注此差异,不强制完全镜像。

单测加:`filter='masonry'` 场景 + 混合 dir/archive 序列。

---

## 7. reader 跨卷

### 7.1 新 composable `useCrossVolume.ts`

职责:统一跨卷入口 + 加载流程。依赖 reader store + slideshow store + settings store + tauri + router。

```ts
export function useCrossVolume() {
  const reader = useReaderStore();
  const slideshow = useSlideshowStore();
  const settings = useSettingsStore();
  const router = useRouter();

  const bookSwapInFlight = ref(false);
  const pendingCrossVolume = ref<NextVolumeResult | null>(null);  // manual 胶囊等待用户确认

  /**
   * 统一入口。force=true(手动 9 宫格/Alt)不看模式直接跨;
   * force=false(末页自动)看 settings.continueToNextVolume。
   */
  async function maybeContinue(force: boolean, dir: 'next' | 'prev'): Promise<void> {
    if (bookSwapInFlight.value) return;           // guard
    if (!force) {
      const mode = settings.continueToNextVolume;  // 'off'|'auto'|'manual'
      if (mode === 'off') { consumePending(); return; }
      if (mode === 'manual') { await armManualToast(dir); return; }
      // auto 落到下面 loadCrossVolume
    }
    await loadCrossVolume(dir);
  }

  /** auto / 手动确认后调. opts.result 复用 manual 已 find 的结果(避免重 IPC) */
  async function loadCrossVolume(dir: 'next' | 'prev', opts: { result?: NextVolumeResult | null } = {}): Promise<void> {
    if (bookSwapInFlight.value) return;
    bookSwapInFlight.value = true;
    try {
      // 1. flush 当前 page progress(reader.emitChanged 已 debounce,这里 force flush)
      await reader.flushProgress();
      // 2. find(manual 确认时复用 pendingCrossVolume,不重 IPC)
      const result = opts.result ?? await findNextVolume(reader.sourceDescriptor, reader.currentRelPath, dir, 'reader');
      if (!result) { toast(t('reader.crossVolume.none')); consumePending(); return; }
      // 3. 智能恢复起点:合成下一卷的 bookId(复用 useReaderActions.ensureBookId 模式:
      //    createBook if not exists → bookId)→ getProgress
      const progress = await getProgressOf(result);
      const startPage = progress && !progress.finished ? progress.page : 0;
      const startImageName = progress?.imageName;     // 优先用 imageName(更精确)
      // 4. openBook(复用 reader.openBook,payload 带 startPage/startImageName — 不走路由)
      reader.openBook({ ...resultToOpenBookPayload(result), startPage, startImageName });
      toast(t('reader.crossVolume.jumped', { title: result.title }));
      consumePending();
    } catch (e) {
      toast(t('reader.crossVolume.failed'));
      log('[useCrossVolume] loadCrossVolume failed', e);
    } finally {
      bookSwapInFlight.value = false;
    }
  }

  /** manual 模式:填充 pendingCrossVolume,胶囊显示等用户点 */
  async function armManualToast(dir: 'next' | 'prev'): Promise<void> {
    const result = await findNextVolume(reader.sourceDescriptor, reader.currentRelPath, dir, 'reader');
    if (!result) { toast(t('reader.crossVolume.none')); consumePending(); return; }
    pendingCrossVolume.value = result;
  }

  function consumePending(): void {
    pendingCrossVolume.value = null;
    slideshow.consumePendingNextVolume();   // 清已有的 slideshow flag
  }

  return { maybeContinue, loadCrossVolume, pendingCrossVolume, bookSwapInFlight, consumePending };
}
```

### 7.2 reader store 扩展

`stores/reader.ts` 新增:
- state `sourceDescriptor: Ref<SourceDescriptor | null>`(openBook 时写入)
- state `currentRelPath: Ref<string>`(当前卷在 parent 的相对路径)
- action `flushProgress()`(force 立即写,不等 500ms debounce)
- `openBook(payload: OpenBookPayload)` 扩展 payload 加可选字段 `startPage?: number` + `startImageName?: string`。**关键**:跨卷是 reader 内部切换(reader 已挂载在 `/reader/:bookId`),**不走路由**,所以不能用 `?at=` query(那是 ReaderView 首次挂载解析的)。openBook 内部落 currentSpreadIndex 时优先用 imageName 定位所在 spread,找不到 fallback startPage,再 fallback 0。

### 7.3 三触发源接线(ReaderView.vue)

```ts
// ReaderView.vue
const crossVolume = useCrossVolume();

// 触发源 1: slideshow pendingNextVolume(已有 watch,改调 maybeContinue)
watch(() => slideshow.pendingNextVolume, (v) => {
  if (v) crossVolume.maybeContinue(false, 'next');
});

// 触发源 2: 手动末页 atLastSpread 翻转(新增 watch)
watch(() => reader.isAtLastSpread, (last, prev) => {
  if (last && !prev) crossVolume.maybeContinue(false, 'next');
});

// 触发源 3: 9 宫格 folder-next / Alt+→(inputBindings 已映射,回调改调)
// useReaderTouchZones 的 folder-next action + hotkey 的 Alt+→
//   → crossVolume.maybeContinue(true, 'next')
```

### 7.4 manual 胶囊确认

用户点胶囊"跳转"按钮 → `crossVolume.loadCrossVolume('next', { result: crossVolume.pendingCrossVolume.value })`(复用 armManualToast 已 find 的结果,不重 IPC)。
用户点"关闭"或往回翻(prev page) → `crossVolume.consumePending()`(清 pending,胶囊消失)。

---

## 8. 瀑布流跨卷

### 8.1 工具栏按钮

MasonryView 工具栏(或 FileBrowser toolbar,与"↶ 跳到上次"同区)加"下一卷"按钮:

```vue
<button class="tb-btn" :disabled="!hasImages || swapping" @click="crossNextVolume">
  <svg .../>  <!-- ICON_NEXT_VOLUME: ChevronRight 或 BookNext -->
  <span>{{ t('fileBrowser.nextVolume') }}</span>
</button>
```

### 8.2 加载流程

```ts
async function crossNextVolume(): Promise<void> {
  if (swapping.value) return;
  swapping.value = true;
  try {
    // 当前 scroll position 已由 useMasonryBrowsePosition 持续 debounce 写入(300ms),
    // 跳转前 force flush 一次确保不丢
    await masonryBrowsePosition.flushNow();   // 新增方法:立即触发 recordCurrentTop 不等 debounce

    const result = await findNextVolume(descriptor, currentRelPath, 'next', 'masonry');
    if (!result) { toast(t('reader.crossVolume.none')); return; }

    // 跳转:瀑布流跨卷在同源内(Local 目录 → Local 目录),不换 source descriptor。
    // result.descriptor 与当前同源(只 path 变)→ 只 navigate,不需要 setRoot。
    // navigate(rel_path) 切到下一卷目录;FileBrowser.fetch 自动 upsert browse_history。
    await fileBrowser.navigate(result.relPath);

    // MasonryView 重新 mount/useMasonryBrowsePosition.start() 自动 restoreAndScroll
    // → 查新目录 progress → 有则滚到 imageName 位置,无则顶部(智能恢复由现有机制提供)
    toast(t('reader.crossVolume.jumped', { title: result.title }));
  } catch (e) {
    toast(t('reader.crossVolume.failed'));
  } finally {
    swapping.value = false;
  }
}
```

**智能恢复已自动**:`useMasonryBrowsePosition.start()` → `restoreAndScroll()` → `getProgress` → `scrollToEntry(imageName)`(已有,§2 已就绪)。

### 8.3 filter='masonry' 不预验证 has_images

跳到下一个 `is_directory`(不查内容是否有图)。如果跳到无图目录,MasonryView 已有"无图自动回落 details + masonry 按钮 disabled"机制(CLAUDE.md §3.0.6),用户可再点"下一卷"跳过。避免 N 次 listDirectory 远程开销。

---

## 9. UI 组件

### 9.1 `ContinueNextVolumeToast.vue`(新建)

复用 `SlideshowToast.vue` 胶囊样式,改 `pointer-events-auto`(有可点击按钮):

```vue
<Teleport to="body">
  <div v-if="crossVolume.pendingCrossVolume.value"
       class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
              bg-surface/90 backdrop-blur-xl rounded-full
              px-3 py-1.5 flex items-center gap-2 text-sm text-white shadow-xl">
    <span>{{ t('reader.crossVolume.continuePrompt', { title: pending.title }) }}</span>
    <button @click="onJump" class="...">{{ t('reader.crossVolume.jump') }}</button>
    <button @click="onClose" class="...">✕</button>
  </div>
</Teleport>
```

挂在 ReaderView 内(与 SlideshowToast 同级)。

### 9.2 SlideshowToast.vue 扩展

auto 模式跨卷后显示"已跳转《XXX》"——复用现有 toast 机制,`crossVolume.jumped` 事件触发短暂提示。或直接用通用 toast(§9.3),不改 SlideshowToast。**选定**:用通用 toast(§9.3),SlideshowToast 不改(职责单一,只管 slideshow 播放/暂停)。

### 9.3 通用 toast

项目当前无通用 toast 组件。本次需要"无下一卷 / 已跳转 / 失败"3 类短暂提示。

**选项**:
- A. 复用 `SlideshowToast` 模式抽一个轻量 `useToast()` composable + `<ToastHost>`(本次新建,后续其他模块复用)
- B. 内联到 ContinueNextVolumeToast(只 reader 场景;瀑布流场景另写)

**选定 A**:抽 `composables/useToast.ts` + `components/common/ToastHost.vue`(Teleport to body + 队列 + 1500ms 自动隐藏)。本次跨卷用,后续复用。规模 ~60 行。

---

## 10. 边界处理

| 场景 | 行为 |
|---|---|
| 无下一卷(`findNextVolume` 返回 null) | toast `reader.crossVolume.none`("无下一卷")+ 清 pending flag |
| 跨卷加载失败(listDirectory/网络错误) | toast `reader.crossVolume.failed` + log;reader 保持当前卷不崩 |
| 跨卷中再触发 | `bookSwapInFlight` guard 阻断(手动/自动/slideshow 都守) |
| current 不在 siblings(目录被移走/重命名) | `findNextVolume` 返回 null → 走"无下一卷"分支 |
| 末卷(真无下一卷) | toast + 停(manual 不显示胶囊,因为 armManualToast 时就 return 了) |
| 跳到无图目录(瀑布流) | MasonryView 自动回落 details,用户可再点"下一卷" |
| Archive 包不支持(ZIP 外) | listDirectory 对 RAR/7z 返回 NotImplemented → 走"失败"分支 |

---

## 11. i18n keys(zh-CN + en-US 同步)

新增 `reader.crossVolume.*` namespace:

| key | zh-CN | en-US |
|---|---|---|
| `reader.crossVolume.none` | 无下一卷 | No next volume |
| `reader.crossVolume.jumped` | 已跳转《{title}》 | Jumped to 《{title}》 |
| `reader.crossVolume.failed` | 跳转失败 | Failed to jump |
| `reader.crossVolume.continuePrompt` | 继续读下一本《{title}》? | Continue to next volume 《{title}》? |
| `reader.crossVolume.jump` | 跳转 | Jump |
| `fileBrowser.nextVolume` | 下一卷 | Next volume |

6 个 key × 2 locale。同步加到 `src/locales/zh-CN.ts` + `en-US.ts`,`i18n-keys.test.ts` 守护对齐。

---

## 12. 测试计划(TDD)

### 12.1 Rust(`commands/find_next_volume.rs` 单测 + 纯函数)

**纯函数 `pick_sibling`**(不依赖 IO,先测):
- next/prev 取相邻
- current 在首/末(边界)
- current 不在 siblings(返回 None)
- filter='reader' 保留 dir+archive
- filter='masonry' 只保留 dir
- 空 siblings

**command 集成**(用 in-memory MediaSourceFactory 或 mock):
- Local 目录跨卷(parent listDirectory → next dir)
- Archive 归一化(当前是 Archive descriptor → origin parent)
- 越界返回 None

### 12.2 前端(Vitest + happy-dom)

**`useCrossVolume`**:
- `maybeContinue(force=true, next)`:不看模式,直接 loadCrossVolume
- `maybeContinue(force=false, off)`:return,不跨
- `maybeContinue(force=false, auto)`:loadCrossVolume
- `maybeContinue(force=false, manual)`:armManualToast(填充 pendingCrossVolume,不跨)
- `loadCrossVolume` null:result → toast none + consumePending
- `loadCrossVolume` 有 result → flush → findNextVolume → getProgress 智能恢复 → openBook(startPage)
- `loadCrossVolume` 已 finished → startPage=0
- `bookSwapInFlight` guard:加载中再触发 return

**`ContinueNextVolumeToast`**:
- pendingCrossVolume 有值 → 显示
- 点跳转 → loadCrossVolume + 隐藏
- 点关闭 → consumePending + 隐藏

**`useToast` + `ToastHost`**:
- push toast → 显示 + 1500ms 自动隐藏
- 队列(多个 toast 不覆盖,或后者替换——选定后者,简单)

**`findNextDirectory.ts`**:
- 已有用例 + 加 filter='masonry' + 混合序列

**reader store**:
- `flushProgress` force 立即写(不等 debounce)
- `openBook` 支持 startPage/startImageName

### 12.3 E2E 手测(验证清单)

- [ ] Local 目录跨卷:auto 模式末页 → 自动跳下一目录
- [ ] manual 模式末页 → 胶囊显示 → 点跳转 → 跳下一卷
- [ ] off 模式末页 → 不跳
- [ ] 9 宫格 folder-next / Alt+→ → 即时跨(不看模式)
- [ ] 智能恢复:跳到读过一半的卷 → 恢复 page
- [ ] 智能恢复:跳到已读完的卷 → 从第 1 页
- [ ] 无下一卷 → toast"无下一卷"
- [ ] 瀑布流"下一卷"按钮 → 跳下一目录瀑布流 + 恢复 scroll
- [ ] 幻灯片末页 → pendingNextVolume → 跨卷(对齐模式)
- [ ] 跨卷中再触发 → 不重复(bookSwapInFlight)

---

## 13. 有意差异 vs Android / DESIGN.md

| 点 | 桌面端 | Android / DESIGN.md |
|---|---|---|
| continue 模式 | `off/auto/manual` 3 态 | Android 含 SWIPE(桌面删,CLAUDE.md §6 拍板) |
| prev 方向 | 算法实现,UI 先不触发 | Android 双向触发 |
| 瀑布流跨卷 | 工具栏按钮(纯手动) | Android 无瀑布流视图 |
| 跳转目标过滤 | reader:dir+archive / masonry:只 dir | Android reader:dir+archive |
| 循环 | 不做 | Android 不做(对齐) |

---

## 14. 实现顺序(plan 提示)

1. Rust `find_next_volume` 替换 stub(纯函数 pick_sibling + command 接 factory)+ 单测
2. `NextVolumeResult` struct + `tauri.ts` findNextVolume 改返回类型 + filter 参数
3. `lib/findNextDirectory.ts` 校对 filter
4. `useToast` + `ToastHost` 通用 toast(跨卷用)
5. reader store 扩展(sourceDescriptor/currentRelPath/flushProgress/openBook startPage)
6. `useCrossVolume` composable + 单测
7. 三触发源接线(ReaderView watch atLastSpread + 改 slideshow watch + 9 宫格回调)
8. `ContinueNextVolumeToast` 组件 + 单测
9. 瀑布流工具栏按钮 + crossNextVolume + useMasonryBrowsePosition.flushNow
10. i18n 6 key × 2 locale
11. E2E 手测验证清单
12. type-check + 全测 + 本地 build
