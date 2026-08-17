# module3.1.0 竖条漫（Webtoon）阅读模式设计

> 2026-08-17 brainstorming 定稿。来源：用户拍板「全做」（M1-M6 全量 + 自由缩放 + 自动滚动）；缩放交互用户选定「Ctrl+滚轮+双击」；自动滚动/宽屏/模式记忆等其余决策点为推荐默认值（用户跳过确认，规格审查时可改）。
> 前置评估：2026-08-16 会话（原生滚动容器 + 虚拟化 + 四件复用积木结论）。
> **2026-08-17 实施前审查修订**（P0×2 / P1×6 / P2 若干，全部闭环）：slideshow 接线 mode-aware（P0-1）、进度双写防护（P0-2）、输入映射改 hotkeys override + webtoon 专用绑定表（P1-1，Space 冲突修正）、恢复链走 snapshot 透出（P1-2）、ReaderOverlay 三态 + 页码 override（P1-3）、Settings 扩既有下拉（P1-6）、缩放/虚拟化两处决定回写本 spec（原 plan 偏差声明取消）。
> **2026-08-17 二轮修订**（P0×2 / P1×6 / P2×2 全闭环）：expose 契约改 getter（defineExpose 自动解包 ref，P0-1）+ 父级 ref 绑定；ReaderContextMenu 纳入（P0-2）；三设置加载映射（P1-3）；恢复链改 `restoreImageIndex` 图索引（P1-4，spread 索引误用）；常规滚动 measured-batch 锚定（P1-5）；尺寸请求 epoch 防陈旧响应（P1-6）；flushNow Promise 化 + onScopeDispose（P1-7）；到底检测 rAF 立即触发（P1-8，interval 不影响结束延迟）；缩放锚点先 zoom 后恢复 + 横向（P2-9）；topVisibleIndex 二分 + gap 固定 px 语义（P2-10）。
> **2026-08-17 三轮修订**（P0×2 / P1×5 / P2×2 全闭环）：loader progress 提升到分支外作用域（P0-1，否则编译失败）；scope dispose 只清 timer、pending 留给 onUnmounted flushNow（P0-2，scope.stop 先于 onUnmounted）；自动滚动到底顺序定为 停止→稳定 1.2s→finished→跨卷（P1-3，finishNow 兜底）；重置缩放补全状态链 zoom-change→webtoonZoom→MainMenu（P1-4）；连续缩放竞态防护（P1-5，四轮修正为共用锚点捕获方案）；无效控件补 Overlay interval/direction + MainMenu slideshow direction（P1-6）；descriptor 三层判空链（P1-7）；模式切换风险文案改写（P2-8）；expose 签名/测试文案/NaN 兜底/测试 flush 四处漂移（P2-9）。
> **2026-08-17 五轮修订**（复审 P0×2 / P1×4 / P2×1 + 四轮自查 7 条，全闭环）：自动结束改 autoEnd 状态机（timer/seq/bookId/atBottom 四重校验 + 五取消点——等待期滚回上方/换卷/切模式不再误跨卷误标完，P0-1）；标完改 `ensureFinished`（成功才置位、失败可重试、in-flight 去重，自动跨卷 await 成功才发 pending，P0-2）；手动越底与自动结束同流程（Alt+→ force 明确不标完，P1-3）；zoom-change 挂载重发（P1-4）；Overlay 测试入命令与提交清单（P1-5）；摘要/实现名统一 + 冒烟清单补取消路径三子项（P2-6）；四轮自查——overlay ◀▶/跳页按钮分流（store 直调第三入口）、doJumpToPage/addBookmark 分流、anchoredScroll unused import（noUnusedLocals 编译错）、锚定恢复与校正互斥、opts 冗余字段清理。

## 0. 目标

新增第三种阅读模式 `webtoon`：全卷图片按原始宽高比竖向无缝拼接、整体连续滚动——条漫的标准阅读体验。进度、跨卷、UI chrome 全部复用现有体系，零 Rust 改动、零 DB 迁移。

## 1. 模式模型

