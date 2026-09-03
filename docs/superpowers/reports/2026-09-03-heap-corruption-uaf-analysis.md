# 堆损坏闪退分析报告：tao 事件循环 UAF 与缩略图事件风暴

> 2026-09-03。承接 3.5.4 ② 号现象（debug build heap corruption 一次）的升级排查：2026-09-02/03 两天 dev 实例在 260901 瀑布流场景连续崩溃 4 次，已抓到全量转储并符号化。
>
> **结论先行**：崩溃点是 tao 事件循环回调闭包的 use-after-free（上游层），但**诱因在本项目自身逻辑**——缩略图调度器在 epoch 翻转后仍把数千旧任务完整送入 worker 空转，且 progress 事件发送侧无 epoch 过滤（"先发后滤"），形成对主线程事件循环的持续高频投递。本文档按「现象 → 取证 → 现场 → 自身逻辑分析 → 验证实验」整理，修复方向以自身逻辑治理为主。

---

## 1. 现象时间线

| # | 时间 | 场景 | 退出码 | 转储 |
|---|---|---|---|---|
| 1 | 09-02 ~16:36 | CDP 冷缓存性能测试（clear + 风暴 + 并发 clear）收尾后 | 0xc0000374 | 无 |
| 2 | 09-02 ~17:00 | 用户手测瀑布流浏览 / 反复立即阅读（uptime ~17min） | 0xc0000374 | 无 |
| 3 | 09-03 ~18:11 | CDP 驱动深冷区翻页（快扫 + clear + 跳滚混合，uptime ~38min） | 0xc0000374 | 无（该实例未挂调试器） |
| 4 | 09-03 18:42:51 | CDP 驱动严格逐屏扫描 sweep-2（clear 后 ~3.5min，uptime 1600s，dump 内记录） | 0xC0000005（调试器下） | **339MB 全量已抓** |

共同点：全部发生在 260901（3736 图）瀑布流 + 缩略图生成活跃期，且全部伴随 **epoch 翻转**（clear_thumbnail_cache / setRoot / 反复进出目录）。
反例：实例 B 的 sweep-1（518 屏全扫、~1500 张生成、**无 clear**）跑完 17 分钟**不崩**——纯风暴不崩，**翻转 + 风暴**才崩。这是机制链的关键对照。

环境注记：同窗口期 Wow.exe 多次 0xc0000005（访问违规，游戏侧独立问题）、shawl.exe 每次关机 0xc0000409（独立工具问题）、Explorer 一次 0xc0000374。除 Explorer 外与本专案无关；Explorer 单次不足以定性机器级问题。

## 2. 取证过程与排除项

1. **内存诊断（mdsched）**：两遍测试无错误（事件 1101/1201，09-03 17:14）。内存条排除。注：报告员计划任务 `RunFullMemoryDiagnostic` 曾被禁用导致首轮结果静默丢弃，已启用；快速启动下「关机」会跳过排定测试，须用「重启」。
2. **崩溃普查修正**：近 3 天 Application Error 全名单中，真 0xc0000374 堆损坏只有 mirapage ×2 + Explorer ×1；Wow ×5 为 0xc0000005（非堆损坏）。早前「三进程同签名 → 机器级」定性作废。
3. **WER 绕过发现**：本进程 fast-fail 型堆崩溃**不落 WER**（事件日志与 LocalDumps 均无记录，默认目录对 Wow/Explorer 却有效）。转储必须调试器抓——procdump `-e -x` 挂调试器方案建立后，第 4 次崩溃当场抓获。
4. **崩溃点定位（dump_syms + minidump-stackwalk + debug PDB）**：见 §3。
5. **已排除**：libwebp/缩略图编码管线（堆栈无关，此前头号嫌疑撤案）、RDP softbuffer（旧定性已作废）、WebView2 渲染进程（崩的是 Rust 宿主主线程）、内存条。

## 3. 崩溃现场

```
Crash reason:  EXCEPTION_ACCESS_VIOLATION_READ @ 0xfeeefeeefeeefeee
               （0xfeeefeee = Windows 堆释放填充模式 → use-after-free 实锤）
Thread 0 (main, crashed):
 0  drop_glue<Box<dyn FnMut(Event<Message>)>>      tao::event_loop mod.rs:825
 1  drop_glue<Option<Box<dyn FnMut(...)>>>         同上
（栈扫描帧含 Mutex<tauri::EventLoop>::lock / Arc<thread::Inner> drop 等）
版本：tao 0.35.3 / tauri 2.11.5 / tauri-runtime-wry 2.11.4 / wry 0.55.1
```

解读：tao 事件循环持有的事件处理闭包（`Box<dyn FnMut(Event<Message>)>`，即 tauri run() 传入的 handler）在 drop/调用路径上解引用已释放堆块。UAF 落点在上游，但**谁在制造触发条件**见 §4。

## 4. 自身逻辑分析（本文重点）

### 4.1 事件发射面盘点（全部 `app.emit` 出口）

| 事件 | 发射点 | 频率模型 | 发射线程 |
|---|---|---|---|
| `thumbnail://progress` | `service.rs:54` `progress_closure_for`（每任务一个闭包，**按阶段无条件 emit**，epoch 只放 payload 供前端过滤） | 每张生成图最多 5 次（queued/decoding/resizing/encoding/writing） | 16 个 worker 的 spawn_blocking 线程 |
| `thumbnail://state` | `service.rs:1439`（完成态；STALE 分支不 emit） | 每次真实完成 1 次 | async 任务 |
| `thumbnail://migration-progress` / `cache-info` | `service.rs:1194/1237+` | 迁移/清空偶发 | — |
| `archive://progress` | `materializer.rs:1255` | 远程物化偶发 | — |

