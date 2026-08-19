# 远程 Archive 物化 + 预载 + cache（M3）实施设计

> 日期：2026-08-19
> 状态：设计待审查
> 母设计：`docs/superpowers/specs/2026-08-18-smb-remote-media-design.md` §5（rev5 定稿）
> 前置：M1 已交付（media:// 协议 / Range 强契约含 Content-Range offset 校验 / rebuild_descriptor 远程 archive 形态 / 缩略图取源 actor）；M2 非硬前置（WebDAV 上的 ZIP 可独立验收，SMB 部分随 M2 复验）
> 关联：DESIGN.md §16.1 RAR/7z 条目不随本设计交付（另行模块）

## 0. 背景与事实基线（M1 后）

1. **`ArchiveMediaSource` 本地路径直开**：list/read/stat 直接 `tokio::fs::read(archive_path)`；`origin: Some(_)` 时 archive_path 是虚拟 URL（WebDAV=`{baseUrl}/{relPath}`、SMB=UNC 形态）→ fs::read 必失败——远程包当前**不可达**（M1 有意留下，本设计接入物化器）。
2. **URL/重建链已通**：`media://archive/webdav|smb/...` 形态、`rebuild_descriptor` 构造 `origin: Some(Box<源 descriptor>)` + `origin_entry_path`/`archive_rel_path` 均已交付。
3. **Range 强契约就绪**：WebDAV 206 Content-Range offset 匹配 + 等长校验（评审轮收紧）——分块下载拼 `.part` 的正确性前提满足。
4. **缩略图链路已通用**：取源 actor 按 descriptor 经 `factory.resolve().read_file()`——远程 Archive 缩略图 = `ArchiveMediaSource.read_file` 接 `ensure_cached` 后自动生效（零新链路）。
5. **远程目录的 `is_archive` 恒 false**（webdav_impl PROPFIND 解析硬编码）——远程 ZIP 浏览入口缺失，本设计补。
6. **migration 最新 015**（014 触控区清理 + **015 position_kind 已被 module3.1.1 占用**——2026-08-19 计划期复核 github/main 发现原稿「最新 014」过期，撞号预警成真）；`archive_cache` 用 **016**。
7. **FileBrowser `openArchive` 为 Local 形态**（archiveParent 记 `{rootPath, path}`）——远程源打开 ZIP 需泛化。

## 1. 目标 / 非目标

**目标**（母 spec §5 + 能力矩阵「远程 Archive」列）：

- Materializer：SMB/WebDAV 上的 CBZ/ZIP 完整下载至本地缓存后解压读取；cache key + 失效判定 + 下载期间变更防护 + 断点续传
- 远程 ZIP 全链路：远程目录双击 CBZ → 「正在准备压缩包」→ 条目视图 → 阅读 → 缩略图（masonry）
- 预载调度（复用 3.0.7 thumbnail scheduler 模式）：元数据预载 / 内容预载 / 强制预存三级
- archive cache 管理：LRU + 容量上限 + 启动清理 + 手动清空 + Settings remote section
- 验收（母 spec §5.5）：首开准备态 / 二次秒开 / 远端变更失效重下 / 断点续传 / LRU 淘汰 + 手动清空

**非目标**（YAGNI）：

- RAR/7z 远程物化（本地尚不支持，DESIGN §16.1 另行模块）
- ZIP 基于 Range 的随机读取优化（母 spec 明确首期整包下载）
- ETag 失效（首期 size+mtime；ETag 后置可选字段）
- 下载暂停/取消 UI（epoch 取消内部生效，无显式按钮）
- 进度百分比 UI 精细化（事件携带进度数据；UI 首期 indeterminate 文案）

## 2. 架构与依赖方向（母 spec §2 断环设计落地）

```text
lib.rs 启动构造顺序：
  concrete sources（Local / Smb / WebDav 的 Arc）
    → Materializer（持 WebDav + Smb 两源 Arc，不经 factory——环断开）
    → ArchiveMediaSource::new(materializer)
    → Factory（持四源）
```

- `ArchiveMediaSource` 由 factory 注入 `Arc<Materializer>`，职责两件事：对已物化缓存文件列条目、解压读取
- 远程包的 origin 读取（stat / 分块下载）只经 Materializer 持有的具体源 Arc，**不递归经 factory**（母 spec §2）
- 未来新增远程源：factory::new 补 concrete source + materializer 源列表追加

**与 M2 的关系**：Materializer 的 smb 源 Arc 在 M2 交付前以现有 stub `SmbMediaSource` 注入（构造期存在即可，调用必 NotImplemented → 502）——M3 的 WebDAV 路径可独立开发验收，不被 M2 阻塞。

## 3. `archive_cache` 表（migration 015）