- **扩既有模式链路，不另立状态**：settings store 既有 `ReaderMode = 'single' | 'double'`（`readerDefaultMode` ref / `reader_default_mode` key / `cycleReaderMode()`）扩展为 `'single' | 'double' | 'webtoon'`——类型单一真值源移至 `src/lib/readerSettings.ts`（`ReadMode` + `normalizeReadMode`，非法值 fallback single），settings.ts re-export 保兼容；`cycleReaderMode` 改三态循环。**不新增 store 级 setReaderMode**（审查 P1-6：Settings.vue:86 本地 setter 已存在且持久化，任务 7 只扩它的 options/断言）。
- **全局设置，即"进入阅读器默认加载视图"**：`reader_default_mode` 既是运行时 cycle 的当前值，也是新开书时的默认视图——用户在 Settings 选定 single / double / webtoon 后，任意入口（History / Likes / 文件浏览器双击图片 / shortcut）进阅读器都按此模式加载（single/double 走现有 spread planner，webtoon 走原生滚动）。不按书记忆（与 single/double 现状一致；YAGNI）。
- 切换入口：ReaderMainMenu「切换模式」三态循环（复用 cycle-mode emit）+ Settings 阅读器 section **既有下拉**扩第三项（非新增控件）。
- RTL/LTR 在 webtoon 下不适用：Settings 与菜单中该选项仅 single/double 生效（webtoon 选中时禁用）。

## 2. WebtoonViewer 组件

新增 `src/components/reader/WebtoonViewer.vue` + `src/composables/useWebtoonDimensions.ts`。

### 2.1 布局

- 外层：`overflow: auto`（纵横双向）滚动容器，占满阅读区。
- 内层 strip：`width: min(100%, max-width 设置值)` 居中（`webtoon_max_width` px，0=不限宽，默认 0）；每张图 `width: 100%; height: 按宽高比计算` 竖向排列；`webtoon_gap` px（默认 0，范围 0-24，**固定 px 不随 zoom 缩放**——二轮 P2-10 语义定死）。
- 图片元素：`<img>` + `decoding="async"`；窗口内才挂载（见 2.3），不用 `loading="lazy"` 属性（虚拟窗口本身就是懒加载）。

### 2.2 尺寸骨架（useWebtoonDimensions）

- 复用 `listImageDimensions` IPC（3.0.6 图头解析：JPEG/PNG/GIF/BMP），按「首屏可见 + 2 屏预读」渐进测量（对齐瀑布流像素窗口思路）；`measuredMap: Map<name, {width,height}>`。
- **IPC 路径语义**：请求前拼书的 root 相对路径前缀（`PathUtils.join(relPath, name)`，relPath 来自 reader store `currentRelPath`（openBook payload，根书为 `''`）；IPC 需要 source-relative 完整路径，裸名在子目录书会全部 miss 退化为估算；响应用 fullPath→name 反查表回填。
- **换书/跨卷清空 + epoch 失效**：watch relPath/descriptor 变化时 epoch 自增、清空 `requested` 与 `measuredMap`；**在途 IPC 响应携带旧 epoch，回来时丢弃**（二轮 P1-6）——否则旧卷响应晚到会污染新卷 measuredMap（两卷同名 `001.jpg` 且反查表已清时按 full path 键写入旧尺寸）。跨卷同名图不复用前一卷尺寸。
- 未测量图：估算宽高比 3:4 占位（WebP/AVIF 等无图头解析的格式走此 fallback）；实测到达后校正总高度（滚动锚定补偿见 2.4）。
- 与瀑布流 `useMasonryLayout` 的差异：单列、无列分配、无卡片间距逻辑——**不共享 masonry composable**，只共享 IPC 与估算/校正模式（薄实现，避免反向耦合）。

### 2.3 虚拟化（审查修订：自建，非复用 useVirtualList）

**~50 行单列专用窗口计算**（`src/lib/webtoonLayout.ts` 纯函数：heights 前缀和 + 二分窗口）。理由：`useVirtualList` 面向 MediaEntry 列表/定行高抽象，webtoon 只有「名字数组 + measuredMap」两个输入，套适配层反而绕；单列 tops 单调递增，二分窗口比通用变高实现更简单。（注：masonry 本身**在用** useVirtualList，本决定与 masonry 无关。）

- 像素窗口 = 视口 ±2.5 屏；窗口外条目 `v-if` 卸载（释放解码内存，非 display:none）。
- `visibleRange` 以累计高度（totalHeight + 每条 top/height）计算。

### 2.4 滚动锚定与恢复

