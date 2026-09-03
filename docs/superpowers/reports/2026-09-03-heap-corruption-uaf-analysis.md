# 堆损坏闪退分析报告（rev2）：subscriber→spawn_blocking 线程风暴与 epoch 提交漏洞

> 2026-09-03 rev2。**rev1 → rev2 重大修正**（2026-09-03 用户复审，四项代码事实与日志统计均已复核采纳）：
> 1. 「旧 pending 在 epoch 翻转后继续出队」**不成立**——`handle_new_epoch`/`handle_cancel_all` 本就 drain pending（8 月 8 日起存在）。真实漏洞在 **`handle_submit` 不拒绝 `task.epoch < current_epoch` 的新提交**：clear 把内部 epoch bump 后，前端仍持旧 epoch 值重复提交，这些任务在 clear 之后入队并执行。
> 2. `completion STALE` 计数是 **subscriber 扇出**（一个任务多个订阅者，每订阅者一个 `spawn_completion`），不是执行次数——「35 worker/秒」结论作废。
> 3. 真正的瞬时风暴是 **`spawn_completion` 无条件 `spawn_blocking`**：Stale 判定在 blocking 闭包内部（`service.rs:1414`）才发生，数千个无需 DB/IO/emit 的 Stale 回包全部先进入 blocking pool 抢 DB mutex。
> 4. progress emit 风暴**证据不足**：生成器每任务恰好 4 次 emit（`generator.rs:77/104/141/163`），701 worker ≈ 8.5 次/秒，非「几十上百」；emit 侧 epoch 过滤降级为纵深防御。
>
> rev1 的取证过程、排除项、崩溃现场记录保留；机制链与实验设计按 rev2 重写。

---

## 1. 现象时间线

| # | 时间 | 场景 | 退出码 | 转储 |
|---|---|---|---|---|
| 1 | 09-02 ~16:36 | CDP 冷缓存性能测试（clear + 风暴 + 并发 clear）收尾后 | 0xc0000374 | 无 |
| 2 | 09-02 ~17:00 | 用户手测瀑布流浏览 / 反复立即阅读（uptime ~17min） | 0xc0000374 | 无 |
| 3 | 09-03 ~18:11 | CDP 驱动深冷区翻页（快扫 + clear + 跳滚混合，uptime ~38min） | 0xc0000374 | 无（该实例未挂调试器） |
| 4 | 09-03 18:42:51 | CDP 驱动严格逐屏扫描 sweep-2（clear 后 ~6.7s 崩溃点见 §4.2，uptime 1600s） | 0xC0000005（调试器下） | **339MB 全量已抓** |

共同点：全部发生在 260901（3736 图）瀑布流 + 缩略图生成活跃期，且全部伴随 **`clear_thumbnail_cache` / 目录切换 / 反复进出（= epoch 翻转 + 前端旧 epoch 重提交）**。
反例：实例 B 的 sweep-1（518 屏全扫、~700 worker、**无 clear**）跑完 17 分钟**不崩**——纯风暴不崩，**epoch 翻转 × 前端重提交**才崩。

环境注记：同窗口期 Wow.exe 多次 0xc0000005（游戏侧独立问题）、shawl.exe 每次关机 0xc0000409（独立工具）、Explorer 一次 0xc0000374。除 Explorer 外与本专案无关。

## 2. 取证过程与排除项

1. **内存诊断（mdsched）**：两遍无错误（事件 1101/1201，09-03 17:14）。内存条排除。注：报告员任务 `RunFullMemoryDiagnostic` 曾被禁用致首轮结果静默丢弃，已启用；快速启动下「关机」跳过排定测试，须用「重启」。
2. **崩溃普查修正**：近 3 天真 0xc0000374 只有 mirapage ×2 + Explorer ×1；Wow ×5 为 0xc0000005（非堆损坏）。「三进程同签名 → 机器级」定性作废。
3. **WER 绕过发现**：本进程 fast-fail 型崩溃不落 WER；procdump `-e -x` 挂调试器后第 4 次崩溃当场抓获。
4. **已排除**：libwebp 编码管线（堆栈无关）、RDP softbuffer（旧定性已作废）、WebView2 渲染进程（崩的是 Rust 宿主主线程）、内存条。

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

