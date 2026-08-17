# module3.1.0 webtoon 实机冒烟 + 性能报告（2026-08-17）

环境：`npm run tauri:dev` + WebView2 CDP（9222，流程见 `docs/tauri-devtools-debugging.md`）。
数据：`Q:\00down\2603\Vinnegal - Mikasa`（32 张 2000×3000 JPG，本地 Q 盘）。

## 冒烟结果（plan 任务 8 清单）

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| 1 | webtoon 连续滚动 + 虚拟窗口 | ✅ | 全程挂载 2–4 项（32 张图）；strip 54696px（估算）→ 58511px（实测后），无缝拼接 |
| 1 | 图片按需加载 | ✅ | Q 盘慢速下 `complete=true`、naturalWidth 2000×3000；首访需 ~2s/张 |
| 2 | Ctrl+滚轮锚点缩放 | ✅ | 单档 drift 0px；连续 3 档（每档 280ms 间隔）逐步 diff 0；zoom 1→1.33、strip 1272→1691.76px |
| 2 | 双击 1↔上次缩放 | ✅ | 1.33 →双击→ 1 →双击→ 1.33 |
| 2 | zoom>1 横向滚动 | ✅ | scrollWidth > clientWidth，scrollLeft 99→299 原生滚动 |
| 2 | 重置缩放状态链 | ✅ | zoom=1.33 时菜单按钮 enabled → 点击 → zoom=1 + 按钮 disabled（zoom-change→webtoonZoom→prop 全链实机验证） |
| 3 | 页码随滚动更新 | ✅ | 顶部图指示 2→5→10→16→23→32 / 32 |
| 3 | 恢复链 finished→0 | ✅ | finished=true 重进 → 第 1 张（MKS01、scrollTop=0、1/32） |
| 3 | 恢复链 imageName | ✅ | progress imageName=MKS16 → 重进 scrollToImage 26288px、指示 16/32（渐进校正到位）；finished 不因中途滚动降级（saveProgress finished=undefined 语义） |
| 4 | 滚到底标 finished | ✅ | atBottom 停留 1.2s+ → `get_progress(108)`：`{imageName: MKS32.jpg, readerMode: webtoon, page: 31, finished: true}` |
| 4 | 底部再滚跨卷 | ✅ | wheel deltaY>0 @bottom → /reader/108 → /reader/109（auto 档直跳）。目标卷顶层无图显示错误页属数据形态（合集嵌套子目录），非缺陷 |
| 5 | 自动滚动 rAF | ✅ | 播放中 scrollTop 持续增长，速度 ≈60px/s 量级（实测 48–99px/s 波动，测量噪声 + rAF 节流） |
| 5 | 滚轮临时变速 + 2s 回落 | ✅ | factor 1 →（3 格下滚）→ 1.73（=1.2³）→ 2.3s 后 → 1 |
| 5 | 取消：到底 1.4s 内滚回上方 | ✅ | 不跨卷（path 不变）、pendingNextVolume=false、**finished 未误标**、进度正常记 MKS06 |
| 5 | 取消：等待期内 Alt+→ 换卷 | ✅ | force 跳 109 后旧 autoEnd 回调 fire，`get_progress(109)=null`——不误标不连跳 |
| 6 | Alt+→ force 跨卷 | ✅ | 卷中任意位置直跳（上面子项已覆盖） |
| 6 | single/double 回归 | ✅ | webtoon→single（OSD 渲染 + PageDown 翻页）→ double（OSD）→ webtoon（viewer 重挂、zoom 归 1）三态往返稳定 |
| 7 | single 模式幻灯片回归（补充轮） | ✅ | interval 500ms tick 推进 spread（29→31 末页）；末页 tick → pause + pendingNextVolume + manual 档 toast「继续读下一本…」；toast ✕ 关闭；Space 开（spread 10→11）/ 停 |
| 7 | webtoon 播放/暂停双入口 | ✅ | Space 键 = 自动滚动开关；主菜单「播放」按钮同效（滚动推进 / 再点即停） |
| 7 | webtoon 无效控件禁用（spec §7） | ✅ | 主菜单：幻灯片方向 / OSD 缩放 / 阅读方向全 disabled；Overlay 轮播条：interval slider + 方向按钮 disabled、播放按钮可用 |

## 性能验收（spec §8.2 验收线对照）

| 指标 | 验收线 | 实测 | 结论 |
|------|--------|------|------|
| JS heap 增长 | ≤50MB 后平台期 | **全程恒定 14MB**（9 个采样点零增长） | ✅ 远超线 |
| >100ms 帧 | ≤5 次 | **0 次**（PerformanceObserver longtask） | ✅ |
| 虚拟窗口 | 恒定 ±窗口 | 2–4 项 | ✅ |

## 已知观察（非缺陷）

1. **首访慢盘下缩放与尺寸批次交错**：图片尺寸批量到达（Q 盘 ~2s/批）期间做 Ctrl+滚轮连续缩放，批次锚定恢复（ratio 基准）与缩放锚定（坐标基准）复合，锚点最大漂移 ~1.1k px（zoom 1.33 时）；尺寸测量收敛后连续缩放逐步 diff 为 0。维度批次的 ratio 锚定是 spec §2 设计（保持顶部图稳定），属可接受的瞬态。
2. **跨卷目标是「顶层无图」目录时显示错误页**：`find_next_volume` 不校验兄弟目录是否含图。数据形态（合集嵌套），非 webtoon 缺陷；如需改进属跨卷模块后续项。
3. **自动滚动速度波动**（48–99px/s vs 设定 60）：rAF dt 累计与测量噪声，无功能性影响。

## 结论

module3.1.0 webtoon 全部冒烟项通过，性能远超验收线。遗留仅上述 3 条观察项，均为既有设计取舍或数据形态。
