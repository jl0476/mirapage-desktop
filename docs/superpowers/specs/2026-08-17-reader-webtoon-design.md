# module3.1.0 竖条漫（Webtoon）阅读模式设计

> 2026-08-17 brainstorming 定稿。来源：用户拍板「全做」（M1-M6 全量 + 自由缩放 + 自动滚动）；缩放交互用户选定「Ctrl+滚轮+双击」；自动滚动/宽屏/模式记忆等其余决策点为推荐默认值（用户跳过确认，规格审查时可改）。
> 前置评估：2026-08-16 会话（原生滚动容器 + 虚拟化 + 四件复用积木结论）。

## 0. 目标

新增第三种阅读模式 `webtoon`：全卷图片按原始宽高比竖向无缝拼接、整体连续滚动——条漫的标准阅读体验。进度、跨卷、UI chrome 全部复用现有体系，零 Rust 改动、零 DB 迁移。

## 1. 模式模型

- **扩既有模式链路，不另立状态**（审查 P1-1）：settings store 既有 `ReaderMode = 'single' | 'double'`（`readerDefaultMode` ref / `reader_default_mode` key / `cycleReaderMode()`）扩展为 `'single' | 'double' | 'webtoon'`——类型单一真值源移至 `src/lib/readerSettings.ts`（`ReadMode` + `normalizeReadMode`，非法值 fallback single），settings.ts re-export 保兼容；`cycleReaderMode` 改三态循环；新增 `setReaderMode` 直设器（Settings 下拉用，写既有 key）。
- **全局设置，不按书记忆**（与 single/double 现状一致；YAGNI）。
- 切换入口：ReaderMainMenu「切换模式」三态循环（复用 cycle-mode emit）+ Settings 阅读器 section 下拉。
- RTL/LTR 在 webtoon 下不适用：Settings 与菜单中该选项仅 single/double 生效（webtoon 选中时禁用）。

## 2. WebtoonViewer 组件

新增 `src/components/reader/WebtoonViewer.vue` + `src/composables/useWebtoonDimensions.ts`。

### 2.1 布局

- 外层：`overflow: auto`（纵横双向）滚动容器，占满阅读区。
- 内层 strip：`width: min(100%, max-width 设置值)` 居中（`webtoon_max_width` px，0=不限宽，默认 0）；每张图 `width: 100%; height: 按宽高比计算` 竖向排列；`webtoon_gap` px（默认 0，范围 0-24）。
- 图片元素：`<img>` + `decoding="async"`；窗口内才挂载（见 2.3），不用 `loading="lazy"` 属性（虚拟窗口本身就是懒加载）。

### 2.2 尺寸骨架（useWebtoonDimensions）

- 复用 `listImageDimensions` IPC（3.0.6 图头解析：JPEG/PNG/GIF/BMP），按「首屏可见 + 2 屏预读」渐进测量（对齐瀑布流像素窗口思路）；`measuredMap: Map<name, {width,height}>`。
- **IPC 路径语义**（审查 P1-3）：请求前拼书的 root 相对路径前缀（`join(relPath, name)`，relPath 来自 reader store 当前卷身份；根书传 `''` 即裸名）——IPC 需要 source-relative 完整路径，裸名在子目录书会全部 miss 退化为估算；响应用 fullPath→name 反查表回填。
- **换书/跨卷清空**：watch relPath/descriptor 变化清空 `requested` 与 `measuredMap`——跨卷同名 `001.jpg` 不复用前一卷尺寸。
- 未测量图：估算宽高比 3:4 占位（WebP/AVIF 等无图头解析的格式走此 fallback）；实测到达后校正总高度（`applyMeasuredBatch` 模式，滚动锚定补偿见 2.4）。
- 与瀑布流 `useMasonryLayout` 的差异：单列、无列分配、无卡片间距逻辑——**不共享 masonry composable**，只共享 IPC 与估算/校正模式（薄实现，避免反向耦合）。

### 2.3 虚拟化

- 复用 `useVirtualList`（变高模式，瀑布流 3.0.6 用法同源）：像素窗口 = 视口 ±2.5 屏；窗口外条目 `v-if` 卸载（释放解码内存，非 display:none）。
- `visibleRange` 以累计高度（totalHeight + 每条 top/height）计算，与瀑布流相同的数据结构。

### 2.4 滚动锚定与恢复

- `scrollToImage(name)`：立即跳估算位 → watch `measuredMap` 校正（最多 5 次 / 3s 静止停，对齐瀑布流 `scrollToEntry` 渐进校正）；上方条目实测高度变化时补偿 scrollTop（防跳动）。
- `getTopVisibleImage(): string | null`：视口顶部相交/最接近的可见条目（相交优先 > 上方 > 下方，跳过非图条目——webtoon 全是图，简化为首个与视口相交的条目）。

