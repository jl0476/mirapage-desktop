# SMB 协议层（M2）实施设计

> 日期：2026-08-19
> 状态：设计待审查
> 母设计：`docs/superpowers/specs/2026-08-18-smb-remote-media-design.md` §4（rev5 定稿，5 轮审查）
> 前置：M1 已交付（`v0.1.0-module3.2.0-media-display` + 评审修复打磨）
> 关联：DESIGN.md §16.1「SMB 协议层」条目随本设计交付划掉剩余项

## 0. 背景与事实基线（M1 后）

M1 已把 SMB 之外的全部地基铺好，M2 的实际工作量集中在 `smb_impl.rs` 实装与连接管理：

1. **协议与显示层全通**：`media://smb/{accountId}/{initialPath}/{relPath}` URL 形态、`rebuild_descriptor` 的 Smb 分支（含根路径契约校验：initialPath 首段 === account.share，不符 403）均已交付。
2. **`smb_impl.rs` 全 stub**：list/read/file_count 四方法 `NotImplemented`，stat 走 trait 默认 `NotImplemented`。
3. **`smb = "0.11"`**（afiffon/smb-rs，纯 Rust SMB2/3，NTLM via sspi）已编译进构建未使用；stub 注释注明 API 以 docs.rs 为准（新发布，README 形态可能与实际有差异）。
4. **凭据/账户框架就位**：account 表 + keyring（CredentialStore）、Accounts UI（share 字段）、`test_connection` 对 smb 返回明确错误（M2 换真握手）。
5. **跨卷**：`find_next_volume::listing_kind` 对 Smb 返回明确报错（本设计放开）。
6. **缩略图/阅读器/瀑布流/喜欢/书签/历史**：M1 已按 descriptor 通用化，WebDAV 验收通过即对 SMB 生效（验收复验，不改代码）。

## 1. 目标 / 非目标

**目标**（母 spec §4 + 能力矩阵 SMB 列）：

- `SmbMediaSource` 5 方法实装（list_directory / read_file / stat / file_count / test）
- 连接管理器：按 accountId 复用连接 + 空闲 TTL 回收 + 连接级错误重建重试一次
- 根路径契约双侧校验收口（handler 侧已有；source 侧补 UNC 拼接前的校验）
- test_connection 真握手；跨卷放开 Smb
- 验收：账户添加（密码落 keyring）→ 浏览（details + masonry）→ 阅读（三模式 + 跨卷 + 书签/进度/历史/喜欢/快捷方式）→ Range 206/416 → 断网恢复

**非目标**（YAGNI）：

- SMB over QUIC / multichannel / 签名加密调优等 smb-rs 高级特性
- 写操作（上传/删除/重命名——项目铁律）
- SMB 账户的 host 缓存发现（枚举网上邻居）
- 连接预热（首个请求建立即可）

## 2. spike（M2 计划的第一个任务，半天）

独立 demo（`src-tauri/examples/smb_spike.rs`，不进 lib）连真实 NAS（账号密码）验证七点（母 spec §4.1）：

1. dialect 协商 + NTLM 认证（sspi）
2. `Directory::query` 列目录返回字段 → MediaEntry 映射可行性
3. `File::read_block` Range 读 + 越界行为（对齐 Range 强契约：必须恰好区间，越界报错而非短读）
4. 文件 stat API（size / modified_at 获取方式 → `FileStat`）
5. 大图（4-8MB）顺序读吞吐
6. **Client 复用语义**：可否 `Arc` 共享跨并发任务（决定连接管理器结构）；断线后 Client 状态；多 share 行为
7. 错误类型可否区分「连接级」vs「文件级」（决定重连策略）

**失败切换标准**：dialect/认证/读块任一不工作或吞吐 < 5MB/s 不可优化 → 切备选路线（Windows 原生 UNC + `WNetAddConnection2`，仅 Windows；Linux/macOS 后置）。结论回写母 spec §4.1，M2 spec 此节标注修订。

