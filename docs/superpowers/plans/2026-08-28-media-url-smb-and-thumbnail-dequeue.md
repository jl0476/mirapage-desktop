# SMB mediaUrl 403 + 缩略图任务出队统一治理 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 2026-08-28 实机暴露的四个缺陷：A）SMB share 根浏览下 `mediaUrl` 空 initialPath 段导致原图直显全量 403 白屏（masonry 与 reader 同病）；B）`MasonryThumbnail` 的 `load-error` 事件在 `MasonryRow` 接线悬空，img 加载失败无任何 UI 兜底；C）缩略图任务出队逻辑缺失（同源切目录不出队、维度翻转 USE_ORIGINAL 后旧任务不取消、卸载不出队阻挡新目录）；D）前端 epoch 跨会话从 0 重数与 Rust `current_epoch` 错位。

**架构：** A 在 `mediaUrl.ts` smb 分支做单点换算（空 `initialPath` 时取 relPath 首段补位、relPath 剥 share 前缀），全部调用方（masonry originalUrlFor / reader 页 URL / 预读）自动覆盖；B 补 `MasonryRow` 事件接线并复用现成 failed 卡片 UI；C 分两层——粗粒度 epoch（把 `currentPath` 纳入失效键 + 卸载时 bump）与细粒度新增 Rust `cancel_keys` 命令（USE_ORIGINAL 判定时取消同 key 任务）；D 用 `Date.now()` 播种 epoch（对齐 3.4.0 archive epoch 先例）。

**技术栈：** Vue 3 composable / Vitest（前端）；tokio mpsc actor / cargo test（Rust）；CDP 实机验证。

---

## 1. 背景与证据（2026-08-28 实机 CDP 取证，SMB 目录 `H/00down/2504/4515 抖音 琳铛 微密圈 NO.099期【45P2V】`，46 项）

### 1.1 缺陷 A：SMB mediaUrl 双重错位 → 403

**症状**：瀑布流 12 张 `USE_ORIGINAL` 直显小图全部白屏（img `naturalWidth=0`），13 张 `CACHED` 缩略图正常。后续 (29) 等图因后台任务补齐缓存转 `cached` 才"自愈"——坏 URL 本身始终存在。

**根因**（`src/lib/mediaUrl.ts:37` + `MasonryView.vue:207` + `useReaderBookLoader.ts:165`）：

```ts
case 'smb':
  return mediaSrc(`smb/${descriptor.accountId}/${seg(descriptor.initialPath)}/${seg(relPath)}`);
```

当前会话 descriptor 为 `{ smb, accountId: 2, initialPath: "", path: "" }`（share 根浏览形态，合法），调用方传的 relPath 是 UI 路径模型（带 share 前缀 `"H/00down/..."`）。拼出 `/smb/2//H%2F00down...`——**initialPath 段为空**。Rust `parse_media_path`（`media_protocol.rs:160-166`）四段匹配后 `validate_rel_path("")` 拒绝空串 → 403。

**reader 同病实锤**：history 行（bookId=21）存的就是 `initialPath:""` + `relPath:"H/00down/..."`，`useReaderBookLoader` 用 `joinRel(normalizedRel, name)` 拼 URL——同一坏形态，阅读器页同样 403 白屏。

**media URL 契约**（`media_protocol.rs:284-293` parse 测试）：`/smb/{id}/{initialPath}/{relPath}` 要求 `initialPath` 非空（首段 === account.share 形态）、`relPath` 相对 `initialPath`。

**顺带**：media handler 对 403/404 完全无日志（本次排查全靠 CDP 逆向），补错误日志。

### 1.2 缺陷 B：load-error 事件悬空

`MasonryThumbnail.vue:132` 有 `@error="onError"` → `emit('load-error')`（组件测试覆盖），但 `MasonryRow.vue:90-98` 的 `<MasonryThumbnail>` 接线只监听 `@retry/@show-progress/@measured`——`load-error` 无人消费（全局搜索证实唯一消费方是测试文件）。任何 img 加载失败（403、缓存文件被删、网络抖动）都是纯白无提示。现成 failed UI（错误角标 + ↻ 重试）到不了。

### 1.3 缺陷 C：出队逻辑场景矩阵（代码实证）

