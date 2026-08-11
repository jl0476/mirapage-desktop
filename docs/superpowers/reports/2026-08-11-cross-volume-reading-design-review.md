# 跨卷连续阅读设计与实施计划审查

> 日期：2026-08-11  
> 审查对象：
> - `docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md`
> - `docs/superpowers/plans/2026-08-11-cross-volume-reading.md`
> 结论：**方向合理，但当前版本不宜直接执行，需要先修订设计和计划。**

## 1. 总体评价

设计对用户语义的处理比较完整：

- 区分 `off / auto / manual` 三种连续阅读模式。
- 明确“到达末页”和“在末页再次向后翻”是两个事件，避免刚看到结尾便立即跨卷。
- 将幻灯片与手动翻页的跨卷意图汇聚到统一入口。
- 对无下一卷、加载失败、重复触发、进度恢复等边界作了说明。
- 实施计划按 TDD 拆分，覆盖 Rust、TypeScript、组件和 E2E。

但代码库验证显示，计划中的核心加载链路与现有 `ReaderView` 的真实状态所有权不一致，并且 Archive、composable 实例共享、瀑布流空目录等场景存在阻断性问题。若按当前计划实施，最可能出现的结果是：跨卷后 store 看似已切换，但界面仍显示旧卷；manual 胶囊不出现；本地图片 URL 无法加载；Archive 目标不可读。

## 2. 必须修改的问题

### P0-1：跨卷加载不能只调用 `reader.openBook`

当前设计让 `useCrossVolume.loadCrossVolume()` 枚举下一卷并直接调用 `reader.openBook()`。这与现有页面结构不兼容。

现有 `ReaderView` 同时持有以下卷级状态：

- `pageUrls`
- `imageNames`
- `book`
- 页面级 `status` / `errorMessage`
- 当前目录排序解析结果

模板传给 `ReaderScreen` 的是 `ReaderView.pageUrls`，而不是 `reader.pages`。因此 composable 只更新 reader store 后，`ReaderScreen` 仍会收到旧卷的 `pageUrls`；跳页总数、右键菜单总页数和卸载时的 `imageName` 也仍取旧数组。

计划中的 `pages = images.map(e => e.name)` 还只是文件名，不是现有 viewer 所需的 `convertFileSrc(...)` URL。本地目录跨卷也会加载失败。

#### 建议修改

将“加载一本书”的完整过程收敛为单一函数，例如：

```ts
async function loadBookByIdentity(identity: BookIdentity, start: StartPosition): Promise<void>
```

它必须统一完成：

1. 建立或取得 `bookId`。
2. 枚举目录。
3. 按该目录的 directory sort 设置排序。
4. 生成 `imageNames`。
5. 生成可渲染的 `pageUrls`。
6. 计算 spreads 与恢复位置。
7. 原子更新 `ReaderView` 与 reader store 的所有卷级状态。
8. 更新 `book` 和当前卷身份。

最小改法是把该函数留在 `ReaderView`，由 `useCrossVolume` 只负责“决策和寻找目标”，然后通过注入的 `loadTarget(result)` 回调加载。更彻底的改法是新建 `useReaderBookLoader`，由首次开卷和跨卷共同调用。

不建议让 `useCrossVolume` 自己复制一份 `ReaderView.loadBook()`，否则排序、URL 构造、错误处理和恢复语义会产生两套实现。

### P0-2：`useCrossVolume()` 的局部 ref 无法被两个组件共享

计划中：

- `ReaderView` 调用一次 `useCrossVolume()`，watch 后写入该实例的 `pendingCrossVolume`。
- `ContinueNextVolumeToast.vue` 又独立调用一次 `useCrossVolume()`。

普通 composable 每次调用都会创建新的 `ref`。因此 toast 组件观察的是另一份 `pendingCrossVolume`，manual 模式下胶囊不会出现；toast 内的 `bookSwapInFlight` 也不是 ReaderView 那份守卫。

#### 建议修改

任选一种明确方案：

1. **推荐：ReaderView 单实例所有权。**
   - `ReaderView` 唯一调用 `useCrossVolume()`。
   - `ContinueNextVolumeToast` 接收 `pending`、`loading` props。
   - 组件通过 `jump`、`close` emits 通知 ReaderView。

2. 将跨卷状态提升为 Pinia store。

3. 使用显式 provide/inject，并在缺少 provider 时失败，而不是静默创建新实例。

对当前规模而言，方案 1 最简单，也最容易测试。