- **常规滚动锚定**（二轮 P1-5）：每个 measured batch 应用前捕获视口锚点（顶部可见图 + 图内偏移比），应用后按新 layout 恢复 scrollTop——用户滚到中部后上方图片尺寸陆续返回时视口不跳动（对齐瀑布流 resize 锚定思路，纯函数 `captureAnchor`/`restoreAnchor` 可测）。
- `scrollToImage(name)`：立即跳估算位 → watch `measuredMap` 校正（最多 5 次 / **真 3s setTimeout 收口**——measuredMap 不再变也必然复位）；跳转进行中（组件级唯一校正器 `activeCorrection`，新跳转先取消旧跳转——连续 A→B 只跟随 B）常规锚定跳过且弃置锚点。
- `getTopVisibleImage(): string | null`：首个与视口相交条目（单列简化 = 首个底边超过 scrollTop 的条目，二分实现）。

### 2.5 Expose 契约（二轮 P0-1：全 getter，不暴露 ref）

Vue `defineExpose` 经 `proxyRefs` 代理，暴露的 ref 在父级访问时**自动解包**——`xxx.value` 取不到，故全部用普通 getter（项目先例：SinglePageViewer 的 `getViewer()`）：

```ts
defineExpose<{
  scrollToImage(name: string): void;
  getTopVisibleImage(): string | null;
  isAtBottom(): boolean;               // getter（非 ref；scrollTop 参与判定，防 3.0.13 atBottom stale）
  setZoom(z: number, anchorX?: number, anchorY?: number): void;  // 1.0-4.0 clamp；同 tick 连续缩放共用一次锚点捕获（pendingZoomAnchor），nextTick 按最终 zoom 一次换算
  getZoom(): number;
  autoScrollStep(dt: number, speed: number, factor: number): void;  // 三参（rAF 驱动方传 speed/factor）
  getScrollEl(): HTMLElement | null;   // ReaderView scrollScreen（键盘滚屏）用
}>()
```

父级必须在 `<ReaderScreen>` 上显式 `ref="webtoonScreenRef"`（模板接线遗漏则全链路 null）。缩放状态回传走 **`zoom-change` emit**（setZoom 成功后派发 + **onMounted 挂载即重发当前值**——跨卷重挂载归 1 时菜单禁用态同步，五轮 P1-4）——「重置缩放」按钮的可用态链：viewer emit → ReaderView `webtoonZoom` ref → ReaderMainMenu `:webtoon-zoom` prop（三轮 P1-4）。

## 3. 自由缩放（用户拍板：Ctrl+滚轮 + 双击；审查修订：显式宽度缩放）

- `zoom` 状态 1.0-4.0（step 10%），**显式宽度缩放**实现：strip 宽 = 基准宽 × zoom（基准宽 = min(容器宽, maxWidth)），img `width:100%` 高度按宽高比自然跟随——布局尺寸随缩放真实变化，滚动区域自动正确；走标准 CSS，规避非标准 CSS `zoom` 属性在 happy-dom/未来引擎的兼容风险。锚点数学不变。
- Ctrl+滚轮：viewer 容器 `wheel`（passive:false + 仅 Ctrl 分支 preventDefault），以鼠标位置为锚（缩放前后保持鼠标下内容点：`scrollTop' = (scrollTop + clientY) × k − clientY`，`scrollLeft' = (scrollLeft + clientX) × k − clientX`，k=新值/旧值）。
- **应用顺序**（二轮 P2-9）：先记录锚点目标坐标 → 更新 zoom（响应式）→ **nextTick DOM 布局完成后**同时恢复 `scrollTop` 与 `scrollLeft`——顺序反了会被旧 scrollHeight 预先钳位，且横向锚点不可漏。
- 双击：1.0 ↔ 上次非 1 缩放值（放大态双击复位 1.0）。
- zoom=1 滚轮 = 纵向滚动（原生，viewer 不接管）；zoom>1 内容宽于视口时原生横向滚动。
- 双击缩放仅在 webtoon 模式（single/double 的 OSD 双击行为不变）。

## 4. 自动滚动（幻灯片等价物）