| # | 场景 | 现状 | 定性 |
|---|---|---|---|
| 1 | 切源/换根（descriptor 变） | epoch bump → Rust drain+abort ✓ | 正常 |
| 2 | **同源切子目录** | `useMasonryThumbnails.ts:142` epoch watch 无 `currentPath` → 不 bump 不出队；stateMap 不清（**同名文件错图窗口**） | ❌ |
| 3 | 列宽/DPR/质量变 | bump → drain ✓；state 不清（有意防闪烁） | 正常 |
| 4 | **维度回填翻转 USE_ORIGINAL** | `service.rs:183` 判 UseOriginal 直接 return，不取消已排队任务（小图"缩略图"= 原尺寸重编码，纯浪费） | ❌ |
| 5 | **卸载**（切 details/离开路由） | 不 bump → 旧任务占 worker，阻挡后续目录 | ❌（用户拍板：要出队） |
| 6 | 清空缓存 | cancel_all ✓ | 正常 |
| 7 | 快速滚动窗口淘汰 | 不取消（只挡 idle 新提交） | 维持（用户拍板：不取消，靠 visible 优先保证新内容优先） |

**用户拍板（2026-08-28）**：① 卸载要出队（后续切别的目录，不出队会阻挡新目录生成）；② 滚动不取消但保证新内容优先（现状的优先级调度已满足）；③ 切目录直接出队。

### 1.4 缺陷 D：epoch 跨会话错位

composable 卸载重建后 `epoch` ref 从 0 重数，而 Rust `current_epoch` 保留旧值（本会话已到 3）。后续 bump 时 `notify(epoch=1)` 会把 Rust `current_epoch` **回退**（`handle_new_epoch` 无单调守卫），且 epoch=0 的新任务相对旧 current 判定语义混乱——误杀/漏杀都可能。3.4.0 archive epoch 已用 `Date.now()` 播种防同款问题，缩略图 epoch 未做。

---

## 2. 方案选型

| 决策点 | 选定 | 理由 |
|---|---|---|
| A 修复位置 | `mediaUrl.ts` smb 分支内聚换算 | 单点修复自动覆盖全部调用方；改调用方则分散易漏 |
| A 换算规则 | 抽纯函数 `smbUrlParts(initialPath, fullPath)`，**普通 smb 与 archive-smb 两分支共用**（R1 审查 P0-1：`origin.initialPath=''` + 带前缀 `archiveRelPath` 的 share 根压缩包同病，`/archive/smb/{id}//H%2F...` 同样被拒） | 同一 URL 契约同一换算；空 initial 取首段（share 名）、非空剥前缀，对齐 `MediaTarget::Smb` 语义与 3.5.1 "空 initial 补 share 首段" 先例 |
| B 兜底形态 | load-error → 转 failed 态复用现成 UI | `MasonryThumbnail` 的 failed 角标 + 重试按钮现成，只缺接线 |
| C 粗粒度 | `currentPath` 纳入 epoch 失效键 + 卸载 bump | 机制现成（3.5.4 已配 abort in-flight），零新协议 |
| C 细粒度 | Rust 新增 `cancel_keys` 命令，**同时覆盖 scheduler 与 RemoteFetchActor 两段队列**（R1 审查 P1-3：远程源任务先经 fetch actor 取源、`on_fetched` 才 submit scheduler，只取消 scheduler 段无效） | USE_ORIGINAL 场景不能 bump epoch（会误杀同目录其他正常任务）；按 key 取消是正确粒度，fetch actor 已有 epoch 级 pending 取消先例（`fetch.rs:233` 测试），按 key 是同机制收敛 |
| D | **模块级全局单调分配器** `nextThumbnailEpoch() = max(Date.now(), last + 1)`；新实例初始化即取值并在首次提交前 notify；Rust `handle_new_epoch` 拒绝 `epoch <= current` 的回退通知（R1 审查 P0-2：每实例独立 `Date.now()` 播种在卸载 bump 与新实例初始化同毫秒时会倒退） | 跨实例单调 + 服务端守卫双保险；对齐 3.4.0 archive epoch 先例并补足其未做的服务端守卫 |
| 滚动淘汰 | 不取消（文档化决策） | visible/ahead 优先级天然先跑；缓存全局有效 |

**不做**：不改 `media_protocol.rs` 的校验语义（空段拒绝是对的——防御性契约）；不动 `policy.rs` 维度未知判 GENERATE 的逻辑（有意设计，注释明确）；不清理 stateMap 与列宽变化的交互（raced 守卫现状保持）。

---