### P0-3：设计声称支持 Archive，但现有 reader 链路只支持 Local

设计将 reader filter 定义为“目录或压缩包”，并构造 Archive descriptor。现有 `ReaderView.loadBook()` 却显式拒绝所有非 Local descriptor；页面 URL 也使用 `convertFileSrc` 读取真实文件路径，无法直接渲染压缩包内条目。

此外，计划中的 Archive 构造是“简化版”：

- 从 `archivePath` 直接推 parent。
- `origin` / `originEntryPath` / `archiveRelPath` 没有按现有 descriptor 契约完整归一化。
- 远程源中的压缩包不能仅通过拼路径交给本地 `ArchiveMediaSource`。
- RAR/7z 当前仍为 `NotImplemented`。

这与规格中的“完整实现：reader dir + archive”不一致。

#### 建议修改

本阶段二选一：

1. **推荐：将 v3.0.9 范围收窄为目录卷。**
   - `reader` 与 `masonry` 都只选择 `isDirectory`。
   - Archive 跨卷另立后续规格，等 archive 页面资源 URL/IPC 渲染链路完成。
   - 文档明确 Local 为已验证目标；WebDAV/SMB 依各自 reader 支持状态再开放。

2. 保留 Archive，但必须把“Archive book loader + 可渲染页面 URL/协议 + origin 归一化 + 进度 identity”纳入本次范围。这会显著扩大任务，不再是当前计划描述的最小实现。

### P0-4：跨卷后路由身份和页面身份会分裂

规格选择“不走路由”，但页面仍挂载在 `/reader/:bookId`。跨卷后 reader store 的 `bookId` 变成新卷，URL 和 `route.params.bookId` 仍是旧卷。

直接后果包括：

- 刷新页面重新打开旧卷。
- 复制链接得到旧卷。
- 页面中仍依赖 `book` 或 route bookId 的喜欢、书签、收藏等操作可能作用于旧卷。
- route query `at` 仍保留旧的显式起始图片语义。

#### 建议修改

跨卷成功后执行：

```ts
await router.replace({
  name: 'reader',
  params: { bookId: targetBookId },
  query: {},
});
```

同时必须避免 route watch 再重复加载。可以选择：

- 让 route 成为唯一真值：replace 后由 route watch 调统一 loader；或
- loader 先完成，再 `replace`，并用已加载 bookId 去重。

推荐第一种，首次打开、跨卷、刷新都走同一条加载路径。

### P1-1：`flushProgress()` 不能只 flush 已存在的 `pendingEmit`

当前 reader 只有在实际翻页时才建立 `pendingEmit`。如果用户打开一卷后没有翻页，或上一次 debounce 已经落盘，跨卷前调用“flush pending”可能什么也不做。

跨卷需要的是“保存当前快照”，不只是“提前执行已有 debounce”。

#### 建议修改

把 API 定义为：

```ts
async function saveCurrentProgressNow(): Promise<void>
```

它应根据 reader 当前状态即时构造 `PageChangeInfo`，写入当前 `bookId/page/imageName/finished`，并返回实际的 Promise。测试需覆盖：

- 有 pending debounce。
- 无 pending debounce。
- 首页未翻页。
- 末页保存 `finished=true`。
- 写失败时跨卷策略（阻断还是记录日志后继续）是明确的。

### P1-2：manual 查找目标缺少并发守卫和陈旧结果校验

`bookSwapInFlight` 只守 `loadCrossVolume`，没有守 `armManualToast`。在远程源延迟较高时，用户可重复触发多个 find；若期间当前卷发生变化，旧请求返回后仍可能把旧卷的下一卷写进 pending。

#### 建议修改

- 增加统一的 `requestSeq` 或 `sourceIdentityAtStart`。
- `armManual` 与 `load` 都受同一状态机保护。
- 结果落地前比较当前 descriptor、path、bookId 是否仍与请求开始时一致。
- manual 胶囊确认时再次验证 pending 的 source identity；目录可能已被移动或删除时允许重新 find。

### P1-3：瀑布流跳入无图目录后无法继续跳过

规格称：跳到无图目录后自动回落 details，用户可再点“下一卷”跳过。但计划把按钮限定为 `viewMode === 'masonry'`。自动回落 details 后按钮立即消失，用户无法按文档所说继续跳过。

#### 建议修改

任选一种：