- 新设置 `webtoon_scroll_speed`（px/s，默认 60，范围 10-300，Settings 滑杆）。
- 复用 slideshow store：webtoon 模式下「播放/暂停」语义切到自动滚动。实现分两层：
  - **ReaderView rAF 循环**（webtoon + isPlaying 时）调 `viewer.autoScrollStep(dt, speed, factor)`（内部 `scrollTop += speed × dt × factor`）。**到底检测在此层触发**（二轮 P1-8），顺序为 **停止 → 稳定 1.2s → `ensureFinished()` 落库成功 → 跨卷**（三轮 P1-3 + 五轮 P0-1/P0-2）：到底帧先 `slideshow.pause()`；挂可取消的 autoEnd 定时器（`autoEndTimer + autoEndSeq + capturedBookId`），**fire 前后四重校验**（仍在 webtoon / seq 未变 / bookId 未变 / 仍 atBottom），任一不过即丢弃；`await ensureFinished()` **成功才**发起 `pendingNextVolume`（置 `pendingNextVolumeFromSlideshow = true`，A7 捕获"发起时在播"）→ 现有 watch → maybeContinue，**标完失败不跨**（log 留痕，用户可 Alt+→ force）。取消点：滚离底部 / 换书跨卷 / 切模式 / 手动跨卷 / 卸载。**不等 interval tick**——intervalMs 必须对结束延迟也无影响。
  - **ReaderScreen slideshow 接线 mode-aware**（一轮 P0-1，**纯防御层**）：现有 onMounted 接线（`setAdvance(() => store.nextPage())` / `setIsAtLast(() => store.isAtLastSpread)`）在 webtoon 下改造——advance/prev 回调内按 `props.mode === 'webtoon'` 短路为 no-op（否则 store 的 spread index 被 interval 不可见推进，`isAtLastSpread` 触发时机与滚动位置无关的错误跨卷）；**`setIsAtLast` 在 webtoon 下恒返回 false**（十轮 P1-2：原返回 `webtoonAtBottom()` 有竞态——interval 可能在 rAF pause 前先 tick → atLast 分支直接 pause + pendingNextVolume，绕过稳定窗口和 ensureFinished。恒 false 让 interval tick 在 webtoon 下完全不参与结束/跨卷，rAF autoEnd 独占）。rAF 立即路径生效后 tick 兜底路径实际不会再命中（pause 已清 interval），保留作为防御层。
- 播放中滚轮：临时 `factor` 偏移（每格 deltaY ±20%，clamp 0-3×），2s 无滚轮操作回落 1×。
- 幻灯片 intervalMs 设置在 webtoon 模式下不生效（速度快慢由 scroll_speed 承担）；Settings 中该项在 webtoon 选中时禁用。

## 5. 进度与跨卷（全套复用 + 双写防护）

