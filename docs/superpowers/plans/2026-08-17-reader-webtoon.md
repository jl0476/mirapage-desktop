# module3.1.0 竖条漫（Webtoon）阅读模式实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 落地 spec `docs/superpowers/specs/2026-08-17-reader-webtoon-design.md`——第三种阅读模式 webtoon（竖向连续滚动 + 自由缩放 + 自动滚动 + 进度/跨卷复用）。

**架构：** 新组件 `WebtoonViewer`（原生滚动 + 单列虚拟化 img strip，不用 OSD）+ 两个薄 composable（尺寸预读 / 进度记录）；ReaderScreen 三模式分支；输入映射 per-mode；零 Rust、零 DB 迁移。

**技术栈：** Vue 3 + Pinia + Vitest（happy-dom）；复用 `listImageDimensions` IPC、`useReaderHotkeys`/`useReaderWheel`、slideshow/crossVolume/settings stores。

**两处设计决定（2026-08-17 审查修订，已回写 spec §2.3/§3，不再是偏差）**：
1. **缩放实现**：**显式宽度缩放**（strip 宽 = 基准宽 × zoom，img `width:100%` 高度自然跟随）——锚点补偿公式不变，走标准 CSS，规避非标准 CSS `zoom` 属性在 happy-dom/未来引擎的兼容风险。锚点数学抽纯函数可测。
2. **虚拟化**：**~50 行单列专用窗口计算**（heights 前缀和 + 二分）。理由：`useVirtualList` 面向 MediaEntry 列表/定行高抽象，webtoon 只有「名字数组 + measuredMap」两个输入，套适配层反而绕；单列 tops 单调递增，二分窗口比通用变高实现更简单。（审查 P2-3：原稿「masonry 也绕开自建」不实——masonry **在用** useVirtualList，本决定与它无关。）

**审查修订要点**（2026-08-17，P0×2 / P1×6 已全部编入对应任务）：
- **P0-1 slideshow 接线**：ReaderScreen onMounted 的 `setAdvance/setIsAtLast` 必须 mode-aware（任务 6 步骤 1），否则 webtoon 播放时 interval 不可见推进 spread index、`isAtLastSpread` 触发错误时机跨卷。
- **P0-2 进度双写防护**：webtoon 时卸载/跨卷旁路 `reader.saveCurrentProgressNow()`（硬编码 `'single'` + 过期 spread 位置会覆盖 image_name），改走 `useWebtoonProgress.flushNow()`（任务 5 实现 + 任务 6 步骤 3 接线）。
- **P1-1 输入映射**：`useReaderHotkeys` 扩 override + `inputBindings.ts` 加 `webtoonKeyBindings`（任务 6 步骤 2）——「不动 useReaderHotkeys」不成立（nextPage 等在 dispatch 内直调 store，ReaderView 无构造点）；**Space 已绑 `slideshowToggle`**（inputBindings.ts:64），原稿「Space=上滚一屏」作废，Space 保留播放/暂停。
- **P1-2 恢复链数据源**：`ReaderBookSnapshot` 加恢复字段（一轮定名 restoreImageName，二轮 P1-4 演进为 `restoreImageIndex` 图索引——见下方二轮段）；字段名是 camelCase `imageName` 非 `image_name`。
- **P1-3 ReaderOverlay**：mode 三元式改三态（任务 7）；ReaderScreen 加 `pageOverride` prop 统一页码。
- **P1-6 Settings**：`src/views/Settings.vue`（路径修正）；阅读模式下拉**已存在**（options:46 / setter:86 持久化），扩而非新增；store 级 `setReaderMode` 取消。
- **P2-1**：`useReaderWheel` 已有 `disabled` 选项，用之，不新增 `enabled`。

**二轮审查修订要点**（2026-08-17，P0×2 / P1×6 / P2×2 已全部编入对应任务）：
- **P0-1 expose 契约**：Vue `defineExpose` 经 proxyRefs 自动解包 ref——`atBottom.value`/`scrollEl.value`/`vm.zoom.value` 全不成立。expose 改全 getter（`isAtBottom()`/`getScrollEl()`/`getZoom()`，任务 4），消费端同步（任务 6），且 (f) 模板补 `ref="webtoonScreenRef"` 绑定。
- **P0-2 ReaderContextMenu**：`mode: 'single' | 'double'`（ReaderContextMenu.vue:23），ReaderView:537 传入宽类型必挂 type-check——纳入任务 7（类型扩 + webtoon 禁用缩放子菜单/方向项）。
- **P1-3 三设置只写不读**：任务 1 补 `load()` 三 key 映射（带 clamp，对齐 thumbnail key 先例）+ load 测试。
- **P1-4 恢复索引错位**：`initialSpreadIndex` 是 spread 索引（webtoon 下 loader 仍按双页 plan spreads），当图索引用会错位——snapshot 改携带 `restoreImageIndex`（图索引全链解析，任务 6 步骤 0）。
- **P1-5 常规滚动锚定**：spec §2.4 承诺的 measured-batch 高度补偿——任务 2 加 `captureAnchor/restoreAnchor` 纯函数 + 任务 3 composable 加 `onBeforeApply` 钩子 + 任务 4 接线。
- **P1-6 陈旧尺寸响应**：任务 3 加 epoch 代际（relPath/descriptor 变化自增，响应提交前核对）+ 测试。
- **P1-7 flushNow 契约**：返回 `Promise<void>` await 写入（跨卷 trySave 的 await 语义）+ `onScopeDispose` 清 timer（任务 5）。
- **P1-8 到底延迟**：rAF 帧内 `webtoonAtBottom` 立即走末端流程（pause + pendingNextVolume），不等 interval tick——intervalMs 对结束延迟也不生效（任务 6 步骤 3(e)）。
- **P2-9 缩放锚点**：先记目标 → 更新 zoom → nextTick 后同时恢复 scrollTop/scrollLeft（防旧 scrollHeight 钳位 + 横向锚点，任务 4 setZoom）。
- **P2-10**：`topVisibleIndex` 改二分（任务 2）；gap 定死固定 px 不随 zoom（spec §2.1，任务 4 调用处）。
- **附注-无效控件**：Overlay/ContextMenu/MainMenu 的 OSD 缩放、方向、interval 在 webtoon 下统一禁用/隐藏（任务 7）。

**三轮审查修订要点**（2026-08-17，P0×2 / P1×5 / P2×2 已全部编入对应任务）：
- **P0-1 loader 作用域**：`progress` 现为 else 块内 `const`——步骤 0 代码先提升为外层 `let`（照抄原稿编译失败）+ page 下限钳 0（任务 6 步骤 0）。
- **P0-2 dispose 抢 flush**：Vue 卸载顺序 scope.stop() **先于** onUnmounted——onScopeDispose 只清 timer、**保留 pending**，ReaderView onUnmounted 的 flushNow 才不空转（任务 5）。
- **P1-3 finished 先行**：自动滚动到底顺序定为 停止 → 稳定 1.2s → `finishNow()`（幂等兜底）→ 跨卷；不能到底即跨卷（bookId 变化会 reset stableTimer，旧卷永远不标完，破坏"跳过已读完卷"）（任务 5 finishNow + 任务 6 步骤 3(e)）。
- **P1-4 重置缩放状态链**：viewer `zoom-change` emit → ReaderView `webtoonZoom` ref → MainMenu `:webtoon-zoom` prop + `@reset-zoom` 接回 ReaderView（任务 4 emit + 任务 6 透传 + 任务 7 接线，ReaderView 进任务 7 commit 清单）。
- **P1-5 连续缩放竞态**：同 tick 多次 setZoom 时旧回调基于未恢复的 scrollTop 计算——改**共用一次锚点捕获**（首个未恢复的 setZoom 记基准 scrollTop/zoom，后续只推进 zoom.value），nextTick 按最终 zoom 一次换算 `(base+c)×(z_final/z_base)−c`（任务 4 setZoom + 复合锚点测试断言 1306；五轮 P2 注：三轮摘要原写 zoomSeq + "线性可复合"——名字与数学均已废弃纠正）。
- **P1-6 无效控件补全**：ReaderOverlay 轮播控制条的 interval slider + slideshow direction、MainMenu 的 slideshow direction，webtoon 下禁用/隐藏（任务 7）。
- **P1-7 descriptor 判空**：三层链——ReaderView 传 `?? undefined` → ReaderScreen prop 可选 → `v-else-if="mode === 'webtoon' && descriptor"` v-if 收窄（任务 6 步骤 1(c)/(f)）。
- **P2-8 模式切换风险**：spec §9 改写为"切 webtoon 从卷首开始、切回落旧 spread"（scrollToImage 仅开卷恢复时调用）。
- **P2-9 四处漂移**：expose `autoScrollStep` 三参签名（spec §2.5）；"到底经 tick 链"测试文案改 rAF 层（spec §8.1）；load 映射加 `Number.isFinite` 守卫（NaN 会穿过 Math.max，任务 1(e)）；bookId 测试 `atBottom.value=true` 后补 watcher flush（任务 5）。

**五轮审查修订要点**（2026-08-17，复审 P0×2 / P1×4 / P2×1 + 四轮自查 P1×1 / P2×4 / P3×2，全部编入）：
- **P0-1 自动结束状态机**：`setTimeout(STABLE_MS+200)` 无句柄/无身份捕获/无 atBottom 复核——等待期内滚回上方仍跨卷、Alt+→ 换卷后旧回调把新卷标完再连跳、切模式切回复活、重播后强制跨卷。改 `autoEndTimer + autoEndSeq + capturedBookId`，fire 前后四重校验（isWebtoon/seq/bookId/atBottom），五个取消点（滚离底部/换书/切模式/手动跨卷/卸载）（任务 6 步骤 3(e)）。
- **P0-2 ensureFinished**：旧 finishNow fire-and-forget（跨卷不等标完落库）+ `finishedMarked` 先置后写（IPC 失败永久 no-op）。改共享 in-flight、**成功才置位**、失败可重试、await 后 bookId 核对；自动跨卷 await 成功才发 pending，失败不跨（任务 5 + 任务 6 (e)）。
- **P1-3 手动越底同流程**：requestCrossVolumeNext 从底部发起时先 `await ensureFinished()` 再 maybeContinue——防快速越底在 stable 窗口内跨卷致旧卷永不标完；**Alt+→ force 明确不经此链**（可从卷中发起，不该标完，spec §6）（任务 6 (c)）。
- **P1-4 zoom 挂载重发**：zoom-change 原本只在 setZoom emit——跨卷重挂载不归 1，菜单误显可重置。Viewer onMounted emit 当前 zoom + 测试（任务 4）。
- **P1-5 Overlay 测试入列**：ReaderOverlay.test.ts 进任务 7 验证命令与 git add（文件已存在，核实过）。
- **P2-6 摘要与实现统一**：三轮 P1-5 摘要按 pendingZoomAnchor 实际方案重写；任务 8 冒烟补"滚回上方不跨卷/等待期换卷不触发旧 timer/新卷重置禁用"三子项。
- **四轮自查 P1 overlay 按钮**：ReaderScreen onNext/onPrev/onJump（:302-319）webtoon 分流——第三条 store 直调链（spread 不可见推进 → atLast → 错误跨卷）（任务 6 步骤 1(f)）。
- **四轮自查 P2×4**：任务 4 import 删 anchoredScroll（noUnusedLocals 编译错，tsconfig:17 已核实）；doJumpToPage/addBookmark webtoon 分流（任务 6 (d2)）；锚定恢复 vs scrollToImage 校正时序注释纠正 + `scrollToImageActive` 互斥（任务 4）。
- **四轮自查 P3×2**：useWebtoonProgress opts 删未消费的 topImage/topIndex；(b0) `?? ''` 冗余清理（任务 6 (b)/(b0)）。

**六轮审查修订要点**（2026-08-17，P1×4 全闭环——均为五轮自引入缺陷）：
- **P1-1 手动越底查返回值**：requestCrossVolumeNext 原本 `await` 了但不论真假都继续跨卷——补 `if (!ok ...) return`（失败不跨，与 spec"await true 后才发起"一致）+ await 后复核 isWebtoon/bookId（任务 6 (c)）。
- **P1-2 in-flight 按卷绑定**：旧卷 markFinished 在途时切新卷，新卷 ensureFinished 会复用旧 promise 拿到假 true——改 `{ bookId, p }` 结构，仅同卷去重，异卷直接发起本卷写入；finally 只清自己的记录（任务 5 + 跨卷用例）。
- **P1-3 切出 webtoon 清 stableTimer**：viewer 卸载后 webtoonAtBottom 冻结在 true，composable 的 stableTimer 继续跑会迟到误标——watch(isWebtoon) 切出时显式置 `webtoonAtBottom = false`（触发 composable watch 清 timer）（任务 6 步骤 3(e)）。
- **P1-4 跳转互斥超时收口**：原"3s 静止停"只在 watch 回调里检查（measuredMap 不再变则永不复位，常规锚定永久禁用）——补真 `setTimeout(finish, 3000)`；互斥分支跳过锚定时**弃置 pendingAnchor**（防陈旧锚点事后拉回）（任务 4）。
- **连锁修正**：五轮删 opts 字段时漏改测试 setup/dispose/bookId 三处调用点（excess property 编译错）+ 实现 opts 接口同步收窄。

**七轮审查修订要点**（2026-08-17，P1×2 / P2×1）：
- **P1 手动越底身份校验**：`bookId !== null` 挡不住"写入期间换了卷"——迟到回调会以**新卷身份**错误发起跨卷。补 `capturedBookId` 快照 + await 后三重校验（同卷 / isWebtoon / 仍 atBottom）+ "写入期间换卷""滚离底部"两测试（任务 6 (c) + 步骤 4）。
- **P1 跳转校正器唯一化**：连续 scrollToImage 各建 watch/timeout 却共享布尔互斥——旧 timeout 提前解除新任务互斥、旧 watch 把滚动拉回旧目标。改组件级唯一 `activeCorrection`（新跳转先 finish 旧跳转，finish 只清自己）+ "A→B 只跟随 B" 测试（任务 4）。
- **P2 spec 残留同步**：§2.4"后注册后写胜出"改为互斥 + 唯一校正器描述；§2.5 setZoom 注释 zoomSeq → pendingZoomAnchor（七轮 P2——spec 是真值源，不能留废弃方案）。

**八轮审查修订要点**（2026-08-17，P1×2 / P2×1 + 新需求确认）：
- **P1-1 flushNow 等串行链尾**：pending 已空但 debounce 写入在途时直接返回——跨卷 trySave 拿不到失败结果，旧位置 A 迟到可能覆盖新位置 B。改 `writeTail` Promise 链（debounce 与 flushNow 触发的写入都挂链尾串行），flushNow 即使无 pending 也 `await writeTail`；补"debounce 在途时 flushNow 等"和"A/B 完成顺序反转"两测试（任务 5）。
- **P1-2 viewer `:key` 防御**：跨卷时 ReaderView 不变量 3 (`visibleReader=false`) 卸载 ReaderScreen → KeepAlive 销毁 → viewer 重挂载隐式成立——但依赖三层隐式行为。加 `:key="${descriptorId(descriptor)}|${relPath}"` 显式化（九轮 P0：原写 `descriptor.rootPath`——联合类型非 Local 变体无此字段，vue-tsc 阻塞；复用 `descriptorId`）：跨卷身份变化强制重建实例，`onMounted` 重发 zoom=1、内部状态干净起步（任务 6 步骤 1(c)，spec §7 同步）。
- **P2 A→B 测试重写**：原 50ms + `>0` 断言旧 watcher 存活也能过——改 fake timers 越过 A 的 3s 截止点 + 挂起 dims Promise + 断言单调不减（A 不把 B 拉回）（任务 4）。
- **新需求（进入阅读器默认加载视图）**：本就是 spec §1 / 任务 1 / 任务 7 的 `reader_default_mode` 全局默认设置——用户在 Settings 选定 single/double/webtoon 后，任意入口进阅读器按此模式加载。语义在 spec §1 显式化（任务 7 Settings 下拉的描述同步加"进入阅读器默认加载视图"文案）。

**九轮终审修订要点**（2026-08-17，P0×1 / P1×1，均为八轮自引入缺陷）：
- **P0 descriptorId 替代 rootPath**：`:key` 原用 `descriptor.rootPath`——`descriptor` 是 `SourceDescriptor` 联合类型，Archive/SMB/WebDAV 变体无 `rootPath`，vue-tsc 阻塞。复用现有 `descriptorId(desc)`（sourceDescriptor.ts:64 已核实）造稳定 key（任务 6 步骤 1(c) + spec §7 同步）。
- **P1 writeTail 失败恢复**：`writeTail.then(...)` 在旧链 reject 后会跳过后续回调——一次 saveProgress 失败后所有后续保存永久中断。改 `const job = writeTail.catch(() => undefined).then(...)`：排队前恢复旧链，当前 job 的 rejection 继续返回调用方（flushNow await 抛、debounce 路径自 catch）；补"首写失败后次写成功"测试（任务 5）。

**十轮审查修订要点**（2026-08-17，P1×2 / P2×4）：
- **P1-1 模式切换进度写屏障**：single/double 的 500ms debounce 与 webtoon 的 300ms 在同会话切换时会反序覆盖（共享 imageName 还污染瀑布流"跳到上次"）。三个阅读器内切换入口统一收口 `switchReaderMode()`——切换前 await 旧模式 pending 写入（paged→webtoon 走 `reader.saveCurrentProgressNow()`，webtoon→paged 走 `webtoonProgress.flushNow()`），完成后才 `cycleReaderMode()`；in-flight guard 防连点；双向延迟写反序测试（任务 6 步骤 3(g) + 步骤 4）。Settings 下拉不经此屏障（阅读器未挂载无 pending）。
- **P1-2 interval tick 绕过 autoEnd**：setIsAtLast 原返回 `webtoonAtBottom()` 有竞态——interval 可能在 rAF pause 前先 tick → atLast 分支直接 pause + pendingNextVolume，绕过稳定窗口和 ensureFinished。改 webtoon 下 `setIsAtLast` 恒 false——interval tick 完全不参与结束/跨卷，rAF autoEnd 独占；`webtoonAtBottom` getter prop 删除（不再被消费）；补"atBottom 后 interval 先 tick 也不跨卷"竞态测试（任务 6 步骤 1(e) + 步骤 4）。
- **P2 MainMenu 页码分流**：:139 `currentSpreadIndex+1/totalSpreads` + ReaderView `jumpValue` 初值都读旧 spread——webtoon 下错显。MainMenu 加 `currentPageOverride/totalPagesOverride` props，ReaderView 传 `webtoonTopIndex+1/pageUrls.length`；`openJumpDialog` 初值分流（任务 7）。
- **P2 webtoon→paged slideshow 恢复测试**：切回 paged 后 setIsAtLast 恢复 `store.isAtLastSpread`、setAdvance 恢复 `store.nextPage()`——tick 正常推进 spread（任务 7 步骤 3）。
- **P2 旧配置兼容测试真实 load()**：不只测 setter，真实调 `settings.load()` 验证 DB 值读回（任务 7 步骤 3）。
- **P2 A→B + debounce 测试 deferred mock**：原 mock 假覆盖（50ms + `>0` / runAllTimers）——改 deferred mock（挂起 Promise 手动 resolve）确保竞态真的被触发（任务 4 + 任务 5）。