- “下一卷”按钮在图片目录浏览场景始终可见，不与当前 viewMode 绑定。
- Rust `find_next_volume` 为 masonry 寻找“下一个含图片的目录”；可以增加有限并发/逐个探测和取消机制。
- 不自动回落 details，但这会与现有行为冲突，不推荐。

若继续采用“不预验证图片”的性能决策，第一种最小且语义一致。

### P1-4：FileBrowser 跨卷必须使用稳定的已展示路径

代码库已明确区分：

- `currentPath`：导航目标，fetch 可能仍在进行。
- `lastFetchedPath`：当前屏幕上 entries 的真实来源。

计划调用 `findNextVolume(..., fb.currentPath, ...)`，会重新引入此前已修过的导航竞态。用户看到的仍是 A 目录，但 `currentPath` 已变为 B 时，下一卷计算会基于 B。

#### 建议修改

瀑布流按钮使用 `fb.lastFetchedPath`，并在结果落地前确认：

```ts
fb.lastFetchedPath === pathAtRequestStart
```

跨卷过程中应禁用会改变目录身份的操作，或使用序列号丢弃陈旧返回。

### P1-5：测试计划中的部分测试不会验证真实行为

当前计划存在以下测试缺口：

- `ContinueNextVolumeToast` 测试写着“补全 mount 用例”，没有定义状态如何注入，恰好掩盖了双 composable 实例问题。
- toast 测试创建了 `useToastSpy()`，但没有注入实现，断言不会观察真实 toast 调用。
- `bookSwapInFlight` 测试创建永不 resolve 的 Promise，可能留下悬挂异步任务。
- Rust `pick_sibling` 只返回索引，若过滤后再排序，必须明确索引属于过滤数组还是原数组；测试应锁住这一点。
- TS `findNextDirectory` 增加一个完全不参与逻辑的 `filter` 参数，只是“记录意图”，没有行为价值，测试也无法证明 Rust/TS 语义一致。

#### 建议修改

- Toast 组件改为 props/emits 后，组件测试直接验证渲染和 emit。
- `useCrossVolume` 注入依赖或 mock 真正的 `useToast` 模块。
- 用 deferred promise 并在测试末尾 resolve/reject，确保无悬挂任务。
- `pick_sibling` 直接返回目标 entry 或目标名称，避免过滤数组索引歧义。
- 删除 TS 函数的虚假 `filter` 参数；若要双实现一致，应将 TS 输入也升级为带 `isDirectory/isArchive` 的条目数组并真正过滤。

## 3. 推荐的修订架构

建议把职责拆成三层：

```text
跨卷意图
  ├─ 末页再次 next（受 off/auto/manual 控制）
  ├─ slideshow 末页（受 off/auto/manual 控制）
  └─ 显式 folder-next（强制）
          ↓
CrossVolumeController
  ├─ 状态机：idle / resolving / awaiting-confirmation / loading
  ├─ resolveNext(currentIdentity)
  ├─ 陈旧请求与重复触发保护
  └─ 输出目标 BookIdentity
          ↓
统一 Book Loader
  ├─ ensure bookId
  ├─ list + sort + imageNames
  ├─ page URLs
  ├─ spreads + progress restore
  ├─ route.replace(targetBookId)
  └─ 原子提交页面与 store 状态
```

其中：

- `CrossVolumeController` 不负责构造图片 URL，也不复制加载书籍逻辑。
- `Book Loader` 同时服务首次进入 reader 和跨卷。
- manual toast 只是 controller 状态的无状态视图，通过 props/emits 交互。
- 本阶段建议只支持目录卷；Archive 在资源渲染链路完成后接入同一 loader。

## 4. 建议调整后的实施顺序

### 第一阶段：先修规格

1. 明确本版本支持矩阵：Local directory 必须支持；Archive 暂缓或扩展完整加载范围。
2. 明确 route/bookId 是当前卷身份的一部分，跨卷后必须同步。
3. 定义 `BookIdentity`、`NextVolumeTarget`、`StartPosition` 三个契约。
4. 定义统一加载器的状态所有权和原子提交边界。
5. 定义跨卷状态机及陈旧请求策略。

### 第二阶段：抽取统一 loader（先于 find-next UI）

1. 为当前 `ReaderView.loadBook()` 写表征测试。
2. 抽取可复用 loader，首次开卷行为保持不变。
3. 覆盖排序、URL、imageName 恢复、finished 回首页、route identity。

### 第三阶段：实现 Rust next-volume 算法

