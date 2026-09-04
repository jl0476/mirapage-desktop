# 缩略图重复提交与 completion 扇出导致线程风暴；其与 tao 疑似 UAF 闪退的因果关系待 Page Heap 定谳（阶段性分析 rev4）

> **2026-09-03 rev3 → rev4（2026-09-04 五轮复审采纳）**。rev4 按证据等级全面修正：① 区分两套崩溃签名（#1-3 为 0xC0000374 heap corruption fast-fail **无转储的同类疑似事件**；#4 为 0xC0000005 访问违规**唯一已取证事件**——二者不得合并定案）；② 「500ms 自持循环」修正为**有限反馈链**（mergeMeasured 对已有 path 返回原引用，每图至多触发一次；证据支持「滚动/渐进测量期间重复整窗提交」，不支持「完成回包无限自驱重发」）；③ 0xFEEEFEEE 降为**强线索**非证明；④ 未崩原因改为「资源风暴非充分条件，决定性触发条件未知」；⑤ 475/552 为**进程总线程数**非 blocking pool 计数；⑥ 旧 epoch 重进 worker **升格为运行时已证实**（rev4 新核查：clear 后 22 分钟窗口内 1766 个 scheduler start 全部携带 epoch < current、零 new_epoch）；⑦「已排除」改为「缺乏直接证据、优先级降低」；⑧ 孤儿 5,348 为扫描时总量；⑨ 权威 epoch 应由后端返回。**本文为阶段性分析，非最终 RCA。**

---

## 1. 现象时间线（按取证状态分级）

| # | 时间 | 场景 | 退出码 | 取证状态 |
|---|---|---|---|---|
| 1-3 | 09-02 ~16:36 / ~17:00 / 09-03 ~18:11 | 260901 瀑布流 + 缩略图风暴（伴随 clear/反复进出目录） | 0xC0000374（heap corruption fast-fail） | **同类疑似事件**（无转储；与 #4 是相似工作负载，但是否同一根因**无证据**） |
| 4 | 09-03 18:42:51 | CDP 严格逐屏扫描 sweep-2（clear 后，uptime 1600s） | 0xC0000005（访问违规，调试器下） | **唯一已取证事件**（339MB 全量转储 + 符号化堆栈） |

环境注记：同窗口期 Wow.exe 多次 0xc0000005（游戏侧）、shawl.exe 每次关机 0xc0000409（某关机工具）、Explorer 一次 0xc0000374。均无证据与本专案相关。

## 2. 取证过程

1. **内存诊断（mdsched）**：两遍无错误（事件 1101/1201，09-03 17:14）。→ 内存条方向**缺乏直接证据、优先级降低**（标准测试覆盖有限）。
2. **崩溃普查**：近 3 天真 0xc0000374 仅 mirapage ×2 + Explorer ×1；Wow ×5 为 0xc0000005（非堆损坏）。
3. **WER 绕过**：本进程 fast-fail 型崩溃不落 WER；procdump `-e -x` 挂调试器后 #4 当场抓获。
4. **其他降级**：libwebp 编码管线、WebView2 渲染进程——堆栈无关联证据，**优先级降低**而非排除。

## 3. 已取证事件 #4 的崩溃现场

```
Crash reason:  EXCEPTION_ACCESS_VIOLATION_READ @ 0xfeeefeeefeeefeee
Thread 0 (main, crashed):
 0  drop_glue<Box<dyn FnMut(Event<Message>)>>      tao::event_loop mod.rs:825
 1  drop_glue<Option<Box<dyn FnMut(...)>>>         同上
（第 2 帧起大量 Found by: stack scanning——不可作为可靠调用链）
进程总线程数：552；版本：tao 0.35.3 / tauri 2.11.5 / wry 0.55.1
```

**证据等级（rev4 修正）**：0xFEEEFEEE 与 Windows 堆释放填充值高度一致——**强烈符合读取已释放堆对象的特征**（UAF 为最强假设，但不能严格排除指针内容被覆盖或更早的堆破坏）；崩溃**发生于 tao handler 的析构/访问路径**（表现符合 UAF）——具体被释放对象**未定位**。tao 是否最初破坏者：未知，需 Page Heap。tauri#10987 为弱旁证（1.7 时代 panic 签名不符）。

## 4. 已证实的资源放大缺陷（本报告的核心可信结论）

### 4.1 前端：滚动/渐进测量期间重复整窗提交（有限反馈链，rev4 修正措辞）