### 2.5 Expose 契约

```ts
defineExpose<{
  scrollToImage(name: string): void;
  getTopVisibleImage(): string | null;
  atBottom: Ref<boolean>;            // 响应式（scrollTop 参与判定，防 3.0.13 atBottom stale 复辙）
  setZoom(z: number): void;          // 1.0-4.0 clamp
  zoom: Ref<number>;
  autoScrollStep(dt: number): void;  // §4 自动滚动单步（rAF 驱动）
}>()
```

## 3. 自由缩放（用户拍板：Ctrl+滚轮 + 双击）

- `zoom` 状态 1.0-4.0（step 10%），**CSS `zoom` 属性**实现（WebView2=Chromium 原生支持；`zoom` 改变布局尺寸 → 滚动区域自动正确，避开 `transform: scale` 不影响滚动区域的补偿复杂度）。
- Ctrl+滚轮：viewer 容器 `wheel`（passive:false + preventDefault），以鼠标位置为锚（缩放前后保持鼠标下内容点：`scrollTop' = (clientY + scrollTop) × k − clientY`，横向同理；k=新值/旧值）。
- 双击：1.0 ↔ 2.0 切换（记忆上次非 1 缩放值，双击放大回到该值；放大态双击复位 1.0）。
- zoom=1 滚轮 = 纵向滚动（原生，viewer 不接管）；zoom>1 内容宽于视口时原生横向滚动。
- 双击缩放仅在 webtoon 模式（single/double 的 OSD 双击行为不变）。

## 4. 自动滚动（幻灯片等价物）

- 新设置 `webtoon_scroll_speed`（px/s，默认 60，范围 10-300，Settings 滑杆）。
- 复用 slideshow store：webtoon 模式下「播放/暂停」语义切到自动滚动；`tick` 不驱动翻页。实现：ReaderView 在 webtoon + isPlaying 时跑 rAF 循环调 `viewer.autoScrollStep(dt)`（内部 `scrollTop += speed × dt × factor`）。
- 播放中滚轮：临时 `factor` 偏移（每格 deltaY ±20%，clamp 0-3×），2s 无滚轮操作回落 1×。
- 滚到底：自动滚动随 atBottom 停止 → 走 §5 跨卷链（含 3.0.13 幻灯片跨卷续播语义：自动滚动发起的跨卷在新卷 ready 后续播）。
- 幻灯片 intervalMs 设置在 webtoon 模式下不生效（速度快慢由 scroll_speed 承担）；Settings 中该项在 webtoon 选中时禁用。

## 5. 进度与跨卷（全套复用）

- **记录**：ReaderView 对 webtoon 走 300ms debounce 记 `getTopVisibleImage()` → `saveProgress(bookId, page, 'webtoon', undefined, image_name)`（现有签名 `(bookId, page, readerMode, finished?, imageName?)`——readerMode 类型扩 `'webtoon'`，Rust 端 String 直存无迁移；finished=undefined 不动完成态）。同图去重；reader 侧新薄 composable `useWebtoonProgress`，不共享 masonry 实现。
- **换书自动重置**（审查 P1-4）：composable watch `bookId` 变化自动 reset（`lastImage` 与 `finishedMarked`）——跨卷同名首图不被去重吞掉、新卷滚到底仍可标 finished；不依赖调用方手动 reset。
- **恢复**：`?at=` query 优先 → `progress.image_name` → `page` → 0，目标图经 `scrollToImage` 渐进到位。
- **读完**：`atBottom` 持续 1.2s（STABLE_MS，对齐瀑布流）→ `markFinished`；底部再向下滚动/按键触发 `maybeContinue`（与翻页模型的「末页再翻」等价）。
- **阅读记录**：`loadRouteBook` 统一 `recordHistory` 已覆盖（3.0.13），零改动。

## 6. 输入映射（per-mode 分派）

- `useReaderWheel`：增加 `enabled` 判断（mode==='webtoon' 时不接管滚轮——原生滚动；viewer 自身只拦 Ctrl+滚轮缩放）。
- `useReaderHotkeys.dispatch`：webtoon 分支——`↑/PageUp/Space` = 上滚一屏（90% 视口高）、`↓/PageDown` = 下滚一屏、`Home/End` = 顶/底、裸 `←/→` v1 不绑定（no-op）、`Escape/菜单键` 现状不变。**`Alt+→/Alt+←`（folderNext/folderPrev）保持现状**——全局 force 跨卷绑定，webtoon 模式照常生效。
- **底部触发跨卷**（翻页模型「末页再翻」的等价物）：viewer 容器挂 passive `wheel` 监听（不 preventDefault，不影响原生滚动）——`deltaY > 0 && atBottom` 时 emit `scroll-past-bottom`，800ms 节流；ReaderView 消费后调 `crossVolume.maybeContinue(false, 'next')`（走 continue_to_next_volume 档位：auto 直跳 / manual toast 确认 / off 忽略；force 路径由 Alt+→ 承担）。`↓/PageDown/Space` 按键在 atBottom 时同样触发（与滚轮共用节流与 maybeContinue 幂等守卫）。