**十一轮终审修订要点**（2026-08-17，P1×1 / P2×2）：
- **P1 spec 残留旧 setIsAtLast 契约**：§7 仍声明 `webtoonAtBottom` getter prop + §8.1 测试清单仍写 `setIsAtLast=atBottom 兜底`——与 §4 及计划的"webtoon 恒 false"正面冲突，可能重新引入 interval 绕过 ensureFinished 的竞态。删 prop + §8.1 改"恒 false"（spec §7/§8.1）。
- **P2 A→B 测试 deferred mock**：原 mock 在请求发出后才设 resolved value，flushPromises 不会产生 measuredMap 更新——改 deferred mock（`new Promise(r => resolveDim = r)` 挂起，手动 `resolveDim([...])` 提交 batch），任务 4 本体直接修订（非 Task 7 附注）。
- **P2 flushNow 在途测试 deferred mock**：原 `runAllTimersAsync` 不能证明 flushNow 等待写链（mock 立即完成）——改 deferred saveProgress（`new Promise(r => resolveSave = r)`），验证 resolve 前后状态，任务 5 本体直接修订。

**十二轮终审修订要点**（2026-08-17，P2×3 不阻塞，终审已通过）：
- **P2 A→B 测试精确化**：原方案 A/B 同 tick 创建后推进 3100ms 会同时结束 B 的 3s 校正器；且改变 c.jpg 自身高度不会改变其 top（top 是前缀和）。改：错开 A/B 启动时间（500ms 间隔，B deadline 在 A 之后）、只越过 A deadline（2501ms）、改变 c 的前置项 a 的高度（估算 3:4→实测 1:1）、断言精确 scrollTop（1866.67 = a 实测 800 + b 估算 1066.67）（任务 4）。
- **P2 spec 模式切换写屏障同步**：§5 双写防护段 + §9 模式切换位置语义段补"切换前 await 旧模式 pending 写入"约束（spec §5/§9）。
- **P2 ReaderScreen.test.ts 进任务 7**：webtoon→paged slideshow 恢复测试在 ReaderScreen 里验证——进任务 7 的 vitest 命令与 git add 清单（任务 7 步骤 3）。

**CRLF 警告**：`ReaderView.vue` / `tauri.ts` 等多数存量文件是 CRLF——多行编辑走 node 补丁脚本（`_wtN_patch.mjs` 模式，跑完即删）；新文件用 Write 直建。

---

## 文件结构

| 文件 | 变更 | 职责 |
|---|---|---|
| `src/lib/readerSettings.ts` + `.test.ts` | 修改 | ReadMode 枚举 + normalize |
| `src/stores/settings.ts` + `.test.ts` | 修改 | 扩既有 ReaderMode 加 webtoon（re-export readerSettings 类型）+ 三 webtoon 设置键 |
| `src/lib/webtoonLayout.ts` + `.test.ts` | 创建 | 纯函数：布局前缀和 / 窗口二分 / 顶部图 / 缩放锚点 / 自动滚动步进 |
| `src/composables/useWebtoonDimensions.ts` + `.test.ts` | 创建 | 图头渐进测量（估算占位 + 预读窗口批量 IPC） |
| `src/components/reader/WebtoonViewer.vue` + `.test.ts` | 创建 | 滚动容器 + 虚拟 strip + 缩放 + expose |
| `src/composables/useWebtoonProgress.ts` + `.test.ts` | 创建 | debounce 记录顶部图 + atBottom→finished + flushNow（P0-2） |
| `src/composables/useReaderBookLoader.ts` | 修改 | snapshot 加 `restoreImageIndex`（P1-2/P1-4：图索引全链解析，spread 索引不可用） |
| `src/lib/inputBindings.ts` + `.test.ts` | 修改 | `webtoonKeyBindings` 导出（P1-1：↑/↓ 滚屏，←/→ 解绑，Space 留 slideshowToggle） |
| `src/composables/useReaderHotkeys.ts` + `.test.ts` | 修改 | ReaderHotkeyActions 扩 isWebtoon + 四命令 override（P1-1） |
| `src/views/ReaderView.vue` | 修改 | webtoon 分支接线（viewer ref / 进度恢复 / 自动滚动 rAF / 输入 override / 双写防护） |
| `src/components/reader/ReaderScreen.vue` | 修改 | mode 加 'webtoon' 分支 + slideshow 接线 mode-aware（P0-1）+ pageOverride prop |
| `src/components/reader/ReaderOverlay.vue` | 修改 | mode 类型扩 + 文案三态（P1-3）+ webtoon 缩放控件禁用 |
| `src/components/reader/ReaderContextMenu.vue` | 修改 | mode 类型扩（二轮 P0-2，type-check 阻塞）+ 缩放子菜单/方向项禁用 |
| `src/components/reader/ReaderMainMenu.vue` | 修改 | cycle 三态 + 重置缩放项 + mode 类型扩 |
| `src/composables/useReaderWheel.ts` | 修改 | **不改**（既有 `disabled` 选项直接用，P2-1；如最终无 diff 则不入 commit） |
| `src/views/Settings.vue` | 修改 | **既有**阅读模式下拉扩 webtoon（P1-6，路径修正为 views/）+ webtoon 子设置 |
| `src/locales/zh-CN.ts` / `en-US.ts` | 修改 | 新 key 双语 |
| `DESIGN.md` / `AGENTS.md` | 修改 | §16.5 移除 Webtoon 行 + §0「本期不做」行（DESIGN.md:21）/ §12 补小节 / 状态表 |

---

### 任务 1：ReadMode 枚举 + settings store

**文件：**
- 修改：`src/lib/readerSettings.ts`
- 修改：`src/stores/settings.ts`
- 测试：`src/lib/readerSettings.test.ts`、`src/stores/settings.test.ts`

- [ ] **步骤 1：写失败测试（readerSettings.test.ts 追加）**

```ts
import { ReadMode, normalizeReadMode, DEFAULT_READ_MODE } from './readerSettings';

describe('ReadMode（module3.1.0）', () => {
  it('DEFAULT_READ_MODE 是 single', () => {
    expect(DEFAULT_READ_MODE).toBe<ReadMode>('single');
  });
  it('normalizeReadMode 合法值透传', () => {
    expect(normalizeReadMode('webtoon')).toBe('webtoon');
    expect(normalizeReadMode('double')).toBe('double');
  });
  it('normalizeReadMode 非法值 fallback single', () => {
    expect(normalizeReadMode('rtl')).toBe('single');
    expect(normalizeReadMode('')).toBe('single');
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/lib/readerSettings.test.ts
```

预期：编译失败（`ReadMode` / `normalizeReadMode` 不存在）。

- [ ] **步骤 3：实现（readerSettings.ts）**

在 `ReadDirection` 定义后追加：

```ts
/** 阅读模式（module3.1.0：webtoon = 竖向连续滚动） */
export type ReadMode = 'single' | 'double' | 'webtoon';
export const DEFAULT_READ_MODE: ReadMode = 'single';

const VALID_READ_MODES: ReadonlySet<ReadMode> = new Set(['single', 'double', 'webtoon']);

/** 把 DB 读出的 reader_mode 值规范化为合法 ReadMode（老数据/非法值 fallback single）。 */
export function normalizeReadMode(v: string): ReadMode {
  return VALID_READ_MODES.has(v as ReadMode) ? (v as ReadMode) : DEFAULT_READ_MODE;
}
```

- [ ] **步骤 4：settings store（settings.ts，CRLF 用 node 补丁）——扩既有 ReaderMode，不新增模式 key（审查 P1-1）**

**背景**：settings.ts:21 已有 `type ReaderMode = 'single' | 'double'` + `readerDefaultMode` ref + `reader_default_mode` key + `cycleReaderMode()` 两态循环，ReaderView/主菜单/双页判断均消费它。**禁止另立 readMode/reader_mode 第二套状态**——扩既有链路：

(a) `readerSettings.ts`（任务 1 步骤 3 已建）成为类型单一真值源；settings.ts:21 本地 `export type ReaderMode` 改为 `export type { ReadMode as ReaderMode } from '@/lib/readerSettings'`（re-export 保既有 import 不动），`import { ReadMode, normalizeReadMode } from '@/lib/readerSettings'`。

(b) 加载映射既有 `['reader_default_mode', (v) => (readerDefaultMode.value = v as ReaderMode)]` 改为：

```ts
      ['reader_default_mode', (v) => (readerDefaultMode.value = normalizeReadMode(v as string))],
```

(c) `cycleReaderMode`（settings.ts:263-270）改三态循环：

```ts
  async function cycleReaderMode(): Promise<void> {
    const order: ReadMode[] = ['single', 'double', 'webtoon'];
    const next = order[(order.indexOf(readerDefaultMode.value) + 1) % order.length];
    log('[settings] cycleReaderMode →', next, '(was', readerDefaultMode.value, ')');
    store.$patch({ readerDefaultMode: next });
    await update('reader_default_mode', next);
    log('[settings] cycleReaderMode done, current=', readerDefaultMode.value);
  }
```

(d) `currentScaleMode` 声明后加 webtoon 三设置（**不含模式直设器**——审查 P1-6：`src/views/Settings.vue:86` 已有本地 `setReaderMode`（赋值 + `settings.update('reader_default_mode', v)` 持久化），任务 7 扩它即可，store 级再加一个就是重复 API）：

```ts
  // module3.1.0: webtoon 设置（spec §1/§2/§4）
  const webtoonMaxWidth = ref(0);     // 0 = 不限宽；px
  const webtoonGap = ref(0);          // 0-24 px
  const webtoonScrollSpeed = ref(60); // px/s，10-300
  function setWebtoonMaxWidth(px: number): void {
    webtoonMaxWidth.value = Math.max(0, Math.round(px));
    void update('webtoon_max_width', String(webtoonMaxWidth.value));
  }
  function setWebtoonGap(px: number): void {
    webtoonGap.value = Math.min(24, Math.max(0, Math.round(px)));
    void update('webtoon_gap', String(webtoonGap.value));
  }
  function setWebtoonScrollSpeed(px: number): void {
    webtoonScrollSpeed.value = Math.min(300, Math.max(10, Math.round(px)));
    void update('webtoon_scroll_speed', String(webtoonScrollSpeed.value));
  }
```

return 对象加 `webtoonMaxWidth, webtoonGap, webtoonScrollSpeed, setWebtoonMaxWidth, setWebtoonGap, setWebtoonScrollSpeed`（`readerDefaultMode`/`cycleReaderMode` 已在 return，不动）。（`update` 为该 store 既有的 settings 写入函数名——已核实 settings.ts:111。）

(e) **加载映射**（二轮 P1-3：只写不读则重启回默认）——`load()` 的 keys 数组（settings.ts:73 起）追加三行，clamp 与 setter 同值域（对齐 `fb_thumbnail_worker_limit` 的 `normalizeWorkerLimit(Number(v))` 先例）：

```ts
      // 三轮 P2-9：Number('abc')=NaN 且 Math.max(0, NaN)=NaN 会传染——先 isFinite 再 clamp（非数字脏值保持默认）
      ['webtoon_max_width', (v) => { const n = Number(v); if (Number.isFinite(n)) webtoonMaxWidth.value = Math.max(0, Math.round(n)); }],
      ['webtoon_gap', (v) => { const n = Number(v); if (Number.isFinite(n)) webtoonGap.value = Math.min(24, Math.max(0, Math.round(n))); }],
      ['webtoon_scroll_speed', (v) => { const n = Number(v); if (Number.isFinite(n)) webtoonScrollSpeed.value = Math.min(300, Math.max(10, Math.round(n))); }],
```

- [ ] **步骤 5：settings.test.ts 追加用例**

```ts
it('readerDefaultMode：webtoon 可直设 + 非法值 normalize fallback single（module3.1.0）', async () => {
  const s = useSettingsStore();
  s.readerDefaultMode = 'webtoon';           // Pinia setup store ref 直写（Settings setter 走 update 持久化，此处测 store 层）
  expect(s.readerDefaultMode).toBe('webtoon');
  // 加载映射层走 normalizeReadMode（settings.ts load 数组）——非法值 fallback single
  expect(normalizeReadMode('bogus')).toBe('single');
  expect(normalizeReadMode('webtoon')).toBe('webtoon');
});

it('cycleReaderMode：三态循环 single→double→webtoon→single（module3.1.0）', async () => {
  const s = useSettingsStore();
  s.readerDefaultMode = 'single';
  await s.cycleReaderMode();
  expect(s.readerDefaultMode).toBe('double');
  await s.cycleReaderMode();
  expect(s.readerDefaultMode).toBe('webtoon');
  await s.cycleReaderMode();
  expect(s.readerDefaultMode).toBe('single');
});

it('webtoon 三设置：load 映射读取 + 值域 clamp（二轮 P1-3）', async () => {
  const s = useSettingsStore();
  await s.setWebtoonMaxWidth(1200);
  await s.setWebtoonGap(8);
  await s.setWebtoonScrollSpeed(120);
  // 重新 load → 从 DB 读回（mock setSetting/getSetting 的既有模式，参照本文件其他 load 用例）
  await s.load();
  expect(s.webtoonMaxWidth).toBe(1200);
  expect(s.webtoonGap).toBe(8);
  expect(s.webtoonScrollSpeed).toBe(120);
  // 越界值经 load clamp（脏 DB 数据兜底）
  // （mock getSetting 返回 '999' → webtoonGap clamp 到 24 的断言，写法随本文件 mock 设施）
});
```

- [ ] **步骤 6：运行验证通过 + Commit**

```bash
npx vitest run src/lib/readerSettings.test.ts src/stores/settings.test.ts
git add src/lib/readerSettings.ts src/lib/readerSettings.test.ts src/stores/settings.ts src/stores/settings.test.ts
git commit -m "feat(reader): 既有 ReaderMode 扩 webtoon（cycle 三态 + normalize）+ webtoon 三设置键（任务 1/8）"
```

---

### 任务 2：webtoonLayout 纯函数库

**文件：**
- 创建：`src/lib/webtoonLayout.ts`、`src/lib/webtoonLayout.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import {
  computeLayout, visibleWindow, topVisibleIndex, clampZoom, anchoredScroll, autoScrollDelta,
  captureAnchor, restoreAnchor,
} from './webtoonLayout';

describe('webtoonLayout（module3.1.0）', () => {
  const measured = new Map([
    ['a.jpg', { width: 1000, height: 2000 }],
    ['b.jpg', { width: 1000, height: 3000 }],
  ]);
  // c.jpg 未测量 → 估算 3:4（宽 1000 → 高 1000*4/3 ≈ 1333.33）

  it('computeLayout：实测用宽高比、未测量用 3:4 估算、tops 为前缀和', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(l.heights[0]).toBe(1000);            // 500 * 2000/1000
    expect(l.heights[1]).toBe(1500);            // 500 * 3000/1000
    expect(l.heights[2]).toBeCloseTo(666.667, 1); // 500 * 4/3
    expect(l.tops[0]).toBe(0);
    expect(l.tops[1]).toBe(1000);
    expect(l.tops[2]).toBe(2500);
    expect(l.totalHeight).toBeCloseTo(3166.667, 1);
  });

  it('computeLayout：gap 计入相邻项', () => {
    const l = computeLayout(['a.jpg', 'b.jpg'], measured, 500, 10);
    expect(l.tops[1]).toBe(1010);
  });

  it('visibleWindow：视口 ±2.5 屏二分窗口', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    // 3 张全高 3166；scrollTop=0 viewport=1000 → 覆盖全部
    expect(visibleWindow(l, 0, 1000)).toEqual({ start: 0, end: 3 });
  });

  it('visibleWindow：中部滚动只含命中条目', () => {
    const names = ['a.jpg', 'b.jpg', 'c.jpg'];
    const l = computeLayout(names, measured, 500, 0);
    // 视口 1px + 0 屏余量：scrollTop=1000（b 顶部）只含 b
    const w = visibleWindow(l, 1000, 1, 0);
    expect(w.start).toBe(1);
    expect(w.end).toBe(2);
  });

  it('topVisibleIndex：首个底边超过 scrollTop 的条目', () => {
    const l = computeLayout(['a.jpg', 'b.jpg', 'c.jpg'], measured, 500, 0);
    expect(topVisibleIndex(l, 0)).toBe(0);
    expect(topVisibleIndex(l, 1000)).toBe(1);
    expect(topVisibleIndex(l, 999)).toBe(0);
  });

  it('captureAnchor/restoreAnchor：上方条目高度校正后视口锚定（二轮 P1-5）', () => {
    // 旧 layout：a 实测 1:1（高 500），b 未测量估算（高 666.67）
    const l1 = computeLayout(['a.jpg', 'b.jpg'], new Map([['a.jpg', { width: 1000, height: 1000 }]]), 500, 0);
    // 用户停在 b 顶部下方 250px：scrollTop = 500 + 250，b 内比例 = 250/666.67 = 0.375
    const anchor = captureAnchor(l1, 750);
    expect(anchor).toEqual({ index: 1, ratio: 0.375 });
    // a 实测改为 1:2（高 1000）→ b 顶部 500 → 1000；b 实测也到达（高 666.67 不变）
    const l2 = computeLayout(['a.jpg', 'b.jpg'], new Map([
      ['a.jpg', { width: 1000, height: 2000 }],
      ['b.jpg', { width: 1000, height: 1333.34 }],
    ]), 500, 0);
    // 恢复 = b 新顶部 + 新高 × 旧比例
    expect(restoreAnchor(l2, anchor)).toBeCloseTo(1000 + 666.67 * 0.375, 1);
    // 锚点越界（索引超长）→ null
    expect(restoreAnchor(l2, { index: 9, ratio: 0 })).toBeNull();
  });

  it('clampZoom：1-4 clamp + 两位小数', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2.34)).toBe(2.34);
    expect(clampZoom(5)).toBe(4);
  });

  it('anchoredScroll：缩放后鼠标下内容点不动', () => {
    // scrollTop=1000, clientY=500, 1x→2x：内容点 Y=1500 → 新 scrollTop=1500*2-500=2500
    expect(anchoredScroll(1000, 500, 1, 2)).toBe(2500);
    // 2x→1x 回去
    expect(anchoredScroll(2500, 500, 2, 1)).toBe(1000);
  });

  it('autoScrollDelta：speed × factor × dt', () => {
    expect(autoScrollDelta(60, 1, 1000)).toBeCloseTo(60);
    expect(autoScrollDelta(60, 2, 500)).toBeCloseTo(60);
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/lib/webtoonLayout.test.ts
```