**本设计对 spike 的依赖处理**：连接管理器与实装按「smb-rs 主路线」设计（下文），涉及 spike 确认点的位置显式标注 `【spike】`；spike 结论若推翻假设，仅影响标注点局部（连接结构 / 错误分类两处），架构不变。

## 3. 连接管理器（`src-tauri/src/source/smb/connection.rs` 新文件）

SMB 与 WebDAV 的最大差异：**有状态连接**（认证会话）。WebDAV 每请求无状态 HTTP；SMB 每次认证握手成本高（NTLM 多轮），必须复用。

```rust
pub struct SmbConnectionManager {
    connections: Mutex<HashMap<i64, ManagedConnection>>,
    db: crate::db::Db,
    creds: Arc<dyn CredentialStore>,
}

struct ManagedConnection {
    client: Arc<SmbClientHandle>,   //【spike】Arc 共享语义；不可共享则换连接池
    last_used: Instant,
}
```

- `get_or_connect(account_id) -> Result<Arc<SmbClientHandle>>`：命中刷新 `last_used`；miss 查 account 行（host/port/share/username）+ keyring 密码 → 建 Client → 存入
- **TTL 回收（懒清理）**：`get_or_connect` 时顺带扫描剔除 `last_used` 超过 5 分钟的条目（代码常量，非用户设置）。不起后台线程——空闲连接占用的只是内存句柄，懒清理足够
- **凭据缓存语义**：连接建立时取一次 DB+keyring（连接生命周期内缓存）。账户密码变更后旧连接 TTL 内仍用旧凭据——与 WebDAV「每请求取」不同，接受（5 分钟窗口；编辑账户场景罕见，重开 app 即刷新）。写进设计权衡，不做失效广播
- **UNC 拼接**（纯函数，可单测）：
  ```rust
  fn unc_path(host: &str, port: i32, initial_path: &str, path: &str) -> String
  // \\{host}\{initial_path}\{path}；descriptor path 为 '/' 分隔 → 转 '\'
  // port != 445 时 SMB over 非 445 的 host 形态【spike】确认 smb crate 支持度
  ```
- **根路径契约 source 侧校验**：UNC 拼接前 `initial_path` 首段 === account.share（与 handler 侧同款判定，母 spec §4.2 双侧校验收口）；不符返回 `PathEscape`
- **连接级错误重试**：实装方法调用失败且错误归类为连接级【spike：错误分类方式】→ 从管理器剔除该连接 → 重建 → 重试一次 → 再失败上抛（media:// 层映射 502）

**测试策略（无 NAS 的 CI）**：`SmbClientHandle` 以 trait 抽象（`SmbTransport`：connect/list/read_block/stat 四能力），生产实现包 smb crate，测试用 mock 实现——TTL 过期回收 / miss 建连 / 连接级错误重建重试 / 凭据取数失败传播 / UNC 拼接与契约校验均可单测。

## 4. SmbMediaSource 实装（`smb_impl.rs` 替换 stub）

- 构造：`SmbMediaSource::new(manager: Arc<SmbConnectionManager>)`；factory::new 构造 manager（与 WebDav 同款注入 db + creds）后传入
- **list_directory**：`query` → `Vec<MediaEntry>`（name / size / mtime 秒级 / is_directory；`is_archive` 按扩展名 `ArchiveFormat::from_extension`——对齐 local.rs，webdav 的 PROPFIND 同步补此判定见 M3 spec §6）；自然排序复用 `algorithm::natural_compare`
- **read_file**：`read_block` Range 强契约——请求区间必须恰好返回（越界/短读报错，对齐 Local 的 read_exact 语义与 WebDAV 的 verify_range_response）；无 range 全量
- **stat**：file info query → `FileStat { size, modified_at: 秒 }`（mtime 精度以 spike 结论为准，不支持则 None）
- **file_count**：list 过滤非目录非压缩包
- **test**：真连接 + 列根（share 根）一次；share 缺失（NULL）返回明确配置错误文案（母 spec §4.2）
- **路径校验**：每个方法对 `path` 参数先跑 `algorithm::validate_source_relative`（PathEscape 防御，与 local.rs 同款）