## 7. 接入与 UI

- `ReaderScreen.vue`：`props.mode` 加 `'webtoon'` 分支挂 `WebtoonViewer`（single/double 分支与 viewerRef 逻辑不动）。
- `ReaderView.vue`：`loadBook` 图片列表/`convertFileSrc` URL 转换共用；按 `settingsStore.readMode` 传 mode；webtoon 时页码显示「顶部图 n / N」（overlay 现有页码位复用，watch topVisibleImage 更新）。
- `ReaderMainMenu.vue`：cycle-mode 三态 + 「重置缩放」项（仅 webtoon，zoom≠1 时可用）。
- `Settings.vue` 阅读器 section：阅读模式下拉（三态）+ webtoon 子设置组（限宽 px、间距 px、滚动速度 px/s；仅 webtoon 选中时显示/启用）。
- i18n：`reader.mode.webtoon` / `reader.menu.resetZoom` / `settings.reader.readMode` / `settings.reader.webtoon.{maxWidth,gap,scrollSpeed}` 等新 key，zh-CN + en-US 双语。

## 8. 测试与性能验收

### 8.1 测试（预计前端 +25~35 用例，零 Rust）

- `useWebtoonDimensions`：估算占位/实测校正/预读窗口/无图头 fallback。
- `WebtoonViewer`：虚拟窗口渲染数量（挂载/卸载）、`atBottom` 响应式、`getTopVisibleImage`、`scrollToImage` 渐进校正、缩放 clamp/双击切换/Ctrl 滚轮锚点计算（纯函数抽出可测）。
- `useWebtoonProgress`：debounce 记录/同图去重/恢复链（?at → image_name → page → 0）。
- 输入映射：webtoon 分支滚屏/Home/End/atBottom 触发跨卷。
- 自动滚动：rAF 步进/滚轮临时变速/2s 回落/到底停止。
- `ReaderScreen` 三模式分支 + `ReaderMainMenu` cycle 三态 + Settings 联动 + i18n 双语一致性（既有自动覆盖）。

### 8.2 性能验收线（devtools 实测，写入 `docs/superpowers/reports/`）

- 200+ 张目录连续滚动全程 heap 平稳（虚拟化卸载生效；允许增长 ≤50MB 后平台期）。
- 单次滚动会话掉帧（单帧 >100ms）≤5 次。
- 缩放 1.0↔2.0↔4.0 连续操作无明显卡顿（无 >250ms 帧）。

## 9. 风险

- **CSS `zoom` 属性**：Chromium 支持良好但非 W3C 标准——happy-dom 对 `zoom` 无行为（仅设值不布局），组件测中只断言值不断言布局；实机验证兜底（验收 §8.2）。若实机发现滚动区域异常，回退方案：transform: scale + 容器宽高手动换算（预留 `applyZoom` 单点替换）。
- **超长单图**（>20000px）：浏览器可渲染，但估算/实测高度差大 → 渐进校正幅度大；`scrollToImage` 校正次数上限防抖动（已设计）。
- **内存**：虚拟窗口 ±2.5 屏 × 4K 长图解码仍可能峰值高；若实测超标，兜底用缩略图管线 quality=high 档作为显示源（3.0.7 积木，预留 `imgSrcFor()` 单点替换）。
- **滚轮接管边界**：`useReaderWheel` 现挂 ReaderView 容器；webtoon 下停用后 OSD 相关 preventDefault 全部失效属预期；需确保 Ctrl+滚轮在 viewer 内外都不触发浏览器页面缩放（preventDefault 全域生效于 viewer 容器，容器外 Ctrl+滚轮由 app 级无影响——WebView2 无浏览器页面缩放，低风险）。

## 10. 交付

- 模块号 `3.1.0-reader-webtoon`（新阅读模式，升 3.1.0）；tag `v0.1.0-module3.1.0-reader-webtoon`。
- 预计 6-8 个实现 commit（viewer / dimensions / 缩放 / 自动滚动 / 进度跨卷 / 输入映射 / 接入 UI / 文档）。
- 文档：AGENTS.md 状态表 + DESIGN.md §16.5 移除 Webtoon 行 + §12 阅读器交互章节补 webtoon 小节。