每次 `app.emit` 在 Windows 上经 EventLoopProxy 投递到**主线程** tao 事件循环再转发 webview——即所有事件最终汇入同一根主线程序列。

### 4.2 崩溃前 3 分钟量化（18:39:51–18:42:51，sweep-2 于 18:39 clear 后）

| 观测 | 数值 |
|---|---|
| `completion STALE`（旧 epoch 任务完整走完执行链后丢弃） | **6316 条（≈35 条/秒）** |
| `scheduler worker DONE` | 391 |
| `generate done` | 385 |
| `flushRequest enter`（前端请求批） | 367 |

### 4.3 机制链：epoch 翻转 → 旧任务空转 + 事件风暴 → 事件循环高压

代码事实（两条缺陷点）：

1. **出队无 epoch 门禁**——`scheduler.rs::try_schedule` 的 `find_admissible` 只看退避时间与内存预算，不比较 `task.epoch` 与 `current_epoch`。clear/切目录把 pending 全部标记 stale 后，这批任务**照常出队、占 worker、进 spawn_blocking**，靠执行中的协作式 abort 在阶段边界退出（最早 1 个阶段后）。观测值 6316 条/3min = 每秒 ~35 个 worker 槽位在烧垃圾任务。
2. **progress 事件发送侧无 epoch 过滤**——`progress_closure_for` 的闭包按阶段回调无条件 `emit`，过滤完全在前端（"先发后滤"）。垃圾任务在其存活的 1-N 个阶段内发出的 progress 事件**全部跨 IPC 进入主线程事件循环**，前端收完才发现 epoch 不符丢弃。

叠加计算：35 任务/秒 × 每任务 1-5 个 progress 事件 + 正常完成事件 ≈ **每秒几十到上百个事件持续投递主线程**，sweep-2 全程 26 分钟累计数万事件。第 4 次崩溃发生在 clear 后 3.5 分钟——正是旧任务队列边烧边 emit 的峰值窗口。

**与全部 4 次崩溃的吻合度**：#1（clear + 风暴 + 二次 clear）、#2（用户反复进出目录 = 反复 setRoot/epoch 翻转）、#3（快扫 + clear + 跳滚混合）、#4（clear 后旧队列倾泻）。反例 sweep-1 无翻转不崩。**翻转 × 风暴 = 必要条件组合**的假设与全部样本一致。

**与上游的关系**：tao 在该负载形态下暴露 UAF 是上游的 bug（tauri 有 emit 频率相关 panic 的先例，tauri#10987），但即便上游修了，35 任务/秒的空转本身也是纯浪费（CPU + 事件带宽），治理自身逻辑在两个层面都成立。

### 4.4 关联线索（非主因，记录备查）

- 崩溃 #4 前 2 分钟 Wow.exe 也崩（18:40）——时间巧合，机制无关（其为 GPU/游戏侧访问违规）。
- 崩溃主线程栈含 `Mutex<tauri::EventLoop>::lock` 帧扫描痕迹，与高频 emit 的锁竞争画像一致。

## 5. 验证实验设计（按此推进修复）

| 实验 | 内容 | 判定 |
|---|---|---|
| E1 出队 epoch 门禁 | `find_admissible` 跳过 `epoch <= current_epoch` 的 pending，直接按 Stale 完成通知订阅者（不走 worker、不生成、不 emit progress） | 复跑「clear + 风暴 + 全目录扫描」×N 遍：`completion STALE` 每秒量应从 ~35 降至 ~0（只剩 clear 瞬间的 in-flight ≤16），CPU 空转消失 |
| E2 emit 侧 epoch 过滤 | `progress_closure_for` 闭包 emit 前查当前 epoch（闭包需可读共享 epoch，如 `Arc<AtomicU64>`） | 垃圾 progress 事件归零；正常事件不变 |
| E3 复现验证 | E1（+E2）后 procdump 装置复跑崩溃组合（含用户手测路径：反复进出目录 + 瀑布流浏览）连续数日 | 不再出现 0xc0000374/0xC0000005 → 自身诱因假设成立；仍崩 → 回到上游 tao 路线（整理 dump + 堆栈报 issue，必要时临时降到低事件速率模式长期观察） |
| E0 基线（先做） | 不改代码，procdump 挂着正常使用数天积累样本，确认崩溃率基线 | E1/E2/E3 前后对照 |

## 6. 工具链附录（复用）

```bash
# 挂调试器启动（先 npm run dev 起 vite）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  /d/compile/tools/procdump.exe -accepteula -ma -e -x "C:\Users\jl0476\AppData\Local\CrashDumps" \
  "D:\compile\rust_target\debug\mirapage-desktop.exe"

# 符号化（cargo install minidump-stackwalk dump_syms）
dump_syms -s /d/compile/tools/symbols /d/compile/rust_target/debug/mirapage_desktop.pdb
minidump-stackwalk --symbols-path /d/compile/tools/symbols <dump 路径>
```

现有物证：`C:\Users\jl0476\AppData\Local\CrashDumps\mirapage-desktop.exe_260903_184251.dmp`（339MB 全量）。