预期：模块不存在。

- [ ] **步骤 3：实现（src/lib/webtoonLayout.ts，新建）**

```ts
/**
 * webtoonLayout.ts — 竖条漫布局纯函数（module3.1.0，spec §2）
 *
 * 无 Vue / DOM 依赖，可独立 vitest。单列线性布局：
 * heights[i] 由实测宽高比或 3:4 估算推导；tops 前缀和支撑窗口二分。
 */

/** 未测量图片的估算宽高比（宽:高 = 3:4，与瀑布流 fallback 一致） */
export const ESTIMATED_RATIO = 3 / 4;

export interface WebtoonLayout {
  names: string[];
  heights: number[];
  /** tops[i] = 第 i 张顶部 y（含前序 gap） */
  tops: number[];
  totalHeight: number;
}

export function computeLayout(
  names: readonly string[],
  measured: ReadonlyMap<string, { width: number; height: number }>,
  stripWidth: number,
  gap: number,
): WebtoonLayout {
  const heights = names.map((n) => {
    const m = measured.get(n);
    if (m && m.width > 0 && m.height > 0) return (stripWidth * m.height) / m.width;
    return stripWidth / ESTIMATED_RATIO;
  });
  const tops: number[] = new Array(names.length);
  let acc = 0;
  for (let i = 0; i < names.length; i++) {
    tops[i] = acc;
    acc += heights[i] + (i < names.length - 1 ? gap : 0);
  }
  return { names: [...names], heights, tops, totalHeight: acc };
}

/** 可见窗口 [start, end)：覆盖 [scrollTop - screens×viewport, scrollTop + (1+screens)×viewport]。二分。 */
export function visibleWindow(
  l: WebtoonLayout,
  scrollTop: number,
  viewportHeight: number,
  screens = 2.5,
): { start: number; end: number } {
  const lo = scrollTop - screens * viewportHeight;
  const hi = scrollTop + (1 + screens) * viewportHeight;
  // start：首个 (top + height) > lo
  let s = 0, e = l.names.length;
  while (s < e) {
    const mid = (s + e) >> 1;
    if (l.tops[mid] + l.heights[mid] > lo) e = mid; else s = mid + 1;
  }
  const start = s;
  // end：首个 top > hi
  let s2 = start, e2 = l.names.length;
  while (s2 < e2) {
    const mid = (s2 + e2) >> 1;
    if (l.tops[mid] > hi) e2 = mid; else s2 = mid + 1;
  }
  return { start, end: Math.max(s2, start) };
}

/** 顶部可见条目：首个底边超过 scrollTop 的索引（二分——底边单调递增，二轮 P2-10 对齐窗口复杂度）。 */
export function topVisibleIndex(l: WebtoonLayout, scrollTop: number): number {
  let s = 0, e = l.names.length;
  while (s < e) {
    const mid = (s + e) >> 1;
    if (l.tops[mid] + l.heights[mid] > scrollTop + 1) e = mid; else s = mid + 1;
  }
  return Math.max(0, Math.min(s, l.names.length - 1));
}

/** 缩放 clamp：1.0-4.0，两位小数。 */
export function clampZoom(z: number): number {
  return Math.min(4, Math.max(1, Math.round(z * 100) / 100));
}

/** 锚点缩放：保持 (scrollTop + clientY) 处的内容点缩放后仍在 clientY（spec §3 公式）。 */
export function anchoredScroll(scrollTop: number, clientY: number, oldZ: number, newZ: number): number {
  return (scrollTop + clientY) * (newZ / oldZ) - clientY;
}

/** 自动滚动单步位移（px）：speed(px/s) × factor × dt(ms)。 */
export function autoScrollDelta(speed: number, factor: number, dt: number): number {
  return (speed * factor * dt) / 1000;
}

/** 视口锚点（二轮 P1-5）：顶部可见条目 + 条目内偏移比。measured batch 应用前用旧 layout 捕获。 */
export interface WebtoonAnchor { index: number; ratio: number }

export function captureAnchor(l: WebtoonLayout, scrollTop: number): WebtoonAnchor | null {
  if (l.names.length === 0) return null;
  const i = topVisibleIndex(l, scrollTop);
  const h = l.heights[i];
  const ratio = h > 0 ? Math.min(1, Math.max(0, (scrollTop - l.tops[i]) / h)) : 0;
  return { index: i, ratio };
}

/** 按锚点恢复 scrollTop（新 layout）；锚点 null 或索引越界返回 null。 */
export function restoreAnchor(l: WebtoonLayout, a: WebtoonAnchor | null): number | null {
  if (!a || a.index >= l.names.length) return null;
  return l.tops[a.index] + l.heights[a.index] * a.ratio;
}
```

- [ ] **步骤 4：运行验证通过 + Commit**

```bash
npx vitest run src/lib/webtoonLayout.test.ts
git add src/lib/webtoonLayout.ts src/lib/webtoonLayout.test.ts
git commit -m "feat(webtoon): 布局纯函数库（前缀和/窗口二分/缩放锚点/滚动步进）（任务 2/8）"
```

---

### 任务 3：useWebtoonDimensions 渐进测量

**文件：**
- 创建：`src/composables/useWebtoonDimensions.ts`、`src/composables/useWebtoonDimensions.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { ref } from 'vue';
import { useWebtoonDimensions } from './useWebtoonDimensions';
import { listImageDimensions } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listImageDimensions: vi.fn() };
});

describe('useWebtoonDimensions（module3.1.0）', () => {
  function mk(relPath = '') {
    return useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['a.jpg', 'b.jpg', 'c.jpg']),
      ref(relPath),
    );
  }

  it('ensureRange：拼 relPath 前缀请求 fullPath，响应反查 name 回填（审查 P1-3）', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'comics/vol01/a.jpg', width: 1000, height: 2000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const d = mk('comics/vol01');
    await d.ensureRange(0, 2);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'R:\\c' },
      ['comics/vol01/a.jpg', 'comics/vol01/b.jpg'],   // fullPaths，非裸名
    );
    // measuredMap 以 name 为 key（layout 消费）
    expect(d.measuredMap.value.get('a.jpg')).toEqual({ width: 1000, height: 2000 });
    // 二次同范围：已请求过的不再发 IPC
    await d.ensureRange(0, 2);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledTimes(1);
  });

  it('relPath=""（书在根）：裸名直传', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'a.jpg', width: 100, height: 200 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const d = mk('');
    await d.ensureRange(0, 1);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledWith(
      expect.anything(), ['a.jpg'],
    );
  });

  it('跨卷（relPath 变化）：requested/measuredMap 清空，同名图重新测量', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'vol1/001.jpg', width: 1000, height: 2000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const relPath = ref('vol1');
    const d = useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['001.jpg']),
      relPath,
    );
    await d.ensureRange(0, 1);
    expect(d.measuredMap.value.size).toBe(1);
    // 跨卷 → relPath 变 → 清空
    relPath.value = 'vol2';
    await Promise.resolve(); // watch flush
    expect(d.measuredMap.value.size).toBe(0);
    // 同名 001.jpg 重新请求（requested 已清）
    vi.mocked(listImageDimensions).mockClear();
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'vol2/001.jpg', width: 800, height: 3000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    await d.ensureRange(0, 1);
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalledTimes(1);
    expect(d.measuredMap.value.get('001.jpg')).toEqual({ width: 800, height: 3000 });
  });

  it('跨卷陈旧响应丢弃（epoch，二轮 P1-6）', async () => {
    let resolveA!: (v: { path: string; width: number; height: number }[]) => void;
    vi.mocked(listImageDimensions).mockImplementationOnce(
      () => new Promise((r) => { resolveA = r; }));
    const relPath = ref('vol1');
    const d = useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['001.jpg']),
      relPath,
    );
    void d.ensureRange(0, 1);                    // 旧卷请求挂起（未 resolve）
    relPath.value = 'vol2';
    await Promise.resolve();                     // watch flush → epoch++
    resolveA([{ path: 'vol1/001.jpg', width: 1000, height: 9999 }]);  // 旧响应晚到
    await new Promise((r) => setTimeout(r, 0));  // 等 IIFE 链走完（真 timer）
    expect(d.measuredMap.value.size).toBe(0);    // 被丢弃，不污染新卷
  });

  it('onBeforeApply：batch 写入前回调（锚点捕获时机，此时 measuredMap 仍是旧值——二轮 P1-5）', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'a.jpg', width: 1000, height: 2000 },
    ] as Awaited<ReturnType<typeof listImageDimensions>>);
    const calls: number[] = [];
    let d!: ReturnType<typeof useWebtoonDimensions>;
    d = useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['a.jpg']),
      ref(''),
      { onBeforeApply: () => calls.push(d.measuredMap.value.size) },
    );
    await d.ensureRange(0, 1);
    expect(calls).toEqual([0]);                  // 回调时 size 仍 0（写入前），写入后变 1
    expect(d.measuredMap.value.size).toBe(1);
  });

  it('IPC 失败静默（估算占位兜底，measuredMap 不写入失败项）', async () => {
    vi.mocked(listImageDimensions).mockRejectedValue(new Error('io'));
    const d = mk();
    await d.ensureRange(0, 1); // 不抛
    expect(d.measuredMap.value.size).toBe(0);
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/composables/useWebtoonDimensions.test.ts
```

预期：模块不存在。

- [ ] **步骤 3：实现（新建，3 参完整版——审查 P2-4：删原稿 2 参残缺版，只留一份可抄的实现）**

```ts
/**
 * useWebtoonDimensions.ts — webtoon 图头渐进测量（module3.1.0，spec §2.2）
 *
 * 复用 listImageDimensions IPC（3.0.6 图头解析）；按窗口批量、按名去重；
 * 失败静默（调用方 layout 对未测量项用 3:4 估算占位）。
 * 不共享 masonry composable：单列薄实现，避免反向耦合。
 */
import { ref, watch, type Ref } from 'vue';
import { listImageDimensions, type ImageDim } from '@/lib/tauri';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
import { PathUtils } from '@/lib/path';
import { log } from '@/lib/logger';

/** relPath = 书的 root 相对路径（ReaderView 从 reader store 的 currentRelPath 传入；根书传 ''）。
 * opts.onBeforeApply：每个 measured batch 写入前回调（viewer 捕获视口锚点用——二轮 P1-5，此时 measuredMap 还是旧值）。 */
export function useWebtoonDimensions(
  descriptor: Ref<SourceDescriptor>,
  names: Ref<readonly string[]>,
  relPath: Ref<string>,
  opts: { onBeforeApply?: () => void } = {},
) {
  const measuredMap = ref(new Map<string, { width: number; height: number }>());
  const requested = new Set<string>();
  const fullNameToName = new Map<string, string>(); // IPC fullPath → name 反查表（layout 以 name 消费）
  let inFlight: Promise<void> | null = null;
  // 二轮 P1-6：换书/跨卷代际。旧代在途响应回来时 epoch 不匹配 → 丢弃，
  // 否则旧卷 dims 会污染新卷 measuredMap（两卷同名 001.jpg 且反查表已清时按 full path 键写入旧尺寸）。
  let epoch = 0;

  async function ensureRange(start: number, end: number): Promise<void> {
    const batch: string[] = [];
    for (let i = Math.max(0, start); i < Math.min(end, names.value.length); i++) {
      const n = names.value[i];
      if (!requested.has(n)) {
        requested.add(n);
        // IPC 需要 source-relative 完整路径（审查 P1-3）：拼 relPath 前缀（MasonryView toRootRelativePath 同款语义）
        const full = relPath.value ? PathUtils.join(relPath.value, n) : n;
        fullNameToName.set(full, n);
        batch.push(full);
      }
    }
    if (batch.length === 0) return;
    if (inFlight) await inFlight.catch(() => {});
    const myEpoch = epoch;
    inFlight = (async () => {
      try {
        const dims: ImageDim[] = await listImageDimensions(descriptor.value, batch);
        if (myEpoch !== epoch) return;   // 旧代响应丢弃（二轮 P1-6）
        const next = new Map(measuredMap.value);
        for (const d of dims) {
          if (d.width <= 0 || d.height <= 0) continue;
          const name = fullNameToName.get(d.path);
          if (!name) continue;           // 反查失败跳过（防 full path 污染键；同代必命中，防御性）
          next.set(name, { width: d.width, height: d.height });
        }
        if (next.size !== measuredMap.value.size) {
          opts.onBeforeApply?.();        // 锚点捕获时机：measuredMap 仍是旧值（二轮 P1-5）
          measuredMap.value = next;
        }
      } catch (e) {
        log('[webtoon] listImageDimensions failed', e);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  // 换书/跨卷（relPath 或 descriptor 变化）：epoch 自增 + 清空 requested + 反查表 + measuredMap
  // ——跨卷同名 001.jpg 若不清会复用前一卷尺寸
  watch([relPath, descriptor], () => {
    epoch++;
    requested.clear();
    fullNameToName.clear();
    measuredMap.value = new Map();
  });

  return { measuredMap, ensureRange };
}
```

（锚点已核实：`ImageDim = { path, width, height }`（tauri.ts:202）、`PathUtils.join` 存在（lib/path.ts:60）、`reader store` 字段名 `currentRelPath`。）

- [ ] **步骤 4：运行验证通过 + Commit**

```bash
npx vitest run src/composables/useWebtoonDimensions.test.ts
git add src/composables/useWebtoonDimensions.ts src/composables/useWebtoonDimensions.test.ts
git commit -m "feat(webtoon): 图头渐进测量 composable（批量去重+失败静默）（任务 3/8）"
```

---

### 任务 4：WebtoonViewer 组件

**文件：**
- 创建：`src/components/reader/WebtoonViewer.vue`、`src/components/reader/WebtoonViewer.test.ts`

- [ ] **步骤 1：写失败测试（组件测，happy-dom 无真实布局——只断言挂载结构/类名/expose 值与源码守卫）**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { readFileSync } from 'node:fs';
import WebtoonViewer from './WebtoonViewer.vue';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listImageDimensions: vi.fn(async () => []) };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': {} } });

const URLS = ['asset://a.jpg', 'asset://b.jpg', 'asset://c.jpg'];
const NAMES = ['a.jpg', 'b.jpg', 'c.jpg'];

function mountViewer(extra: Record<string, unknown> = {}) {
  return mount(WebtoonViewer, {
    props: { urls: URLS, names: NAMES, descriptor: { type: 'local', rootPath: 'R:\\c' }, relPath: '' },
    global: { plugins: [i18n] },
    ...extra,
  });
}

