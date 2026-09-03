# 堆损坏闪退分析报告（rev3）：前端 500ms 重发循环 → subscriber 扇出 → blocking 线程风暴

> 2026-09-03 rev2 → **rev3（2026-09-04）**。rev2 确立了后端放大器与崩溃现场；rev3 补上**前端燃料来源**（用户实时监控报告 + 代码核实）：`useMasonryThumbnails` 的保底节流使**全窗口（含 cached/generating 项）每 ~500ms 重发一次**，且生成回包自身喂养下一轮重发（自持循环）；配套新增线程动态实测（39-89 → 475）、孤儿 WebP 发现（5,348 个 / 467.7MB），修复清单按新证据重排优先级。rev2 的取证过程、排除项、崩溃现场记录保留。

---

## 1. 现象时间线

| # | 时间 | 场景 | 退出码 | 转储 |
|---|---|---|---|---|
| 1 | 09-02 ~16:36 | CDP 冷缓存性能测试（clear + 风暴 + 并发 clear）收尾后 | 0xc0000374 | 无 |
| 2 | 09-02 ~17:00 | 用户手测瀑布流浏览 / 反复立即阅读（uptime ~17min） | 0xc0000374 | 无 |
| 3 | 09-03 ~18:11 | CDP 驱动深冷区翻页（快扫 + clear + 跳滚混合，uptime ~38min） | 0xc0000374 | 无（该实例未挂调试器） |
| 4 | 09-03 18:42:51 | CDP 驱动严格逐屏扫描 sweep-2（clear 后 ~6.7s 崩溃点见 §4.2，uptime 1600s） | 0xC0000005（调试器下） | **339MB 全量已抓** |

共同点：全部发生在 260901（3736 图）瀑布流 + 缩略图生成活跃期。反例：实例 B 的 sweep-1（518 屏全扫、~700 worker、无 clear）跑完 17 分钟**不崩**——风暴本身可承受，**放大器叠加**（epoch 翻转 × 重发循环 × 扇出）才崩。

环境注记：同窗口期 Wow.exe 多次 0xc0000005（游戏侧独立问题）、shawl.exe 每次关机 0xc0000409（独立工具）、Explorer 一次 0xc0000374。除 Explorer 外与本专案无关。

## 2. 取证过程与排除项

1. **内存诊断（mdsched）**：两遍无错误（事件 1101/1201，09-03 17:14）。内存条排除。
2. **崩溃普查修正**：近 3 天真 0xc0000374 只有 mirapage ×2 + Explorer ×1；Wow ×5 为 0xc0000005（非堆损坏）。「三进程同签名 → 机器级」定性作废。
3. **WER 绕过发现**：本进程 fast-fail 型崩溃不落 WER；procdump `-e -x` 挂调试器后第 4 次崩溃当场抓获。
4. **已排除**：libwebp 编码管线（堆栈无关）、RDP softbuffer、WebView2 渲染进程、内存条。
5. **rev3 新增排除**：非「图片太多」或 JS heap 泄漏——是请求重复放大形成的 blocking 线程与事件回调风暴（§4）。

## 3. 崩溃现场

```
Crash reason:  EXCEPTION_ACCESS_VIOLATION_READ @ 0xfeeefeeefeeefeee
               （0xfeeefeee = Windows 堆释放填充模式 → 读取已释放内存）
Thread 0 (main, crashed):
 0  drop_glue<Box<dyn FnMut(Event<Message>)>>      tao::event_loop mod.rs:825
 1  drop_glue<Option<Box<dyn FnMut(...)>>>         同上
（第 2 帧起大量 Found by: stack scanning——不可作为可靠调用链）
进程线程数：552（Thread 551 编号）
版本：tao 0.35.3 / tauri 2.11.5 / tauri-runtime-wry 2.11.4 / wry 0.55.1
```

**定性**：`0xfeeefeee` 证明读取已释放堆内存，受害对象是 tao 事件处理闭包——这只证明崩溃发生在 tao handler 析构/访问处，**不能证明 tao 是最初破坏堆的组件**。rev3 定性：tao UAF **很可能是线程/事件风暴诱发的最终崩溃点**（线程动态实测与 dump 规模吻合，§4.2）；第一处非法释放仍需 Page Heap 定夺（§5）。tauri#10987 为弱旁证（1.7 时代 panic 签名不符）。

## 4. 完整因果链（rev3 重构：前端源头 → 后端放大 → 崩溃形态）

### 4.1 前端源头：500ms 全窗口重发自持循环（rev3 新确立）

代码事实（均已核实）：

1. **保底节流即 ~500ms 全量重发**——`useMasonryThumbnails.ts:200-212` `scheduleRequest`：距上次发出 ≥500ms 即**立即**发（注释原话「连续滚动中每 500ms 必有一条请求覆盖途中的可见区」）。
2. **重发不过滤已请求项**——`useMasonryThumbnails.ts:224` 起 `flushRequest` 遍历整个 `prioMap`（可见 + 预读全窗口）构建 items，循环内只滤 idle（快速滚动时）/ 非图片 / 路径校验失败，**没有「已 cached / 已 generating / 本 epoch 已请求」任何过滤**——cached 项也整批进 IPC。
3. **自持循环**——`useMasonryThumbnails.ts:340` `watch(thumbnailWindows)`：生成回包 → measuredMap/状态更新 → windows computed 重算出新数组引用 → watch 触发 → scheduleRequest → 500ms 保底直发。**生成活动自身喂养重发**。
4. **无变化也替换响应式 Map**——`applyResults`（`useMasonryThumbnails.ts:333` 区段）对 `cached→cached` 等无变化结果也整体替换 `state` Map → 卡片持续无意义重渲染。

