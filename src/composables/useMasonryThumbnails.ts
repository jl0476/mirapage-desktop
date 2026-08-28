// useMasonryThumbnails.ts — 缩略图队列前端 composable（§12 §13）
//
// 职责：把像素窗口（visible/ahead/behind/idle）合成去重 batch，80ms debounce 后批量
// 请求；监听 thumbnail://state 事件更新单卡状态；cached 路径转 asset URL；retry/regenerate；
// 切目录/列宽/DPR/质量递增 epoch，旧 epoch 事件忽略；unmount 解绑。

import { computed, onBeforeUnmount, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  invalidateThumbnailCacheKeys,
  notifyThumbnailEpoch,
  notifyThumbnailFastScrolling,
  regenerateThumbnail,
  requestThumbnails,
  retryThumbnail,
  thumbnailCacheUrl,
  type ThumbnailProgressEvent,
  type ThumbnailStateEvent,
} from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import {
  THUMBNAIL_QUALITY_MARGIN,
  type ThumbnailPhase,
  type ThumbnailPriority,
  type ThumbnailProgressSnapshot,
  type ThumbnailQuality,
  type ThumbnailRequestItem,
  type ThumbnailState,
} from '@/lib/thumbnail';
import type { ThumbnailWindows } from './useMasonryLayout';
import { toRootRelativePath } from './useMasonryLayout';
import { isMasonryImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import { validateSourceRelativePath } from '@/lib/relativePath';

const REQUEST_DEBOUNCE_MS = 80;
/** 停止滚动后多久才允许提交 idle（§5.3）。 */
const IDLE_SETTLE_MS = 250;
/**
 * 连续滚动期间的请求保底间隔（hotfix）。
 * 纯 debounce 在连续窗口变化（滚动事件间隔 <80ms）下会无限重置 timer——
 * 滚多久请求就延迟多久（实测快速滚动 3 秒才漏出一条）。加保底节流：
 * 距上次发出 ≥500ms 时下一条立即发，滚动中最多延迟 500ms。
 */
const REQUEST_MIN_INTERVAL_MS = 500;

/** 每次 batch log 上限（path 数量），防止 flood */
const BATCH_LOG_PATH_LIMIT = 12;

/** happy-dom / Storybook / 普通浏览器环境无 __TAURI_INTERNALS__，listen() 会抛；
 * 仅在真正的 Tauri runtime 才打 log，避免测试日志噪音。 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ─── 任务 5（D / R1 P0-2）：模块级全局 epoch 分配器 ─────────────────────────
// 每实例独立 Date.now() 播种仍可倒退：同毫秒内「实例 A 卸载 bump 至 e+1 / 实例 B
// 初始化取 e」会让 B 的 epoch ≤ Rust current_epoch，新任务被 epoch 检查丢弃。
// 全局单调分配：同毫秒内多次分配按 +1 递增，跨实例保证新挂载实例的 epoch 严格
// 大于所有已分配值（含前实例卸载时的出队 bump）。
let lastThumbnailEpoch = 0;
function nextThumbnailEpoch(): number {
  lastThumbnailEpoch = Math.max(Date.now(), lastThumbnailEpoch + 1);
  return lastThumbnailEpoch;
}

export interface UseMasonryThumbnailsParams {
  descriptor: Ref<SourceDescriptor>;
  /** 当前目录相对 source root 的路径（如 `normal`），拼 sourceRelPath 用。 */
  currentPath: Ref<string>;
  entries: Ref<readonly MediaEntry[]>;
  thumbnailWindows: ComputedRef<ThumbnailWindows>;
  measuredMap: Ref<Map<string, { width: number; height: number }>>;
  colWidth: ComputedRef<number>;
  dpr: Ref<number>;
  quality: Ref<ThumbnailQuality>;
  scrollTop: Ref<number>;
  /** 构造原图 img URL（service 返回 original / 阅读器双击时用）。 */
  originalUrlFor: (entry: MediaEntry) => string;
}