1. 以强类型 `SourceDescriptor` 作为参数，不在 command 内反复操作 `serde_json::Value`。
2. 纯函数返回目标 entry/名称，不返回容易混淆的过滤后索引。
3. 校验 direction/filter 的非法值并返回明确错误，不要静默 fallback。
4. 当前阶段若只支持目录，过滤逻辑只保留 directory。
5. command 集成测试至少覆盖 Local root、嵌套目录、Windows/POSIX 分隔符和 current 不存在。

### 第四阶段：实现 controller 与 reader 接线

1. 先测状态机：off/auto/manual/force、重复触发、陈旧返回、无目标、失败。
2. ReaderView 唯一持有 controller 实例。
3. toast 使用 props/emits。
4. 末页 next callback 在 onUnmounted 时清除，避免 Pinia store 持有旧组件闭包。
5. prevPage、成功跳转、关闭操作均明确消费 pending 状态。

### 第五阶段：瀑布流接线

1. 添加真正的 `saveCurrentBrowsePositionNow()`。
2. 使用 `lastFetchedPath` 作为当前目录身份。
3. 按钮在自动回落 details 后仍可用，或改变目标过滤策略。
4. 加导航竞态测试。

### 第六阶段：集成验证

除原计划的用例外，增加：

- 跨卷后画面、标题、总页数、imageName、bookId 和 URL 全部属于新卷。
- 跨卷后刷新仍打开新卷。
- 跨卷后收藏/喜欢/书签作用于新卷。
- manual 胶囊能显示，关闭后不会由旧请求重新出现。
- 连续快速触发只加载一次。
- 从 A 发起 find、切到 B、A 请求晚返回时结果被丢弃。
- 瀑布流从有图目录跳到无图目录后仍可继续下一卷。
- 首页未翻页直接强制下一卷时，当前进度仍被保存。

## 5. 两份文档的具体修改清单

### 设计规格需要修改

- §1.1/§1.2：收窄或补全 Archive 支持范围。
- §4：把 `loadCrossVolume → reader.openBook` 改为 `resolve target → unified book loader`。
- §5：使用强类型 descriptor；删去 Archive 简化归一化，或把 Archive 延后。
- §6：删掉无行为的 TS `filter` 参数，或升级输入类型并实现真实过滤。
- §7.1：controller 不直接 list/sort/openBook；加入状态机和 request identity。
- §7.2：将 `flushProgress` 改为“保存当前快照”；明确 callback 清理。
- §7.3：加入 route identity 同步策略。
- §7.4：toast 改为 props/emits，明确单实例状态所有权。
- §8：使用 `lastFetchedPath`；修复无图目录后按钮消失的矛盾。
- §10：新增陈旧响应、路由刷新、组件卸载、加载部分成功后的回滚边界。
- §12：新增统一 loader 与竞态测试。

### 实施计划需要修改

- 在现有任务 1 前增加“表征并抽取统一 book loader”。
- 重写任务 2 的 Archive 伪代码，不保留 `archive_origin_root` 未使用的简化实现。
- 删除或重写任务 4 的虚假 filter 校对。
- 任务 6 的 `flushProgress` 必须返回 Promise 并主动生成当前快照。
- 任务 7 不再复制 list/sort/spread/URL 逻辑，改为调用 loader。
- 任务 8 改用 props/emits，不在组件内再次调用 `useCrossVolume()`。
- 任务 9 增加 callback/watch 清理及 route 更新测试。
- 任务 10 使用 `lastFetchedPath`，并解决 details 回落后的按钮可达性。
- 任务 12 不应预先接受“现有 2 个 Rust 测试失败”；完成声明应要求相关基线明确且本次新增测试全绿。若基线确有已知失败，应单独记录精确测试名、失败原因和与本功能无关的证据。
- tag/push 不应写进默认实施任务；应在全部验证完成后由分支收尾流程决定。

## 6. 最终结论

这份设计的产品行为可以保留，尤其是“末页再次 next 才产生跨卷意图”和三模式决策。但技术方案需要先围绕“统一 book loader”和“单一状态所有权”重构文档。

建议在修改完上述 P0 项后再进入编码。最低可行版本应聚焦：

- Local 目录卷。
- reader 的 off/auto/manual + 显式下一卷。
- route/bookId 同步。
- 首次加载与跨卷共用同一 loader。
- manual toast 单实例。
- 瀑布流使用稳定路径并保持下一卷按钮可达。

完成这些后，再扩展 Archive 和远程源会稳妥得多。