## 3. 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/lib/mediaUrl.ts` | 修改 | smb 分支换算 + 新增导出 `smbUrlSegments()` 纯函数（可测） |
| `src/lib/mediaUrl.test.ts` | 修改/创建 | 换算规则单测（先红） |
| `src/components/filebrowser/MasonryRow.vue` | 修改 | 补 `@load-error` 接线上抛 |
| `src/components/filebrowser/MasonryView.vue` | 修改 | 监听 row 上抛的 load-error → stateMap 转 failed |
| `src-tauri/src/media_protocol_handler`（`lib.rs` 内 `handle_media_request`） | 修改 | 403/404/502 错误 `write_log`（一行，带 path 与原因） |
| `src-tauri/src/thumbnail/scheduler.rs` | 修改 | `Command::CancelKeys{keys}` + `handle_cancel_keys`（pending drain 发 Stale、in-flight 置 abort）+ `SchedulerHandle::cancel_keys` |
| `src-tauri/src/thumbnail/fetch.rs` | 修改 | `new_epoch` 改 `fetch_max`（R2 P0-2）；`RemoteFetchActor::cancel_keys`（cancelled 按 `(cache_key, epoch)` 绑定：待取源跳过、在途完成丢弃不进 scheduler，消费后移除） |
| `src-tauri/src/thumbnail/service.rs` | 修改 | `request` 循环判 UseOriginal 时计算 cache_key 并对 scheduler + remote_fetch 双段 `cancel_keys` |
| `src/composables/useMasonryThumbnails.ts` | 修改 | epoch watch 拆组（目录/源→清 state + bump；布局→只 bump）；`currentPath` 纳入；卸载 bump；模块级全局 epoch 分配器 + `epochReady` 屏障；`markLoadFailed`/`retryLoadFailed` |
| `src/lib/tauri.ts` + `src-tauri/src/commands/thumbnails.rs` | 修改 | 新命令 `invalidate_thumbnail_cache_keys`（删文件+索引行，幂等，spawn_blocking）+ 前端封装 |
| 对应 `*.test.ts` / scheduler tests | 修改 | 各任务先红后绿 |

---

## 4. 任务分解

### 任务 1：A——mediaUrl SMB 换算（TDD）

**文件：** `src/lib/mediaUrl.ts`、`src/lib/mediaUrl.test.ts`

- [ ] **步骤 1：写失败测试**（覆盖六种形态，R1 审查 P0-1 补 archive 变体）

```ts
describe('mediaUrl smb 分支换算', () => {
  // 空 initialPath + share 前缀 relPath（实机 403 形态）→ 首段补位
  it('initialPath 空时取 relPath 首段作 initial、剩余作 rel', () => {
    const url = mediaUrl(
      { type: 'smb', accountId: 2, initialPath: '', path: '', port: 445 },
      'H/00down/2504/1 (31).jpg',
    );
    expect(url).toBe('http://media.localhost/smb/2/H/' + encodeURIComponent('00down/2504/1 (31).jpg'));
  });
  // initialPath 非空 → relPath 剥前缀
  it('initialPath 非空时 relPath 剥离 initialPath 前缀', () => {
    const url = mediaUrl(
      { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 },
      'share/comics/v1/001.jpg',
    );
    expect(url).toBe('http://media.localhost/smb/3/' + encodeURIComponent('share/comics') + '/' + encodeURIComponent('v1/001.jpg'));
  });
  // 前缀不匹配 → 不剥（防御：返回原样，让 Rust 403 并留日志）
  it('relPath 不以 initialPath 开头时不剥离', () => {
    const url = mediaUrl(
      { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 },
      'other/dir/1.jpg',
    );
    expect(url.endsWith('/' + encodeURIComponent('other/dir/1.jpg'))).toBe(true);
  });
  // R1 P0-1：archive-SMB share 根（origin.initialPath 空 + archiveRelPath 带前缀）同款换算
  it('archive smb 分支：origin.initialPath 空时 archiveRelPath 首段补位、entry 原样', () => {
    const url = mediaUrl(
      { type: 'archive', archivePath: '', origin: { type: 'smb', accountId: 2, initialPath: '', path: '', port: 445 }, archiveRelPath: 'H/books/a.cbz' },
      'p1.jpg',
    );
    expect(url).toBe('http://media.localhost/archive/smb/2/H/' + encodeURIComponent('books/a.cbz') + '/' + encodeURIComponent('p1.jpg'));
  });
  it('archive smb 分支：origin.initialPath 非空时剥前缀', () => {
    const url = mediaUrl(
      { type: 'archive', archivePath: '', origin: { type: 'smb', accountId: 2, initialPath: 'H/books', path: '', port: 445 }, archiveRelPath: 'H/books/a.cbz' },
      'p1.jpg',
    );
    expect(url).toBe('http://media.localhost/archive/smb/2/' + encodeURIComponent('H/books') + '/' + encodeURIComponent('a.cbz') + '/' + encodeURIComponent('p1.jpg'));
  });
  // local/webdav 分支回归不受影响
  it('local 与 webdav 分支不受影响', () => {
    expect(mediaUrl({ type: 'local', rootPath: 'D:/x' }, 'D:/comics/1.jpg'))
      .toBe('http://media.localhost/local/' + encodeURIComponent('D:/comics/1.jpg'));
    expect(mediaUrl({ type: 'webdav', accountId: 7, host: 'https://h:5006/home' }, 'sub/1.jpg'))
      .toBe('http://media.localhost/webdav/7/' + encodeURIComponent('sub/1.jpg'));
  });
});
```

