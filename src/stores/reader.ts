/**
 * Reader store
 *
 * 状态机: idle → (openBook) → ready / error
 * 翻页: nextPage / prevPage / jumpToSpread
 * 进度持久化防抖: 500ms debounce (DESIGN §12.4 进度保存策略)
 *
 * v0.1.0-module1.21: 末页翻到时持久化 finished=true (与 perfect-viewer 一致)
 *
 * 2026-08-12 跨卷任务 4: 加 saveCurrentProgressNow / nextPage atLast 回调 /
 * setOnAtLastNextAttempt / sourceDescriptor / currentRelPath（spec §9）。
 * 模块级 onAtLastNextAttempt 防止 Pinia store 持有旧组件闭包；ReaderView 卸载
 * 调 setOnAtLastNextAttempt(null) 清理（不变量 11）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { saveProgress } from '@/lib/tauri';
import { log } from '@/lib/logger';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

export type ReaderStatus = 'idle' | 'ready' | 'error';
export type ReaderErrorKind =
  | 'Unreachable'
  | 'Timeout'
  | 'PermissionRevoked'
  | 'DecodingError'
  | 'Empty';

export interface OpenBookPayload {
  bookId: number;
  title: string;
  pages: string[];
  spreads: Array<{ start: number; end: number }>;
  initialSpreadIndex: number;
  /** 2026-08-12 跨卷任务 4: 当前卷 descriptor（module3.2.0 拓宽为四类源，
   *  跨卷路由身份 + CrossVolumeController identity 校验依赖此字段）。 */
  sourceDescriptor?: SourceDescriptor;
  /** 2026-08-12 跨卷任务 4: 当前卷相对 rootPath 的完整路径（如 "comics/vol1"）。 */
  currentRelPath?: string;
}

export interface PageChangeInfo {
  bookId: number;
  /** 当前 spread 的首页索引 (0-based) */
  page: number;
  spreadIndex: number;
  /** v0.1.0-module3.0.8: 当前 spread 起始图的文件名（瀑布流端复用同一锚点）。
   *  reader 翻页时由 emitChanged 计算, masonry 端不用此字段. */
  imageName: string | null;
}

type PageChangeListener = (info: PageChangeInfo) => void;

const SAVE_DEBOUNCE_MS = 500;

/** 2026-08-12 跨卷任务 4: 模块级末页再向下回调（spec §9）。
 *  ReaderView 注入：在末页再 nextPage 时写 slideshow.pendingNextVolume，
 *  卸载时 setOnAtLastNextAttempt(null) 清理（不变量 11）。
 *  模块级避免 Pinia store 持有旧组件闭包。 */
let onAtLastNextAttempt: (() => void) | null = null;