- **记录**：ReaderView 对 webtoon 走 300ms debounce 记 `getTopVisibleImage()` → `saveProgress(bookId, page, 'webtoon', undefined, image_name)`（现有签名 `(bookId, page, readerMode, finished?, imageName?)`——readerMode 类型扩 `'webtoon'`，Rust 端 String 直存无迁移；**`ProgressItem.readerMode` 返回类型同步扩**，审查 P2-2；finished=undefined 不动完成态）。同图去重；reader 侧新薄 composable `useWebtoonProgress`，不共享 masonry 实现。
- **换书自动重置**：composable watch `bookId` 变化自动 reset（`lastImage` 与 `finishedMarked`）——跨卷同名首图不被去重吞掉、新卷滚到底仍可标 finished；不依赖调用方手动 reset。
- **双写防护**（一轮 P0-2）：reader store 旧链路（`saveCurrentProgressNow` 硬编码 `'single'`、page/imageName 取过期 spread 位置）在 webtoon 下**必须旁路**——① ReaderView onUnmounted 的 `reader.saveCurrentProgressNow()` 兜底在 webtoon 时改为 `useWebtoonProgress.flushNow()` 并跳过 store 版本；② useCrossVolume 注入的 `saveCurrentProgressNow`（跨卷 trySave）同样 mode-aware 分流。否则卸载/跨卷会用过期位置覆盖 image_name，下次恢复跳错图。`flushNow(): Promise<void>` **始终 await 串行写链尾**（八轮 P1-1：即使 pending 已空，debounce 到期的写入可能仍在途——不 await 就返回会让跨卷 trySave 拿不到失败结果，且旧位置 A 迟到可能覆盖新位置 B）；内部维护 `writeTail` Promise 链，debounce 与 flushNow 触发的写入都挂链尾串行。await 写入完成（二轮 P1-7：跨卷 trySave 的 await 契约、保存失败可进既有错误处理）；标完统一走 `ensureFinished(): Promise<boolean>`（五轮 P0-2 + 六轮 P1-2）：幂等 + in-flight 去重（**按发起时 bookId 绑定，仅同卷共享**——旧卷在途时切新卷不复用旧 promise）+ **成功才置 finishedMarked**（写库失败保持可重试）+ await 后 bookId 核对（防旧卷 promise 污染新卷）——自动结束与手动越底跨卷都必须 await **true** 后才发起（失败不跨，手动 force 例外见 §6）。资源清理用 `onScopeDispose` **只清 timer、保留 pending**——Vue 卸载顺序 scope.stop() 先于 onUnmounted，若 dispose 抢先清 pending，ReaderView onUnmounted 的 flushNow 会变 no-op 丢最后 300ms 位置（三轮 P0-2）。切出 webtoon 模式时 ReaderView 显式置 atBottom=false（viewer 卸载后该 ref 冻结，不清会迟到误标，六轮 P1-3）。**模式切换写屏障**（十轮 P1-1）：同会话切换模式时，single/double 的 500ms debounce writer 与 webtoon 的 300ms writer 会反序覆盖（共享 imageName 还污染瀑布流"跳到上次"）——三个阅读器内切换入口（ReaderScreen / MainMenu / ContextMenu）统一收口 `switchReaderMode()`：切换前 await 旧模式 pending 写入（paged→webtoon 走 `reader.saveCurrentProgressNow()`，webtoon→paged 走 `webtoonProgress.flushNow()`），完成后才 `cycleReaderMode()`；Settings 下拉不经此屏障（阅读器未挂载无 pending）。
- **恢复**：`?at=` query 优先 → `progress.imageName` → `progress.page` → 0；**数据来源 = loader snapshot 新增 `restoreImageIndex: number`（图索引）**（二轮 P1-4：`initialSpreadIndex` 是 spread 索引且 webtoon 下 loader 仍按双页 plan spreads，直接当图索引用会错位——如 page 10 恢复到第 5 张；loader 内完成 explicit→imageName→page→0 全链解析，finished→0）。**finished 书恢复到第 0 张**（对齐 resolveInitialSpreadIndex 的 finished→0 语义，一轮 P2-6），目标图经 `scrollToImage` 渐进到位。
- **读完**：`atBottom` 持续 1.2s（STABLE_MS，对齐瀑布流）→ `markFinished`；底部再向下滚动/按键触发 `maybeContinue`（与翻页模型的「末页再翻」等价）。
- **阅读记录**：`loadRouteBook` 统一 `recordHistory` 已覆盖（3.0.13），零改动。

## 6. 输入映射（per-mode 分派；审查 P1-1 修订）

现状核查：`defaultKeyBindings` 只绑 `ArrowRight/PageDown`（next）、`ArrowLeft/PageUp`（prev）、`Home/End`；**Space 已绑 `slideshowToggle`**（`inputBindings.ts:64`）——原稿「Space = 上滚一屏」与它冲突，修订为保留 Space = 播放/暂停自动滚动（语义正好）。

- **机制**：`inputBindings.ts` 新增 `webtoonKeyBindings`（基于 default 覆写 prev/next 两组）；`useReaderHotkeys` 的 `ReaderHotkeyActions` 扩可选 `isWebtoon(): boolean` + `nextPage/prevPage/jumpFirst/jumpLast` 四个 override 回调——onKeydown 按 `isWebtoon()` 选绑定表，dispatch 前优先查 override（对齐既有 `folderNext → actions.nextVolume` 注入模式）。single/double 不传 override，行为零变化。
- **webtoon 键位**（`webtoonKeyBindings`）：`↑/PageUp` = 上滚一屏（90% 视口高）、`↓/PageDown` = 下滚一屏、`←/→` 不绑定（zoom>1 时留给原生横向滚动）、`Home/End` = 顶/底、`Space/p/F5` = 播放/暂停（原样）、`Escape/m/Alt+→/Alt+←` 现状不变（Alt 跨卷为全局 force 绑定，webtoon 照常生效）。
- **滚轮**：`useReaderWheel` 既有 `disabled?: Ref<boolean>` 选项传 `computed(() => isWebtoon)`——webtoon 不接管滚轮（原生滚动；Ctrl 缩放由 viewer 自身处理）。不新增 API（审查 P2-1）。
- **底部触发跨卷**（翻页模型「末页再翻」的等价物）：viewer 容器挂 passive `wheel` 监听（不 preventDefault，不影响原生滚动）——`deltaY > 0 && atBottom` 时 emit `scroll-past-bottom`，800ms 节流；ReaderView 消费后走 `requestCrossVolumeNext`（**五轮 P1-3 + 六轮 P1-1：从底部发起时先 `await ensureFinished()` 且返回 true 才 `maybeContinue(false, 'next')`**——失败不跨；与自动结束同流程，防快速越底在 stable 窗口内跨卷致旧卷永不标完；走 continue_to_next_volume 档位：auto 直跳 / manual toast 确认 / off 忽略）。`↓/PageDown` 按键在 atBottom 时同样触发（共用节流）。**Alt+→ force 不经此链**——force 可从卷中任意位置发起，不 ensureFinished（中途跳不该标完），保持现状直接 `maybeContinue(true, 'next')`。