- [ ] **步骤 2：跑测试确认失败**：`npx vitest run src/lib/mediaUrl.test.ts` → 预期首条 + 两条 archive 变体 FAIL（当前实现直拼空段）。
- [ ] **步骤 3：实现换算**（mediaUrl.ts，导出纯函数供两分支共用）

```ts
/** 2026-08-28 缺陷 A（R1 P0-1）：SMB URL 契约要求 initial 段非空（首段=share）、
 * rel 相对 initial。浏览态 descriptor 可能 initialPath=""（share 根）且调用方传
 * share 前缀 UI 路径——直拼产生空段被 Rust validate_rel_path 拒绝（403）。
 * 统一换算：空 initial 取 fullPath 首段（share 名）；非空时剥前缀（不匹配不剥，
 * 留给 Rust 403 + 日志暴露调用方数据错误）。 */
export function smbUrlParts(initialPath: string, fullPath: string): { initial: string; rel: string } {
  if (!initialPath) {
    const parts = fullPath.split('/').filter(Boolean);
    const initial = parts.shift() ?? '';
    return { initial, rel: parts.join('/') };
  }
  const rel = fullPath.startsWith(initialPath + '/')
    ? fullPath.slice(initialPath.length + 1)
    : fullPath;
  return { initial: initialPath, rel };
}
```

`smb` 分支改 `const { initial, rel } = smbUrlParts(descriptor.initialPath, relPath); return mediaSrc(\`smb/${descriptor.accountId}/${seg(initial)}/${seg(rel)}\`)`；archive-smb 分支对 `(origin.initialPath, descriptor.archiveRelPath ?? '')` 应用同函数，entry 段原样。（实现时可微调组织，六形态断言必须全过。）

- [ ] **步骤 4：跑测试确认通过**；同时盘点 `grep -rn "mediaUrl(" src/ --include=*.ts --include=*.vue | grep -v test` 调用面（预期仅 `MasonryView.vue:207` 与 `useReaderBookLoader.ts:165` 两处生产调用 + Rust 侧 `warm_media_urls` 若自拼 URL 需同规则——核查并在报告说明）。

### 任务 2：A 附带——media handler 错误日志

**文件：** `src-tauri/src/lib.rs`（`handle_media_request` 错误分支）

- [ ] 找到 `ProtocolError` → 状态码映射处，为 403/404/502 各加一行 `log::write_log("WARN", "media", &format!("reject {} {} reason={}", status, path, err))`；补 1 条 Rust 测试断言日志调用点存在（或按现有 media 测试基建加最小用例）。跑 `cargo test -j 2 media`。

### 任务 3：B——load-error 接线与重试链路（TDD，含 R1 P1-4 + R2 P1）

**背景（R1 P1-4 + R2 P1）**：现有 `retryThumbnail` → Rust `resubmit()` 对非 Local descriptor 直接返回 `unsupported`（`service.rs:887`）——远程源点了重试也无效。且 re-request 有盲区（R2 P1）：CACHED 命中校验只查**文件存在且非空**（`service.rs:139-142` `metadata.len() > 0`），**非空但损坏的 WebP 会再次返回同一 CACHED URL → 失败→重试→失败死循环**。因此 load-error 重试按来源分流：`original` 网络失败 → 直接 re-request；`cached` 文件损坏 → **先按 key 失效缓存（删文件+索引行）再 re-request**（重新 GENERATE，远程源走 fetch 链）。`markLoadFailed` 必须保留原 state 的 `cacheKey`（失效目标，R2 指出清空即丢失）。