export interface UseMasonryThumbnailsReturn {
  stateMap: ComputedRef<Map<string, ThumbnailState>>;
  /** module3.0.11：失败态时间线快照（failed 事件覆盖 generating 态后明细已丢）。 */
  progressSnapshots: ComputedRef<Map<string, ThumbnailProgressSnapshot>>;
  retry: (path: string) => void;
  /** 任务 3：img load-error → failed 态（保留 cacheKey 供失效重试）。 */
  markLoadFailed: (path: string) => void;
  /** 任务 3：failed 卡片 ↻ 统一重试——cached 来源先失效缓存再 re-request，
   *  original 来源直接 re-request（Rust resubmit 对远程源返回 unsupported）。 */
  retryLoadFailed: (path: string) => Promise<void>;
  regenerate: (path: string) => void;
  regenerateBatch: (paths: string[]) => void;
  epoch: Ref<number>;
}

/** 把窗口四组（保持优先级）合成去重 path->priority 映射；优先级 visible>ahead>behind>idle。 */
export function mergeWindowsToPriorities(w: ThumbnailWindows): Map<string, ThumbnailPriority> {
  const order: ThumbnailPriority[] = ['visible', 'ahead', 'behind', 'idle'];
  const rank: Record<ThumbnailPriority, number> = { visible: 0, ahead: 1, behind: 2, idle: 3 };
  const out = new Map<string, ThumbnailPriority>();
  for (const group of order) {
    for (const path of w[group]) {
      const existing = out.get(path);
      if (existing === undefined || rank[group] < rank[existing]) {
        out.set(path, group);
      }
    }
  }
  return out;
}