describe('WebtoonViewer（module3.1.0）', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('挂载滚动容器 + strip + 窗口内 img（decoding=async）', async () => {
    const w = mountViewer();
    await flushPromises();
    expect(w.find('.webtoon-scroll').exists()).toBe(true);
    const imgs = w.findAll('.webtoon-item img');
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].attributes('decoding')).toBe('async');
    expect(imgs[0].attributes('src')).toBe('asset://a.jpg');
  });

  it('getTopVisibleImage：scrollTop=0 → 首图', async () => {
    const w = mountViewer();
    await flushPromises();
    expect(w.vm.getTopVisibleImage()).toBe('a.jpg');
  });

  it('setZoom clamp 1-4 + getZoom 可读（expose 全 getter，二轮 P0-1）', async () => {
    const w = mountViewer();
    await flushPromises();
    w.vm.setZoom(9);
    expect(w.vm.getZoom()).toBe(4);
    w.vm.setZoom(0.2);
    expect(w.vm.getZoom()).toBe(1);
  });

  it('isAtBottom()：getter 可读（非 ref——defineExpose 自动解包）', async () => {
    const w = mountViewer();
    await flushPromises();
    expect(typeof w.vm.isAtBottom).toBe('function');
    expect(w.vm.isAtBottom()).toBe(false);   // happy-dom 布局下 scrollTop=0 未到底
  });

  it('连续 3 次 Ctrl 缩放：共用一次锚点捕获，恢复 = 复合缩放锚点（三轮 P1-5）', async () => {
    const w = mountViewer();
    await flushPromises();
    const el = w.find('.webtoon-scroll').element as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 1000, writable: true });
    Object.defineProperty(el, 'scrollLeft', { value: 0, writable: true });
    w.vm.setZoom(1.1, 10, 20);
    w.vm.setZoom(1.2, 10, 20);
    w.vm.setZoom(1.3, 10, 20);              // 同 tick 连续 3 次
    const zoomEvents = w.emitted('zoom-change') as number[][];
    expect(zoomEvents.map((e) => e[0])).toEqual([1.1, 1.2, 1.3]);   // 状态链：每次都 emit
    await flushPromises();                  // nextTick 恢复跑完
    // 复合锚点一次换算：(1000+20)×(1.3/1)−20 = 1306（逐次乘 1.1→1.2→1.3 的错位方案会得错误值）
    expect(el.scrollTop).toBe(1306);
  });

  it('挂载即 emit zoom-change=1（跨卷重挂载归 1 → 菜单"重置缩放"禁用态同步，五轮 P1-4）', async () => {
    const w = mountViewer();
    await flushPromises();
    const events = w.emitted('zoom-change') as number[][];
    expect(events[0]).toEqual([1]);        // onMounted 重发当前 zoom（初始 1）
    w.vm.setZoom(2);
    expect(events.length).toBe(2);         // setZoom 再 emit
    // 模拟跨卷重挂载：新实例从 1 开始，同样 emit 1——父级 webtoonZoom 被拉回，旧卷 2x 不残留
    const w2 = mountViewer();
    await flushPromises();
    const events2 = w2.emitted('zoom-change') as number[][];
    expect(events2[0]).toEqual([1]);
  });

  it('连续跳转 A→B：唯一校正器使 A 失效，越过 A deadline 后只按 B 校正（七轮 P1 + 八轮 P2 + 十一轮 P2 deferred + 十二轮 P2 精确）', async () => {
    // 十一轮 P2：改 deferred mock（挂起 Promise 手动 resolve）。
    // 十二轮 P2：原方案 A/B 同 tick 创建后推进 3100ms 会同时结束 B 的 3s 校正器（B 的 stopAt
    // 也是 +3000）；且改变 c.jpg 自身高度不会改变其 top（top 是前缀和，c.top = a.h + b.h）。
    // 正确方案：错开 A/B 启动时间（B 的 deadline 在 A 之后）、只越过 A 的 deadline、
    // 改变 c 的前置项 a 的高度、断言精确 scrollTop。
    let resolveDim!: (v: { path: string; width: number; height: number }[]) => void;
    vi.mocked(listImageDimensions).mockImplementation(
      () => new Promise((r) => { resolveDim = r; }));
    vi.useFakeTimers();
    try {
      const w = mountViewer();
      await flushPromises();
      const el = w.find('.webtoon-scroll').element as HTMLElement;
      Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });

      // A 跳转：target=a.jpg（top=0）。A 校正 watch 挂上，deadline = T0 + 3000。
      w.vm.scrollToImage('a.jpg');
      // 错开 500ms 后发起 B——B 的 deadline = T0 + 3500，在 A 之后。
      vi.advanceTimersByTime(500);
      w.vm.scrollToImage('c.jpg');          // B target=c.jpg，A 的 activeCorrection 被 finish
      await flushPromises();
      const afterB = el.scrollTop;          // B 估算 top（c.top = a.h估算 + b.h估算）

      // 越过 A 的 deadline（T0+3000），但未到 B 的 deadline（T0+3500）——
      // 若 A 的 timeout 仍存活会错误置 activeCorrection=null，解除 B 的互斥。
      vi.advanceTimersByTime(2501);         // 总计 3001ms past T0

      // 改变 c 的前置项 a 的高度（a 估算 3:4 → 实测 1:1，高度变大）→ c.top 改变。
      // B 的校正 watch 应把 scrollTop 校正到 c 的新 top；A 的 watch 已 unwatch 不会拉回。
      resolveDim([{ path: 'a.jpg', width: 1000, height: 1000 }]);
      await flushPromises();                // IPC promise resolve + measuredMap watch 跑

      // 精确断言：a 实测高 = stripWidth(800) × 1000/1000 = 800（估算时 800×4/3≈1066.67）。
      // b 仍估算 800×4/3≈1066.67。c 新 top = 800 + 1066.67 = 1866.67。
      expect(el.scrollTop).toBeCloseTo(1866.67, 0);
      expect(el.scrollTop).toBeGreaterThanOrEqual(afterB);   // 单调不减（A 不把 B 往回拉）
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoScrollStep：正 dt 增 scrollTop（mock 元素属性）', async () => {
    const w = mountViewer();
    await flushPromises();
    const el = w.find('.webtoon-scroll').element as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 10000 });
    w.vm.autoScrollStep(1000, 60, 1);
    expect(el.scrollTop).toBe(60);
  });

  it('emit scroll-past-bottom：wheel deltaY>0 且 atBottom', async () => {
    const w = mountViewer();
    await flushPromises();
    const el = w.find('.webtoon-scroll');
    Object.defineProperty(el.element, 'scrollTop', { value: 999999, writable: true });
    Object.defineProperty(el.element, 'clientHeight', { value: 100 });
    Object.defineProperty(el.element, 'scrollHeight', { value: 1000 });
    // 审查 P1-5：atBottom 依赖 scrollTop ref（经 @scroll 更新）——必须先派发 scroll 再 wheel，
    // 否则 ref 仍是 0 → atBottom=false → 不 emit（原稿直改 el.scrollTop 不触发 scroll，必挂）
    await el.trigger('scroll');
    await el.trigger('wheel', { deltaY: 120 });
    expect(w.emitted('scroll-past-bottom')).toBeTruthy();
  });

  it('源码守卫：窗口外 v-if 卸载（非 v-show）、无 loading=lazy、普通滚轮不 preventDefault', () => {
    const src = readFileSync('src/components/reader/WebtoonViewer.vue', 'utf-8');
    expect(src).toContain('v-for="it in windowItems"');
    expect(src).not.toContain('v-show');
    expect(src).not.toContain('loading="lazy"');
    // 普通滚轮必须放行原生滚动：绑定不带 .prevent（preventDefault 只在 Ctrl 分支内调）
    expect(src).toContain('@wheel="onWheel"');
    expect(src).not.toMatch(/wheel\.prevent/);
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
npx vitest run src/components/reader/WebtoonViewer.test.ts
```

预期：组件不存在。

- [ ] **步骤 3：实现（新建 WebtoonViewer.vue）**

```vue
<script setup lang="ts">
/**
 * WebtoonViewer.vue — 竖条漫连续滚动视图（module3.1.0，spec §2-§4）
 *
 * 原生滚动容器 + 单列虚拟化 img strip（窗口外 v-if 卸载释放解码内存）。
 * 缩放 = strip 显式宽度 ×zoom（img width:100% 高度自然跟随，标准 CSS）。
 * Ctrl+滚轮锚点缩放 / 双击 1.0↔上次非 1 值；atBottom 响应式（scrollTop 参与）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
import {
  autoScrollDelta, captureAnchor, clampZoom, computeLayout,
  restoreAnchor, topVisibleIndex, visibleWindow,
} from '@/lib/webtoonLayout';
// （五轮 P2：删 anchoredScroll——setZoom 改共用锚点捕获后组件内已无调用；
//  tsconfig noUnusedLocals: true，留着是 vue-tsc 编译错。库函数与其单测保留。）
import { useWebtoonDimensions } from '@/composables/useWebtoonDimensions';

const props = withDefaults(defineProps<{
  /** 与 names 平行的 asset URL 列表（ReaderView convertFileSrc 产物） */
  urls: string[];
  names: string[];
  descriptor: SourceDescriptor;
  /** 书的 root 相对路径（图头 IPC 拼 fullPath 用，审查 P1-3；根书传 ''） */
  relPath: string;
  /** 0 = 不限宽 */
  maxWidth?: number;
  gap?: number;
}>(), { maxWidth: 0, gap: 0 });

const emit = defineEmits<{
  (e: 'scroll-past-bottom'): void;
  (e: 'scroll'): void;
  (e: 'wheel-delta', deltaY: number): void;
  (e: 'zoom-change', z: number): void;   // 三轮 P1-4：重置缩放按钮可用态链（ReaderView webtoonZoom ref）
}>();

const scrollEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const zoom = ref(1);
let lastNonUnityZoom = 2;

// 常规滚动锚定（二轮 P1-5）：measured batch 写入前捕获视口锚点，写入后按新 layout 恢复
let pendingAnchor: ReturnType<typeof captureAnchor> = null;

const { measuredMap, ensureRange } = useWebtoonDimensions(
  computed(() => props.descriptor),
  computed(() => props.names),
  computed(() => props.relPath),
  { onBeforeApply: () => {
    if (scrollTop.value <= 0) return;   // 顶部不打架（batch 影响的全在下方）
    pendingAnchor = captureAnchor(layout.value, scrollTop.value);   // 此时 measuredMap/layout 仍是旧值
  } },
);

const containerWidth = ref(800);

/** 容器内容基准宽（zoom 前）：min(容器宽, maxWidth||容器宽)。审查 P3：先声明再消费，守卫按 containerWidth 自身判 */
const baseWidth = computed(() => {
  const cw = containerWidth.value > 0 ? containerWidth.value : 800;
  return props.maxWidth > 0 ? Math.min(cw, props.maxWidth) : cw;
});

const layout = computed(() =>
  computeLayout(props.names, measuredMap.value, baseWidth.value * zoom.value, props.gap));
// 注：gap 固定 px 不随 zoom 缩放（spec §2.1，二轮 P2-10 语义定死）；宽度×zoom，高度随宽高比自然跟随

// 锚定恢复（二轮 P1-5，五轮 P2 时序修正，七轮 P1 改判 activeCorrection）：measured batch
// 应用 + DOM 重渲染后（flush:'post'）按新 layout 恢复 scrollTop。Vue watcher 时序真相：
// scrollToImage 的校正 watch 是默认 pre（渲染前跑）、本 watch 是 post（渲染后跑）——
// **锚定恢复后写**，会覆盖同 batch 的校正值。顶对齐跳转场景两者数学等价（ratio=0），
// 但为避免复杂角部场景打架，跳转进行中（activeCorrection 非空——声明在 scrollToImage 处，
// 运行时先于此回调初始化）的 batch 跳过锚定恢复。
watch(measuredMap, () => {
  if (activeCorrection) { pendingAnchor = null; return; }   // 六轮 P1-4：跳过时必须弃锚——否则跳转结束后陈旧锚点会把页面拉回
  if (!pendingAnchor) return;
  const target = restoreAnchor(layout.value, pendingAnchor);
  pendingAnchor = null;
  const el = scrollEl.value;
  if (target === null || !el) return;
  if (Math.abs(target - el.scrollTop) > 0.5) el.scrollTop = target;   // 赋值触发 scroll → onScroll 同步 ref
}, { flush: 'post' });

const windowRange = computed(() => visibleWindow(layout.value, scrollTop.value, viewportHeight.value));

const windowItems = computed(() => {
  const { start, end } = windowRange.value;
  const out: { name: string; url: string; top: number; height: number }[] = [];
  for (let i = start; i < end && i < props.names.length; i++) {
    out.push({
      name: props.names[i],
      url: props.urls[i],
      top: layout.value.tops[i],
      height: layout.value.heights[i],
    });
  }
  return out;
});

/** atBottom：scrollTop 参与判定（防 3.0.13 masonry atBottom stale 复辙） */
const atBottom = computed(() => {
  const el = scrollEl.value;
  if (!el) return false;
  return scrollTop.value + viewportHeight.value >= layout.value.totalHeight - 4;
});

function getTopVisibleImage(): string | null {
  const i = topVisibleIndex(layout.value, scrollTop.value);
  return props.names[i] ?? null;
}

/** 渐进校正滚动到指定图：立即跳估算位 + measuredMap 变化最多校正 5 次 / 3s。
 *  **组件级唯一校正器**（七轮 P1：旧版每次调用创建独立 watch/timeout 但共享一个布尔——
 *  连续跳转时旧 timeout 会提前解除新任务的互斥、旧 watch 会把滚动拉回旧目标）：
 *  开始新跳转先 finish 上一个；锚定恢复以 activeCorrection 非空为准。
 *  3s 收口是真的 setTimeout（六轮 P1-4）——measuredMap 不再变化也必然复位。 */
let activeCorrection: { finish: () => void } | null = null;

function scrollToImage(name: string): void {
  const target = () => {
    const i = props.names.indexOf(name);
    return i >= 0 ? layout.value.tops[i] : -1;
  };
  let y = target();
  if (y < 0 || !scrollEl.value) return;
  scrollEl.value.scrollTop = y;
  activeCorrection?.finish();                    // 取消上一个跳转（互斥随之复位，下面重建）
  let corrections = 0;
  let done = false;
  const stopAt = Date.now() + 3000;
  const un = watch(measuredMap, () => {
    if (done) return;
    if (corrections >= 5 || Date.now() > stopAt) { finish(); return; }
    const ny = target();
    if (ny >= 0 && ny !== y) {
      y = ny;
      corrections++;
      if (scrollEl.value) scrollEl.value.scrollTop = y;
    }
    if (corrections >= 5) finish();
  });
  const timeoutId = setTimeout(finish, 3000);    // 真 timeout 兜底：measuredMap 不再变也要复位
  activeCorrection = { finish };
  function finish(): void {
    if (done) return;
    done = true;
    clearTimeout(timeoutId);
    un();
    if (activeCorrection?.finish === finish) activeCorrection = null;   // 只清自己（新跳转已接管时不误清）
  }
}

// 三轮 P1-5：同 tick 连续 Ctrl+滚轮时，中间 setZoom 读到的 el.scrollTop 还是旧 DOM 空间值——
// 逐次按 newZ/oldZ 乘会复合错位。改为「共用一次锚点捕获」：首个未恢复的 setZoom 捕获基准
// （DOM 实际空间 scrollTop + 当时 zoom），后续 setZoom 只推进 zoom.value；nextTick 恢复时
// 按最终 zoom 一次换算 (base+c)×(z_final/z_base)−c——数学等价于复合缩放锚点。
let pendingZoomAnchor: {
  baseScrollTop: number; baseScrollLeft: number; baseZoom: number;
  ax: number; ay: number; hasX: boolean;
} | null = null;
let zoomRestoreScheduled = false;

function setZoom(z: number, anchorX?: number, anchorY?: number): void {
  const nz = clampZoom(z);
  if (nz === zoom.value) return;
  const el = scrollEl.value;
  // 二轮 P2-9 + 三轮 P1-5：先捕获（仅pending为空时——此时 el.scrollTop 是 DOM 真实空间值）
  // → 更新 zoom → nextTick DOM 布局完成后按最终 zoom 恢复（防旧 scrollHeight 钳位 + 横向锚点）。
  if (el && anchorY !== undefined && !pendingZoomAnchor) {
    pendingZoomAnchor = {
      baseScrollTop: el.scrollTop, baseScrollLeft: el.scrollLeft, baseZoom: zoom.value,
      ax: anchorX ?? 0, ay: anchorY, hasX: anchorX !== undefined,
    };
  }
  zoom.value = nz;
  if (nz !== 1) lastNonUnityZoom = nz;
  emit('zoom-change', nz);                       // 三轮 P1-4：状态回传
  if (pendingZoomAnchor && el && !zoomRestoreScheduled) {
    zoomRestoreScheduled = true;
    void nextTick(() => {
      zoomRestoreScheduled = false;
      const a = pendingZoomAnchor;
      pendingZoomAnchor = null;
      const nel = scrollEl.value;
      if (!a || !nel) return;
      const k = zoom.value / a.baseZoom;          // 最终 zoom 一次换算
      if (a.hasX) nel.scrollLeft = (a.baseScrollLeft + a.ax) * k - a.ax;
      nel.scrollTop = (a.baseScrollTop + a.ay) * k - a.ay;
    });
  }
}

/** Ctrl+滚轮锚点缩放（step 10%）；普通滚轮不拦截（原生滚动）+ 底部越滚观察 + 临时变速通知 */
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = scrollEl.value?.getBoundingClientRect();
    setZoom(
      zoom.value * dir,
      rect ? e.clientX - rect.left : undefined,
      rect ? e.clientY - rect.top : undefined,
    );
    return;
  }
  // 普通滚轮：通知 ReaderView（自动滚动临时变速用，spec §4）
  emit('wheel-delta', e.deltaY);
  if (e.deltaY > 0 && atBottom.value) emitScrollPastBottom();
}

/** 底部越滚节流 800ms（spec §6） */
let lastBottomEmit = 0;
function emitScrollPastBottom(): void {
  const now = Date.now();
  if (now - lastBottomEmit < 800) return;
  lastBottomEmit = now;
  emit('scroll-past-bottom');
}

function onDblclick(e: MouseEvent): void {
  const rect = scrollEl.value?.getBoundingClientRect();
  const ax = rect ? e.clientX - rect.left : undefined;
  const ay = rect ? e.clientY - rect.top : undefined;
  if (zoom.value === 1) setZoom(lastNonUnityZoom, ax, ay);
  else setZoom(1, ax, ay);
}

/** 自动滚动单步（ReaderView rAF 驱动）；factor=滚轮临时变速（2s 回落由 ReaderView 管） */
function autoScrollStep(dt: number, speed: number, factor: number): void {
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + autoScrollDelta(speed, factor, dt));
}

let ro: ResizeObserver | null = null;
function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
  containerWidth.value = el.clientWidth;
  emit('scroll'); // ReaderView 节流更新顶部图/页码/atBottom
}
function syncGeometry(): void { onScroll(); }

onMounted(() => {
  onScroll();
  ro = new ResizeObserver(() => syncGeometry());
  if (scrollEl.value) ro.observe(scrollEl.value);
  emit('zoom-change', zoom.value);   // 五轮 P1-4：挂载即重发当前 zoom（跨卷重挂载归 1 → 菜单禁用态同步）
  void ensureRange(windowRange.value.start, windowRange.value.end);
});
onUnmounted(() => { ro?.disconnect(); ro = null; });

// 窗口移动 → 预读图头
watch(windowRange, (r) => { void ensureRange(r.start, r.end); });

// 二轮 P0-1：defineExpose 经 proxyRefs 自动解包 ref——暴露 ref 父级拿到的是解包值，.value 不成立。
// 全部用普通 getter（项目先例：SinglePageViewer 的 getViewer()）。atBottom/scrollEl/zoom 内部仍是 ref/computed。
defineExpose({
  scrollToImage,
  getTopVisibleImage,
  isAtBottom: () => atBottom.value,
  setZoom,
  getZoom: () => zoom.value,
  autoScrollStep,
  getScrollEl: () => scrollEl.value,   // ReaderView scrollScreen（键盘滚屏）/jumpFirst/jumpLast 用
});
</script>

<template>
  <div
    ref="scrollEl"
    class="webtoon-scroll"
    @scroll.passive="onScroll"
    @wheel="onWheel"
    @dblclick="onDblclick"
  >
    <div
      class="webtoon-strip"
      :style="{ width: (baseWidth * zoom) + 'px', height: layout.totalHeight + 'px' }"
    >
      <div
        v-for="it in windowItems"
        :key="it.name"
        class="webtoon-item"
        :style="{ position: 'absolute', top: it.top + 'px', left: 0, width: '100%', height: it.height + 'px' }"
      >
        <img :src="it.url" :alt="it.name" decoding="async" draggable="false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.webtoon-scroll {
  height: 100%;
  overflow: auto; /* 纵横双向（zoom>1 时横向可达） */
  background: var(--color-bg);
}
.webtoon-strip {
  position: relative;
  margin: 0 auto; /* maxWidth 限宽居中 */
}
.webtoon-item img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
```

注意（审查 P2-4：原「注意两点」第一条的 `@wheel.prevent` 修正已直接内化到上方模板与测试，执行时无需再改）：

- happy-dom 无 ResizeObserver 时空实现兜底：`if (typeof ResizeObserver === 'undefined') ro = null;`。

- [ ] **步骤 4：运行验证通过**

```bash
npx vitest run src/components/reader/WebtoonViewer.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add src/components/reader/WebtoonViewer.vue src/components/reader/WebtoonViewer.test.ts
git commit -m "feat(webtoon): WebtoonViewer 滚动容器（虚拟窗口/锚点缩放/底部越滚/渐进定位）（任务 4/8）"
```

---

### 任务 5：useWebtoonProgress（记录 + finished）

**文件：**
- 创建：`src/composables/useWebtoonProgress.ts`、`src/composables/useWebtoonProgress.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { effectScope, ref } from 'vue';
import { useWebtoonProgress } from './useWebtoonProgress';
import { saveProgress, markFinished } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, saveProgress: vi.fn(), markFinished: vi.fn() };
});