## 7. 接入与 UI

- `ReaderScreen.vue`：`props.mode` 加 `'webtoon'` 分支挂 `WebtoonViewer`（single/double 分支与 viewerRef 逻辑不动；**viewer 加 `:key="${descriptorId(descriptor)}|${relPath}"`**——八轮 P1-2 防御：跨卷身份变化强制重建实例，`onMounted` 重发 zoom=1、内部状态干净起步。九轮 P0：`descriptor` 是 `SourceDescriptor` 联合类型，非 Local 变体无 `rootPath`——复用现有 `descriptorId(desc)`（sourceDescriptor.ts:64）造稳定 key，避免 vue-tsc 阻塞。注：跨卷在 ReaderView 不变量 3 下也会经 `visibleReader=false` 卸载 ReaderScreen 触发 KeepAlive 销毁——重挂载隐式成立，`:key` 把这个不变量显式化防后续策略变化破坏假设）；slideshow 接线 mode-aware（§4，**webtoon 下 setIsAtLast 恒 false——十轮 P1-2 后不传 webtoonAtBottom prop**）；新增 `pageOverride?: number | null` prop——`currentPage` computed 优先用它（watermark 与 ReaderOverlay 页码一处改两处生效，审查 P1-3）。
- `ReaderOverlay.vue`：`mode` 类型扩 `'webtoon'` + 模式按钮文案从 single/double 二元三元式改三态 `t('reader.mode.' + mode)`（一轮 P1-3）；**webtoon 下 OSD 缩放控件禁用/隐藏**（fit-* 档位对原生滚动无意义）。
- `ReaderContextMenu.vue`（二轮 P0-2，一轮遗漏）：`mode: 'single' | 'double'`（ReaderContextMenu.vue:23）类型扩——ReaderView :537 传的就是 `settings.readerDefaultMode`，不扩则 type-check 必挂；webtoon 下缩放子菜单与「阅读方向」项禁用。
- **webtoon 无效控件统一原则**（二轮附注 + 三轮 P1-6 补全）：OSD 缩放（Overlay / ContextMenu / MainMenu 中的 fit-* 与 original）、阅读方向（MainMenu / ContextMenu）、幻灯片间隔（Settings + **ReaderOverlay 轮播控制条的 interval slider**）、幻灯片方向（**ReaderOverlay 轮播控制条 + MainMenu 的 slideshow direction**——webtoon 自动滚动固定向下）——webtoon 选中时一律禁用或隐藏，不保留"可点但无效"的误导态；「切换模式」「重置缩放」「播放/暂停」照常。
- **descriptor 判空链**（三轮 P1-7）：`reader.sourceDescriptor` 类型含 null，vue-tsc 不会因 ready 状态收窄——三层显式处理：ReaderView 传 `reader.sourceDescriptor ?? undefined` → ReaderScreen `descriptor?: SourceDescriptor`（可选 prop）→ WebtoonViewer 分支 `v-else-if="mode === 'webtoon' && descriptor"`（v-if 收窄后传必填 prop）。
- `ReaderView.vue`：`loadBook` 图片列表/`convertFileSrc` URL 转换共用；按 `settingsStore.readMode` 传 mode；webtoon 时页码显示「顶部图 n / N」（`:page-override="webtoonTopIndex + 1"`）。
- `ReaderMainMenu.vue`：cycle-mode 三态 + 「重置缩放」项（仅 webtoon，zoom≠1 时可用）；`mode` prop 类型扩。
- `Settings.vue`（`src/views/`，审查 P1-6 修正路径）：**既有**阅读模式下拉（options/EnumRow/setter 已存在）扩 webtoon 选项 + `v as` 断言放宽 + RTL 行 webtoon 时 disabled；webtoon 子设置组（限宽 px、间距 px、滚动速度 px/s；仅 webtoon 选中时显示/启用）。
- i18n：`reader.mode.webtoon` / `reader.menu.resetZoom` / `settings.reader.webtoon.{maxWidth,gap,scrollSpeed}` 等新 key，zh-CN + en-US 双语。