```sql
CREATE TABLE archive_cache (
  cache_key TEXT PRIMARY KEY,         -- sha256(canonical origin descriptor JSON + '\0' + archive_rel_path)
  origin_kind TEXT NOT NULL,          -- 'webdav' | 'smb'（清缓存/展示用；语义冗余可校验）
  archive_rel_path TEXT NOT NULL,
  origin_size INTEGER NOT NULL,       -- 物化时的远端 size（字节）
  origin_mtime INTEGER,               -- 物化时的远端 mtime 秒；NULL = 源不提供
  cache_abs_path TEXT NOT NULL,       -- 物化文件绝对路径
  byte_size INTEGER NOT NULL,         -- 实际文件字节（应 == origin_size，校验用）
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);
```

- **只存 ready 态**：`.part` 临时文件不入表（断点续传靠文件系统存在性 + 大小判断，不依赖索引）
- cache key 的 canonical 序列化：复用 typed `serde_json::to_string(SourceDescriptor)`（migration 013 已验证的 canonical 形态，不新造 raw-Value 字母序变体）
- LRU 依据 `last_accessed_at`（命中 touch；与 thumbnail_cache 同款 DAO 模式）

## 4. Materializer（`src-tauri/src/source/archive/materializer.rs` 新文件）

```rust
pub struct Materializer {
    webdav: Arc<WebDavMediaSource>,
    smb: Arc<SmbMediaSource>,
    cache_root: RwLock<PathBuf>,              // 支持运行时查看/迁移（起步只读设置）
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,  // 按 cache_key 去重
}

impl Materializer {
    /// 核心入口：确保 origin 上的 archive_rel_path 已物化，返回缓存绝对路径。
    /// 全部调用方（ArchiveMediaSource 三方法 + 预载）统一走这里。
    pub async fn ensure_cached(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> Result<std::path::PathBuf, MaterializeError>;
}
```

### 4.1 ensure_cached 状态机

```text
cache_key = sha256(canonical(origin) + '\0' + archive_rel_path)
  ├─ 查表命中 → stat 远端（size/mtime）
  │    ├─ 与表内 origin_size/origin_mtime 一致 → touch last_access → 返回 cache_abs_path
  │    └─ 不一致（远端已变更）→ 删表行 + 删缓存文件 → 走下载
  ├─ 表 miss → in-flight 去重（同 key 已在下载 → await Notify 后重查表）
  └─ 下载：
       快照 stat（size/mtime）→ range 分块循环（4MB chunk）
         → .part 追加写（cache_root/part/{cache_key}.part）
         → 完成后【rename 前二次 stat】：与快照一致 → 原子改名 .part → {cache_key}.zip
                              不一致 → 删 .part → 按新版本重新排队（epoch 计数防死循环，重试 ≤1 次）
       → upsert 表行（ready）→ notify 等待者 → 返回
```

- **断点续传**：下载开始时发现 `.part` 已存在 → 先 stat 远端：远端 size < `.part` size（文件已换/截断）→ 弃 `.part` 重来；否则从 `.part` 当前偏移续传
- **失败语义**：下载中途网络错误 → `.part` 保留（供续传）+ 上抛 `MaterializeError::Network`（media:// 层 502；UI 走重试）
- **epoch 取消**：预载任务被取消（切目录）→ 停止发起新 chunk；已写 `.part` 保留

### 4.2 失效判定（纯函数，可单测）

```rust
fn is_stale(row_origin_size: i64, row_origin_mtime: Option<i64>,
            current: &FileStat) -> bool
// size 不同 → 失效；mtime Some 且不同 → 失效；row mtime None 且 current Some →
// 以 size 为唯一判据（SMB mtime 缺失场景），保守放行
```

### 4.3 分块下载

- chunk 4MB（代码常量）；每块 `read_file(origin, rel, Some(ByteRange{offset, 4MB}))`——Range 强契约保证恰好区间
- 并发：**首期顺序下载**（单连接顺序流式写 `.part`）。`archive_download_concurrency` 设置项保留但首期恒 1（母 spec 列了该项——做成常量起步 + 设置占位为 1，避免多连接写同一 `.part` 的偏移管理复杂度进首期；多连接分段下载后置）
- 事件：每 chunk 完成 emit `archive://progress`（载荷：cache_key / relPath / downloaded / total_bytes / phase: downloading|ready|failed）——非阻塞 `let _ =`，模式同 `thumbnail://progress`

## 5. ArchiveMediaSource 接入（`archive_impl.rs` 改造）

- 构造：`ArchiveMediaSource::new(materializer: Arc<Materializer>)`
- 三方法（list / read / stat）前置统一路径解析：

