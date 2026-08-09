/**
 * Reader store
 *
 * 状态机: idle → (openBook) → ready / error
 * 翻页: nextPage / prevPage / jumpToSpread
 * 跨卷触发累计: accumulateContinuePull (SWIPE 模式末页继续划)
 * 进度持久化防抖: 500ms debounce (DESIGN §12.4 进度保存策略)
 *
 * v0.1.0-module1.21: 末页翻到时持久化 finished=true (与 perfect-viewer 一致)
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { saveProgress } from '@/lib/tauri';
import { log } from '@/lib/logger';

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
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      pendingEmit = null;
    }
  }

  function nextPage() {
    if (status.value !== 'ready') return;
    if (currentSpreadIndex.value < spreads.value.length - 1) {
      currentSpreadIndex.value += 1;
      emitChanged();
    }
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
  };
});