export const useReaderStore = defineStore('reader', () => {
  const status = ref<ReaderStatus>('idle');
  const bookId = ref<number | null>(null);
  const title = ref<string>('');
  const pages = ref<string[]>([]);
  const spreads = ref<Array<{ start: number; end: number }>>([]);
  // v0.1.0-module3.0.8: 当前阅读的 image 名数组（用于 emitChanged 计算 imageName 锚点）.
  // 暂由外部（ReaderView loadBook, 见任务 5）填充；未填充时 emitChanged 输出 null.
  const imageNames = ref<string[]>([]);
  const currentSpreadIndex = ref<number>(0);
  const chromeVisible = ref<boolean>(true);
  // v0.1.0-module3.0.2 (L3): 删 continueSwipePull / accumulateContinuePull
  // 这两个字段/actions 0 引用, 跨卷 swip-pulling 进度语义未实现
  const errorKind = ref<ReaderErrorKind | null>(null);
  // 2026-08-12 跨卷任务 4: 当前卷 descriptor（openBook 时写入，closeBook 清）。
  const sourceDescriptor = ref<SourceDescriptor | null>(null);
  // 2026-08-12 跨卷任务 4: 当前卷相对 rootPath 路径。
  const currentRelPath = ref<string>('');

  /** 累计订阅器列表 — 翻页防抖最终触发回调 */
  const listeners = new Set<PageChangeListener>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEmit: PageChangeInfo | null = null;

  const isAtFirstSpread = computed(() => currentSpreadIndex.value <= 0);
  const isAtLastSpread = computed(
    () => currentSpreadIndex.value >= spreads.value.length - 1,
  );

  /** 内部:通知订阅器当前页状态 */
  function emitChanged() {
    if (bookId.value === null || spreads.value.length === 0) return;
    const spread = spreads.value[currentSpreadIndex.value];
    const page = spread?.start ?? 0;
    const imageName = spread ? (imageNames.value[spread.start] ?? null) : null;
    pendingEmit = {
      bookId: bookId.value,
      page,
      spreadIndex: currentSpreadIndex.value,
      imageName,
    };
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (pendingEmit !== null) {
        const info = pendingEmit;
        // 末页判定：finished=true (永久 true, Rust 端保证不降级)
        const isLast = info.spreadIndex >= spreads.value.length - 1;
        // v0.1.0-module3.0.8: 双写 imageName 锚点 (瀑布流端用同一字段恢复).
        // 旧 reader 路径不传时由 saveProgress ?? null 走保留分支.
        saveProgress(
          info.bookId,
          info.page,
          'single',
          isLast ? true : undefined,
          info.imageName ?? undefined,
        ).catch(
          (e) => log('[reader] saveProgress failed', e),
        );
        for (const listener of listeners) listener(info);
      }
      pendingEmit = null;
      debounceTimer = null;
    }, SAVE_DEBOUNCE_MS);
  }

  /** 公开 actions */
  function openBook(payload: OpenBookPayload) {
    if (
      !payload
      || typeof payload.bookId !== 'number'
      || !Array.isArray(payload.pages)
      || !Array.isArray(payload.spreads)
      || payload.pages.length === 0
      || payload.spreads.length === 0
    ) {
      status.value = 'error';
      errorKind.value = 'Empty';
      return;
    }
    bookId.value = payload.bookId;
    title.value = payload.title;
    pages.value = payload.pages;
    spreads.value = payload.spreads;
    currentSpreadIndex.value = Math.max(
      0,
      Math.min(payload.initialSpreadIndex, payload.spreads.length - 1),
    );
    chromeVisible.value = true;
    errorKind.value = null;
    sourceDescriptor.value = payload.sourceDescriptor ?? null;
    currentRelPath.value = payload.currentRelPath ?? '';
    status.value = 'ready';
  }

  function closeBook() {
    status.value = 'idle';
    bookId.value = null;
    title.value = '';
    pages.value = [];
    spreads.value = [];
    imageNames.value = [];
    currentSpreadIndex.value = 0;
    errorKind.value = null;
    sourceDescriptor.value = null;
    currentRelPath.value = '';
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      pendingEmit = null;
    }
  }

  function nextPage() {
    if (status.value !== 'ready') return;
    if (currentSpreadIndex.value >= spreads.value.length - 1) {
      // 末页再向下（spec §1.2 / §9 末页触发时机）—— 不翻页，写跨卷意图
      onAtLastNextAttempt?.();
      return;
    }
    currentSpreadIndex.value += 1;
    emitChanged();
  }

  function prevPage() {
    if (status.value !== 'ready') return;
    if (currentSpreadIndex.value > 0) {
      currentSpreadIndex.value -= 1;
      emitChanged();
    }
  }

  function jumpToSpread(index: number) {
    if (status.value !== 'ready') return;
    const last = spreads.value.length - 1;
    if (last < 0) return;
    const target = Math.max(0, Math.min(index, last));
    if (target === currentSpreadIndex.value) return;
    currentSpreadIndex.value = target;
    emitChanged();
  }

  function toggleChrome() {
    chromeVisible.value = !chromeVisible.value;
  }

  /** 订阅页变化（每次翻页/跳页 debounce 后回调 1 次） */
  function onPageChanged(listener: PageChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 2026-08-12 跨卷任务 4 (P1-1 修复): 构造当前快照 await 写入。
   *  - 取消 pending debounce timer（防旧卷延迟写跨卷后落盘）
   *  - 读 store 自身状态（bookId/spreads/currentSpreadIndex/imageNames）构造 PageChangeInfo
   *  - 末页判定 finished = currentSpreadIndex >= spreads.length - 1
   *  - await saveProgress（spec 不变量 10：保存失败不阻断跨卷，但调用方可 await 结果） */
  async function saveCurrentProgressNow(): Promise<void> {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (bookId.value === null || spreads.value.length === 0) return;
    const spread = spreads.value[currentSpreadIndex.value];
    const page = spread?.start ?? 0;
    const imageName = spread ? (imageNames.value[spread.start] ?? null) : null;
    const finished = currentSpreadIndex.value >= spreads.value.length - 1;
    await saveProgress(
      bookId.value,
      page,
      'single',
      finished || undefined,
      imageName ?? undefined,
    );
  }

  /** 2026-08-12 跨卷任务 4: 设置末页再向下回调（ReaderView 注入）。
   *  传 null 清理（不变量 11，组件卸载必调）。 */
  function setOnAtLastNextAttempt(fn: (() => void) | null): void {
    onAtLastNextAttempt = fn;
  }

  return {
    // 状态
    status,
    bookId,
    title,
    pages,
    spreads,
    imageNames,
    currentSpreadIndex,
    chromeVisible,
    errorKind,
    sourceDescriptor,
    currentRelPath,
    // 派生
    isAtFirstSpread,
    isAtLastSpread,
    // 动作
    openBook,
    closeBook,
    nextPage,
    prevPage,
    jumpToSpread,
    toggleChrome,
    onPageChanged,
    saveCurrentProgressNow,
    setOnAtLastNextAttempt,
  };
});