```rust
// 三方法均为 async_trait（可直接 await，无 block_on——见 §12）
async fn resolve_archive_path(&self, descriptor) -> Result<PathBuf> {
    match descriptor.origin {
        None => Ok(PathBuf::from(archive_path)),                   // 本地直开（现状，零回归）
        Some(origin) => materializer.ensure_cached(               // 远程物化
            origin, archive_rel_path).await.map_err(→ MediaSourceError)
    }
}
```

- 后续逻辑（读 ZIP / central directory / entry 解压 / stat entry size）对物化后的本地文件与本地包**完全一致**——M1 已验收的本地路径成为远程路径的真子集
- 两条 stat 路径维持分离（母 spec §5.1 rev3）：协议层 entry stat（解压后 size）与物化层容器 stat（`origin.stat`，Materializer 内部使用）不混用

## 6. 远程 ZIP 浏览入口（前端 + webdav 补丁）

### 6.1 `is_archive` 判定（webdav_impl）

PROPFIND 解析处按 href 末段扩展名跑 `ArchiveFormat::from_extension` 置 `is_archive`（对齐 local.rs 语义；webdav 无资源类型元数据，扩展名是唯一可用信号）。

### 6.2 FileBrowser `openArchive` 泛化（`fileBrowser.ts`）

- `archiveParent` 形态扩展：`{ descriptor: SourceDescriptor; relPath: string } | null`（进入前数据源，Local 或远程通用）
- `openArchive(entry)`：
  - 当前源 Local → 现状（`archivePath` = root/dir/name 绝对路径，origin None）
  - 当前源 WebDAV/SMB → 构造 `Archive { archivePath: 虚拟 URL/UNC, entryPrefix: '', format, origin: Some(当前 descriptor), originEntryPath: joinRel(currentPath, name), archiveRelPath: 同左 }` → `currentDescriptor` 置入 → `fetch('')`（首次 fetch 走 ensure_cached → 下载整包 → loading 态覆盖）
- `exitArchive`：恢复 `archiveParent.descriptor`（`openDescriptorAt(parent.descriptor, parent.relPath)` 复用）
- `up()` 顶层退出 / 面包屑 ZIP 名点击退出：同款恢复（现状逻辑，恢复目标从 rootPath 换 descriptor）
- **「正在准备压缩包」占位**：`fetch` 期间现有 `fb.loading` 转圈文案即可；`archive://progress` 事件监听后文案细化（`fileBrowser.archivePreparing` i18n，显示 downloaded/total MB）——首期 indeterminate 文案 + 事件数据留增强

### 6.3 阅读器 / 缩略图（零改动）

双击 ZIP 内图片 → `useReaderBookLoader`（M1 已通用）→ `media://archive/...` URL → handler rebuild → `ArchiveMediaSource.stat/read` → ensure_cached（已物化则秒回）→ 解压 entry。缩略图同链路（取源 actor）。强制预存 = 首次打开的同步等待，无需专门代码。

## 7. 预载调度（`source/archive/prefetch.rs` 新文件）

复用 3.0.7 thumbnail scheduler 模式（优先队列 + in-flight 去重 + epoch 取消），任务三级（母 spec §5.3）：

| 级别 | 触发 | 实现 |
|---|---|---|
| 元数据预载 | 远程目录列举完成（entries 含 is_archive） | 对预读窗口内 archive 逐个 `origin.stat`（不下载），结果缓存在内存（本会话）——供失效判定预热 |
| 内容预载 | archive 进入 masonry 预读窗口 / 选中 | 低优先级 ensure_cached（走 in-flight 去重，与打开共享任务） |
| 强制预存 | 双击打开 / 阅读器进入 | 同步 ensure_cached（天然由 §5/§6 路径承担，调度器只提供已存在检查） |

- 预读窗口沿用 masonry 的像素窗口（3.0.7 selectPathsInPixelWindow 同源参数）；非 masonry 视图不内容预载（details 选中才预载）
- 开关 `remote_archive_prefetch_enabled`（默认 true）关闭时只保留强制预存
- 取消：切目录 / 换源 → epoch++（待开始任务丢弃；在途 chunk 完成后不续发）

## 8. cache 管理

- **位置**：`app_cache_dir()/archive-cache`（与 thumbnail 缓存分开目录分开设置，母 spec §5.4）
- **LRU**：超容量（`archive_cache_max_mb`，默认 2048）按 `last_accessed_at` 淘汰至 80% 水位——复用 `evict_to_limit` 模式（batch 256 + protected 跳过在途 key，与 thumbnail_cache 同款）
- **启动清理**：①删 `part/` 下孤儿 `.part`（无对应表行或重启遗留）②孤儿缓存文件（表无行）③超容量淘汰
- **手动清空**：Settings maintenance 区按钮（取消在途 → 删文件 → 清表 → toast 结果；模式同 `clear_thumbnail_cache`）
- **Settings remote section**（母 spec §5.4 五项）：`remote_archive_prefetch_enabled`（BooleanRow）/ `archive_cache_max_mb`（数值 Row，钳 512–32768）/ `archive_prefetch_window`（首期常量，设置项做只读展示或隐藏——**砍到 3 项 UI**，YAGNI：窗口与并发常量起步，不进设置页；母 spec 5 项中 2 项降级为代码常量，偏差记录在案）+ 清空按钮 + 缓存用量展示

