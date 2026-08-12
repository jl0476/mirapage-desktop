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
import { naturalCompare } from '@/lib/naturalSort';

const DEBOUNCE_MS = 300;
const RESIZE_COOLDOWN_MS = 500;
const BOOKID_CACHE_TTL_MS = 30_000;

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
  let activeStartSeq = 0;
  let activeWriteSeq = 0;
  const bookIdCache = new Map<string, Promise<number | null>>();

  const lastWrittenPath = ref<string | null>(null);
  const lastBrowseProgress = ref<ProgressItem | null>(null);

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
    const absPath = pathAtEntry;
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

  /** 早捕获 5 字段 + writeSeq 防覆盖（spec §3.2.2 v4 P1 修复） */
  async function recordCurrentTop(): Promise<void> {
    const seqAtEntry = activeStartSeq;
    const descAtEntry = JSON.parse(JSON.stringify(params.descriptor.value)) as SourceDescriptor;
    const pathAtEntry = params.currentPath.value;
    const e = topmostImage.value;
    if (!e) return;
    if (e.path === lastWrittenPath.value) return;
    const pageAtEntry = params.canonicalImageNames.value.indexOf(e.name);
    const writeSeqAtEntry = activeWriteSeq;

    try {
      const bookId = await ensureBookIdForCurrentDir(descAtEntry, pathAtEntry);
      if (seqAtEntry !== activeStartSeq) return;
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
      if (bookId == null) return;
      if (writeSeqAtEntry !== activeWriteSeq) return;
      await saveProgress(
        bookId,
        pageAtEntry,
        'single',
        undefined,
        e.name,
      );
      if (seqAtEntry !== activeStartSeq) return;
      if (writeSeqAtEntry !== activeWriteSeq) return;
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;
      lastWrittenPath.value = e.path;
      lastBrowseProgress.value = {
        bookId,
        page: pageAtEntry,
        imageName: e.name,
        readerMode: 'single',
        updatedAt: Date.now(),
        finished: false,
      };
    } catch (err) {
      log('[useMasonryBrowsePosition] recordCurrentTop failed', err);
    }
  }

  function scheduleRecord(): void {
    // resize 后 RESIZE_COOLDOWN_MS 内任何 scheduleRecord（无论是 scroll 还是 layout
    // 重排触发的 topmostImage 漂移）都丢弃：用户没主动滚动，UI 重排不该污染进度
    if (Date.now() - lastResizeAt < RESIZE_COOLDOWN_MS) {
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
    activeStartSeq += 1;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (stopScrollWatch) { stopScrollWatch(); stopScrollWatch = null; }
    lastWrittenPath.value = null;

    if (stopEnabledWatch) stopEnabledWatch();
    stopEnabledWatch = watch(
      () => params.enabled.value,
      (now) => { now ? enableWatcher() : disableWatcher(); },
      { immediate: true },
    );

    await restoreAndScroll();
  }

  function stop(): void {
    activeStartSeq += 1;
    disableWatcher();
    if (stopEnabledWatch) { stopEnabledWatch(); stopEnabledWatch = null; }
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