## 8. 测试与性能验收

### 8.1 测试（预计前端 +30~40 用例，零 Rust）

- `useWebtoonDimensions`：估算占位/实测校正/预读窗口/无图头 fallback。
- `WebtoonViewer`：虚拟窗口渲染数量（挂载/卸载）、`isAtBottom()`、`getTopVisibleImage`、`scrollToImage` 渐进校正（含连续跳转 A→B 只跟随 B）、缩放 clamp/双击切换/Ctrl 滚轮锚点计算（纯函数抽出可测）。
- `useWebtoonProgress`：debounce 记录/同图去重（连续两次同图）/恢复链（?at → imageName → page → 0）/`flushNow` 冲刷/bookId 重置。
- 输入映射：`webtoonKeyBindings` 键位解析 / hotkeys override 分派（webtoon 下 nextPage→scrollScreen、single 不变）/ atBottom 触发跨卷。
- 自动滚动：rAF 步进/滚轮临时变速/2s 回落/ReaderScreen 接线 mode-aware（webtoon 下 setAdvance no-op + setIsAtLast 恒 false——interval tick 完全不参与结束/跨卷，十轮 P1-2）/到底顺序 停止→稳定 1.2s→ensureFinished 成功→跨卷（rAF autoEnd 独占，非 tick）/**autoEnd 取消路径（滚离底部/换卷/切模式不跨卷不误标完）+ ensureFinished 失败可重试 + 手动越底同流程**（五轮）。
- `ReaderScreen` 三模式分支 + `ReaderMainMenu` cycle 三态 + `ReaderOverlay` 三态文案 + Settings 联动 + i18n 双语一致性（既有自动覆盖）。

### 8.2 性能验收线（devtools 实测，写入 `docs/superpowers/reports/`）

- 200+ 张目录连续滚动全程 heap 平稳（虚拟化卸载生效；允许增长 ≤50MB 后平台期）。
- 单次滚动会话掉帧（单帧 >100ms）≤5 次。
- 缩放 1.0↔2.0↔4.0 连续操作无明显卡顿（无 >250ms 帧）。

## 9. 风险

- **超长单图**（>20000px）：浏览器可渲染，但估算/实测高度差大 → 渐进校正幅度大；`scrollToImage` 校正次数上限防抖动（已设计）。
- **内存**：虚拟窗口 ±2.5 屏 × 4K 长图解码仍可能峰值高；若实测超标，兜底用缩略图管线 quality=high 档作为显示源（3.0.7 积木，预留 `imgSrcFor()` 单点替换）。
- **模式切换位置语义**（一轮 P2-5，三轮 P2-8 改写）：`scrollToImage` 仅在开卷恢复（loadRouteBook）时调用——已开卷状态下 single/double 切到 webtoon **从卷首开始**（不重载书）；webtoon 切回 single/double 落到**未随滚动更新的旧 spread**（恢复点）。v1 接受，不追求跨模式位置锚定；可选增强（mode watcher 触发一次定位）留后续。**切换前必须 await 旧模式 pending 写入**（§5 模式切换写屏障），否则延迟写反序会污染新模式的进度。
- **滚轮接管边界**：`useReaderWheel` 停用后 OSD 相关 preventDefault 全部失效属预期；Ctrl+滚轮仅在 viewer 容器内拦（WebView2 无浏览器页面缩放，容器外低风险）。

## 10. 交付

- 模块号 `3.1.0-reader-webtoon`（新阅读模式，升 3.1.0）；tag `v0.1.0-module3.1.0-reader-webtoon`。
- 预计 8-9 个实现 commit（枚举/纯函数/尺寸/viewer/进度+flush/接线含输入/菜单 Settings i18n/文档；slideshow 接线并入接线 commit）。
- 文档：AGENTS.md 状态表 + DESIGN.md §16.5 移除 Webtoon 行 + **§0「本期不做」行的 webtoon 字样**（DESIGN.md:21）+ §12 阅读器交互章节补 webtoon 小节。