## 9. i18n（双语）

```
fileBrowser.archivePreparing: 正在准备压缩包（{downloaded}/{total} MB） / Preparing archive ({downloaded}/{total} MB)
settings.remote.title / settings.remote.archiveCacheLimit / settings.remote.prefetchEnabled / settings.remote.clearArchiveCache / settings.remote.archiveCacheUsage
settings.remote.clearConfirm: 确认清空压缩包缓存（{count} 项 / {size}）？
```

## 10. 测试策略

- **纯函数**：cache key 稳定性（同 descriptor+rel 同 key / 不同 origin 分 key）；`is_stale` 失效矩阵（size 变/mtime 变/mtime None）；UNC/URL 虚拟路径拼接
- **Materializer（mock MediaSource：可控字节/错误/延迟）**：完整下载→原子改名→表行 ready；二次调用秒回（不再下载——mock 计数断言）；远端 size 变更→失效重下；rename 前二次 stat 不一致→弃 .part 重排队（≤1 次）；断点续传（.part 半截+远端一致→从偏移续；远端截断→弃重下）；并发去重（两任务同 key 单下载，Notify 双醒）；取消（epoch 失效后不续发 chunk）
- **DAO**：archive_cache upsert/touch/evict（80% 水位 + protected）/clear（migration 015 建表断言）
- **ArchiveMediaSource**：origin None 零回归（M1 既有用例不红）；origin Some（mock materializer trait）分派正确
- **webdav**：PROPFIND fixture 含 .cbz/.zip href → is_archive true；普通文件 false
- **前端**：openArchive 远程分支 descriptor 构造（origin/archiveRelPath 断言）；exitArchive 恢复远程源；进度事件文案
- **集成（tempdir + mock 源字节构造真 ZIP）**：物化→解压→读 entry 字节端到端
- **回归**：全量 Rust / 前端绿（硬门槛）

## 11. 验收清单（母 spec §5.5 + 能力矩阵「远程 Archive」列）

1. 打开 WebDAV 上的 CBZ：首次「正在准备压缩包」→ 下载完成 → 条目视图 → 阅读（三模式）
2. 二次打开同包：秒开（devtools 确认无网络请求——LRU/表命中）
3. 远端压缩包更新（size 或 mtime 变）：缓存失效自动重下
4. 断点续传：下载中途断网 → 恢复 → 从 `.part` 续传不重头（devtools 看请求 offset）
5. LRU：超容量淘汰最旧；手动清空按钮生效（文件 + 表 + 用量展示归零）
6. 远程 ZIP 的 masonry 缩略图 + 原图打开（取源链 ensure_cached 复用）
7. （M2 后）SMB 上的 CBZ 同 1-6 复验
8. Local ZIP 零回归（M1 验收 2 复跑）

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 大包整包下载占满磁盘 | 容量上限 + LRU + 启动清理；`.part` 目录计入用量统计 |
| 下载期间远端变更拼出损坏包 | rename 前二次 stat 快照比对（母 spec rev3 防护）；损坏 ZIP 解压报错走重试 |
| ensure_cached 在 trait 同步上下文阻塞 | ArchiveMediaSource 方法本就 async（async_trait），直接 await；无 block_on |
| WebDAV 服务器对高频 Range 限流 | chunk 4MB（请求数低）；失败重试退避（沿用 MediaSourceError 上抛，UI 手动重试） |
| 双机 migration 号冲突 | 实施前 `git fetch github main` 复核（015 占用则顺延） |

## 13. 交付

- tag：`v0.1.0-module3.4.0-remote-archive`
- migration：016（archive_cache 表；015 已被 module3.1.1 position_kind 占用）
- 新文件：`source/archive/mod.rs` + `source/archive/materializer.rs` + `source/archive/prefetch.rs` + DAO（并入 materializer 或独立 `archive_cache_dao.rs`）
- 修改：`archive_impl.rs`（构造注入 + 路径解析）/ `factory.rs`（构造顺序）/ `webdav_impl.rs`（is_archive）/ `fileBrowser.ts` + `FileBrowser.vue`（openArchive 泛化 + 进度文案）/ `Settings.vue`（remote section）/ `commands/thumbnails.rs` 同款清空命令（新 command `clear_archive_cache` + `get_archive_cache_info`）/ i18n 双语