用户实测：同一组 ~69 张图每 ~500ms 重发一次（含 cached/generating）。

### 4.2 后端放大器（rev2 确立，保留）

1. **`handle_submit` 无 epoch 门禁**（`scheduler.rs:309`）——`clear_thumbnail_cache` bump 内部 epoch 后，前端持旧 epoch 值的重提交照常入队执行（崩溃前 6.7s 实测 13-15 个 start/DONE）。
2. **DEDUP 挂订阅者**（`scheduler.rs:309` 起两分支）——同 cache_key 的重复请求不重复执行，但**每请求追加一个 subscriber**。
3. **每 subscriber 一次完整副作用**（`scheduler.rs:508` / `service.rs:1325→1414`）——完成时对所有 subscriber 各发 Outcome，各起一个 `spawn_completion`：无条件 `spawn_blocking` + DB upsert + LRU 检查 + emit 状态事件（Stale 判定在 blocking 闭包内才发生）。

### 4.3 风暴形态与崩溃

- **线程动态实测（用户监控，rev3 新证据）**：线程数从常态 **39-89 瞬间升至 475**、句柄增至 **1,169**，随后排空回落——与历史崩溃 dump 的 **552 线程**（集中在 spawn_completion/blocking pool）规模吻合。Tokio blocking pool 默认上限 512。
- 本次未崩是峰值在触发 native 崩溃前及时排空——**时序随机性**解释「有时崩有时不崩」。
- 日志量化（崩溃 #4 前 6.7 秒）：cancel_all ×1、drained 402、aborted 6、worker DONE ×13-15、**completion STALE ×2937-2972**（subscriber 扇出）；5.5 分钟窗口：worker DONE 701 vs completion STALE 9262、DEDUP_PENDING 7462（≈22/秒，燃料即 §4.1 的重发循环）。

**链条总述**：前端 500ms 全窗口重发（cached/generating 也发）→ 后端 DEDUP 挂订阅者 → 完成时每订阅者各起 spawn_blocking 抢 DB mutex → blocking pool 膨胀（实测 475 / dump 552）+ 前端重复事件引发持续 Map 替换重渲染 → 极端时序下 tao 事件闭包 UAF 崩溃。

### 4.4 附带发现：孤儿缓存文件（rev3 新）

UI 清空缩略图缓存只删索引内文件、不扫描实际缓存目录——实测遗留**孤儿 WebP 5,348 个 / 467.7 MB**（用户于缓存目录实测，修复时复验）。

### 4.5 置信度表

| 主张 | 状态 |
|---|---|
| 前端 500ms 全窗口重发自持循环（不过滤 cached/generating） | **已证实**（代码核实 + 用户实测） |
| 旧 epoch 任务 clear 后重进 worker（handle_submit 漏洞） | **已证实** |
| subscriber → spawn_blocking 线程风暴 | **已证实**（动态 475 + dump 552 双证） |
| 无变化状态替换 Map 致持续重渲染 | 已证实（代码 + cached→cached 日志） |
| 清理遗漏孤儿文件 5,348 个 | 用户实测（修复时复验） |
| tao handler 是最终 UAF 受害点 | 已证实 |
| tao 自身是最初内存破坏源 | 未证实，需 Page Heap |

## 5. 修复优先级（rev3 合并重排）

**P0（止血——消灭风暴燃料与放大）**
1. **前端增量请求**：按 `epoch + path + priority` 做增量提交——相同或更低优先级不重复提交；已 cached / generating 项不再重发（`flushRequest` 过滤 + watch 触发条件收敛）。
2. **后端副作用去重**：每个 cache_key 的 DB upsert / LRU 检查 / completion emit **只执行一次**（首个订阅者路径）；subscriber 只接收结果，不各自重复副作用。

**P1（配套治理）**
3. cached→cached 等无变化状态不替换前端 Map（applyResults 判等跳过）。
4. `handle_submit` 拒绝 `task.epoch < current_epoch` 的提交（注意 `<` 不是 `<=`）；`find_admissible` 再放一道防御。
5. `spawn_completion` 对 `Outcome::Stale` 在进 spawn_blocking **前**短路（零副作用无需 DB/IO）。
6. clear 后前端同步 bump epoch 分配器（否则卡片先 queued 后静默 stale → 永久 spinner）。
7. 缓存清空同时扫描实际缓存目录，删除索引外孤儿文件（附带回收 467.7MB 类存量）。

**P2（验证与定谳）**
8. 三组 A/B 实验：①只修前端增量 ②只修后端扇出 ③都修——复现装置（procdump + 260901 扫描）对照线程峰值（目标：常态 <100，不再出现 400+）。
9. Page Heap（`gflags /p /enable mirapage-desktop.exe /full`，测毕必关）捕获**第一处**非法写/释放——确定最初破坏者是 tao、tokio 线程压力还是其他 native 组件。

## 6. 工具链附录（复用）

```bash
# 挂调试器启动（先 npm run dev 起 vite）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  /d/compile/tools/procdump.exe -accepteula -ma -e -x "C:\Users\jl0476\AppData\Local\CrashDumps" \
  "D:\compile\rust_target\debug\mirapage-desktop.exe"

# 符号化（cargo install minidump-stackwalk dump_syms）
dump_syms -s /d/compile/tools/symbols /d/compile/rust_target/debug/mirapage_desktop.pdb
minidump-stackwalk --symbols-path /d/compile/tools/symbols <dump 路径>

# Page Heap（P2-9，管理员）
gflags /p /enable mirapage-desktop.exe /full
gflags /p /disable mirapage-desktop.exe /full   # 测毕必关
```

现有物证：`C:\Users\jl0476\AppData\Local\CrashDumps\mirapage-desktop.exe_260903_184251.dmp`（339MB 全量，552 线程）。