export function useMasonryThumbnails(
  params: UseMasonryThumbnailsParams,
): UseMasonryThumbnailsReturn {
  const state = shallowRef<Map<string, ThumbnailState>>(new Map());
  // 任务 5（D）：全局分配器播种——与 Rust current_epoch 的单调契约从此处开始
  const epoch = ref(nextThumbnailEpoch());
  /** notify 完成屏障（任务 5 / R2 P0-1）：request 先于 new_epoch 到达后端会被
   * fetch actor 的 prepared.epoch != current 检查丢弃（IPC 到达顺序无契约）——
   * flushRequest 发请求前 await 当时快照。初始化与每次 bump 都替换；catch 吞错
   * （屏障只保证顺序，不因 IPC 失败卡死请求）。Promise.resolve 包裹防 mock 返回
   * 非 promise（vi.fn() 返回 undefined）时 .catch 抛 TypeError。 */
  let epochReady: Promise<void> = Promise.resolve();
  const pushEpochNotify = () => {
    epochReady = Promise.resolve(notifyThumbnailEpoch(epoch.value)).catch(() => {}) as Promise<void>;
  };
  pushEpochNotify(); // 新实例挂载即 notify：防上一实例卸载 bump 后 current 更高
  const pathToCacheKey = ref<Map<string, string>>(new Map());
  let lastScrollAt = 0;
  let unlisten: UnlistenFn | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** round-1 P1-3：progress 事件先于 queued 回包到达时的竞态缓冲（每 path 留最新）。 */
  const pendingProgress = new Map<string, ThumbnailProgressEvent>();
  /** round-1 P1-6：失败态时间线快照（failed 事件覆盖 generating 态后明细已丢）。 */
  const progressSnapshots = shallowRef<Map<string, ThumbnailProgressSnapshot>>(new Map());
  /** round-2：listen() 异步——unmount 先于 .then(fn) 到达时防泄漏。 */
  let disposed = false;

  const setSnapshot = (path: string, snap: ThumbnailProgressSnapshot) => {
    const next = new Map(progressSnapshots.value);
    next.set(path, snap);
    progressSnapshots.value = next;
  };
  const deleteSnapshot = (path: string) => {
    if (!progressSnapshots.value.has(path)) return;
    const next = new Map(progressSnapshots.value);
    next.delete(path);
    progressSnapshots.value = next;
  };

  const setState = (path: string, s: ThumbnailState) => {
    const next = new Map(state.value);
    next.set(path, s);
    state.value = next;
  };

  // epoch 递增（任务 5：全局单调分配）：目录身份/布局参数变化 + 卸载出队共用
  const bumpEpoch = () => {
    const old = epoch.value;
    epoch.value = nextThumbnailEpoch();
    pushEpochNotify();
    log('[thumbnail] epoch changed old=' + old + ' new=' + epoch.value);
  };

  // 任务 5（C）：watch 拆两组——
  // ① 目录身份（descriptor / currentPath）变化：bump 出队 + 清目录级状态
  //   （stateMap / cacheKey 索引 / round-1 P1-3 竞态缓冲 / P1-6 失败快照）
  watch(
    () => [params.descriptor.value, params.currentPath.value] as const,
    () => {
      bumpEpoch();
      state.value = new Map();
      pathToCacheKey.value = new Map();
      pendingProgress.clear();
      progressSnapshots.value = new Map();
    },
  );

  // ② 布局参数（列宽/DPR/质量）变化：只 bump（重生成尺寸档位），不清目录状态
  watch(
    () => [params.colWidth.value, params.dpr.value, params.quality.value] as const,
    () => bumpEpoch(),
  );

  // 滚动节流记录（用于 idle settle 判定）
  watch(
    () => params.scrollTop.value,
    () => {
      lastScrollAt = Date.now();
    },
  );

  /** 距上次 flushRequest 发出的时刻（0 = 尚未发过）。保底节流用。 */
  let lastFlushAt = 0;

  const scheduleRequest = () => {
    const now = Date.now();
    // 保底节流（hotfix）：距上次发出 ≥500ms（且已发过至少一次）→ 立即发，
    // 不再等 debounce——连续滚动中每 500ms 必有一条请求覆盖途中的可见区。
    if (lastFlushAt > 0 && now - lastFlushAt >= REQUEST_MIN_INTERVAL_MS) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      void flushRequest();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushRequest, REQUEST_DEBOUNCE_MS);
  };

  // 实机批热修：immediate——挂载时 windows 已非空（估算比例窗口）也立即发首批，
  // 不再串行化等待"维度预取完成 → windows 重算"。空窗口在 flushRequest 内
  // prioMap.size === 0 自然消化，无副作用。注意必须注册在 flushRequest 定义之后
  //（immediate 回包同步走 scheduleRequest → 引用 flushRequest，置于其前即 TDZ）。


  const flushRequest = async () => {
    debounceTimer = null;
    lastFlushAt = Date.now(); // 保底节流基准（hotfix）
    const reqEpoch = epoch.value;
    const ready = epochReady; // 任务 5：屏障快照——await 前捕获，bump 后不等旧通知
    const w = params.thumbnailWindows.value;
    const prioMap = mergeWindowsToPriorities(w);
    if (prioMap.size === 0) return;

    const margin = THUMBNAIL_QUALITY_MARGIN[params.quality.value];
    const requiredWidth = Math.round(params.colWidth.value * params.dpr.value * margin);
    const measured = params.measuredMap.value;
    const entriesByPath = new Map(params.entries.value.map((e) => [e.path, e]));
    const fastScrolling = Date.now() - lastScrollAt < IDLE_SETTLE_MS;

    const items: ThumbnailRequestItem[] = [];
    const visibleKeys: string[] = [];
    for (const [path, prio] of prioMap) {
      // 快速滚动期间不提交 idle
      if (fastScrolling && prio === 'idle') continue;
      const entry = entriesByPath.get(path);
      if (!entry) continue;
      // 非图片不进缩略图请求（isMasonryImage：目录/归档/杂文件无缩略图语义，占位卡由
      // MasonryRow 直接渲染；cover.jpg 目录不得因扩展名混入）
      if (!isMasonryImage(entry)) continue;
      const m = measured.get(path);
      // 路径身份修复 (2026-08-12): sourceRelPath 必须 source-relative。
      // params.currentPath 若被污染（绝对路径），toRootRelativePath 会拼出绝对
      // sourceRelPath 污染 thumbnail_cache。校验失败跳过该 item（不发 IPC）。
      const relPath = toRootRelativePath(params.currentPath.value, path);
      if (!validateSourceRelativePath(relPath).ok) {
        log('[useMasonryThumbnails] sourceRelPath 越界, 跳过缩略图请求', { relPath, currentPath: params.currentPath.value });
        continue;
      }
      // header 失败的图（m 为空）也请求：传 0 尺寸，Rust 生成器 decode 完整文件兜底
      // （decide_source 对 0 尺寸强制 Generate，不判 UseOriginal）
      items.push({
        path,
        sourceRelPath: relPath,
        fileSize: entry.size,
        modifiedAt: entry.modifiedAt ?? null,
        sourceWidth: m ? m.width : 0,
        sourceHeight: m ? m.height : 0,
        requiredWidth,
        priority: prio,
      });
      const ck = pathToCacheKey.value.get(path);
      if (ck && (prio === 'visible' || prio === 'ahead')) visibleKeys.push(ck);
    }
    if (items.length === 0) return;

    // log 1: flushRequest 入口 — reqid 方便关联入口/出口日志
    const reqid = Math.random().toString(36).slice(2, 10);
    const t0 = performance.now();
    const pathPreview = items
      .slice(0, BATCH_LOG_PATH_LIMIT)
      .map((i) => i.path)
      .join(',');
    log(
      '[thumbnail] flushRequest enter reqid=' + reqid +
        ' epoch=' + reqEpoch +
        ' items=' + items.length +
        ' visibleKeys=' + visibleKeys.length +
        ' fastScrolling=' + fastScrolling +
        ' paths[' + items.length + ']=' + pathPreview +
        (items.length > BATCH_LOG_PATH_LIMIT ? '…(+' + (items.length - BATCH_LOG_PATH_LIMIT) + ' more)' : ''),
    );

    void notifyThumbnailFastScrolling(fastScrolling);

    // 任务 5（R2 P0-1）：notify 完成屏障——request 先于 new_epoch 到达后端会被
    // fetch actor 的 prepared.epoch != current 检查直接丢弃。await 快照后再发请求；
    // 屏障期间 bump 则丢弃（请求侧对称防线，响应侧守卫见下方 epoch re-check）。
    await ready;
    if (epoch.value !== reqEpoch) {
      log(
        '[thumbnail] flushRequest reqid=' + reqid +
          ' epoch changed during notify barrier (now=' + epoch.value + '), dropping',
      );
      return;
    }

    let results;
    try {
      results = await requestThumbnails(params.descriptor.value, items, reqEpoch, visibleKeys);
    } catch (err) {
      log('[thumbnail] flushRequest reqid=' + reqid + ' IPC error: ' + String(err));
      return;
    }
    // 请求期间 epoch 已变（切目录/列宽）则丢弃响应，避免污染新目录状态
    if (epoch.value !== reqEpoch) {
      log(
        '[thumbnail] flushRequest reqid=' + reqid +
          ' epoch changed (now=' + epoch.value + '), dropping ' + results.length + ' results',
      );
      return;
    }
    // log 2: IPC 完成 — 分类统计
    const stats = { original: 0, cached: 0, queued: 0, failed: 0, unsupported: 0 };
    for (const r of results) {
      if (r.status in stats) (stats as Record<string, number>)[r.status] += 1;
    }
    const durationMs = (performance.now() - t0).toFixed(1);
    log(
      '[thumbnail] flushRequest done reqid=' + reqid +
        ' results=' + results.length +
        ' stats=' + JSON.stringify(stats) +
        ' durationMs=' + durationMs,
    );
    applyResults(results, entriesByPath);
  };

  // 实机批热修：immediate——挂载时 windows 已非空（估算比例窗口）也立即发首批，
  // 不再串行化等待"维度预取完成 → windows 重算"。空窗口在 flushRequest 内
  // prioMap.size === 0 自然消化，无副作用。注册位置必须在 flushRequest 定义之后
  //（immediate 回调同步进 scheduleRequest，引用其上未初始化的 const 即 TDZ）。
  watch(
    () => params.thumbnailWindows.value,
    () => scheduleRequest(),
    { deep: false, immediate: true },
  );

  const applyResults = (
    results: Awaited<ReturnType<typeof requestThumbnails>>,
    entriesByPath: Map<string, MediaEntry>,
  ) => {
    // log 3: applyResults — 分类转换明细（前 5 + 卡在 queued 的 path 重点）
    const transitions: string[] = [];
    const queuedPaths: string[] = [];
    for (const r of results) {
      const prior = state.value.get(r.path);
      const priorKind = prior?.kind ?? 'none';
      const nextKind = r.status;
      if (nextKind === 'queued') queuedPaths.push(r.path);
      // 只打印前 5 个 + 全部 queued 重点（57-68 案例相关）
      if (transitions.length < BATCH_LOG_PATH_LIMIT) {
        transitions.push(r.path + ':' + priorKind + '→' + nextKind);
      }
    }
    if (queuedPaths.length > 0) {
      log(
        '[thumbnail] applyResults total=' + results.length +
          ' queuedN=' + queuedPaths.length +
          ' queuedPaths=' + queuedPaths.slice(0, BATCH_LOG_PATH_LIMIT).join(',') +
          (queuedPaths.length > BATCH_LOG_PATH_LIMIT ? '…(+' + (queuedPaths.length - BATCH_LOG_PATH_LIMIT) + ')' : ''),
      );
    }
    log(
      '[thumbnail] applyResults transitions (first ' + Math.min(BATCH_LOG_PATH_LIMIT, results.length) + ') ' +
        transitions.join(' '),
    );
    // 实机批 bug⑤ 削峰（一）：单批事务化——原实现循环内逐条 setState（每次克隆
    // 整个 Map 替换 ref），N 条结果 = N 次 Map 克隆 + N 次响应式触发（O(n²)），
    // 大目录 224 张时与 CPU 合成风暴叠加把渲染线程打爆。改为：一次克隆，循环内
    // 直接写 next，尾部一次赋值。raced 守卫读 state.value（本批旧值）——同 path
    // 不会在一批内出现两次，语义等价。
    const nextStates = new Map(state.value);
    const nextKeys = new Map(pathToCacheKey.value);
    let keysDirty = false;
    const bufferedToApply: ThumbnailProgressEvent[] = [];
    for (const r of results) {
      const entry = entriesByPath.get(r.path);
      switch (r.status) {
        case 'original':
          if (entry) nextStates.set(r.path, { kind: 'original', url: params.originalUrlFor(entry) });
          break;
        case 'cached':
          if (r.cachePath && r.width && r.height) {
            nextStates.set(r.path, {
              kind: 'cached',
              cacheKey: r.cacheKey ?? '',
              path: thumbnailCacheUrl(r.cachePath),
              width: r.width,
              height: r.height,
            });
          }
          break;
        case 'queued': {
          const prev = nextStates.get(r.path);
          // round-1 P1-3 顺序守卫：Tauri 事件与 invoke 回包无先后保证。同 cacheKey 的
          // progress/完成事件先到时保留事件写入的状态——否则 cached/failed 被降级回
          // generating（永久 spinner）或 phase 被重置回 queued。cacheKey 不同
          // （列宽/质量变化后的重请求）正常覆盖。
          const raced = prev && 'cacheKey' in prev && prev.cacheKey === (r.cacheKey ?? '');
          if (!raced) {
            nextStates.set(r.path, {
              kind: 'generating',
              cacheKey: r.cacheKey ?? '',
              phase: 'queued',
              startedAt: Date.now(),
              timings: {},
            });
          }
          // 消费先于回包缓冲的 progress 事件（decoding 等已到但状态尚未建立）——
          // P2 修复：记录待消费，挪到尾部赋值之后执行。原位置 applyProgressEvent
          // 写 state.value（旧 Map），会被循环尾 state.value = nextStates 整体
          // 覆盖（raced 项 phase 停在较早阶段/新项缓冲完全丢失）。
          const buffered = pendingProgress.get(r.path);
          if (buffered && buffered.cacheKey === (r.cacheKey ?? '')) {
            pendingProgress.delete(r.path);
            bufferedToApply.push(buffered);
          }
          if (r.cacheKey) {
            nextKeys.set(r.path, r.cacheKey);
            keysDirty = true;
          }
          break;
        }
        case 'failed':
          nextStates.set(r.path, {
            kind: 'failed',
            cacheKey: r.cacheKey ?? '',
            retryable: true,
            message: r.errorKind ?? 'failed',
          });
          break;
        default:
          break;
      }
    }
    if (keysDirty) pathToCacheKey.value = nextKeys;
    state.value = nextStates;
    // 尾部赋值后消费缓冲：applyProgressEvent 读到的已是本批最终状态
    for (const buffered of bufferedToApply) {
      applyProgressEvent(buffered);
    }
  };

  // 监听 Rust 状态事件
  // v0.1.0-module3.0.8 audit-fix：happy-dom / Storybook / 普通浏览器环境无
  // __TAURI_INTERNALS__，listen() 抛 TypeError(transformCallback undefined)。
  // 仅 Tauri runtime 静默失败才 log（实际不期望失败）；其他环境静默吞下避免
  // 测试日志噪音与 4× unhandled rejection。
  let stateEventCount = 0;
  void listen<ThumbnailStateEvent>('thumbnail://state', (event) => {
    const payload = event.payload;
    stateEventCount += 1;
    if (payload.epoch !== epoch.value) {
      // log 5: epoch mismatch 旧事件忽略（不应该发生，但方便排查）
      if (stateEventCount <= 5 || stateEventCount % 50 === 0) {
        log(
          '[thumbnail] state event IGNORE path=' + payload.path +
            ' state=' + payload.state +
            ' eventEpoch=' + payload.epoch + ' currentEpoch=' + epoch.value,
        );
      }
      return;
    }
    switch (payload.state) {
      case 'cached':
        if (payload.cachePath) {
          setState(payload.path, {
            kind: 'cached',
            cacheKey: payload.cacheKey,
            path: thumbnailCacheUrl(payload.cachePath),
            width: payload.outputWidth ?? 0,
            height: payload.outputHeight ?? 0,
          });
          if (stateEventCount <= 20 || stateEventCount % 50 === 0) {
            log(
              '[thumbnail] state event path=' + payload.path +
                ' state=cached from=thumbnail://state' +
                ' w=' + (payload.outputWidth ?? 0) + ' h=' + (payload.outputHeight ?? 0),
            );
          }
        }
        break;
      case 'failed':
        setState(payload.path, {
          kind: 'failed',
          cacheKey: payload.cacheKey,
          retryable: true,
          message: payload.message ?? 'failed',
        });
        log(
          '[thumbnail] state event path=' + payload.path +
            ' state=failed msg=' + (payload.message ?? 'null'),
        );
        break;
      case 'stale':
        // 旧目录事件忽略（已由 epoch 过滤）；不做 UI 更新
        break;
    }
  }).then((fn) => {
    unlisten = fn;
  }).catch((err) => {
    if (isTauriEnv()) {
      log('[useMasonryThumbnails] listen(thumbnail://state) failed (unexpected in Tauri env)', err);
    }
  });

  // 监听生成阶段步进事件（module3.0.11）
  // progress 事件统一应用点（直接到达 / queued 回包后消费缓冲两条路径共用）
  function applyProgressEvent(p: ThumbnailProgressEvent) {
    const prev = state.value.get(p.path);
    if (!prev || prev.kind !== 'generating' || prev.cacheKey !== p.cacheKey) return;
    if (p.phase === prev.phase) return; // 幂等：同阶段事件不重复应用
    const generationStartedAt = prev.generationStartedAt ?? (Date.now() - p.elapsedMs);
    const timings = { ...prev.timings, [p.phase]: p.elapsedMs };
    setState(p.path, { ...prev, phase: p.phase as ThumbnailPhase, generationStartedAt, timings });
    // 进度快照：failed 事件会整体覆盖 generating 态，快照保住时间线明细（round-1 P1-6）
    setSnapshot(p.path, { phase: p.phase as ThumbnailPhase, timings, startedAt: prev.startedAt, generationStartedAt });
  }

  let progressEventCount = 0;
  let progressUnlisten: UnlistenFn | null = null;
  void listen<ThumbnailProgressEvent>('thumbnail://progress', (event) => {
    const p = event.payload;
    progressEventCount += 1;
    if (p.epoch !== epoch.value) return;
    const prev = state.value.get(p.path);
    if (prev?.kind === 'generating') {
      applyProgressEvent(p);
      if (progressEventCount <= 20 || progressEventCount % 50 === 0) {
        log('[thumbnail] progress event path=' + p.path + ' phase=' + p.phase + ' elapsedMs=' + p.elapsedMs);
      }
    } else {
      // round-1 P1-3：事件先于 queued 回包到达 → 缓冲，回包建立 generating 态后消费。
      // prev 为同 cacheKey 终态（cached/failed 已先到）则丢弃——生成已结束。
      // original/unsupported 变体无 cacheKey，视为不匹配（缓冲）。
      const prevKey = prev && 'cacheKey' in prev ? prev.cacheKey : undefined;
      if (!prev || prevKey !== p.cacheKey) {
        pendingProgress.set(p.path, p);
      }
    }
  }).then((fn) => {
    if (disposed) fn(); // round-2：组件已卸载，立即解绑迟到的监听
    else progressUnlisten = fn;
  }).catch((err) => {
    if (isTauriEnv()) {
      log('[useMasonryThumbnails] listen(thumbnail://progress) failed (unexpected in Tauri env)', err);
    }
  });

  const findEntry = (path: string): { entry: MediaEntry; item: ThumbnailRequestItem } | null => {
    const entry = params.entries.value.find((e) => e.path === path);
    if (!entry) return null;
    const m = params.measuredMap.value.get(path);
    // header 失败的图（m 为空）也允许 retry/regenerate：传 0 尺寸兜底
    const margin = THUMBNAIL_QUALITY_MARGIN[params.quality.value];
    const requiredWidth = Math.round(params.colWidth.value * params.dpr.value * margin);
    // 路径身份修复: sourceRelPath 校验, 非法返 null（retry/regenerate 放弃该 item）。
    const relPath = toRootRelativePath(params.currentPath.value, path);
    if (!validateSourceRelativePath(relPath).ok) {
      log('[useMasonryThumbnails/buildItem] sourceRelPath 越界, 放弃 retry/regenerate', { relPath });
      return null;
    }
    return {
      entry,
      item: {
        path,
        sourceRelPath: relPath,
        fileSize: entry.size,
        modifiedAt: entry.modifiedAt ?? null,
        sourceWidth: m ? m.width : 0,
        sourceHeight: m ? m.height : 0,
        requiredWidth,
        priority: 'visible',
      },
    };
  };

  const retry = (path: string) => {
    const found = findEntry(path);
    if (!found) return;
    // module3.0.11：预置 generating(queued)；删旧失败快照（不喂给新一轮）
    deleteSnapshot(path);
    setState(path, { kind: 'generating', cacheKey: pathToCacheKey.value.get(path) ?? '', phase: 'queued', startedAt: Date.now(), timings: {} });
    void retryThumbnail(params.descriptor.value, found.item, epoch.value).then((r) => {
      applyResults([r], new Map([[path, found.entry]]));
    });
  };

  // ─── 任务 3：load-error 接线与重试分流 ────────────────────────────────────

  /** img load-error（403 / 缓存损坏）→ failed 态。保留原 state 的 cacheKey
   *  （cached 来源的失效目标——清空即丢失，R2）；message 固定 'load-error'
   *  区别于 Rust failed 事件的 errorKind。 */
  const markLoadFailed = (path: string) => {
    const prev = state.value.get(path);
    const cacheKey = prev && 'cacheKey' in prev ? prev.cacheKey : '';
    setState(path, { kind: 'failed', cacheKey, retryable: true, message: 'load-error' });
  };

  /** failed 卡片 ↻ 统一重试（load-error 与生成失败共用）：
   *  - cached 来源（有 cacheKey）：先失效缓存（删文件 + 索引行）再 re-request——
   *    CACHED 命中校验只查「文件存在且非空」，损坏 WebP 不失效会拿到同一 URL 死循环；
   *  - original 来源（无 cacheKey）：直接 re-request（网络失败重拉）。
   *  不走 Rust resubmit——其对非 Local descriptor 返回 unsupported（service.rs）。 */
  const retryLoadFailed = async (path: string) => {
    const found = findEntry(path);
    if (!found) return;
    const prev = state.value.get(path);
    const cacheKey = prev && 'cacheKey' in prev ? prev.cacheKey : '';
    if (cacheKey) {
      try {
        await invalidateThumbnailCacheKeys([cacheKey]);
      } catch (err) {
        // 失效失败不阻断重试（退化为可能再命中损坏缓存，log 留诊断线索）
        log('[thumbnail] retryLoadFailed invalidate failed path=' + path + ' err=' + String(err));
      }
    }
    deleteSnapshot(path);
    setState(path, { kind: 'generating', cacheKey, phase: 'queued', startedAt: Date.now(), timings: {} });
    try {
      const results = await requestThumbnails(params.descriptor.value, [found.item], epoch.value, []);
      applyResults(results, new Map([[path, found.entry]]));
    } catch (err) {
      log('[thumbnail] retryLoadFailed IPC error path=' + path + ' err=' + String(err));
    }
  };


  const regenerate = (path: string) => {
    const found = findEntry(path);
    if (!found) return;
    deleteSnapshot(path);
    setState(path, { kind: 'generating', cacheKey: pathToCacheKey.value.get(path) ?? '', phase: 'queued', startedAt: Date.now(), timings: {} });
    void regenerateThumbnail(params.descriptor.value, found.item, epoch.value).then((r) => {
      applyResults([r], new Map([[path, found.entry]]));
    });
  };

  /** 批量重新生成：循环复用 regenerate（删旧缓存 + 重新生成）。 */
  const regenerateBatch = (paths: string[]) => {
    for (const p of paths) regenerate(p);
  };

  onBeforeUnmount(() => {
    disposed = true; // round-2：先立标志，迟到的 listen resolve 会立即自解绑
    if (debounceTimer) clearTimeout(debounceTimer);
    if (unlisten) unlisten();
    if (progressUnlisten) progressUnlisten(); // round-1 P1-5：防监听器累积
    bumpEpoch(); // 任务 5：卸载出队——Rust 端据此清本实例残留的 pending/in-flight
  });

  return {
    stateMap: computed(() => state.value),
    progressSnapshots: computed(() => progressSnapshots.value),
    retry,
    markLoadFailed,
    retryLoadFailed,
    regenerate,
    regenerateBatch,
    epoch,
  };
}