## 5. 接线与放开点

| 位置 | 改动 |
|---|---|
| `factory.rs` | `new(db, creds)` 内构造 `SmbConnectionManager` → `SmbMediaSource::new(mgr)` |
| `commands/accounts.rs` | `test_connection` smb 分支删「尚未实装」换 factory 真握手 |
| `find_next_volume.rs` | `listing_kind` 放开 `SourceDescriptor::Smb`（factory 列目录自动生效——排序/跳已读/directory_sort 操作 MediaEntry 与 location_key，母 spec §3.2 泛化结论） |
| `commands/warm.rs` | 无改动（rebuild_descriptor Smb 分支 M1 已交付，read 走 factory 自动生效） |

前端零改动（descriptor 通用链路 M1 已验收）。

## 6. i18n

`accounts.*` 补充 testFail 细化文案（连接失败 vs 配置错误 vs 凭据错误——`test_connection` 错误字符串区分三态，前端 toast 透传）。中英双语。无新增页面/组件。

## 7. 测试策略

- **纯函数**：UNC 拼接（445/非 445、'/'→'\' 转换、空 path）；根路径契约校验；MediaEntry 映射（mock query 结果 → entry 字段断言）
- **连接管理器（mock SmbTransport）**：TTL 回收（注入时钟或短 TTL）/ miss 建连 / 连接级错误剔除重建重试一次 / 文件级错误不重建 / keyring 失败传播
- **trait 方法（mock transport）**：list 成功与 NotFound / read range 恰好区间与越界报错 / stat 映射
- **实机**：spike 七点 + §8 验收清单
- **回归**：既有 375+ Rust / 1122+ 前端全绿（硬门槛）

## 8. 验收清单（母 spec §4.3 + 能力矩阵 SMB 列复验）

1. 添加、测试 SMB 账户（密码落 keyring 不落库；Windows 凭据管理器目检 `smb-{id}` 条目）
2. 浏览 SMB 目录（details + masonry 两视图；缩略图走 M1 通用取源链）
3. 阅读 SMB 普通图片目录（single/double/webtoon 三模式 + 跨卷[含跳已读] + 书签/进度/历史/喜欢/快捷方式同一 descriptor 流程）
4. Range 请求 206/416 实测（devtools 构造）
5. 断网恢复：拔网线 → 阅读报错 → 恢复 → 重连一次成功继续读（连接级重试验证）
6. 预读预载复验（warm 会话协议对 SMB 生效——翻页后 3 张 LRU 命中）

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| smb-rs 与真实 NAS 互操作失败 | spike 前置 + UNC 备选切换点（§2）；标注点局部化 |
| smb-rs API 与 README 形态不符 | spike 产出真实 API 摘要回写母 spec §4.1；实装以 spike 代码为准 |
| Client 不能 Arc 共享 | 连接管理器降级为每任务连接 + 短 TTL 复用池（结构不变，Handle 内部换池）【spike】 |
| 高并发下文件锁（M1 打磨期间实测 Defender 干扰 rmeta） | CI/本地跑 `cargo test -j 2`；不属代码问题 |
| NTLM 仅支持（无 Kerberos） | sspi NTLM 覆盖主流 NAS；Kerberos 后置（记录非目标） |

## 10. 交付

- tag：`v0.1.0-module3.3.0-smb`
- 无 migration（复用 account 表；无新表）
- 新文件：`source/smb/mod.rs`（或并入 smb_impl.rs）+ `source/smb/connection.rs` + `examples/smb_spike.rs`
- 修改：`smb_impl.rs` / `factory.rs` / `commands/accounts.rs` / `find_next_volume.rs` / i18n 双语
