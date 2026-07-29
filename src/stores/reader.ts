/**
 * Reader store
 *
 * 状态机: idle → (openBook) → ready / error
 * 翻页: nextPage / prevPage / jumpToSpread
 * 跨卷触发累计: accumulateContinuePull (SWIPE 模式末页继续划)
 * 进度持久化防抖: 500ms debounce (DESIGN §12.4 进度保存策略)
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

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
}

type PageChangeListener = (info: PageChangeInfo) => void;

const SAVE_DEBOUNCE_MS = 500;

export const useReaderStore = defineStore('reader', () => {
  const status = ref<ReaderStatus>('idle');
  const bookId = ref<number | null>(null);
  const title = ref<string>('');
  const pages = ref<string[]>([]);
  const spreads = ref<Array<{ start: number; end: number }>>([]);
  const currentSpreadIndex = ref<number>(0);
  const chromeVisible = ref<boolean>(true);
  const continueSwipePull = ref<number>(0);
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
    pendingEmit = {
      bookId: bookId.value,
      page: spreads.value[currentSpreadIndex.value]?.start ?? 0,
      spreadIndex: currentSpreadIndex.value,
    };
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (pendingEmit !== null) {
        for (const listener of listeners) listener(pendingEmit);
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
    continueSwipePull.value = 0;
    errorKind.value = null;
    status.value = 'ready';
  }

  function closeBook() {
    status.value = 'idle';
    bookId.value = null;
    title.value = '';
    pages.value = [];
    spreads.value = [];
    currentSpreadIndex.value = 0;
    continueSwipePull.value = 0;
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
      continueSwipePull.value = 0;
      emitChanged();
    }
  }

  function prevPage() {
    if (status.value !== 'ready') return;
    if (currentSpreadIndex.value > 0) {
      currentSpreadIndex.value -= 1;
      continueSwipePull.value = 0;
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
    continueSwipePull.value = 0;
    emitChanged();
  }

  function toggleChrome() {
    chromeVisible.value = !chromeVisible.value;
  }

  /** 累计跨卷触发进度（仅在末页生效） */
  function accumulateContinuePull(delta: number) {
    if (status.value !== 'ready') return;
    if (!isAtLastSpread.value) return;
    continueSwipePull.value = Math.min(1.0, continueSwipePull.value + delta);
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
    currentSpreadIndex,
    chromeVisible,
    continueSwipePull,
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
    accumulateContinuePull,
    onPageChanged,
  };
});