**rev2 定性修正**：`0xfeeefeee` 证明程序读取了已释放堆内存，受害对象是 tao 的事件处理闭包——但这**只证明崩溃发生在 tao handler 析构/访问处，不能证明 tao 是最初破坏堆的组件**。栈扫描帧（含 `Mutex<tauri::EventLoop>::lock`）不可靠。候选肇因：极端线程/资源压力下暴露的竞态（tao 或 tauri 内部）、此前某次 native 写坏堆（libwebp 等尚未完全排除）、tao 自身 double-drop——**区分手段是 Page Heap（§5 E6）**。
（rev1 引用的 tauri#10987 降级为弱旁证：其为 Tauri 1.7/tao 0.16 的 unsafe-precondition panic、无复现代码、closed not planned，与本次 Tauri 2.11 的释放后访问不同签名。）

## 4. 自身逻辑分析（rev2 重写）

### 4.1 已证实的缺陷链

**缺陷 A：`handle_submit` 不拒绝旧 epoch 提交**（`scheduler.rs:309`）

调度器在 epoch 翻转上有三层既有防护：`handle_new_epoch` 拒绝回退通知（:385 `<=` 单调守卫）、new_epoch/cancel_all drain 全部旧 pending（:398/:444）。**但 `handle_submit` 入口没有 `task.epoch < current_epoch` 检查**。

后果链：`clear_thumbnail_cache` → `cancel_all` 把内部 epoch 从 `1788430634243` bump 到 `1788430634244` → 前端 epoch 分配器仍持旧值 `…243` 继续提交 → 这些**在 clear 之后新提交的旧 epoch 任务**通过 handle_submit 正常入队/执行 → 完成时被 epoch 映射成 Stale。日志实证（最后 6.7 秒，两轮独立统计一致）：`cancel_all` ×1、drained pending=402、aborted inflight=6、**scheduler start ×13-15、worker DONE ×13-15、completion STALE ×2937-2972**——崩溃前确实有一批 clear 后重提交的旧 epoch 任务被执行。

**缺陷 B：Stale 回包也走完整 `spawn_blocking` 路径**（`service.rs:1325` → :1414）

`spawn_completion` 收到任何 Outcome 后**无条件** `tokio::task::spawn_blocking` 并先取 DB mutex，直到 blocking 闭包内部（:1414）才判断是 Stale。Stale 分支零副作用（不写索引/不删文件/不 emit），却照样消耗一个 blocking 线程 + 一次 DB 锁竞争。

**缺陷 C：subscriber 扇出放大**（`scheduler.rs` drain/completion 路径）

同 cache_key 的重复提交在 DEDUP_PENDING/DEDUP_INFLIGHT 处只挂订阅者不重复执行——worker 只跑一次，但 drain 与完成时**对每个 subscriber 各发一次 Outcome**，每个 subscriber 各自起一个 `spawn_completion`。5.5 分钟窗口：scheduler start 707 / worker DONE 701 / **completion STALE 9262** / ENQUEUE 1767 / DEDUP_PENDING 7462——STALE 计数 ≈ 订阅者数，非执行数。

**三缺陷叠加的崩溃形态**：clear 后 6.7 秒内 ~2940 个 spawn_completion 全部涌进 `spawn_blocking` → Tokio blocking pool（默认上限 512 线程）瞬间膨胀（**转储实测 552 线程**，与上限+主线程+runtime 线程的规模吻合）→ 数千 blocking 任务抢同一把 DB mutex → 极端并发/资源压力下，tao 事件处理闭包成为最终 UAF 崩溃点。

### 4.2 量化数据（两轮独立统计互证）