function setup(atBottom = ref(false)) {
  return useWebtoonProgress({
    bookId: ref(105),
    atBottom,
  });
}

describe('useWebtoonProgress（module3.1.0）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('顶部图变化 300ms debounce 后 saveProgress（readerMode=webtoon，image_name 第五参）', async () => {
    const p = setup();
    p.notifyTopChanged('p005.jpg', 4);
    expect(saveProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(310);
    // 签名 (bookId, page, readerMode, finished?, imageName?)——审查 P1-2 修正
    expect(saveProgress).toHaveBeenCalledWith(105, 4, 'webtoon', undefined, 'p005.jpg');
  });

  it('同图不重复写（连续两次同图只写一次；首次必写——lastImage 初始 null，审查 P1-4）', async () => {
    const p = setup();
    p.notifyTopChanged('p001.jpg', 0);
    p.notifyTopChanged('p001.jpg', 0);   // 第二次同图被去重
    vi.advanceTimersByTime(310);
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it('flushNow：await 写入完成后返回（二轮 P1-7——跨卷 trySave 契约）', async () => {
    const p = setup();
    p.notifyTopChanged('p005.jpg', 4);
    await p.flushNow();                  // 不等 300ms 直接冲刷；await 后 saveProgress 必已发出
    expect(saveProgress).toHaveBeenCalledWith(105, 4, 'webtoon', undefined, 'p005.jpg');
    vi.advanceTimersByTime(310);         // 冲刷后不重复写
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it('flushNow：debounce 写入在途时调用仍 await 链尾（八轮 P1-1 + 十一轮 P2 deferred）', async () => {
    // 十一轮 P2：原 mock 立即完成，runAllTimersAsync 不能证明 flushNow 等待写链——
    // 改 deferred mock（挂起 saveProgress Promise 手动 resolve），验证 resolve 前后状态。
    const p = setup();
    let resolveSave!: () => void;
    vi.mocked(saveProgress).mockImplementation(
      () => new Promise((r) => { resolveSave = r; }));
    p.notifyTopChanged('p005.jpg', 4);
    vi.advanceTimersByTime(310);            // debounce 到期 → saveProgress 发起、挂起
    expect(saveProgress).toHaveBeenCalledTimes(1);
    // pending 已空但写入在途——flushNow 必须等链尾，不能立即 resolve
    let resolved = false;
    const done = p.flushNow().then(() => { resolved = true; });
    await Promise.resolve();                // microtask 推进
    expect(resolved).toBe(false);           // 仍在途 → 未 resolve（deferred mock 证明）
    resolveSave();                          // 手动让挂起的 saveProgress 完成
    await done;
    expect(resolved).toBe(true);            // 链尾完成 → flushNow resolve
  });

  it('flushNow：A/B 完成顺序反转——串行链防迟到覆盖（八轮 P1-1）', async () => {
    const p = setup();
    // A 写：挂起（让 B 先入链尾但被 A 阻塞）
    let resolveA!: () => void;
    vi.mocked(saveProgress).mockImplementationOnce(
      () => new Promise((r) => { resolveA = r; }));
    vi.mocked(saveProgress).mockImplementationOnce(async () => undefined);  // B 正常
    p.notifyTopChanged('pA.jpg', 1);     // A 入链（debounce 路径）
    vi.advanceTimersByTime(310);         // A 开始执行、挂起
    p.notifyTopChanged('pB.jpg', 2);     // B 入 pending
    const flushB = p.flushNow();         // B 入链尾（被 A 阻塞）
    await Promise.resolve();
    expect(vi.mocked(saveProgress)).toHaveBeenCalledTimes(1);   // 只 A 发了
    resolveA();                          // A 完成 → 链释放 → B 才发
    await flushB;
    expect(vi.mocked(saveProgress)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveProgress)).toHaveBeenNthCalledWith(2, 105, 2, 'webtoon', undefined, 'pB.jpg');
  });

  it('writeTail：首写失败后次写仍执行（九轮 P1-2——旧链 reject 不永久中断）', async () => {
    const p = setup();
    vi.mocked(saveProgress).mockRejectedValueOnce(new Error('io'));   // A 失败
    vi.mocked(saveProgress).mockImplementationOnce(async () => undefined);  // B 应成功
    p.notifyTopChanged('pA.jpg', 1);
    await p.flushNow().catch(() => undefined);   // A 失败（自 catch 防未处理 rejection）
    expect(saveProgress).toHaveBeenCalledTimes(1);
    p.notifyTopChanged('pB.jpg', 2);
    await p.flushNow();                          // B 必须仍执行（旧链已 catch 恢复）
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenNthCalledWith(2, 105, 2, 'webtoon', undefined, 'pB.jpg');
  });

  it('onScopeDispose：scope 结束清 timer 但保留 pending——onUnmounted 的 flushNow 仍写出（三轮 P0-2）', async () => {
    const scope = effectScope();
    const atBottom = ref(false);
    const p = scope.run(() => useWebtoonProgress({
      bookId: ref(105), atBottom,
    }))!;
    atBottom.value = true;
    await Promise.resolve();             // watch flush → stableTimer 建立
    vi.advanceTimersByTime(600);         // 0.6s（<1.2s，timer 仍在挂）
    p.notifyTopChanged('p009.jpg', 8);   // debounce pending
    scope.stop();                        // 离开阅读器（scope.stop 先于 onUnmounted）
    vi.advanceTimersByTime(5000);
    expect(markFinished).not.toHaveBeenCalled();   // stable timer 已清，不迟到写库
    expect(saveProgress).not.toHaveBeenCalled();   // debounce timer 已清
    // 三轮 P0-2：pending 保留——模拟 ReaderView onUnmounted 调 flushNow，最后位置不丢
    await p.flushNow();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(105, 8, 'webtoon', undefined, 'p009.jpg');
  });

  it('ensureFinished：立即标完（幂等 + in-flight 去重 + 失败可重试，五轮 P0-2）', async () => {
    const atBottom = ref(false);
    const p = setup(atBottom);
    atBottom.value = true;
    await Promise.resolve();
    vi.advanceTimersByTime(500);              // stable 在途（<1.2s）
    await p.ensureFinished();                 // 不等稳定窗口，立即标
    expect(markFinished).toHaveBeenCalledTimes(1);
    expect(markFinished).toHaveBeenCalledWith(105, true);
    vi.advanceTimersByTime(3000);             // stableTimer 到期再调 ensureFinished——幂等
    expect(markFinished).toHaveBeenCalledTimes(1);
    await p.ensureFinished();                 // 幂等（finishedMarked 已置）
    expect(markFinished).toHaveBeenCalledTimes(1);
  });

  it('ensureFinished：写库失败不置位，可重试（五轮 P0-2——旧版先置位会永久 no-op）', async () => {
    const p = setup();
    vi.mocked(markFinished).mockRejectedValueOnce(new Error('db'));
    expect(await p.ensureFinished()).toBe(false);   // 失败
    expect(await p.ensureFinished()).toBe(true);    // 重试成功
    expect(markFinished).toHaveBeenCalledTimes(2);
  });

  it('ensureFinished：并发去重——两个同时调用共享 in-flight，markFinished 仅 1 次', async () => {
    const p = setup();
    const [a, b] = await Promise.all([p.ensureFinished(), p.ensureFinished()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(markFinished).toHaveBeenCalledTimes(1);
  });

  it('ensureFinished：in-flight 按卷绑定——旧卷在途时切新卷，新卷不复用旧 promise（六轮 P1-2）', async () => {
    const bookId = ref(105);
    let resolveA!: () => void;
    vi.mocked(markFinished)
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))   // 旧卷 105：挂起
      .mockImplementationOnce(async () => undefined);                          // 新卷 206：正常
    const p = useWebtoonProgress({ bookId, atBottom: ref(false) });
    const first = p.ensureFinished();          // 旧卷发起，在途
    bookId.value = 206;                        // 写库期间换卷（composable watch → reset）
    await Promise.resolve();
    const second = await p.ensureFinished();   // 新卷不复用旧 promise，发自己的 markFinished(206)
    expect(markFinished).toHaveBeenNthCalledWith(2, 206, true);
    expect(second).toBe(true);
    resolveA();                                // 旧卷 promise 完成
    expect(await first).toBe(true);            // 旧卷写成功返回 true；epoch 校验不置 finishedMarked（当前卷 206 未被污染）
    expect(markFinished).toHaveBeenCalledTimes(2);
  });

  it('atBottom 持续 1.2s → markFinished(true) 一次', async () => {
    const atBottom = ref(false);
    setup(atBottom);
    atBottom.value = true;
    await Promise.resolve();   // 审查 P1-4：watch（pre flush）排 microtask，须先 flush 再走假 timer
    vi.advanceTimersByTime(1300);
    expect(markFinished).toHaveBeenCalledTimes(1);
    expect(markFinished).toHaveBeenCalledWith(105, true);
    // 持续 true 不重复
    vi.advanceTimersByTime(3000);
    expect(markFinished).toHaveBeenCalledTimes(1);
  });

  it('atBottom 短暂抖动（<1.2s 回 false）不标 finished', async () => {
    const atBottom = ref(false);
    setup(atBottom);
    atBottom.value = true;
    await Promise.resolve();   // 同上
    vi.advanceTimersByTime(600);
    atBottom.value = false;
    await Promise.resolve();   // 同上
    vi.advanceTimersByTime(2000);
    expect(markFinished).not.toHaveBeenCalled();
  });
});
```

（**tauri.ts 前置改动**（本任务步骤 3 一并提交）：① `saveProgress` 第三参类型 `readerMode: 'single' | 'double'` 扩为 `'single' | 'double' | 'webtoon'`（tauri.ts:408）——Rust 端 `save_progress` 的 `reader_mode` 是 String 直存 DB，无需改 Rust、无迁移；② **`ProgressItem.readerMode`（tauri.ts:383）同步扩**为 `'single' | 'double' | 'webtoon'`（审查 P2-2：webtoon 写入后返回类型不再撒谎；前端当前无该字段消费方，纯类型契约）。）

补充用例（审查 P1-4：bookId 变化自动 reset）：

```ts
  it('bookId 变化自动 reset：跨卷同名首图仍写进度 + 新卷可再标 finished', async () => {
    const bookId = ref(105);
    const atBottom = ref(false);
    const p = useWebtoonProgress({ bookId, atBottom });
    // 卷 1 读完
    atBottom.value = true;
    await Promise.resolve();   // 三轮 P2-9：watch（pre flush）排 microtask，须先 flush 再走假 timer
    vi.advanceTimersByTime(1300);
    expect(markFinished).toHaveBeenCalledTimes(1);
    // 跨卷 → bookId 变化 → auto reset
    bookId.value = 206;
    await Promise.resolve(); // watch flush
    // 新卷顶部又是同名 001.jpg —— lastImage 已被 reset，必须写进度
    p.notifyTopChanged('001.jpg', 0);
    vi.advanceTimersByTime(310);
    expect(saveProgress).toHaveBeenCalledWith(206, 0, 'webtoon', undefined, '001.jpg');
    // 新卷滚到底 → finishedMarked 已 reset，可再标
    atBottom.value = false;
    await Promise.resolve();
    atBottom.value = true;
    await Promise.resolve();   // 三轮 P2-9：同上
    vi.advanceTimersByTime(1300);
    expect(markFinished).toHaveBeenCalledTimes(2);
    expect(markFinished).toHaveBeenLastCalledWith(206, true);
  });
```

- [ ] **步骤 2：验证失败 → 步骤 3：实现（新建）**

```ts
/**
 * useWebtoonProgress.ts — webtoon 进度记录（module3.1.0，spec §5）
 * 300ms debounce 记顶部可见图；atBottom 稳定 1.2s 标 finished（STABLE_MS 对齐瀑布流）；
 * flushNow 立即冲刷 pending（卸载/跨卷前调用——审查 P0-2 双写防护的 webtoon 侧）。
 */
import { onScopeDispose, watch, type Ref } from 'vue';
import { saveProgress, markFinished } from '@/lib/tauri';
import { log } from '@/lib/logger';

const DEBOUNCE_MS = 300;
/** 稳定窗口（导出供 ReaderView 自动跨卷前的等待对齐——三轮 P1-3）。 */
export const STABLE_MS = 1200;

export function useWebtoonProgress(opts: {
  bookId: Ref<number | null>;
  atBottom: Ref<boolean>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastImage: string | null = null;
  // pending pair：flushNow 需在 debounce 到期前拿到待写值（一轮 P0-2）
  let pendingImage: string | null = null;
  let pendingIndex = 0;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let finishedMarked = false;

  // 八轮 P1-1：进度写串行链。debounce 到期或 flushNow 触发的写入都挂到链尾，
  // 保证跨卷前的 flushNow 能 await 链尾——否则 pending 已被 debounce 清掉但 saveProgress
  // 在途时，flushNow 直接返回会让跨卷 trySave 拿不到失败结果，且 A 写迟到可能覆盖 B 写。
  let writeTail: Promise<void> = Promise.resolve();

  function notifyTopChanged(image: string, index: number): void {
    if (image === lastImage) return;
    lastImage = image;
    pendingImage = image;
    pendingIndex = index;
    if (timer) clearTimeout(timer);
    // debounce 路径自行 catch（flushNow 失败向外抛——显式调用方负责，二轮 P1-7）
    timer = setTimeout(() => {
      timer = null;
      flushNow().catch((e) => log('[webtoon] saveProgress failed', e));
    }, DEBOUNCE_MS);
  }

  /** 立即冲刷 pending 记录（幂等：无 pending 时 no-op）。**始终 await 串行写链的尾**——
   *  即使 pending 已空，debounce 到期的写入可能仍在途；不等就返回会破坏"跨卷前 await 写入
   *  完成"契约（八轮 P1-1）。
   *  返回 Promise 且 await 写入完成——跨卷 trySave 的 await 契约（二轮 P1-7：保存完成后才导航、失败可进错误处理）。
   *  失败向外抛；debounce 定时器路径在上面自行 catch。 */
  async function flushNow(): Promise<void> {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pendingImage !== null) {
      const image = pendingImage;
      const index = pendingIndex;
      pendingImage = null;
      const bookId = opts.bookId.value;
      // 九轮 P1-2：旧链 reject 后 .then 会被跳过——后续保存永久中断。排队前 catch 恢复旧链，
      // 当前 job 的 rejection 继续返回调用方（flushNow await 会抛，debounce 路径自 catch）。
      const job = writeTail
        .catch(() => undefined)
        .then(async () => {
          if (bookId === null) return;
          // await 后 bookId 仍可能变（跨卷）；写参数固定为发起时的 bookId——saveProgress 不会跨书误写，
          // 只是迟到写入若已过时会被下一卷的 flushNow 再次覆盖（用户当前顶图更新于新卷数据）。
          await saveProgress(bookId, index, 'webtoon', undefined, image);
        });
      writeTail = job;
    }
    await writeTail;
  }

  watch(opts.atBottom, (b) => {
    if (b) {
      if (stableTimer || finishedMarked) return;
      stableTimer = setTimeout(() => {
        stableTimer = null;
        void ensureFinished();
      }, STABLE_MS);
    } else {
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    }
  });

  /** 换书自动重置（审查 P1-4）：跨卷后 finishedMarked 必须清（新卷可再标完），
   * lastImage 必须清（跨卷同名首图 001.jpg 不被去重吞掉）。不依赖调用方手动 reset。 */
  watch(opts.bookId, (nb, ob) => {
    if (ob !== null && nb !== ob) reset();
  });

  /** 确保当前卷已标 finished（三轮 P1-3 引入 finishNow，五轮 P0-2 重构为 ensureFinished）。
   *  语义：① 幂等（已标 → true）② 并发去重——**in-flight 按发起时的 bookId 绑定，仅同卷共享**
   *  （六轮 P1-2：旧卷在途时切新卷，新卷不复用旧 promise——否则拿到旧卷的 true 却没写过新卷，
   *  新卷直接发起自己的写入）③ **成功才置 finishedMarked**（写库失败保持 false 可重试）
   *  ④ await 后核对 bookId 未变才置位（防旧卷 promise 完成污染新卷状态）。
   *  返回 true = 已标/本次落库成功；false = 失败或发起时无 bookId。
   *  自动跨卷（autoEnd）与手动越底（requestCrossVolumeNext）都必须 await true 后才能发起。 */
  let finishedInFlight: { bookId: number; p: Promise<boolean> } | null = null;

  async function ensureFinished(): Promise<boolean> {
    if (finishedMarked) return true;
    const bookId = opts.bookId.value;
    if (bookId === null) return false;
    if (finishedInFlight?.bookId === bookId) return finishedInFlight.p;   // 仅同卷去重
    const p = (async () => {
      try {
        await markFinished(bookId, true);
        if (opts.bookId.value === bookId) finishedMarked = true;   // epoch：写库期间换卷不置位
        return true;
      } catch (e) {
        log('[webtoon] markFinished failed', e);
        return false;                                              // 失败可重试
      } finally {
        if (finishedInFlight?.p === p) finishedInFlight = null;    // 只清自己的记录（后发卷先完成时不误删）
      }
    })();
    finishedInFlight = { bookId, p };
    return p;
  }

  /** 手动重置（兜底，测试/特殊场景用） */
  function reset(): void {
    lastImage = null;
    pendingImage = null;
    finishedMarked = false;
    if (timer) clearTimeout(timer);
    if (stableTimer) clearTimeout(stableTimer);
    timer = stableTimer = null;
  }

  // 三轮 P0-2：Vue 卸载顺序 scope.stop() **先于** onUnmounted——这里若清 pendingImage，
  // ReaderView onUnmounted 的 flushNow() 会变 no-op，丢最后 300ms 位置。
  // 故只清 timer（防迟到写入/finished 迟到标记），pending 留给 flushNow 消费（幂等，不调不写）。
  onScopeDispose(() => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
  });

  return { notifyTopChanged, flushNow, ensureFinished, reset };
}
```

- [ ] **步骤 4：验证通过 + Commit**

```bash
npx vitest run src/composables/useWebtoonProgress.test.ts
git add src/composables/useWebtoonProgress.ts src/composables/useWebtoonProgress.test.ts
git commit -m "feat(webtoon): 进度记录 composable（debounce 顶部图 + atBottom 标完 + flushNow 冲刷）（任务 5/8）"
```

---

### 任务 6：ReaderView / ReaderScreen / 输入映射接线

**文件：**
- 修改：`src/composables/useReaderBookLoader.ts`（P1-2/P1-4：snapshot 加 restoreImageIndex）+ 测试
- 修改：`src/lib/inputBindings.ts` + `.test.ts`（P1-1：webtoonKeyBindings）
- 修改：`src/composables/useReaderHotkeys.ts` + `.test.ts`（P1-1：isWebtoon + 四 override）
- 修改：`src/components/reader/ReaderScreen.vue`（CRLF；mode 分支 + P0-1 接线 + pageOverride）
- 修改：`src/views/ReaderView.vue`（CRLF；webtoon 分支 + P0-2 双写防护）
- 修改：`src/views/ReaderView.test.ts`、`src/components/reader/ReaderScreen.test.ts`
- **不改** `src/composables/useReaderWheel.ts`（既有 `disabled` 选项直接用，P2-1）

- [ ] **步骤 0：useReaderBookLoader snapshot 加 `restoreImageIndex`（一轮 P1-2 + 二轮 P1-4）**

背景：getProgress 在 loader 内部调用（useReaderBookLoader.ts:152），`ReaderBookSnapshot` 只暴露折叠后的 `initialSpreadIndex`——且它是 **spread 索引**（webtoon 下 loader 仍按 `readerDefaultMode === 'single'` 判定 → 双页 plan），直接当图索引用会错位（page 10 恢复到第 5 张）。loader 内完成图索引全链解析：

(a) `ReaderBookSnapshot` 接口加 `restoreImageIndex: number`。
(b) `loadBookById` 内两步改造（三轮 P0-1：现有 `const progress` 声明在 else 块内（useReaderBookLoader.ts:152），分支外不可见——原稿表达式照抄编译失败）：

```ts
// ① 提升到分支外（替代原 if/else 内的 const progress = await getProgress(...)）：
let progress: Awaited<ReturnType<typeof getProgress>> = null;
if (!explicitHit) {
  progress = await getProgress(bookId);
}
// else 块内原 resolveInitialSpreadIndex(progress, ...) 调用不动（progress 此时必非 null，
// 传参类型 ProgressItem | null 兼容）。

