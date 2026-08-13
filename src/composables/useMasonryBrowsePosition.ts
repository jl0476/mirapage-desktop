// useMasonryBrowsePosition.ts — 瀑布流滚动 → progress 双写（image_name + page）
//
// 职责：
//   1. 监听 scrollTop + 300ms debounce，写入顶部可见图的 (imageName, page)
//   2. 进入目录查 progress 缓存 + 可选自动跳（autoRestoreOnMount 开关）
//   3. 提供手动 jumpToLast() 给 toolbar「↶ 跳到上次」按钮
//
// 关键不变量（spec v4 + v0.1.0-module3.0.8 audit-fix）：
//   - topmostImage 3 级优先级（相交 > 上方 > 下方），过滤文件夹
//   - page = canonicalImageNames.indexOf(imageName)，不受 UI 过滤
//   - writeSeq 防晚返回覆盖较新滚动位置
//   - activeStartSeq 防 stop()/start() 抢占时旧请求污染
//   - 目录校验同时比 descriptor + path
//   - enabled=false 只控制"写"（recordCurrentTop 入口 + enableWatcher/disableWatcher），
//     不控制"读"（restoreAndScroll 仍查 progress 设缓存），保证按钮（jumpToLast +
//     顶栏立即阅读）永远能根据 progress 是否有记录来 enable
//   - autoRestoreOnMount 只控制"自动跳"，不控制"读"
//   - lastBrowseProgress 缓存：手动按钮 + 顶栏立即阅读都优先用
//   - resize 冷却期（v0.1.0-module3.0.8 fix19）：colWidth 变化后 500ms 内任何
//     scheduleRecord 都被丢弃，窗口尺寸变化不污染阅读进度

import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  createBook,
  getProgress,
  listDirectory,
  recordHistory,
  saveProgress,
  type ProgressItem,
} from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import { validateSourceRelativePath } from '@/lib/relativePath';
import { naturalCompare } from '@/lib/naturalSort';
import { progressWriteKey } from '@/lib/progressWriteKey';

const DEBOUNCE_MS = 300;
const RESIZE_COOLDOWN_MS = 500;
const BOOKID_CACHE_TTL_MS = 30_000;
/** 任务 9: 滚到底停留确认窗口(防惯性滑过末尾误触发 finished, spec §2.3) */
const STABLE_MS = 1200;

/**
 * 枚举 entry 下的图片页（供 create_book 写入封面 + 页数）。
 * 与 useReaderActions.enumerateCover 语义一致 — 失败时返 fallback。
 */