代码事实（已核实）：
1. `useMasonryThumbnails.ts:200-212` 保底节流 500ms——连续滚动中每 500ms 必有一条请求覆盖途中可见区。
2. `flushRequest` 遍历全窗口构建 items，**无「已 cached / 已 generating / 本 epoch 已提交」过滤**——cached 项整批重进 IPC（用户实测同组 ~69 张每 ~500ms 重发）。
3. **有限反馈链（非自持循环）**：cached 回包 → img 出现 → 首次 load 写 measuredMap → layout/thumbnailWindows 重算 → 触发 scheduleRequest。但 `mergeMeasured` 对已有 path 返回原引用——**每张图至多触发一次该反馈**；state Map 的 cached→cached 替换不是 thumbnailWindows 的依赖。现有证据支持「滚动/渐进测量期间的重复整窗提交」，**不支持**「完成回包可无限自行驱动 500ms 重发」。
4. `applyResults` 对 cached→cached 等无变化结果也整体替换 state Map → 无意义重渲染（独立渲染面缺陷）。

### 4.2 后端：三项放大器（运行时均已证实）

1. **`handle_submit` 无 epoch 门禁 + 前端 epoch 失同步（rev4 运行时升格）**：clear 时 `cancel_all prevEpoch=…243 newEpoch=…244`（ts 1788430635658）后，**直至崩溃的 ~25 分钟窗口内 1766 个 scheduler start 全部携带 epoch=…243（< current 244），零 new_epoch 事件**——前端分配器 clear 后未同步，持续以旧 epoch 提交且全部被执行。代码层：`scheduler.rs:309` 不拒 `task.epoch < current_epoch`。
2. **subscriber 扇出**：同 cache_key 重复请求在 DEDUP 处只挂订阅者；完成时对每订阅者各发 Outcome。
3. **每 subscriber 一次完整副作用**：`service.rs:1325` 无条件 `spawn_blocking` + DB upsert + LRU 检查 + emit（Stale 判定在 blocking 闭包内 :1414 才发生）。5.5 分钟窗口：worker DONE 701 vs completion STALE 9262（扇出比 ~13:1）；崩溃前 6.7 秒 completion STALE ×2937-2972。

### 4.3 风暴形态（观测边界已标注）

- 用户实时监控：**进程总线程数**从常态 39-89 升至 475、句柄 1,169 后回落（rev4 注：475/552 均为进程总线程数，**不是 Tokio blocking pool 线程计数**——「subscriber 产生大量 blocking 工作」成立，「blocking pool 膨胀至 475/552」未证实）；崩溃 #4 转储进程总线程 552。
- 该次未崩：**资源风暴不是触发崩溃的充分条件；决定性触发条件未知**（rev4 修正——此前「峰值及时排空」为事后推断，无判据）。反例 sweep-1（无 clear、全扫 17 分钟）未崩——epoch 失同步叠加风暴是已观察的伴随条件，必要性/充分性均未证明。

### 4.4 附带发现

UI 清缓存不扫描实际缓存目录——扫描时点目录存量孤儿 WebP **5,348 个 / 467.7 MB**（rev4 注：为扫描时总量，不等于单次清理遗漏量；成因待归因——可能含历史版本/异常退出残留）。

## 5. 修复优先级（rev4 调整）

**P0（消灭风暴燃料与放大——本身即值得修，无论与崩溃因果如何）**
1. 前端增量请求：按 `epoch + path + priority` 增量提交，不重发 cached/generating 项。
2. 后端副作用去重：每 cache_key 的 DB upsert/LRU/emit 只执行一次，subscriber 只收结果。

**P1（配套治理）**
3. cached→cached 无变化不替换 state Map。
4. `handle_submit` 拒绝 `task.epoch < current_epoch`（`<` 非 `<=`）+ `find_admissible` 防御。
5. `spawn_completion` 对 `Outcome::Stale` 进 blocking 前短路。
6. **clear 后 epoch 同步：权威值由后端返回**（rev4 修正——前端自行 bump 不稳健，前后端双分配器会失同步，本次 1766 旧 epoch 提交即失同步实证）。
7. 缓存清空扫描实际目录删孤儿（先归因存量来源）。

**P2（定谳）**
8. A/B 实验（①只修前端 ②只修后端 ③都修）观察线程峰值与崩溃率。
9. Page Heap（`gflags /p /enable mirapage-desktop.exe /full`，测毕必关）捕获**第一处**非法写/释放——#1-3（heap corruption）与 #4（AV）是否同根因、最初破坏者是谁，均以此定谳。

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

现有物证：`C:\Users\jl0476\AppData\Local\CrashDumps\mirapage-desktop.exe_260903_184251.dmp`（339MB 全量，进程总线程 552）。