// ② initialSpreadIndex 计算后追加（page 下限也钳 0——三轮 P0-1，脏 DB 数据兜底）：
const restoreImageIndex = explicitHit
  ? imageNames.indexOf(opts.explicitImageName!)
  : (!progress || progress.finished) ? 0            // 无进度 / finished → 第 0 张（对齐 resolveInitialSpreadIndex finished→0，一轮 P2-6）
  : (progress.imageName && imageNames.includes(progress.imageName))
    ? imageNames.indexOf(progress.imageName)        // imageName 命中（改名文件 miss 自动落到 page）
    : Math.max(0, Math.min(progress.page, imageNames.length - 1));
```

reader 侧（single/double）不消费此字段（initialSpreadIndex 照旧），纯增量。loader 单测加 3 用例（imageName 命中 → 索引；finished → 0；仅 page → page 钳位）。

- [ ] **步骤 1：ReaderScreen mode 扩展 + slideshow 接线 mode-aware（审查 P0-1）**

(a) `mode?: 'single' | 'double'` 类型改 `mode?: 'single' | 'double' | 'webtoon'`（props interface + 默认值处）。
(b) viewer 切换 watch（`props.mode === 'single' ? ... : ...` 处）加 webtoon 分支：webtoon 时不取 OSD viewerRef（`scaleViewerRef` 置 null，useReaderScale 不作用）。
(c) 模板 `v-if` 链：**先把 `DoublePageViewer` 的 `v-else` 改 `v-else-if="mode === 'double'"`**（原 v-else 兜底会吞掉 webtoon 分支），再加：

```vue
    <WebtoonViewer
      v-else-if="mode === 'webtoon' && descriptor"
      :key="`${descriptorId(descriptor)}|${relPath}`"
      ref="webtoonRef"
      :urls="pageUrls"
      :names="pageNames"
      :descriptor="descriptor"
      :rel-path="relPath"
      :max-width="webtoonMaxWidth"
      :gap="webtoonGap"
      @scroll="onViewerScroll"
      @wheel-delta="$emit('wheel-delta', $event)"
      @zoom-change="$emit('zoom-change', $event)"
      @scroll-past-bottom="$emit('scroll-past-bottom')"
    />
```

新增 props：`pageNames: string[]`、`descriptor?: SourceDescriptor`（**可选**——三层判空链中环，三轮 P1-7）、`relPath: string`（书的 root 相对路径）、`webtoonMaxWidth: number`、`webtoonGap: number`、`pageOverride?: number | null`；emit `scroll` / `wheel-delta` / `zoom-change`（透传）/ `scroll-past-bottom`（透传）；`webtoonRef` defineExpose 转发（`getWebtoon(): 暴露类型 | null`）。import WebtoonViewer + `import { descriptorId } from '@/lib/sourceDescriptor'`（九轮 P0：`descriptor` 是 `SourceDescriptor` 联合类型，Archive/SMB/WebDAV 变体无 `rootPath`——复用现有 `descriptorId(desc)` 造稳定 key，避免 vue-tsc 阻塞）。（v-if 双条件收窄后，WebtoonViewer 的必填 descriptor prop 类型可保持不变。十轮 P1-2 后 `webtoonAtBottom` getter prop 不再需要——setIsAtLast 恒 false，rAF autoEnd 读 ReaderView 本地 ref。）

**`:key` 防御**（八轮 P1-2）：基于 `descriptorId(descriptor) | relPath`——跨卷时身份变化强制 Vue 重建组件实例，`onMounted` 重发 `zoom-change=1`、`activeCorrection`/`pendingZoomAnchor`/`measuredMap`/`requested` 随新实例干净起步。注：跨卷本身在 ReaderView 不变量 3 下也会经 `visibleReader=false` 卸载 ReaderScreen 触发 KeepAlive 销毁——viewer 重挂载是隐式成立的，`:key` 把这个不变量显式化，防后续 KeepAlive 策略变化破坏假设。

(d) `currentPage` computed 首行加 `if (props.pageOverride != null) return props.pageOverride;`——watermark 与 ReaderOverlay 页码一处改两处生效（审查 P1-3）。

(e) **slideshow 接线 mode-aware**（改 onMounted 现有 setAdvance/setPrev/setIsAtLast 三行，ReaderScreen.vue:270-272）：

```ts
slideshow.setAdvance(() => { if (props.mode !== 'webtoon') store.nextPage(); });
slideshow.setPrev(() => { if (props.mode !== 'webtoon') store.prevPage(); });
// 十轮 P1-2：webtoon 下 setIsAtLast 恒 false——interval tick 不参与结束/跨卷。
// 原方案返回 webtoonAtBottom() 有竞态：interval 可能在 rAF pause 前先 tick → atLast 分支
// 直接 pause + pendingNextVolume，绕过稳定窗口和 ensureFinished（旧卷永不标完）。
// webtoon 到底只由 rAF autoEnd 状态机独占处理（步骤 3(e)）。
slideshow.setIsAtLast(() => props.mode === 'webtoon' ? false : store.isAtLastSpread);
```

闭包内读 `props.mode`（响应式 prop），运行中 cycle 切模式无需重接线。语义：webtoon 下 advance/prev 短路 no-op（interval 空转无害），`setIsAtLast` 恒 false（十轮 P1-2）——**interval tick 在 webtoon 下完全不参与结束/跨卷**，rAF autoEnd 状态机独占（步骤 3(e)）。原稿未处置这条接线：webtoon 播放会 rAF + interval 双驱动，且 spread-index 摸到末页会触发与滚动位置无关的错误时机跨卷。

(f) **overlay ◀▶ / 跳页按钮 webtoon 分流（五轮——四轮审查发现的第三条 store 直调链）**：ReaderScreen 现有 `onNext/onPrev`（:302-309）直调 `store.nextPage()/prevPage()`、`onJump`（:313-319）直调 `jumpToSpread`——ReaderOverlay 的 ◀▶ 按钮（:284/:308）与跳页输入（:102）都走这条链。webtoon 下点 ▶：spread 不可见推进 → atLast 触发 `onAtLastNextAttempt` → `pendingNextVolume` → **错误跨卷**。改：

```ts
function scrollByScreen(dir: 1 | -1): void {
  const el = webtoonRef.value?.getScrollEl();
  if (!el) return;
  el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: 'auto' });
}
function onPrev() {
  if (props.mode === 'webtoon') { scrollByScreen(-1); return; }
  store.prevPage();
  slideshow.reset();
}
function onNext() {
  if (props.mode === 'webtoon') { scrollByScreen(1); return; }
  store.nextPage();
  slideshow.reset();
}
function onJump(page: number) {
  if (props.mode === 'webtoon') {
    const clamped = Math.max(0, Math.min(page - 1, props.pageNames.length - 1));
    const name = props.pageNames[clamped];
    if (name) webtoonRef.value?.scrollToImage(name);
    return;
  }
  // 现有 spread 逻辑不动
  const target = page - 1;
  const idx = SpreadPlanner.spreadIndexForPage(target, finalSpreads.value);
  store.jumpToSpread(idx);
  slideshow.reset();
}
```

（webtoon 分支不调 `slideshow.reset()`——interval 空转无害。）

- [ ] **步骤 2：inputBindings webtoonKeyBindings + useReaderHotkeys override（审查 P1-1）**

背景：nextPage/prevPage/jumpFirst/jumpLast 在 `useReaderHotkeys.ts:50-106` dispatch 内部直调 store——ReaderView **没有**「actions 构造处」，原稿「不动 useReaderHotkeys + 在 ReaderView 分流」不可实现。且 **Space 已绑 `slideshowToggle`**（inputBindings.ts:64），原稿「Space=上滚一屏」与之冲突——Space 保留播放/暂停（webtoon 下=自动滚动开关，语义正好）。

(a) `inputBindings.ts` 在 `defaultKeyBindings` 之后追加：

```ts
/** module3.1.0 webtoon 专用键位：↑/↓ 承担滚屏；←/→ 解绑（zoom>1 留给原生横向滚动）；
 * Space/p/F5 保留 slideshowToggle（webtoon 下 = 自动滚动播放/暂停）。 */
export const webtoonKeyBindings: KeyBindings = {
  ...defaultKeyBindings,
  prevPage: ['PageUp', 'ArrowUp'],
  nextPage: ['PageDown', 'ArrowDown'],
};
```

（`inputBindings.test.ts` 加用例：webtoon 表下 ArrowUp→prevPage、ArrowDown→nextPage、ArrowLeft/ArrowRight→null、' '→slideshowToggle 不变。）

(b) `useReaderHotkeys.ts`：`ReaderHotkeyActions` 扩五个可选字段；`onKeydown` 按 isWebtoon 选绑定表，dispatch 前查 override（对齐既有 folderNext → actions.nextVolume 注入模式，single/double 不传 → 行为零变化）：

```ts
export interface ReaderHotkeyActions {
  nextVolume?: () => void;
  prevVolume?: () => void;
  /** module3.1.0：返回 true 时用 webtoonKeyBindings 解析，且下方四 override 生效 */
  isWebtoon?: () => boolean;
  nextPage?: () => void;
  prevPage?: () => void;
  jumpFirst?: () => void;
  jumpLast?: () => void;
}
```

```ts
  function onKeydown(e: KeyboardEvent): void {
    const wt = actions.isWebtoon?.() ?? false;
    const cmd = resolveHotkey(e, wt ? webtoonKeyBindings : defaultKeyBindings);
    if (!cmd) return;
    if (wt) {
      const overrides: Partial<Record<ReaderCommand, (() => void) | undefined>> = {
        nextPage: actions.nextPage, prevPage: actions.prevPage,
        jumpFirst: actions.jumpFirst, jumpLast: actions.jumpLast,
      };
      const ov = overrides[cmd];
      if (ov) { ov(); return; }
    }
    dispatch(store, router, cmd, actions);
  }
```

（import 补 `webtoonKeyBindings` 与 `type ReaderCommand`。`useReaderHotkeys.test.ts` 加用例：isWebtoon 时 nextPage 命中 override 不调 store.nextPage；未传 isWebtoon 时行为不变。）

(c) **useReaderWheel 不改**（审查 P2-1：既有 `disabled?: Ref<boolean>`（useReaderWheel.ts:23）就是干这个的，不新增 `enabled` API）。ReaderView 现有调用处改为：

```ts
useReaderWheel({
  containerRef,
  disabled: computed(() => settings.readerDefaultMode === 'webtoon'),
  onPrev: () => { reader.prevPage(); slideshow.reset(); },
  onNext: () => { reader.nextPage(); slideshow.reset(); },
});
```

- [ ] **步骤 3：ReaderView webtoon 分支（node 补丁，锚点按实际代码）**

(a) script 顶部接 viewer 引用与状态：

```ts
const webtoonScreenRef = ref<InstanceType<typeof ReaderScreen> | null>(null);
const webtoonTopImage = ref<string | null>(null);
const webtoonTopIndex = ref(0);
const webtoonAtBottom = ref(false);
const webtoonZoom = ref(1);   // 三轮 P1-4：重置缩放按钮可用态（viewer zoom-change → (f) 透传更新）
const isWebtoon = computed(() => settings.readerDefaultMode === 'webtoon');
```

（`webtoonTopImage/Index` 由 scroll 事件更新，节流 rAF：）

```ts
// webtoon：顶部可见图 watch（节流 rAF）驱动页码与进度
let webtoonScrollDirty = false;
function markWebtoonScroll(): void {
  if (webtoonScrollDirty) return;
  webtoonScrollDirty = true;
  requestAnimationFrame(() => {
    webtoonScrollDirty = false;
    const v = webtoonScreenRef.value?.getWebtoon?.() ?? null;
    if (!v) return;
    const name = v.getTopVisibleImage();
    if (name) {
      webtoonTopImage.value = name;
      webtoonTopIndex.value = imageNames.value.indexOf(name);
    }
    webtoonAtBottom.value = v.isAtBottom();   // 二轮 P0-1：expose 是 getter 非 ref
  });
}
```

（WebtoonViewer `@scroll.passive` 里同时 `emit('scroll')`（任务 4 已含），ReaderScreen 透传，ReaderView `@scroll="markWebtoonScroll"`。）

(b0) relPath 来源：`reader.currentRelPath`（已核实 stores/reader.ts:79，`ref('')` 非 null 类型，openBook 时写入、跨卷随之更新；根书为 `''`）：

```ts
const webtoonRelPath = computed(() => reader.currentRelPath);
```

(b) 进度 composable 接入：

```ts
const webtoonProgress = useWebtoonProgress({
  bookId: computed(() => reader.bookId),   // reader store 字段（跨卷 openBook 更新 → composable watch 自动 reset）
  atBottom: webtoonAtBottom,
});
// （五轮 P3：opts 不含 topImage/topIndex——实现只消费 bookId/atBottom，图像经 notifyTopChanged 显式传参）
watch(webtoonTopImage, (n) => { if (n) webtoonProgress.notifyTopChanged(n, webtoonTopIndex.value); });
```

（b1）恢复链（**loadRouteBook 内 `commitBookSnapshot(snapshot)` 之后、seq 校验通过后**，isWebtoon 时——一轮 P1-2 + 二轮 P1-4：数据来自 snapshot.restoreImageIndex 图索引，spread 索引不可用）：

```ts
if (settings.readerDefaultMode === 'webtoon') {
  const name = snapshot.imageNames[snapshot.restoreImageIndex] ?? snapshot.imageNames[0];
  nextTick(() => webtoonScreenRef.value?.getWebtoon()?.scrollToImage(name));
}
```

（`?at=` 优先级由 loader 承担——explicitImageName 命中时 restoreImageIndex 即该图索引；finished → 0；跨卷新书无 progress → 第 0 张 ✓。）

（b2）**双写防护**（一轮 P0-2：reader store 的 `saveCurrentProgressNow` 硬编码 `'single'`、page/imageName 取过期 spread 位置，webtoon 下调用会覆盖 image_name）：

```ts
/** 卸载/跨卷前进度保存——webtoon 走 flushNow（webtoon 位置），否则走 reader store（spread 位置）。
 *  flushNow 是 Promise（二轮 P1-7）——跨卷 trySave 的 await 契约在这里兑现。 */
async function saveProgressForCurrentMode(): Promise<void> {
  if (isWebtoon.value) await webtoonProgress.flushNow();
  else await reader.saveCurrentProgressNow();
}
```

两处接入：① crossVolume 实例化 opts 里 `saveCurrentProgressNow: () => saveProgressForCurrentMode(),`（替换现有直传 reader 版本——跨卷 trySave 不再写坏位置）；② onUnmounted 里现有 `if (reader.bookId !== null) { void reader.saveCurrentProgressNow(); }` 改 `if (reader.bookId !== null) { void saveProgressForCurrentMode(); }`。

(c) 跨卷：`@scroll-past-bottom` → `requestCrossVolumeNext()`（与按键共用）：

```ts
let lastCrossVolumeReqAt = 0;
async function requestCrossVolumeNext(): Promise<void> {
  const now = Date.now();
  if (now - lastCrossVolumeReqAt < 800) return;   // 800ms 节流（spec §6）
  lastCrossVolumeReqAt = now;
  cancelAutoEnd();                                // 五轮 P0-1：手动路径接管，作废自动结束回调
  // 五轮 P1-3 + 六轮 P1-1：手动越底与自动结束同流程——从底部发起时先标完**成功**再跨卷。
  // 防快速越底在 stable 窗口内跨卷 → bookId reset 清掉 stableTimer → 旧卷永不标完；
  // ensureFinished 返回 false（写库失败）则不跨（与 spec"await true 后才发起"一致，用户可 Alt+→）。
  if (webtoonAtBottom.value) {
    const capturedBookId = reader.bookId;        // 七轮 P1：发起时卷身份
    const ok = await webtoonProgress.ensureFinished();
    // 六轮 P1-1 + 七轮 P1：await 后三重校验——返回值 / 仍是发起时的卷（非空不够，写入期间
    // 换卷则迟到回调会以新卷身份错误发起）/ 仍在 webtoon 且仍在底部（滚离则用户已改主意）。
    if (!ok || !isWebtoon.value
        || reader.bookId !== capturedBookId || !webtoonAtBottom.value) return;
  }
  await crossVolume.maybeContinue(false, 'next');
}
function onWebtoonBottomKeyPush(): void { if (webtoonAtBottom.value) void requestCrossVolumeNext(); }
```

（manual/auto 档走现有链，off 忽略。**Alt+→ force 保持直接 `maybeContinue(true, 'next')` 不经此函数**——force 可从卷中任意位置发起，不该标完；仅"从底部发起的下一卷"（自动 + 手动越底）走 ensureFinished，spec §6 已明确。）

(d) 输入动作（审查 P1-1：改 hotkeys 注入，不是「actions 构造处分流」）：

```ts
function scrollScreen(dir: 1 | -1): void {
  const el = webtoonScreenRef.value?.getWebtoon()?.getScrollEl();   // 二轮 P0-1：expose 是 getter
  if (!el) return;
  el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: 'auto' });
}

