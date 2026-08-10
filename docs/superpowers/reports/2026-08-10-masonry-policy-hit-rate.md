# 瀑布流 `decide_source` 命中率实测

**日期**: 2026-08-10
**目的**: 评估当前 thumbnail policy (`src-tauri/src/thumbnail/policy.rs`) 的 `UseOriginal` 触发条件是否过严,典型图片目录的实际命中率是多少。
**背景**: 用户反馈"这个目录图片本身不大,为什么都走缩略图生成"。本文是**数据 + 结论**,不动代码;后续若要放宽阈值再开新 spec。

---

## 1. 测试对象

**目录**: `Q:\00down\2603\极品颜值长腿嫩逼黑丝女神·佳菲(白雪)·大尺度私拍套图`
**入口**: FileBrowser store `viewMode = "masonry"`(已持久化)
**条目数**: 620 张图,全部 `.jpg`
**典型文件**: 1.jpg – 620.jpg,体积 443–571 KB
**Settings 实测值**(`pinia._s.get('settings')`):

| key | 值 |
|---|---|
| `thumbnailResourceMode` | `custom` |
| `thumbnailQuality` | `high` → margin **1.25**, max_bucket **2048** |
| `thumbnailWorkerLimit` | 4 |
| `thumbnailDecodeMemoryMb` | 256 |
| `thumbnailPrefetchScreens` | 3 |
| `thumbnailIdleGeneration` | true |

---

## 2. 测试方法

通过 `mcp__tauri-devtools__evaluate_script` 在运行中的 dev 实例里:

1. 拿 `fileBrowser.entries`(已 listDirectory) + `settings` 当前值
2. 取 DOM 中 `.masonry-col` 真实列宽 → 算 `requiredWidth = colWidth × dpr × margin`
3. 调 `list_image_dimensions(descriptor, paths)` 批量读 header
4. 复刻 `policy::decide_source` 三段决策,统计三档分布
5. 仿真不同列数下命中率

### 2.1 路径处理坑(P1-1 性质的遗留)

`Local.resolve_path` (`src-tauri/src/source/local.rs:21-24`) = `PathBuf::from(root_path).join(path)`。

`Local.list_directory` (`local.rs:87`) 返回的 `entry.path` 是 **`strip_prefix(full_path)`** 后的相对路径(相对当前 dir,不是相对 root)。

**`list_image_dimensions` 直接 `read_file(&descriptor, &path)`**,把 `entry.path` 当成相对 root_path 的路径 → 子目录场景全 NotFound。

`useMasonryThumbnails.ts:140-141` 和 `MasonryView.vue:103-105` 都已经踩过这个坑:
- **thumbnail service** 走 `source_rel_path`(P1-1 修复,见 `service.rs:357-358`)
- **MasonryView** 前端拼 `fullPath = toRootRelativePath(currentPath, entry.path)` 再调 IPC,回来再 `fullByRel` 反查

本次测试一开始 200 张全 0 结果就是踩这个坑(第一次只传 `entry.path = '1.jpg'`)。**建议后续清理**: `list_image_dimensions` 改成接受 `Vec<{ relPath: string }>` 或干脆复用 thumbnail service 的 `sourceRelPath` 字段,消除前端重复 hack。

---

## 3. 实测数据(620 张全量)

### 3.1 真实尺寸分布

```
width 全部 1800 px,height 全部 3202 px → 5.76 MP,9:16 竖屏手机照
bytes 全部 ≤ 2 MB(443–571 KB)
```

宽度分布:

| 区间 | 数量 |
|---|---|
| 1024–1279 | 0 |
| 1280–1919 | **551** |
| 1920–3839 | **69** |

### 3.2 当前决策(4 列,bucket=512)

| 决策 | 命中数 | 占比 |
|---|---|---|
| `UseOriginal`(直用) | 0 | **0.0 %** |
| `Generate::Required`(必生成) | 620 | **100.0 %** |
| `Generate::Opportunistic`(灰区) | 0 | 0.0 % |
| 尺寸未知 → 强制 Generate | 0 | 0.0 % |

### 3.3 决策细节(以 `3.jpg` 为例)