**文件：** `src/components/filebrowser/MasonryRow.vue`、`MasonryView.vue`、`useMasonryThumbnails.ts`、`src/lib/tauri.ts`（新命令封装）、`src-tauri/src/commands/thumbnails.rs` + `service.rs`（invalidate 命令）、对应 test

- [ ] **步骤 1：失败测试**：
  1. MasonryRow：thumbnail emit `load-error` → 上抛 `row-load-error(entry)`；
  2. composable：`markLoadFailed(path)` 把 stateMap 中该 path 转为 `{ kind:'failed', cacheKey: <原 state 的 cacheKey，保留>, retryable:true, message:'load-error' }`；
  3. composable：`retryLoadFailed(path)`——原 state 为 cached（有 cacheKey）→ **先 `invalidateThumbnailCacheKeys([cacheKey])` 再 `requestThumbnails`**（mock 断言两者调用顺序与参数，损坏缓存场景不再返回原 URL 的闭环由此成立）；原 state 为 original → 直接 re-request（无 invalidate）；调用前该 path state 预置回 `{kind:'generating', phase:'queued'}`（spinner 反馈）；
  4. Rust：`invalidate_thumbnail_cache_keys(keys)` 命令——删缓存文件 + 索引行（幂等，key 不存在 no-op；参照 `clear` 的单 key 版本，`spawn_blocking` 同款约束），测试文件+行删除与幂等重调。
- [ ] **步骤 2：红** → **步骤 3：实现**：MasonryRow 模板 `@load-error="$emit('row-load-error', entry)"` + emits 声明；MasonryView `@row-load-error` → `markLoadFailed`；failed 卡片的 ↻ 统一调 `retryLoadFailed`（load-error 与生成失败共用 failed UI，重试语义统一；`retryThumbnail` 保留给 Rust failed 事件的 Local 场景）。`retryLoadFailed`：`findEntry(path)` 构造单 item → 有 cacheKey 则 `await invalidateThumbnailCacheKeys([cacheKey])` → `setState(generating/queued)` → `requestThumbnails(descriptor, [item], epoch.value, [])` → `applyResults`。
- [ ] **步骤 4：绿 + 组件断言**：failed 态卡片 ↻ 点击后 spinner 出现；cached 来源的重试先失效后请求（顺序断言）；original 来源无失效调用。

### 任务 4：C 细粒度——cancel_keys 覆盖 scheduler + RemoteFetchActor 双段（TDD，含 R1 P1-3 + R3 P0）

**背景**：远程源的 Generate 任务先入 `RemoteFetchActor`（SMB/WebDAV 取源，并发 4/64MB），`on_fetched` 才 `scheduler.submit`。只取消 scheduler 段，取源在途的任务仍会完成后送进解码队列。fetch actor 已有 epoch 级 pending 取消先例（`fetch.rs:233` `concurrency_limited_and_epoch_cancels_pending_and_drops_results`），按 key 取消走同机制。**R3 P0**：现有 `handle_completed()` 只在 `task.epoch < current_epoch` 时转 Stale（`scheduler.rs:451-455`）——按 key 取消不推进 epoch，同 epoch 的 in-flight 被协作取消返回 `Err(Cancelled)` 后会映射成 `Outcome::Failed` → `spawn_completion` 发 `thumbnail://state failed` **反向覆盖已由 UseOriginal 建立的 original 态**（卡片倒退成 failed）。必须给 InFlight 加完成态约束标志。

**文件：** `src-tauri/src/thumbnail/scheduler.rs`、`fetch.rs`、`service.rs`

- [ ] **步骤 1：失败测试**