useReaderHotkeys({
  nextVolume: () => { void crossVolume.maybeContinue(true, 'next'); },   // 现有注入保持
  isWebtoon: () => isWebtoon.value,
  nextPage: () => { scrollScreen(1); onWebtoonBottomKeyPush(); },        // webtoon 才会被调（步骤 2 override 机制）
  prevPage: () => scrollScreen(-1),
  jumpFirst: () => { const el = webtoonScreenRef.value?.getWebtoon()?.getScrollEl(); if (el) el.scrollTop = 0; },
  jumpLast: () => { const el = webtoonScreenRef.value?.getWebtoon()?.getScrollEl(); if (el) el.scrollTop = el.scrollHeight; },
});
```

（single/double 行为零变化——isWebtoon() 为 false 时 override 不参与分派。）

(d2) **跳页 dialog 与书签的 webtoon 分流**（五轮——四轮审查发现）：

① `doJumpToPage`（ReaderView:199-209，主菜单 + 右键两入口共用）——webtoon 下 `jumpToSpread` 无视觉效果（store spread 无人渲染），分流：

```ts
function doJumpToPage(page: number): void {
  if (!Number.isFinite(page) || page < 1) return;
  const total = pageUrls.value.length;
  if (total === 0) return;
  const target = Math.min(Math.max(1, Math.floor(page)), total) - 1;
  if (isWebtoon.value) {
    const name = imageNames.value[target];
    if (name) webtoonScreenRef.value?.getWebtoon()?.scrollToImage(name);
    return;
  }
  // 现有 spread 逻辑不动
  ...
}
```

② 主菜单「加书签」按钮（ReaderView:528 `addBookmark(book.id, reader.currentSpreadIndex, null)`）——webtoon 会话中 `currentSpreadIndex` 停在恢复值，会记错位置。模板改：

```vue
@add-bookmark="book?.id != null && addBookmark(book.id, isWebtoon ? webtoonTopIndex : reader.currentSpreadIndex, null)"
```

(e) 自动滚动 rAF（webtoon 语义的幻灯片）：

```ts
// slideshow isPlaying && isWebtoon → rAF 循环；滚轮临时 factor 2s 回落
const webtoonSpeedFactor = ref(1);
let lastWheelAt = 0;
let rafId: number | null = null;
let lastTs = 0;

// 五轮 P0-1：自动结束状态机（可取消 + 身份校验）。取消点：
// 滚离底部 / 换书跨卷（bookId 变）/ 切模式 / 手动跨卷（requestCrossVolumeNext）/ 组件卸载。
let autoEndTimer: ReturnType<typeof setTimeout> | null = null;
let autoEndSeq = 0;
function cancelAutoEnd(): void {
  autoEndSeq++;
  if (autoEndTimer !== null) { clearTimeout(autoEndTimer); autoEndTimer = null; }
}
watch(webtoonAtBottom, (b) => { if (!b) cancelAutoEnd(); });   // 滚离底部
watch(() => reader.bookId, () => cancelAutoEnd());             // 换书/跨卷（含手动 Alt+→）
watch(isWebtoon, (w) => {                                     // 切模式
  cancelAutoEnd();
  // 六轮 P1-3：切出 webtoon 时 viewer 即将卸载，webtoonAtBottom 冻结在 true 会让
  // useWebtoonProgress 的 stableTimer 继续跑 → 迟到误标 finished。显式置 false
  // 触发 composable watch 的 else 分支清掉 stableTimer。
  if (!w) webtoonAtBottom.value = false;
});