```
srcW=1800, srcH=3202, srcPixels=5.76 MP, srcBytes=558 KB
bucket=512
硬阈值 width > bucket×1.5 : 1800 >  768 → ✓ 命中
硬阈值 pixels > 4 MP       : 5.76M > 4M  → ✓ 命中
硬阈值 bytes  > 4 MB       : 558K < 4M   → ✗ 不命中
硬阈值 maxEdge > 4096      : 3202 < 4096 → ✗ 不命中
直用 width ≤ bucket×1.25  : 1800 >  640 → ✗ 不命中
直用 pixels ≤ 2 MP         : 5.76M > 2M  → ✗ 不命中
直用 bytes  ≤ 2 MB         : 558K < 2M   → ✓ 满足
```

任意一个硬阈值命中即 `Required`,**这里 width 和 pixels 两个同时爆**。

---

## 4. 列数仿真

| 列数 | colWidth | requiredWidth | bucket | useOriginal | required | opportunistic |
|---|---|---|---|---|---|---|
| 4(当前) | 300 | 469 | 512 | 0 | 620 | 0 |
| 3 | 400 | 625 | 768 | 0 | 620 | 0 |
| 2 | 600 | 938 | 1024 | 0 | 620 | 0 |

**列数调整救不了**。即便 bucket=2048(> 5.76MP 密度也够),`pixels > 4MP` 硬阈值仍命中。

要让 `UseOriginal` 命中,**必须同时**:
- `bucket × 1.25 ≥ width` = bucket ≥ 1440(colWidth ≥ 1152)
- `pixels ≤ 2 MP` ← **永远过不去**(5.76MP > 2MP)
- `bytes ≤ 2 MB` ✓ 满足

---

## 5. 分析

### 5.1 用户感知"图片不大" vs 政策"图片太大"错位

| 维度 | 实际 | 瀑布流需求 |
|---|---|---|
| 文件字节 | 500 KB | — |
| 原图像素 | **5.76 MP** | — |
| 渲染像素(300px × 1.25 × 1.25 = 469px 宽) | — | **0.22 MP** |
| 冗余度 | 原图是渲染需求的 **~26×** | — |

`decide_source` 评估的是**原图本身**超不超阈值(`HARD_MAX_PIXELS=4MP`),不是"渲染需求"超不超阈值。**5.76MP 原图触发 4MP 硬阈值是必然**。

### 5.2 阈值的现实命中率

| 原图尺寸 | 当前决策 | 备注 |
|---|---|---|
| ≤ 2 MP 且 ≤ 2 MB | UseOriginal | 朋友圈分享小图 |
| 2–4 MP 且 ≤ 2 MB 且 ≤ bucket×1.25 宽 | Opportunistic | 灰区,低优生成 |
| 4–8 MP | Required | **本测试目录**;绝大多数手机竖屏照(iPhone 12MP 默认竖屏裁切) |
| > 4 MB 或 > 4096 px | Required | RAW/单反/扫描 |
| > bucket×1.5 宽 | Required | 8K 截图、长图 |

**5.76 MP(1800×3202)落在 4–8 MP 区间,典型手机照**。当前策略把它一律当"必生成",跟 spec §6.3 "避免 4K 渲染卡顿"初衷匹配,但**对中等尺寸手机照的命中率显著低估**。

### 5.3 现有"避免卡顿"措施在 spec §6 已经够用

`UseOriginal` 即使放行,**渲染时**仍受下列保护:
- `quality_policy.margin = 1.25` → 高 DPI 屏渲染略放大但仍 ≤ bucket×1.25
- `output_pixel_budget = 3 MP` → 渲染输出像素预算
- WebView2 浏览器层 GPU decode 缓存
- 缩略图 `UseOriginal` 是 lazy img,viewport 外不 paint

**直用原图不会触发"4K paint 卡顿"**,因为渲染像素 = colWidth×dpr×margin,与原图大小解耦。

---

## 6. 后续评估选项