```rust
// scheduler.rs tests——沿用 setup/task/recv_job 基建
#[tokio::test]
async fn cancel_keys_drains_pending_and_aborts_inflight() {
    let (handle, mut rx) = setup(SchedulerConfig { worker_limit: 1, memory_budget_mb: 1024, starvation_threshold: Duration::from_secs(60) });
    let _holder = handle.submit(task("holder", Priority::Visible, 1, 10)); // 占住唯一 worker
    let (_hj, _hreply) = recv_job(&mut rx).await;
    let r1 = handle.submit(task("k1", Priority::Visible, 1, 10));
    handle.cancel_keys(vec!["k1".into(), "holder".into()]);
    assert!(matches!(r1.await.unwrap(), Outcome::Stale));          // pending 被 drain 发 Stale
    // in-flight abort：holder 的 gen 闭包内 job.abort 已置位（recv_job 返回的 job 上断言）
}

// R3 P0：同 epoch in-flight 被 cancel_keys 后，完成回包（Cancelled 或成功）必须映射 Stale 而非 Failed
#[tokio::test]
async fn cancel_keys_inflight_completes_as_stale_not_failed() {
    let (handle, mut rx) = setup(SchedulerConfig { worker_limit: 1, memory_budget_mb: 1024, starvation_threshold: Duration::from_secs(60) });
    let rh = handle.submit(task("h", Priority::Visible, 1, 10));
    let (_hj, hreply) = recv_job(&mut rx).await;
    handle.cancel_keys(vec!["h".into()]);
    // 协作取消路径：gen 返回 Err(Cancelled)
    let _ = hreply.send(Err(ThumbnailError::Cancelled));
    assert!(matches!(rh.await.unwrap(), Outcome::Stale));           // 不得是 Failed
    // 成功路径同样 Stale：新任务跑完（跨阶段边界未检查 abort 时）
    let r2 = handle.submit(task("h2", Priority::Visible, 1, 10));
    let (_hj2, h2reply) = recv_job(&mut rx).await;
    handle.cancel_keys(vec!["h2".into()]);
    let _ = h2reply.send(Ok(ok_thumb()));
    assert!(matches!(r2.await.unwrap(), Outcome::Stale));
}
// 注：spawn_completion 收 Stale 不写索引不发 UI 事件（既有语义），单测层面以 subscriber
// 收到 Stale 为准；"completion 不产生 failed 状态事件"由 Stale 分支的既有行为保证，
// service 集成测试侧补一条断言（state 事件计数不变）。

// fetch.rs tests——按 :233 既有测试的 fake Fetch 模式新增
#[tokio::test]
async fn cancel_keys_skips_pending_and_drops_inflight_results() {
    // 待取源任务：cancel 后不再调用 fetch；
    // 在途任务：fetch 完成后 on_fetched 不被调用（结果丢弃，不进 scheduler）
}

// fetch.rs——R3 收尾建议：new_epoch（fetch_max 生效）时清理旧 epoch 的 cancelled 记录
#[tokio::test]
async fn new_epoch_clears_stale_cancelled_entries() {
    // cancel(k, epoch=5) → new_epoch(7) → k@epoch=7 的请求正常执行（记录已清）
}
```

- [ ] **步骤 2：红** → **步骤 3：实现**：
  - scheduler：`Command::CancelKeys { keys: Vec<String> }` + `handle_cancel_keys`（pending 匹配 drain 发 `Outcome::Stale`；inflight 匹配置 `abort` **并置 `stale_on_completion: true`**——`InFlight` 结构加该字段，`try_schedule` 插入时初始化 false）+ `SchedulerHandle::cancel_keys`；
  - **`handle_completed` 完成态约束（R3 P0）**：`let effective = if inf.stale_on_completion || epoch < self.current_epoch { Outcome::Stale } else { outcome };`（注意从 `inflight.remove` 取出的 `inf` 上读标志）；
  - fetch：`RemoteFetchActor` 增加 cancelled 记录 **`Arc<Mutex<HashMap<String /*cache_key*/, u64 /*epoch*/>>>`**（R2 附带建议：不能用永久 HashSet——未来同 key 合法新请求会被无声误杀；按 `(cache_key, epoch)` 绑定，epoch 变了的新请求不受影响）+ `cancel_keys(&self, keys_with_epoch)` 发命令；取源前查 `cancelled.get(key) == Some(prepared.epoch)` 才跳过（跳过后移除条目）；`on_fetched` 前同款检查丢弃在途结果（丢弃后移除）；**`new_epoch` 在 `fetch_max` 实际推进 current 后，清理所有 `epoch < current` 的 cancelled 条目**（R3 收尾：防任务已进 scheduler 后取消、fetch 侧记录永不被消费而累积）；
  - service：`request` 循环判 `UseOriginal` 时计算 `cache_key`（把 :196 起的 cache_key 计算提前到判定前），`scheduler.cancel_keys(keys)` 与 `remote_fetch.cancel_keys(keys)` 双发（幂等，无匹配 no-op）。
- [ ] **步骤 4：绿** + `cargo test -j 2 thumbnail::`。

### 任务 5：C 粗粒度 + D——composable epoch 重构（TDD，含 R1 P0-2 全局单调）