| 窗口 | scheduler start | worker DONE | completion STALE | 其他 |
|---|---:|---:|---:|---|
| 崩溃前 5.5 分钟 | 707 | 701 | 9262 | ENQUEUE 1767 / DEDUP_PENDING 7462 / DEDUP_INFLIGHT 46 |
| **最后 6.7 秒**（cancel_all → 崩溃） | 13-15 | 13-15 | **2937-2972** | cancel_all ×1 / drained 402 / aborted 6 |

progress emit 实际量级：每任务恰 4 次（generator.rs:77/104/141/163；queued 态是前端侧无 Rust emit）→ 701 worker ≈ 2804 次/330 秒 ≈ **8.5 次/秒**。rev1 的「几十到上百次/秒」高估，**progress emit 作为主要诱因的假设证据不足，当前数据反对**。

### 4.3 置信度表

| 主张 | 状态 |
|---|---|
| 旧 epoch 任务在 clear 后重新进入 worker（handle_submit 漏洞） | **已证实** |
| subscriber → spawn_blocking 线程风暴（6.7s × ~2940） | **已证实** |
| tao handler 是最终 UAF 受害点 | **已证实** |
| progress emit 是主要诱因 | 证据不足，数据反对 |
| tao 自身是最初内存破坏源 | 未证实，需 Page Heap |

## 5. 验证实验与修复设计（rev2 重写，按优先级）

1. **E1 提交门禁**：`handle_submit` 开头拒绝 `task.epoch < self.current_epoch` 的提交（直接回 `Outcome::Stale` 给 reply，不入队）；`find_admissible` 再放一道 `< current_epoch` 防御。注意**必须是 `<` 而非 `<=`**——`<=` 会拒绝当前合法 epoch 的全部提交。
2. **E2 Stale 短路**：`spawn_completion` 在进 `spawn_blocking` **之前**判断 `Outcome::Stale` 直接返回（Stale 分支零副作用，无需 DB/IO；仅清理保护集合等必要动作）。
3. **E3 前端 epoch 同步**：clear 后前端同步 bump 本地 epoch 分配器，否则卡片会先收 queued 再静默 stale，表现为永久 spinner。
4. **E4 subscriber 副作用去重**：同 cache_key 的 DB upsert / LRU 驱逐 / state emit 只执行一次（首个订阅者路径），其余订阅者只等结果。
5. **E5 三组 A/B 实验**区分「事件队列压力」vs「blocking pool 线程风暴」：① 只关 progress emit ② 只短路 Stale spawn_blocking ③ 两者都做——预期 ② 单独即可消除崩溃，① 单独不消除。
6. **E6 Page Heap 定肇因**：`gflags /p /enable mirapage-desktop.exe /full` 复跑，在**首次**非法写/释放处中断（而非最终受害点）——确认 tao / libwebp / 其他 native 谁先破坏堆的关键证据。测毕必须 `gflags /p /disable mirapage-desktop.exe /full`（full page heap 内存代价大，不可常开）。

## 6. 工具链附录（复用）

```bash
# 挂调试器启动（先 npm run dev 起 vite）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  /d/compile/tools/procdump.exe -accepteula -ma -e -x "C:\Users\jl0476\AppData\Local\CrashDumps" \
  "D:\compile\rust_target\debug\mirapage-desktop.exe"

# 符号化（cargo install minidump-stackwalk dump_syms）
dump_syms -s /d/compile/tools/symbols /d/compile/rust_target/debug/mirapage_desktop.pdb
minidump-stackwalk --symbols-path /d/compile/tools/symbols <dump 路径>

# Page Heap（E6，管理员）
gflags /p /enable mirapage-desktop.exe /full
gflags /p /disable mirapage-desktop.exe /full   # 测毕必关
```

现有物证：`C:\Users\jl0476\AppData\Local\CrashDumps\mirapage-desktop.exe_260903_184251.dmp`（339MB 全量，552 线程）。