async function enumerateCover(
  descriptor: SourceDescriptor,
  absPath: string,
): Promise<{ coverEntryPath: string | null; coverEntryName: string | null; pageCount: number }> {
  try {
    const entries = await listDirectory(descriptor, absPath);
    const images = entries
      .filter((e) => !e.isDirectory && isImage(e.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (images.length === 0) {
      return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
    }
    const first = images[0]!;
    return {
      coverEntryPath: first.path,
      coverEntryName: first.name,
      pageCount: images.length,
    };
  } catch {
    return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
  }
}

export interface UseMasonryBrowsePositionParams {
  descriptor: Ref<SourceDescriptor>;
  currentPath: Ref<string>;
  renderEntries: Ref<readonly MediaEntry[]>;
  canonicalImageNames: ComputedRef<string[]>;
  layoutMap: ComputedRef<Map<string, { top: number; height: number }>>;
  scrollTop: Ref<number>;
  colWidth: Ref<number>;
  /** 任务 8: 容器是否滚到底(MasonryView 三档 computed 注入, spec §2.1/§2.5) */
  atBottom: Ref<boolean>;
  scrollToEntry: (imageName: string) => Promise<boolean>;
  autoRestoreOnMount: ComputedRef<boolean>;
  enabled: ComputedRef<boolean>;
}

export interface UseMasonryBrowsePositionReturn {
  start: () => Promise<void>;
  stop: () => void;
  jumpToLast: () => Promise<void>;
  /** v0.1.0-module3.0.8 (任务 9): 跨卷前 flush — 立即清 debounce + 写入顶部图,
   *  不等剩余的 300ms. spec §14.3. 失败/空目录 silent (与 scheduleRecord → recordCurrentTop 一致) */
  flushNow: () => Promise<void>;
  lastBrowseProgress: ComputedRef<ProgressItem | null>;
  hasRecordedProgress: ComputedRef<boolean>;
}

function sameDir(
  d1: SourceDescriptor, p1: string,
  d2: SourceDescriptor, p2: string,
): boolean {
  return p1 === p2 && JSON.stringify(d1) === JSON.stringify(d2);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function useMasonryBrowsePosition(
  params: UseMasonryBrowsePositionParams,
): UseMasonryBrowsePositionReturn {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopScrollWatch: (() => void) | null = null;
  let stopResizeWatch: (() => void) | null = null;
  let lastResizeAt = 0;
  let stopEnabledWatch: (() => void) | null = null;
  let stopAtBottomWatch: (() => void) | null = null;
  let activeStartSeq = 0;
  let activeWriteSeq = 0;
  /** 任务 9: 底部停留起点(毫秒时间戳);null=未在底部(spec §2.3 不变量) */
  let bottomSince: number | null = null;
  /** 任务 9: STABLE_MS 后升级判定的在途 timer(spec §2.3) */
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  const bookIdCache = new Map<string, Promise<number | null>>();

  const lastWrittenPath = ref<string | null>(null);
  const lastBrowseProgress = ref<ProgressItem | null>(null);
  /** 任务 10: 缓存最后一次写成功的 finishedParam(给 A9 快路径去重同图同 finished 查询用, spec §2.8) */
  const lastWrittenFinishedParam = ref<boolean | undefined>(undefined);
  /** 任务 10: A9 慢路径去重用的 DB 成功写入 Set(identity = progressWriteKey(...), spec §2.8) */
  const successfulWrites = new Set<string>();

  /**
   * 任务 9: 调度 STABLE_MS 后的升级判定(spec §2.3 scheduleStableTimer)。
   * 置空守护:已有在途 timer 不重复调度(不变量)。
   * 回调首行置空 stableTimer(审查 P1-a):否则失败重试会因引用仍在而不再重排。
   * 注:本任务只搭骨架,回调内调 recordCurrentTop 不带 finishedNow 判定,
   * 任务 10 才接入。
   */
  function scheduleStableTimer(): void {
    if (stableTimer !== null) return;
    stableTimer = setTimeout(() => {
      stableTimer = null;
      void recordCurrentTop();
    }, STABLE_MS);
  }

  /**
   * 任务 9: 清 stableTimer + 置 bottomSince=null(5 出口统一调, spec §2.3 不变量)。
   * 不变量:stableTimer!==null ⇒ bottomSince!==null ⇒ atBottom=true。
   * 反向清:先清 timer(可能产生引用),再清 bottomSince,顺序保证。
   */
  function clearStableTimer(): void {
    if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
    bottomSince = null;
  }

  /**
   * 任务 9 骨架: 统一失败出口(spec §2.3 审查 P1 核心)。
   * 任务 10 接入 recordCurrentTop 各早退路径(瞬时失败:seq/writeSeq 丢弃 + saveProgress catch)。
   * 本任务先在 scheduleStableTimer/clearStableTimer 已有逻辑上预留接口。
   * 仅当仍在底部 + enabled + bottomSince 已设 + 无在途 timer 时重排。
   */
  function scheduleRetryIfStillAtBottom(): void {
    if (
      params.enabled.value &&
      params.atBottom.value &&
      bottomSince !== null &&
      stableTimer === null
    ) {
      scheduleStableTimer();
    }
  }

  /** 3 级优先级顶部图（spec §3.2.2 P0 修复） */
  const topmostImage = computed<MediaEntry | null>(() => {
    const scrollTop = params.scrollTop.value;
    const map = params.layoutMap.value;
    const entries = params.renderEntries.value;
    let intersectingBest: { path: string; top: number } | null = null;
    let aboveBest: { path: string; top: number } | null = null;
    let belowBest: { path: string; top: number } | null = null;
    for (const e of entries) {
      if (!isImage(e.name)) continue;
      const item = map.get(e.path);
      if (!item) continue;
      const baselineIn = item.top <= scrollTop && item.top + item.height > scrollTop;
      if (baselineIn) {
        if (!intersectingBest || item.top > intersectingBest.top) intersectingBest = { path: e.path, top: item.top };
      } else if (item.top <= scrollTop) {
        if (!aboveBest || item.top > aboveBest.top) aboveBest = { path: e.path, top: item.top };
      } else {
        if (!belowBest || item.top < belowBest.top) belowBest = { path: e.path, top: item.top };
      }
    }
    const pick = intersectingBest ?? aboveBest ?? belowBest;
    if (!pick) return null;
    return entries.find((e) => e.path === pick.path) ?? null;
  });

  /** ensureBookId 接 desc/path 参数（spec §3.2.2 v4） */
  async function ensureBookIdForCurrentDir(
    descAtEntry: SourceDescriptor,
    pathAtEntry: string,
  ): Promise<number | null> {
    // 路径身份修复 (2026-08-12): createBook 前校验 pathAtEntry 必须 source-relative。
    // 非法则返 null（不创建 book、不写 progress），避免污染 library 表。
    const pathCheck = validateSourceRelativePath(pathAtEntry);
    if (!pathCheck.ok) {
      log('[useMasonryBrowsePosition] pathAtEntry 越出数据源根, 拒绝 createBook', { pathAtEntry, reason: pathCheck.reason });
      return null;
    }
    const absPath = pathCheck.normalized;
    const descriptor = descAtEntry;
    const cacheKey = `${JSON.stringify(descriptor)}|${absPath}`;
    const cached = bookIdCache.get(cacheKey);
    if (cached) return cached;

    const pathAtRequest = absPath;
    const descAtRequest = JSON.parse(JSON.stringify(descriptor)) as SourceDescriptor;
    const promise = (async (): Promise<number | null> => {
      const localRoot = descAtRequest.type === 'local' ? (descAtRequest as { rootPath: string }).rootPath : '';
      const title =
        pathAtRequest.split(/[\\/]/).filter(Boolean).pop() ||
        localRoot.split(/[\\/]/).filter(Boolean).pop() ||
        'root';
      const cover = await enumerateCover(descAtRequest, pathAtRequest);
      const bookId = await createBook({
        title,
        sourceDescriptor: descAtRequest,
        absolutePath: pathAtRequest,
        sourceType: descAtRequest.type === 'local' ? 'Local' : capitalize(descAtRequest.type),
        favorite: false,
        ...cover,
      });
      if (params.currentPath.value !== pathAtRequest) return null;
      if (JSON.stringify(params.descriptor.value) !== JSON.stringify(descAtRequest)) return null;
      return bookId;
    })();

    bookIdCache.set(cacheKey, promise);
    setTimeout(() => bookIdCache.delete(cacheKey), BOOKID_CACHE_TTL_MS);
    return promise;
  }

  /**
   * 早捕获 5 字段 + writeSeq 防覆盖 + atBottom/finishedNow 计算(spec §2.3 v6)。
   *
   * 两阶段提交(审查 P1 v5/v6):
   * - 阶段 1(写入前): seq/writeSeq/dir 早退可取消, 瞬时失败(丢弃)调 scheduleRetryIfStillAtBottom,
   *   持久失败(bookId==null)不调。
   * - IPC: try/catch, catch 调 scheduleRetryIfStillAtBottom。
   * - 阶段 2(写入后): saveProgress 已 resolve → always 记 successfulWrites.add(identity);
   *   当前 UI 缓存仅 writeSeqAtEntry===activeWriteSeq && sameDir 时更新(陈旧成功不污染当前 UI);
   *   不重试。
   */
  async function recordCurrentTop(): Promise<void> {
    // 任务 9: 入口 enabled 守卫(审查 P1-2)。
    // flushNow 也走此入口 → enabled=false 时跨卷前 flush 也不写普通进度。
    if (!params.enabled.value) return;
    const seqAtEntry = activeStartSeq;
    const descAtEntry = JSON.parse(JSON.stringify(params.descriptor.value)) as SourceDescriptor;
    const pathAtEntry = params.currentPath.value;
    const e = topmostImage.value;
    if (!e) return;

    // ── atBottom + 停留判定(spec §2.3) ──
    const atBottom = params.atBottom.value;
    let finishedNow = false;
    if (atBottom) {
      if (bottomSince === null) {
        bottomSince = Date.now();
        scheduleStableTimer();
        // 首次到底: 先写普通进度, finishedNow=false
      } else {
        finishedNow = Date.now() - bottomSince >= STABLE_MS;
      }
    } else {
      clearStableTimer();                                 // 离开底部(5 出口之一, 任务 8 审查契约 a)
      finishedNow = false;
    }

    // finished 单调: 只传 true, 不传 false(spec A1)
    const finishedParam: boolean | undefined = finishedNow ? true : undefined;

    // ── A7 幂等: 已 finished 跳过整个 recordCurrentTop(spec §2.7 + §2.8 A7) ──
    // 入口检查单调保留后的 lastBrowseProgress.finished;
    // 已 finished → 跳过整次(含 finished=undefined 普通滚动), 防止覆盖 imageName。
    // spec §2.7 显式:"幂等跳过依据(A7): recordCurrentTop 入口判断「当前已 finished 则跳过」"
    if (lastBrowseProgress.value?.finished === true) return;

    // ── A9 复合去重(快+慢路径, spec §2.8) ──
    const identity = progressWriteKey(descAtEntry, pathAtEntry, e.path, finishedParam);
    const alreadyWritten =
      (e.path === lastWrittenPath.value && finishedParam === lastWrittenFinishedParam.value)
      || successfulWrites.has(identity);
    if (alreadyWritten) return;

    const pageAtEntry = params.canonicalImageNames.value.indexOf(e.name);
    const writeSeqAtEntry = activeWriteSeq;

    try {
      // ── 阶段 1: 写入前竞态(允许取消) ──
      const bookId = await ensureBookIdForCurrentDir(descAtEntry, pathAtEntry);
      if (seqAtEntry !== activeStartSeq) { scheduleRetryIfStillAtBottom(); return; }
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;  // 切目录: 不重试
      if (bookId == null) return;                         // 持久失败: 不重试
      if (writeSeqAtEntry !== activeWriteSeq) { scheduleRetryIfStillAtBottom(); return; }

      // ── IPC 写入 ──
      try {
        await saveProgress(bookId, pageAtEntry, 'single', finishedParam, e.name);
      } catch (err) {
        log('[useMasonryBrowsePosition] saveProgress failed', err);
        scheduleRetryIfStillAtBottom();
        return;
      }

      // ── 阶段 2: 写入后(DB 已成功) ──
      successfulWrites.add(identity);                     // ① 始终记 DB 成功(慢路径去重)
      if (writeSeqAtEntry === activeWriteSeq
          && sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) {
        // ② 仅最新请求 + 同目录: 更新当前 UI 缓存
        lastWrittenPath.value = e.path;
        lastWrittenFinishedParam.value = finishedParam;
        lastBrowseProgress.value = {
          bookId,
          page: pageAtEntry,
          imageName: e.name,
          readerMode: 'single',
          updatedAt: Date.now(),
          finished: finishedNow || lastBrowseProgress.value?.finished || false,  // 单调(审查 P1-1)
        };
      }
      // ③ 陈旧成功(writeSeq 变): 不碰 UI 缓存, 不重试(DB 已成功)
    } catch (err) {
      log('[useMasonryBrowsePosition] recordCurrentTop failed', err);
    }
  }

  function scheduleRecord(): void {
    // resize 后 RESIZE_COOLDOWN_MS 内任何 scheduleRecord（无论是 scroll 还是 layout
    // 重排触发的 topmostImage 漂移）都丢弃：用户没主动滚动，UI 重排不该污染进度
    if (Date.now() - lastResizeAt < RESIZE_COOLDOWN_MS) {
      clearStableTimer();                     // 任务 9: resize 冷却清 timer + bottomSince(底部判定失效)
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      return;
    }
    activeWriteSeq += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void recordCurrentTop();
    }, DEBOUNCE_MS);
  }

  function enableWatcher(): void {
    if (!stopScrollWatch) {
      stopScrollWatch = watch(
        () => [params.scrollTop.value, params.renderEntries.value.length] as const,
        () => scheduleRecord(),
      );
    }
    // v0.1.0-module3.0.8 fix19: 窗口尺寸变化 → colWidth 派生值变化 → 标记冷却期。
    // flush: 'post' 确保 layout 重排完成后再标记（避免滚动过程中多次 fire）。
    if (!stopResizeWatch) {
      stopResizeWatch = watch(
        () => params.colWidth.value,
        () => {
          lastResizeAt = Date.now();
          // 顺手清掉残留 timer，防止 resize 期间的 scroll 触发刚排上的 record 落地
          if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        },
        { flush: 'post' },
      );
    }
  }
  function disableWatcher(): void {
    clearStableTimer();                       // 任务 9: enabled=false 停记录,清 timer + bottomSince
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (stopScrollWatch) { stopScrollWatch(); stopScrollWatch = null; }
    if (stopResizeWatch) { stopResizeWatch(); stopResizeWatch = null; }
    lastResizeAt = 0;
  }

  async function restoreAndScroll(): Promise<void> {
    // v0.1.0-module3.0.8 audit-fix P1 还原原意：
    // enabled 只控制"写"路径（recordCurrentTop 入口 + enableWatcher/disableWatcher），
    // 不控制"读"路径——restoreAndScroll 始终查 progress 设缓存，保证按钮（jumpToLast
    // + 顶栏立即阅读）能根据 progress 是否有记录来 enable。
    // autoRestoreOnMount 只控制"自动跳"，由下方 `if (!params.autoRestoreOnMount.value) return;` 守住。
    const seqAtEntry = activeStartSeq;
    const descAtEntry = JSON.parse(JSON.stringify(params.descriptor.value)) as SourceDescriptor;
    const pathAtEntry = params.currentPath.value;
    try {
      const bookId = await ensureBookIdForCurrentDir(descAtEntry, pathAtEntry);
      if (seqAtEntry !== activeStartSeq) return;
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
      if (bookId == null) return;
      // v0.1.0-...: 进入瀑布流时一次性写 history — 滚动不写 (滚动太频繁, 反复更新 last_visited_at 不妥).
      // record_history INSERT OR UPDATE 幂等, 重复进入只更新 last_visited_at.
      const displayName = pathAtEntry.split(/[\\/]/).filter(Boolean).pop()
        || JSON.stringify(descAtEntry);
      await recordHistory(descAtEntry, pathAtEntry, displayName, bookId);
      if (seqAtEntry !== activeStartSeq) return;
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
      const progress = await getProgress(bookId);
      if (seqAtEntry !== activeStartSeq) return;
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
      lastBrowseProgress.value = progress;
      if (!params.autoRestoreOnMount.value) return;
      if (!progress?.imageName) return;
      await params.scrollToEntry(progress.imageName);
    } catch (err) {
      log('[useMasonryBrowsePosition] restoreAndScroll failed', err);
    }
  }

  async function start(): Promise<void> {
    clearStableTimer();                       // 任务 9: start 重置(spec §2.3 不变量 A4)
    activeStartSeq += 1;
    successfulWrites.clear();                 // 任务 10: A9 慢路径去重集随 start 重置(spec §2.8)
    lastWrittenFinishedParam.value = undefined; // 任务 10: 缓存 finishedParam 同步重置
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (stopScrollWatch) { stopScrollWatch(); stopScrollWatch = null; }
    lastWrittenPath.value = null;

    if (stopEnabledWatch) stopEnabledWatch();
    stopEnabledWatch = watch(
      () => params.enabled.value,
      (now) => { now ? enableWatcher() : disableWatcher(); },
      { immediate: true },
    );

    // 任务 8: atBottom 翻转监听(布局变化入口, spec §时序 7 审查 P1)。
    // false→true 调 scheduleRecord(等价一次滚动事件, 进入 recordCurrentTop 写顶部图);
    // true→false 调 clearStableTimer(离开底部, 清 timer + bottomSince 留待下次进入时重置)。
    if (stopAtBottomWatch) stopAtBottomWatch();
    stopAtBottomWatch = watch(
      () => params.atBottom.value,
      (now, prev) => {
        if (now && !prev) scheduleRecord();
        else if (!now && prev) clearStableTimer();
      },
    );

    await restoreAndScroll();
  }

  function stop(): void {
    clearStableTimer();                       // 任务 9: stop 重置(spec §2.3 不变量 A4)
    activeStartSeq += 1;
    successfulWrites.clear();                 // 任务 10: A9 慢路径去重集随 stop 重置(spec §2.8)
    lastWrittenFinishedParam.value = undefined; // 任务 10: 缓存 finishedParam 同步重置
    disableWatcher();
    if (stopEnabledWatch) { stopEnabledWatch(); stopEnabledWatch = null; }
    if (stopAtBottomWatch) { stopAtBottomWatch(); stopAtBottomWatch = null; }
    lastWrittenPath.value = null;
    lastResizeAt = 0;
  }

  /** v0.1.0-module3.0.8 (任务 9): 立即清 debounce + 写入顶部图 (spec §14.3).
   *  跨卷前 flush 用: 不等剩余 300ms. 失败/空目录 silent (依赖 recordCurrentTop 自带 try/catch + 同图去重). */
  async function flushNow(): Promise<void> {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    await recordCurrentTop();
  }

  async function jumpToLast(): Promise<void> {
    const seqAtEntry = activeStartSeq;
    let progress = lastBrowseProgress.value;
    if (!progress) {
      try {
        const descAtEntry = JSON.parse(JSON.stringify(params.descriptor.value)) as SourceDescriptor;
        const pathAtEntry = params.currentPath.value;
        const bookId = await ensureBookIdForCurrentDir(descAtEntry, pathAtEntry);
        if (seqAtEntry !== activeStartSeq) return;
        if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
        if (bookId == null) return;
        progress = await getProgress(bookId);
        if (seqAtEntry !== activeStartSeq) return;
        if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
        lastBrowseProgress.value = progress;
      } catch (err) {
        log('[useMasonryBrowsePosition] jumpToLast failed', err);
        return;
      }
    }
    if (!progress?.imageName) return;
    await params.scrollToEntry(progress.imageName);
  }

  onBeforeUnmount(stop);

  return {
    start,
    stop,
    jumpToLast,
    flushNow,
    lastBrowseProgress: computed(() => lastBrowseProgress.value),
    hasRecordedProgress: computed(() => !!lastBrowseProgress.value?.imageName),
  };
}