**背景（R1 审查 P0-2 + R2 审查 P0-1/P0-2）**：每实例独立 `Date.now()` 播种仍可倒退（同毫秒卸载 bump t+1 / 新实例初始化 t）；且 notify 是**异步 IPC，与首批 request 的后端到达顺序无契约**（`thumbnailWindows` immediate watch 挂载即排首批请求）——request 先到时 fetch actor 的 `prepared.epoch != current` 检查（`fetch.rs:85/120`）会直接丢弃新任务；RemoteFetchActor 的 `new_epoch` 又是无条件 `store`（`fetch.rs:157`），乱序 IPC 可让旧通知覆盖新值、旧 fetch 结果重新进解码链（`:129/140` 的 `==` 检查）。修法四件套：模块级全局分配器 + **notify 完成屏障（epochReady promise）** + 新实例挂载即 notify + **Rust 双端（scheduler + fetch actor）拒绝回退**。

**文件：** `src/composables/useMasonryThumbnails.ts` + test；`src-tauri/src/thumbnail/scheduler.rs`、`fetch.rs`（单调守卫）

- [ ] **步骤 1：失败测试**（composable 级按既有 mock 模板；Rust 侧各一）：
  1. `currentPath` 变化 → `notifyThumbnailEpoch` 被调用（出队）且 stateMap 清空；
  2. `colWidth` 变化 → `notifyThumbnailEpoch` 被调用但 stateMap **不清**；
  3. 组件卸载 → `notifyThumbnailEpoch` 被调用（卸载出队）；
  4. **同一毫秒跨实例单调**（`vi.useFakeTimers` 固定时间）：实例 A 挂载取 epoch=e、卸载 bump 至 e+1 → 实例 B 挂载取 epoch ≥ e+2，且 B 挂载时即 notify 初始 epoch；
  5. **notify 屏障（R2 P0-1）**：mock `notifyThumbnailEpoch` 返回受控 pending promise——挂载后首批 `requestThumbnails` 的调用时刻**不早于**该 promise resolve（用手动 resolve + 调用顺序数组断言）；bump 后同样满足；
  6. Rust scheduler：`new_epoch` 传入 ≤ current → 拒绝（日志 + current 不变、不 drain）；
  7. Rust fetch actor（R2 P0-2）：`new_epoch(5)` 后 `new_epoch(3)` → current 仍为 5（`fetch_max` 或显式比较）。
- [ ] **步骤 2：红** → **步骤 3：实现**：
  - mediaUrl.ts 同款思路在 useMasonryThumbnails.ts 模块级：`let lastThumbnailEpoch = 0; function nextThumbnailEpoch() { lastThumbnailEpoch = Math.max(Date.now(), lastThumbnailEpoch + 1); return lastThumbnailEpoch; }`；
  - composable 初始化 `const epoch = ref(nextThumbnailEpoch())`；维护 `let epochReady: Promise<void> = Promise.resolve();`——初始化与每次 `bumpEpoch` 都替换：`epochReady = notifyThumbnailEpoch(epoch.value).catch(() => {}) as Promise<void>;`（catch 吞错：屏障只保证顺序，不因 IPC 失败卡死请求）；
  - **`flushRequest` 在调用 `requestThumbnails` 前 `await` 当时快照**：`const ready = epochReady; ... await ready; if (epoch.value !== reqEpoch) return;`（await 后 re-check——bump 竞态下丢弃，旧响应守卫已有，这是请求侧对称防线）；
  - watch 拆两组：`() => [descriptor, currentPath]` → bump + 清 `state`/`pathToCacheKey`/`pendingProgress`/`progressSnapshots`；`() => [colWidth, dpr, quality]` → 只 bump；
  - `onBeforeUnmount` 追加 `bumpEpoch()`；
  - Rust `handle_new_epoch` 头部加 `if epoch <= self.current_epoch { log::write_log(WARN, "ignore regressed epoch …"); return; }`；
  - Rust `fetch.rs` `new_epoch` 改 `self.epoch.fetch_max(e, Ordering::SeqCst)`。
- [ ] **步骤 4：绿 + 全量前端**：`npm test -- --run` + `npm run type-check`。

### 任务 6：全量验证 + commit

- [ ] `cargo test -j 2`（预期全绿）；`npm test -- --run` + `npm run type-check`（0 err）。
- [ ] Commit（两段式可选，建议单 commit）：`fix(thumbnail+media): SMB share根 mediaUrl 403 / load-error 兜底 / 缩略图任务统一出队 / epoch 跨会话单调`，正文四点分述根因与修法 + 实机证据摘要 + 三项用户拍板决策。push `github main`（不打 tag）。