function step(ts: number): void {
  if (!isWebtoon.value || !slideshow.isPlaying) { rafId = null; return; }
  const dt = lastTs ? Math.min(100, ts - lastTs) : 16;
  lastTs = ts;
  if (Date.now() - lastWheelAt > 2000) webtoonSpeedFactor.value = 1;
  webtoonScreenRef.value?.getWebtoon()?.autoScrollStep(dt, settings.webtoonScrollSpeed, webtoonSpeedFactor.value);
  // 二轮 P1-8 + 三轮 P1-3 + 五轮 P0-1：到底检测在帧内触发，顺序为 停止 → 稳定 1.2s →
  // ensureFinished 落库成功 → 跨卷。**autoEnd 状态机**（五轮 P0-1）：定时器可取消，
  // fire 时四重校验，任一不过即丢弃——
  //   isWebtoon（模式没切走）/ seq === autoEndSeq（没有更新的一次自动结束）/
  //   reader.bookId === capturedBookId（没被手动跨卷/换书）/ webtoonAtBottom（仍在底部）
  if (webtoonAtBottom.value) {
    slideshow.pause();                                 // 先停滚动（atBottom watcher 的 stable 计时继续跑）
    rafId = null;
    cancelAutoEnd();                                   // 作废旧回调后再挂新的
    const capturedBookId = reader.bookId;
    const mySeq = autoEndSeq;
    autoEndTimer = setTimeout(async () => {
      autoEndTimer = null;
      if (!isWebtoon.value || mySeq !== autoEndSeq
          || reader.bookId !== capturedBookId || !webtoonAtBottom.value) return;
      // 五轮 P0-2：await 标完**成功**才跨卷；失败不跨（log 留痕，用户可 Alt+→ force）
      const ok = await webtoonProgress.ensureFinished();
      if (!ok || !isWebtoon.value || mySeq !== autoEndSeq
          || reader.bookId !== capturedBookId || !webtoonAtBottom.value) return;
      slideshow.pendingNextVolumeFromSlideshow = true; // A7：捕获"发起时在播"（pause 前确实在播）
      slideshow.pendingNextVolume = true;              // 现有 watch → maybeContinue
    }, STABLE_MS + 200);                               // import { STABLE_MS } from './useWebtoonProgress'
    return;
  }
  rafId = requestAnimationFrame(step);
}
watch(() => [isWebtoon.value, slideshow.isPlaying] as const, ([w, p]) => {
  if (w && p && rafId === null) { lastTs = 0; rafId = requestAnimationFrame(step); }
});
// 滚轮临时变速：WebtoonViewer 普通滚轮分支 emit('wheel-delta', deltaY)（任务 4 已含），
// ReaderView 监听：lastWheelAt=Date.now(); webtoonSpeedFactor=clamp(webtoonSpeedFactor*(deltaY>0?1.2:1/1.2),0,3)
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  cancelAutoEnd();                                            // 五轮 P0-1：卸载取消
});
```

（**滚到底的停止与跨卷由本层 autoEnd 状态机独占承担**（上面 atBottom 分支——检测在帧内、跨卷延迟 STABLE_MS+200 且四重校验）；步骤 1(e) 的 slideshow 接线在 webtoon 下 setIsAtLast 恒 false——**interval tick 完全不参与结束**（十轮 P1-2：原返回 webtoonAtBottom 有竞态，interval 可能在 rAF pause 前先 tick 绕过稳定窗口和 ensureFinished 直接跨卷）。跨卷续播：新卷 ready 后 slideshow 续播链已有（3.0.13），rAF watch isPlaying 自动恢复。）

(f) 模板（**二轮 P0-1：`<ReaderScreen>` 必须显式加 `ref="webtoonScreenRef"`**，否则全链路 getWebtoon() 为 null）：ReaderScreen 传 `ref="webtoonScreenRef"` + `:mode="isWebtoon ? 'webtoon' : settings.readerDefaultMode"`（webtoon 优先）+ `:page-names="imageNames"` + **`:descriptor="reader.sourceDescriptor ?? undefined"`**（三层判空链首环，三轮 P1-7：`SourceDescriptorLocal | null` 不会因 ready 状态被 vue-tsc 收窄，`?? undefined` 匹配可选 prop；二环 ReaderScreen prop 可选 + 步骤 1(c) v-if 双条件收窄）+ `:rel-path="webtoonRelPath"` + `:webtoon-max-width="settings.webtoonMaxWidth"` + `:webtoon-gap="settings.webtoonGap"` + `:page-override="isWebtoon ? (webtoonTopIndex >= 0 ? webtoonTopIndex + 1 : 1) : null"` + `@scroll="markWebtoonScroll"` + `@wheel-delta="onWebtoonWheelDelta"` + `@zoom-change="(z: number) => (webtoonZoom = z)"` + `@scroll-past-bottom="requestCrossVolumeNext"`。

（`webtoonZoom` 为 (a) 新增 ref `const webtoonZoom = ref(1)`——「重置缩放」按钮可用态链中环，三轮 P1-4；跨卷/换书时随 WebtoonViewer 重挂载由 zoom-change 重发归 1。）

(g) **模式切换进度写屏障**（十轮 P1-1：single/double 的 500ms debounce writer 与 webtoon 的 300ms writer 在同会话切换时会反序覆盖——paged→webtoon 时旧 paged 写迟到覆盖新 webtoon 位置，反向同理；共享 `imageName` 被污染连带影响瀑布流"跳到上次"）：

三个阅读器内切换入口（ReaderScreen `onToggleMode`、ReaderMainMenu `cycle-mode`、ReaderContextMenu `cycle-mode`）统一收口为异步屏障函数。ReaderView 替换三处现有 `() => settings.cycleReaderMode()` 接线：

```ts
let modeSwitchInFlight = false;
async function switchReaderMode(): Promise<void> {
  if (modeSwitchInFlight) return;          // 防快速连点
  modeSwitchInFlight = true;
  try {
    // 切换前先 await 旧模式的 pending 写入，防止延迟写反序覆盖新模式位置
    if (isWebtoon.value) {
      // webtoon → paged：冲刷 webtoon debounce（300ms）
      await webtoonProgress.flushNow();
    } else {
      // paged → webtoon：冲刷 reader store debounce（500ms）
      await reader.saveCurrentProgressNow();
    }
    await settings.cycleReaderMode();
  } finally {
    modeSwitchInFlight = false;
  }
}
```

模板三处改 `@toggle-mode="switchReaderMode"` / `@cycle-mode="switchReaderMode"`（ReaderScreen + ReaderMainMenu + ReaderContextMenu）。**Settings 下拉不进此屏障**——从 Settings 切模式时阅读器未挂载（无 pending 写），直接走 `setReaderMode` 即可。

- [ ] **步骤 4：测试 + 验证**

- `ReaderView.test.ts` 追加：scroll-past-bottom → maybeContinue 调用；isWebtoon 下 hotkeys nextPage override 走 scrollScreen 不走 store.nextPage；**webtoon 时 unmount 调 flushNow 不调 reader.saveCurrentProgressNow（一轮 P0-2）**；**自动结束状态机（五轮 P0-1，fake timers）——到底 pause 后 STABLE_MS+200 才 ensureFinished 成功 + pendingNextVolume；等待期内滚离底部 / bookId 变化 / 切模式 → 回调丢弃不跨卷；ensureFinished 失败 → 不跨卷**；**手动越底（七轮 P1）——写入期间换卷（bookId ≠ captured）不跨卷、写入期间滚离底部不跨卷**；**切出 webtoon 清 atBottom/stableTimer 不迟到误标（六轮 P1-3）**；**interval tick 竞态（十轮 P1-2）——atBottom=true 后 interval 先 tick 也不跨卷（setIsAtLast 恒 false）**；**模式切换屏障（十轮 P1-1）——paged→webtoon await reader.saveCurrentProgressNow 后才 cycle；webtoon→paged await flushNow 后才 cycle；双向延迟写反序测试**；overlay ◀▶/跳页按钮 webtoon 分流（步骤 1(f)）+ doJumpToPage/addBookmark 分流（步骤 3(d2)）。
- `ReaderScreen.test.ts` 追加：webtoon 分支渲染 WebtoonViewer（mock 组件）+ slideshow 接线 mode-aware（webtoon 下 tick 不推进 store.currentSpreadIndex；setIsAtLast 恒 false——十轮 P1-2）。
- `useReaderBookLoader` 相关测试：restoreImageIndex 三用例（步骤 0：imageName 命中 / finished→0 / page 钳位）。
- `inputBindings.test.ts` / `useReaderHotkeys.test.ts`：步骤 2 (a)/(b) 用例。

```bash
npx vitest run src/views/ReaderView.test.ts src/components/reader/ReaderScreen.test.ts src/components/reader/WebtoonViewer.test.ts src/lib/inputBindings.test.ts src/composables/useReaderHotkeys.test.ts
npm run type-check
```

- [ ] **步骤 5：Commit**

```bash
git add src/views/ReaderView.vue src/components/reader/ReaderScreen.vue src/composables/useReaderBookLoader.ts src/lib/inputBindings.ts src/lib/inputBindings.test.ts src/composables/useReaderHotkeys.ts src/composables/useReaderHotkeys.test.ts src/views/ReaderView.test.ts src/components/reader/ReaderScreen.test.ts
git commit -m "feat(webtoon): 接线——ReaderView/Screen 三模式 + slideshow mode-aware（P0-1）+ 进度双写防护（P0-2）+ hotkeys override + 恢复链 restoreImageIndex（任务 6/8）"
```

---

### 任务 7：菜单 / Overlay / Settings / i18n

**文件：**
- 修改：`src/components/reader/ReaderMainMenu.vue`（CRLF）
- 修改：`src/components/reader/ReaderOverlay.vue`（CRLF；一轮 P1-3）
- 修改：`src/components/reader/ReaderContextMenu.vue`（CRLF；**二轮 P0-2，两轮清单均漏**）
- 修改：`src/views/Settings.vue`（路径修正，一轮 P1-6——**不是** `src/components/settings/`）
- 修改：`src/locales/zh-CN.ts`、`en-US.ts`（CRLF）

- [ ] **步骤 1：ReaderMainMenu + ReaderOverlay + ReaderContextMenu**

ReaderMainMenu：
- cycle-mode 按钮文案/行为：现有 single↔double toggle 改三态 cycle（点击顺序 single→double→webtoon→single）。emit `cycle-mode` 语义不变，ReaderView 按当前值推进（**经 (g) 屏障**）。`mode` prop 类型（ReaderMainMenu.vue:35）扩 `'webtoon'`。
- 新增「重置缩放」按钮——**完整状态链**（三轮 P1-4）：① ReaderView (a) `webtoonZoom` ref（viewer `zoom-change` 透传更新，见任务 6 (f)）；② ReaderView 模板 ReaderMainMenu 处传 `:webtoon-zoom="webtoonZoom"` + `@reset-zoom="() => webtoonScreenRef.value?.getWebtoon()?.setZoom(1)"`（setZoom(1) 无锚点 → 不做滚动恢复，浏览器按新 scrollHeight 自然钳位）；③ ReaderMainMenu 新 prop `webtoonZoom?: number`，按钮 `disabled = mode !== 'webtoon' || webtoonZoom === 1`，emit `reset-zoom`。
- webtoon 下「阅读方向」按钮 + 「幻灯片方向」按钮 disabled（方向对条漫无意义；自动滚动固定向下，三轮 P1-6）。
- **页码分流**（十轮 P2：:139 `currentSpreadIndex + 1 / totalSpreads` + ReaderView `jumpValue` 初值都读旧 spread——webtoon 下会错显）：新增 `currentPageOverride?: number | null` + `totalPagesOverride?: number | null` props，模板 `{{ currentPageOverride ?? currentSpreadIndex + 1 }} / {{ totalPagesOverride ?? totalSpreads }}`；ReaderView 传 `:current-page-override="isWebtoon ? webtoonTopIndex + 1 : null"` + `:total-pages-override="isWebtoon ? pageUrls.length : null"`。`openJumpDialog`（ReaderView:188）初值改 `isWebtoon ? webtoonTopIndex + 1 : reader.currentSpreadIndex + 1`，`doJumpToPage` 已在 (d2) 分流。
- i18n：`reader.menu.resetZoom` zh「重置缩放」/ en "Reset zoom"；模式名 `reader.mode.webtoon`（zh 条漫，en Webtoon；single/double 已有）。

ReaderOverlay（一轮 P1-3，原稿遗漏）：
- `mode` prop 类型（ReaderOverlay.vue:40）扩 `'webtoon'`。
- 模式按钮文案（ReaderOverlay.vue:181）现为二元三元式 `mode === 'single' ? t('reader.mode.single') : t('reader.mode.double')`——webtoon 会错显「双页」。改三态 `t('reader.mode.' + mode)`。
- webtoon 下 OSD 缩放控件（fit-* 档位选择）disabled/隐藏——对原生滚动无意义（二轮附注）。
- webtoon 下轮播控制条的 **interval slider + 方向切换** disabled/隐藏（ReaderOverlay.vue:7 控制条构成；interval 不生效 + 方向固定向下，三轮 P1-6）——play/pause 照常（=自动滚动开关）。

ReaderContextMenu（**二轮 P0-2，一轮清单也漏了**）：
- `mode: 'single' | 'double'`（ReaderContextMenu.vue:23）扩 `'webtoon'`——**type-check 硬阻塞**：ReaderView:537 传的就是 `settings.readerDefaultMode`，不扩必挂。
- webtoon 下：缩放子菜单（SCALE_MODES，:45）与「阅读方向」项 disabled/隐藏。
- 测试：ReaderContextMenu.test 补 webtoon 下类型渲染 + 无效项禁用断言。

**无效控件统一原则**（二轮附注 + 三轮 P1-6 补全，spec §7 同步）：OSD 缩放（Overlay/ContextMenu/MainMenu 中 fit-* 与 original）、阅读方向（MainMenu/ContextMenu 的 read direction + MainMenu/Overlay 的 slideshow direction）、幻灯片间隔（Settings + **ReaderOverlay 轮播控制条 interval slider**）——webtoon 选中时一律禁用或隐藏，不保留"可点但无效"的误导态；「切换模式」「重置缩放」「播放/暂停」照常。

- [ ] **步骤 2：Settings 阅读器 section（扩既有，非新增——审查 P1-6）**

现状：`src/views/Settings.vue` **已有**阅读模式下拉——options 数组（:46-47）、本地 `setReaderMode`（:86-89，赋值 + `settings.update('reader_default_mode', v)` 持久化）、EnumRow 绑定（:217-218）。改动：

- options 数组（`readerModeOptions` 同名变量，:46 附近）加第三项 `{ value: 'webtoon', label: t('reader.mode.webtoon') }`。
- 本地 `setReaderMode` 的 `v as 'single' | 'double'` 断言改 `v as ReaderMode`（re-export 的宽类型）。
- webtoon 子组（`settings.readerDefaultMode === 'webtoon'` 时显示）：限宽 `webtoonMaxWidth`（number input 0=不限）、间距 `webtoonGap`（slider 0-24）、滚动速度 `webtoonScrollSpeed`（slider 10-300）——setter 用任务 1 的 `settings.setWebtoonMaxWidth/Gap/ScrollSpeed`。
- RTL 方向行 + 幻灯片 interval 行在 webtoon 时 disabled（spec §1/§4）。
- i18n：`settings.reader.webtoon.maxWidth|gap|scrollSpeed`（zh：限宽（0 为不限）/图片间距/自动滚动速度）双语。

- [ ] **步骤 3：测试 + 验证 + Commit**

ReaderMainMenu.test（cycle 三态 + resetZoom 条件渲染含 webtoonZoom prop + 方向/幻灯片方向按钮禁用 + **页码 override 在 webtoon 下显示 webtoonTopIndex/pageUrls.length**）、ReaderOverlay.test（三态文案（P1-3）+ 缩放/interval/direction 控件禁用）、ReaderContextMenu.test（webtoon 类型 + 无效项禁用，二轮 P0-2）、Settings 相关既有测试同步（**旧配置兼容测试真实调用 `settings.load()` 而非只测 setter**——十轮 P2）；i18n 双语一致性自动覆盖。

**deferred mock 精度修正**（十轮 P2——前述 A→B 校正测试与 debounce 在途测试的 mock 仍是假覆盖，需改 deferred mock）：
- A→B 测试（任务 4）：`vi.mocked(listImageDimensions).mockImplementationOnce(() => new Promise(r => resolveDim = r))` 挂起 dims，越过 A 的 3s 后 `resolveDim([...])` 提交 batch，断言只按 B 校正。
- debounce 在途测试（任务 5 `flushNow：debounce 写入在途时调用仍 await 链尾`）：`saveProgress` 用 deferred mock（挂起 Promise），flushNow 不立即 resolve，手动 resolve 后才 await 完成。
- **webtoon → single/double 后 slideshow 恢复正常翻页**（十轮 P2）：切回 paged 模式后 `setIsAtLast` 恢复 `store.isAtLastSpread`、`setAdvance` 恢复 `store.nextPage()`——tick 正常推进 spread，不再短路。

```bash
npx vitest run src/components/reader/ReaderMainMenu.test.ts src/components/reader/ReaderOverlay.test.ts src/components/reader/ReaderContextMenu.test.ts src/components/reader/ReaderScreen.test.ts src/views/Settings.test.ts
npm run type-check
git add src/components/reader/ReaderMainMenu.vue src/components/reader/ReaderMainMenu.test.ts src/components/reader/ReaderOverlay.vue src/components/reader/ReaderOverlay.test.ts src/components/reader/ReaderContextMenu.vue src/components/reader/ReaderContextMenu.test.ts src/components/reader/ReaderScreen.vue src/components/reader/ReaderScreen.test.ts src/views/Settings.vue src/views/Settings.test.ts src/views/ReaderView.vue src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(webtoon): 主菜单/Overlay/ContextMenu 三态与无效控件禁用 + 重置缩放状态链（zoom-change→webtoonZoom，挂载重发），Settings 扩既有下拉与 webtoon 子设置，i18n（任务 7/8）"
```

（十二轮 P2：`ReaderScreen.test.ts` 进命令与 git add——webtoon→paged slideshow 恢复测试在 ReaderScreen 里验证 setIsAtLast/setAdvance 接线。）

---

### 任务 8：实机验证 + 文档 + tag

- [ ] **步骤 1：全量验证**

```bash
npm run type-check && npm test -- --run && cd src-tauri && cargo test
```

预期：前端 946（2026-08-17 实测基线，73 文件全绿）→ 约 990±（+38~50，二轮新增 epoch/锚点/dispose/load 映射等用例），Rust 321 不变 0 fail。

- [ ] **步骤 2：实机冒烟（devtools 流程 docs/tauri-devtools-debugging.md；需先关 portable 实例）**

清单：
1. 切 webtoon 模式：连续滚动、窗口卸载（滚动后 DOM 条目数恒定 ±窗口）、无缝拼接。
2. Ctrl+滚轮锚点缩放（鼠标下的内容不动）、双击 1↔2、zoom>1 横向滚动。
3. 顶部图页码随滚动更新；退出重进恢复到上次位置（image_name 链）。
4. 滚到底停 1.2s → finished 徽标；再向下滚 → 跨卷（manual 档 toast 确认）。
5. 自动滚动：播放/暂停、滚轮临时变速 2s 回落、滚到底自动停 + 跨卷续播。
   - **到底后滚回上方（1.4s 窗口内）→ 不跨卷、不误标完（五轮 P0-1 取消路径）**。
   - **等待期内 Alt+→ 手动换卷 → 旧 autoEnd 回调对新卷无副作用（不标完、不连跳，五轮 P0-1 身份校验）**。
   - 旧卷 zoom=2 → 跨卷 → 新卷「重置缩放」应禁用（挂载 emit 归 1，五轮 P1-4）。
6. Alt+→ force 跨卷照常；single/double 模式回归无变化。

- [ ] **步骤 3：性能实测（写入 `docs/superpowers/reports/2026-08-17-webtoon-performance.md`）**

devtools：200+ 张目录全程滚动 heap 曲线（验收：增长 ≤50MB 后平台期）；单次会话 >100ms 帧 ≤5 次；缩放连续操作无 >250ms 帧。

- [ ] **步骤 4：文档**

- `DESIGN.md`：§16.5 删「Webtoon 模式」行 + **§0 附近「本期不做：条漫 webtoon」字样（DESIGN.md:21）同步删**；§12 加 12.6 webtoon 小节（布局/缩放/滚动/进度/输入摘要 + 指向 spec）。
- `AGENTS.md`：状态表加 3.1.0 行（实测数字回填）；§0 阅读器交互规约加 0.6 webtoon 小节要点（含 slideshow mode-aware 接线 + 双写防护两条约束）。

- [ ] **步骤 5：tag + push**

```bash
git tag v0.1.0-module3.1.0-reader-webtoon
git push github main
git push github v0.1.0-module3.1.0-reader-webtoon
```

推送后盯 CI（verify 含 cargo test）至全绿。

---

## 自检记录（2026-08-17 审查修订后重写）

- **规格覆盖度**：spec §1→任务 1/7；§2→任务 2/3/4；§3→任务 2（纯函数）/4（交互）；§4→任务 4（step）/6（rAF + 步骤 1(e) tick 链接线）；§5→任务 5（flushNow）/6（步骤 0 恢复链 + b2 双写防护）；§6→任务 4（scroll-past-bottom）/6（步骤 2 hotkeys override + webtoonKeyBindings + wheel disabled）；§7→任务 6/7；§8→各任务测试 + 任务 8 实测；§9 风险→任务 8 兜底（模式切换位置语义已记入 spec §9）；§10→任务 8。无遗漏。
- **审查修订闭环**：P0-1（slideshow 接线）→任务 6 步骤 1(e)；P0-2（双写防护）→任务 5 flushNow + 任务 6 步骤 3(b2)；P1-1（输入映射）→任务 6 步骤 2；P1-2（恢复链）→任务 6 步骤 0 + 3(b1)；P1-3（ReaderOverlay/页码）→任务 6 步骤 1(c)(d) + 任务 7 步骤 1；P1-4/P1-5（测试写法）→任务 5/4 步骤 1；P1-6（Settings 扩既有 + 路径）→任务 7 步骤 2；P2-1（wheel disabled）→任务 6 步骤 2(c)；P2-2（ProgressItem 类型）→任务 5 前置；P2-3（spec 回写 + 虚拟化理由修正）→头部声明；P2-4（内嵌代码矛盾）→任务 3/4 已内化；P2-6（finished→0）→任务 6 步骤 0(b)。
- **类型一致性**：`WebtoonLayout` 系列 + `captureAnchor/restoreAnchor`（任务 2 定义，任务 4 消费）；WebtoonViewer expose getter 集 `getTopVisibleImage/scrollToImage/isAtBottom/setZoom/getZoom/autoScrollStep/getScrollEl`（任务 4，任务 6 消费——二轮 P0-1 后全 getter）；`notifyTopChanged/flushNow(Promise)/ensureFinished(Promise&lt;boolean&gt;)/reset`（任务 5，任务 6 消费）；`restoreImageIndex`（任务 6 步骤 0 loader 定义，步骤 3(b1) 消费）；`webtoonKeyBindings`（步骤 2(a) inputBindings 定义，2(b) hotkeys 消费）；ReaderHotkeyActions 五新字段（步骤 2(b) 定义，步骤 3(d) 注入）；`onBeforeApply`（任务 3 定义，任务 4 锚定捕获消费）；`cancelAutoEnd/autoEndTimer/autoEndSeq`（步骤 3(e) 定义并消费，(c) 与卸载处取消）。
- **五轮审查闭环**（2026-08-17）：P0-1（autoEnd 状态机）→任务 6 步骤 3(e) 状态机 + 四重校验 + 五取消点 + 步骤 4 时序测试 + 任务 8 冒烟两子项；P0-2（ensureFinished）→任务 5 实现（成功才置位/in-flight/可重试/epoch）+ 3 用例 + 任务 6 (e) await 成功才 pending；P1-3（手动越底同流程）→任务 6 (c) async + Alt+→ force 明确不经此链（spec §6）；P1-4（zoom 挂载重发）→任务 4 onMounted emit + 测试 + 任务 8 冒烟子项；P1-5（Overlay 测试入列）→任务 7 步骤 3 命令与 git add；P2-6（摘要统一）→头部三轮 P1-5 条重写。四轮自查：overlay 按钮分流→任务 6 步骤 1(f)；doJumpToPage/addBookmark→步骤 3(d2)；anchoredScroll import→任务 4（noUnusedLocals）；锚定互斥→任务 4 scrollToImageActive + 时序注释纠正；opts 冗余→任务 5/6 (b)；(b0) `?? ''`→清理。
- **六轮审查闭环**（2026-08-17，P1×4 均为五轮自引入缺陷）：P1-1（手动越底查返回值 + await 后复核）→任务 6 (c)；P1-2（in-flight 按卷绑定 + finally 只清自己）→任务 5 实现 + 跨卷复用用例；P1-3（切出 webtoon 置 atBottom=false 连动清 stableTimer）→任务 6 步骤 3(e) watch(isWebtoon)（spec §5 同步）；P1-4（scrollToImage 真 3s setTimeout 收口 + 互斥分支弃置 pendingAnchor）→任务 4；连锁修正（opts 删字段漏改三处测试调用点 + 接口收窄）→任务 5。
- **七轮审查闭环**（2026-08-17，P1×2 / P2×1）：P1（手动越底身份校验）→任务 6 (c) capturedBookId + await 后三重校验 + 两测试描述（步骤 4）；P1（跳转校正器唯一化）→任务 4 `activeCorrection`（新跳转 finish 旧跳转、finish 只清自己、锚定判空改 activeCorrection）+ A→B 用例；P2（spec 残留）→§2.4 互斥描述 / §2.5 pendingZoomAnchor / §8.1 测试行。
- **八轮审查闭环**（2026-08-17，P1×2 / P2×1 + 新需求）：P1-1（writeTail 串行链 + flushNow 等链尾）→任务 5 实现 + 两测试（debounce 在途 await / A-B 反转防覆盖）；P1-2（viewer `:key` 防御）→任务 6 步骤 1(c) + spec §7；P2（A→B 测试重写）→任务 4 fake timers + 越过 3s + 挂起 dims；新需求（默认视图）→spec §1 显式化 + 任务 7 Settings 下拉文案。
- **九轮终审闭环**（2026-08-17，P0×1 / P1×1）：P0（descriptorId 替代 rootPath）→任务 6 步骤 1(c) `:key` + spec §7（联合类型无 rootPath，复用 sourceDescriptor.ts:64 现有 helper）；P1（writeTail 失败恢复）→任务 5 `writeTail.catch(() => undefined).then(...)` + "首写失败后次写成功"测试。
- **十轮审查闭环**（2026-08-17，P1×2 / P2×4）：P1-1（模式切换进度写屏障）→任务 6 步骤 3(g) `switchReaderMode()` + in-flight guard + 双向测试；P1-2（interval tick 绕过 autoEnd）→任务 6 步骤 1(e) setIsAtLast 恒 false + 删 webtoonAtBottom prop + 竞态测试（spec §4 同步）；P2 MainMenu 页码分流→任务 7 currentPageOverride/totalPagesOverride + openJumpDialog 初值；P2 webtoon→paged slideshow 恢复测试→任务 7 步骤 3；P2 旧配置 load 真实调用→任务 7 步骤 3；P2 A→B+debounce deferred mock→任务 4 + 任务 5。
- **十一轮终审闭环**（2026-08-17，P1×1 / P2×2）：P1（spec §7 残留 webtoonAtBottom prop + §8.1 setIsAtLast=atBottom）→spec §7 删 prop + §8.1 改"恒 false"（与 §4/计划统一，消除 interval 绕过竞态重新引入风险）；P2（A→B 测试 deferred mock）→任务 4 本体改 `new Promise(r => resolveDim = r)` + 手动 resolveDim；P2（flushNow 在途测试 deferred mock）→任务 5 本体改 `new Promise(r => resolveSave = r)` + 手动 resolveSave。
- **十二轮终审闭环**（2026-08-17，P2×3 不阻塞）：P2（A→B 测试精确化）→任务 4 错开 A/B 时间 + 只越 A deadline + 改前置项 a 高度 + 精确断言 1866.67；P2（spec 模式切换写屏障同步）→spec §5/§9 补"切换前 await 旧模式 pending 写入"约束；P2（ReaderScreen.test.ts 进任务 7）→任务 7 步骤 3 命令与 git add 补 ReaderScreen.test.ts + ReaderScreen.vue。
- **锚点已核实清单**（2026-08-17 对照代码）：settings.ts:21 ReaderMode / :111 update / :263-270 cycleReaderMode；tauri.ts:202 ImageDim / :383 ProgressItem / :405-419 saveProgress / :445 markFinished；stores/reader.ts:79 currentRelPath、:218 saveCurrentProgressNow（硬编码 'single'）；ReaderScreen.vue:270-272 slideshow 接线；useReaderHotkeys.ts:50-106 dispatch 直调；inputBindings.ts:64 Space→slideshowToggle；Settings.vue:46-47 options / :86 本地 setReaderMode（持久化）；useReaderWheel.ts:23 disabled；useReaderBookLoader.ts:152 getProgress（进度在 loader 内消费，snapshot 未透出——步骤 0 补）。
- **二轮审查闭环**（2026-08-17，P0×2 / P1×6 / P2×2 + 附注）：P0-1（expose 解包 + ref 绑定）→任务 4 expose 全 getter + 测试 + 任务 6 步骤 3(a)(d)(f) 消费端与 `ref="webtoonScreenRef"`；P0-2（ReaderContextMenu）→任务 7 步骤 1 + 文件表 + commit 清单；P1-3（load 映射）→任务 1(e) + 测试；P1-4（spread 索引误用）→任务 6 步骤 0 `restoreImageIndex`；P1-5（常规滚动锚定）→任务 2 `captureAnchor/restoreAnchor` + 任务 3 `onBeforeApply` + 任务 4 锚定恢复 watch；P1-6（陈旧响应）→任务 3 epoch + 测试；P1-7（flushNow 契约）→任务 5 async flushNow + `onScopeDispose` + 测试；P1-8（到底延迟）→任务 6 步骤 3(e) rAF 帧内立即触发 + 步骤 1(e) 降级兜底；P2-9（缩放锚点顺序 + 横向）→任务 4 setZoom（nextTick 双轴恢复）；P2-10（O(n) + gap 语义）→任务 2 topVisibleIndex 二分 + 任务 4 gap 固定 px；附注（无效控件）→任务 7 步骤 1 统一原则。
- **expose 契约一致性**（二轮 P0-1 后复查）：spec §2.5 getter 集（`isAtBottom/getZoom/getScrollEl/setZoom/scrollToImage/getTopVisibleImage/autoScrollStep`）= 任务 4 defineExpose = 任务 6 全部消费点（markWebtoonScroll / scrollScreen / jumpFirst / jumpLast / (b1) 恢复链 / (e) autoScrollStep）——无 `.value` 访问残留。
- **三轮审查闭环**（2026-08-17，P0×2 / P1×5 / P2×2）：P0-1（loader 作用域）→任务 6 步骤 0(b) progress 提升 + page 下限钳 0；P0-2（dispose 抢 flush）→任务 5 onScopeDispose 只清 timer 保留 pending（scope.stop 先于 onUnmounted）+ 测试；P1-3（finished 先行）→任务 5 `finishNow` + export STABLE_MS + 任务 6 (e) 到底顺序 停止→稳定→finishNow→跨卷 + 时序测试；P1-4（重置缩放链）→任务 4 `zoom-change` emit + 任务 6 (a) `webtoonZoom` ref + (f) 透传 + 任务 7 MainMenu prop/接线 + ReaderView 入 commit；P1-5（连续缩放竞态）→任务 4 共用锚点捕获（一次 nextTick 按最终 zoom 换算——比逐次比率乘正确）+ 复合锚点测试（断言 1306）；P1-6（无效控件补全）→任务 7 Overlay interval/direction + MainMenu slideshow direction；P1-7（descriptor 判空）→任务 6 (f) `?? undefined` + 步骤 1(c) 可选 prop + v-if 双条件；P2-8（模式切换风险）→spec §9 改写；P2-9（四处漂移）→spec §2.5 三参签名 / §8.1 测试文案 / 任务 1(e) isFinite 守卫 / 任务 5 测试补 flush。
