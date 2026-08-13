// useMasonryThumbnails.ts — 缩略图队列前端 composable（§12 §13）
//
// 职责：把像素窗口（visible/ahead/behind/idle）合成去重 batch，80ms debounce 后批量
// 请求；监听 thumbnail://state 事件更新单卡状态；cached 路径转 asset URL；retry/regenerate；
// 切目录/列宽/DPR/质量递增 epoch，旧 epoch 事件忽略；unmount 解绑。

import { computed, onBeforeUnmount, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  notifyThumbnailEpoch,
  notifyThumbnailFastScrolling,
  regenerateThumbnail,
  requestThumbnails,
  retryThumbnail,
  thumbnailCacheUrl,
  type ThumbnailStateEvent,
} from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import {
  THUMBNAIL_QUALITY_MARGIN,
  type ThumbnailPriority,
  type ThumbnailQuality,
  type ThumbnailRequestItem,
  type ThumbnailState,
} from '@/lib/thumbnail';
import type { ThumbnailWindows } from './useMasonryLayout';
import { toRootRelativePath } from './useMasonryLayout';
import { log } from '@/lib/logger';
import { validateSourceRelativePath } from '@/lib/relativePath';

const REQUEST_DEBOUNCE_MS = 80;
/** 停止滚动后多久才允许提交 idle（§5.3）。 */
const IDLE_SETTLE_MS = 250;

/** 每次 batch log 上限（path 数量），防止 flood */
const BATCH_LOG_PATH_LIMIT = 12;

/** happy-dom / Storybook / 普通浏览器环境无 __TAURI_INTERNALS__，listen() 会抛；
 * 仅在真正的 Tauri runtime 才打 log，避免测试日志噪音。 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
  retry: (path: string) => void;
  retryBatch: (paths: string[]) => void;
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
  const epoch = ref(0);
  const pathToCacheKey = ref<Map<string, string>>(new Map());
  let lastScrollAt = 0;
  let unlisten: UnlistenFn | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (path: string, s: ThumbnailState) => {
    const next = new Map(state.value);
    next.set(path, s);
    state.value = next;
  };

  // epoch 递增：切目录/列宽/DPR/质量变化
  const bumpEpoch = () => {
    const old = epoch.value;
    epoch.value += 1;
    void notifyThumbnailEpoch(epoch.value);
    log('[thumbnail] epoch changed old=' + old + ' new=' + epoch.value);
  };

  watch(
    () => [params.descriptor.value, params.colWidth.value, params.dpr.value, params.quality.value] as const,
    () => bumpEpoch(),
  );

  // 滚动节流记录（用于 idle settle 判定）
  watch(
    () => params.scrollTop.value,
    () => {
      lastScrollAt = Date.now();
    },
  );

  const scheduleRequest = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushRequest, REQUEST_DEBOUNCE_MS);
  };

  watch(
    () => params.thumbnailWindows.value,
    () => scheduleRequest(),
    { deep: false },
  );

  const flushRequest = async () => {
    debounceTimer = null;
    const reqEpoch = epoch.value;
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
    for (const r of results) {
      const entry = entriesByPath.get(r.path);
      switch (r.status) {
        case 'original':
          if (entry) setState(r.path, { kind: 'original', url: params.originalUrlFor(entry) });
          break;
        case 'cached':
          if (r.cachePath && r.width && r.height) {
            setState(r.path, {
              kind: 'cached',
              cacheKey: r.cacheKey ?? '',
              path: thumbnailCacheUrl(r.cachePath),
              width: r.width,
              height: r.height,
            });
          }
          break;
        case 'queued':
          setState(r.path, { kind: 'queued', cacheKey: r.cacheKey ?? '' });
          if (r.cacheKey) {
            const next = new Map(pathToCacheKey.value);
            next.set(r.path, r.cacheKey);
            pathToCacheKey.value = next;
          }
          break;
        case 'failed':
          setState(r.path, {
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
    setState(path, { kind: 'queued', cacheKey: pathToCacheKey.value.get(path) ?? '' });
    void retryThumbnail(params.descriptor.value, found.item, epoch.value).then((r) => {
      applyResults([r], new Map([[path, found.entry]]));
    });
  };

  /** 批量重试：循环复用 retry（不删缓存，重新排队）。scheduler 队列自然限流。 */
  const retryBatch = (paths: string[]) => {
    for (const p of paths) retry(p);
  };

  const regenerate = (path: string) => {
    const found = findEntry(path);
    if (!found) return;
    setState(path, { kind: 'queued', cacheKey: pathToCacheKey.value.get(path) ?? '' });
    void regenerateThumbnail(params.descriptor.value, found.item, epoch.value).then((r) => {
      applyResults([r], new Map([[path, found.entry]]));
    });
  };

  /** 批量重新生成：循环复用 regenerate（删旧缓存 + 重新生成）。 */
  const regenerateBatch = (paths: string[]) => {
    for (const p of paths) regenerate(p);
  };

  onBeforeUnmount(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (unlisten) unlisten();
  });

  return {
    stateMap: computed(() => state.value),
    retry,
    retryBatch,
    regenerate,
    regenerateBatch,
    epoch,
  };
}