### 任务 7：实机 CDP 验证

- [ ] 重启 dev（带 9222），导航到该 SMB 目录切 masonry：
  1. **A**：白屏小图恢复直显（img `naturalWidth>0`，URL 形态 `/smb/2/H/00down%2F...`）；进阅读器页图正常；share 根打开 CBZ/ZIP 条目视图同验（archive-SMB 分支，R1 P0-1）；
  2. **B**（注入验证）：把一张 img src 临时改为 404 → 卡片转 failed 显示 ↻ → 点击后 `requestThumbnails` 发出且 spinner 出现（远程源有效重试，R1 P1-4）；
  3. **C**：缓冲中切同源子目录 → Rust 日志出现 `scheduler new_epoch`（drain 计数>0）；切回 details 再切 masonry（卸载+重挂）→ 同样出队；
  4. **C4 双段**：观察 `decision=USE_ORIGINAL` 的 path，其 scheduler pending 被 drain（Stale）**且** remote fetch 队列不再为其取源（日志无对应 fetch 完成/on_fetched，R1 P1-3）；
  5. **D**：重挂后首个 `notify_thumbnail_epoch` 值为毫秒级大数且单调；日志无 "ignore regressed epoch"（scheduler 与 fetch 双端——若有说明仍有回退路径，回查）；首批请求日志时间戳不早于对应 notify 完成时刻。
- [ ] AGENTS.md 3.5.4 行补记 ⑦（四缺陷 + 三项拍板决策 + R1 审查四缺口），commit + push。

---

## 5. 验证清单（汇总）

| 项 | 手段 | 通过标准 |
|---|---|---|
| A 换算（普通 + archive） | mediaUrl.test.ts 六形态 | 全绿（修复前 smb 首条 + archive 两条红） |
| A 实机 | CDP img/URL/reader | 直显恢复、无空段 URL |
| A 日志 | media 403/404 有 WARN | 可定位 |
| B 接线 + 重试链路 | 组件/composable/Rust 测试 + 实机 | 失败卡片有 ↻；点击走 invalidate→re-request 分流（cached）/re-request（original），远程源有效，损坏缓存不再返回原 URL |
| C scheduler + fetch 双段 | 两模块测试 + 实机日志 | 切目录/卸载/翻转均出队；remote fetch 被取消不进解码；cancelled 按 (key,epoch) 绑定不误杀新请求 |
| D 单调 + 屏障 | 同毫秒双实例测试 + Rust 双端回退拒绝 + notify 先于首请求断言 | epoch 全局单调、scheduler 与 fetch actor 双端拒回退、request 必在 notify 完成后 |
| 回归 | cargo 全量 + vitest 全量 + type-check | 全绿 0 err |

## 6. 风险与备注

- **relPath 整段等于 initialPath 的边界**（rel 剥后为空）仍 403——属调用方数据错误，靠任务 2 日志暴露，不在本计划防御。
- **`warm_media_urls`（Rust 自拼 URL）**：任务 1 步骤 4 盘点；若同病，`smbUrlParts` 换算规则镜像到 Rust 侧，作为任务 1 的追加小节。
- **切目录清 stateMap 的瞬时空窗**：新目录卡片回到 none 态（无 spinner 直至首批请求回来，<100ms 量级）——用户已知悉（拍板 ③）。
- **滚动淘汰不取消**：文档化决策（拍板 ②）；若未来实测滚走任务拖慢新目录，复用 `cancel_keys`（scheduler + fetch 双段）做窗口差集取消。
- **fetch actor 取消的语义边界**：被 cancel 的取源任务**无声丢弃**（不走 on_failed、不 emit failed 事件）——它的位置已被 UseOriginal 结果取代，任何 UI 状态都会是倒退。cancelled 记录按 `(cache_key, epoch)` 绑定并在消费（跳过/丢弃）后移除；残留条目只在"同 epoch 同 key 重提"时生效——而 UseOriginal 判定后同 epoch 内该 key 不会再被前端提交（state 已转 original），安全。
- **Rust `handle_new_epoch` 单调守卫**：拒绝 `epoch <= current` 的通知（日志可观测）；RemoteFetchActor 侧 `fetch_max` 同语义。存量任务不受影响（task.epoch 判定仍按 current 比较）。
- **epochReady 屏障的失败语义**：notify IPC 失败时屏障 catch 吞错放行（只保证顺序不因失败卡死请求）；请求侧 await 后 re-check epoch 变化丢弃。