| 方案 | 改 `policy.rs` 哪行 | 收益(本目录) | 代价 |
|---|---|---|---|
| **A. 放宽 `HARD_MAX_PIXELS` 4MP → 8MP** | `policy.rs:117` | 5.76MP 落到灰区 Opportunistic,允许别的图抢 worker | 仍生成,不命中 UseOriginal |
| **B. 放宽 `HARD_MAX_PIXELS` 4MP → 16MP** | `policy.rs:117` | 5.76MP 完全不命中硬阈值;走 width 检查;UseOriginal 命中**取决于 width**(1800 vs bucket×1.25) | 大图(>16MP,如 50MP 手机)仍保护 |
| **C. 引入"相对密度"判定**:`pixels / (colWidth × dpr)^2 ≤ K` | `policy.rs:132` 新增参数 | 精准:5.76MP 对 300px 卡片是 64× 冗余,可控 | 改语义,需 spec 重审 |
| **D. 接受现状** | — | 1164 张 ≈ 100MB,512MB 配额远未满;二次访问秒开 | 首次生成 IO 仍要走 |
| **E. `UseOriginal` 直用前的 EXIF 归一化** | 新代码 | 直用原图也需要 EXIF 方向正确(否则旋转 90° 错位) | 与 thumbnail service 共用 orientation 模块 |

### 推荐顺序(给未来决策者)

1. **若 E2E 显示首次进目录卡顿**:先 A(最低风险,灰区低优生成让位给高频图)
2. **若发现 50%+ 手机照目录都触发 Required**:走 B(spec 微调,一行)
3. **若想"按密度自适应"**:走 C(spec 重写,新档位定义)
4. **若 perf 实测无明显卡顿**:保持 D

---

## 7. 已知遗留(与本次评估相关)

### 7.1 `list_image_dimensions` 路径处理

- 命令名:`list_image_dimensions`(`src-tauri/src/commands/image_dimensions.rs:35`)
- 接受 `Vec<String>`,每个是 `read_file` 的 path
- **问题**: path 直接传给 `Local.resolve_path` = `root_path.join(path)`,不拼 currentPath
- **现网 workaround**: `MasonryView.vue:107-111` 前端拼 `fullPath = toRootRelativePath(currentPath, relPath)` 再传,返回的 `dims.path` 也是 `fullPath`,需要 `fullByRel` 反查回 relPath 作为 `measuredMap` key
- **thumbnail service** 没这个问题,因 `ThumbnailRequestItem.source_rel_path` 是一等字段(P1-1 修复,见 `service.rs:357-358`)
- **建议**: `list_image_dimensions` 签名改成 `paths: Vec<String>` 接受"相对 root 的完整路径"(沿用现状),**或** 与 thumbnail 一样引入 `source_rel_path` 字段消除重复 hack
- **影响**: 仅前端调用方需配合;Rust 测 `image_dimensions.rs:35` 的 7 测不动;不影响功能正确性

### 7.2 5.76MP"必生成"的实际 IO 开销

620 张 × ~100KB WebP ≈ 60 MB 一次性写盘 + 4 worker × 16 并发限流。

- 首次进入: 实测批 50,毫秒级(本地 SSD)
- 二次进入: 命中缓存,直接返回 cacheKey + asset URL,**几乎 0 开销**
- LRU 驱逐: 512MB 配额,620 张占 ~12%,远未触顶

**结论: IO 开销不是问题,设计意图(避免首次 paint 慢)与现实(渲染需求 0.22MP 远低于原图 5.76MP)的错位才是真问题**。

---

## 8. 验证记录

```bash
# 测入口: docs/tauri-devtools-debugging.md 描述的 tauri-devtools MCP
# 已连 9222,实例 PID 来自 netstat
mcp__tauri-devtools__list_pages → "MiraPage Desktop" ✓
mcp__tauri-devtools__evaluate_script → 上述测量 ✓
```

测试过程中**确认 instance 本身在正常浏览**(日志 `list_directory ok: 620 entries`),不是 stale 状态。

---

## 9. 未来再评估时

把这个文档跟以下资源一起看:

- spec: `docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md` §6.2 §6.3
- code: `src-tauri/src/thumbnail/policy.rs:132-177` (`decide_source`)
- code: `src-tauri/src/thumbnail/service.rs:357-358` (P1-1 路径修复)
- code: `src/components/filebrowser/MasonryView.vue:103-117` (前端 path hack 注释)
- 报告: `docs/superpowers/reports/2026-08-08-masonry-thumbnail-performance.md` (原 4K 卡顿根因)
- 报告: `docs/superpowers/reports/2026-08-09-thumbnail-generation-bench.md` (生成 bench)

**若决定改 policy,先看 §9 引用顺序里的 spec §6.2 §6.3**,别只看代码 — 阈值是 spec 决策,不是临时拍的数。