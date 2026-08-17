/** Webtoon 连续阅读模式的进度记录与完成态管理。 */
import { onScopeDispose, watch, type Ref } from 'vue';
import { markFinished, saveProgress } from '@/lib/tauri';
import { log } from '@/lib/logger';

const DEBOUNCE_MS = 300;
export const STABLE_MS = 1200;

type Options = { bookId: Ref<number | null>; atBottom: Ref<boolean> };

export function useWebtoonProgress(opts: Options) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let lastImage: string | null = null;
  let pendingImage: string | null = null;
  let pendingIndex = 0;
  let finishedMarked = false;
  let writeTail: Promise<void> = Promise.resolve();
  let finishedInFlight: { bookId: number; p: Promise<boolean> } | null = null;

  function notifyTopChanged(image: string, index: number): void {
    if (image === lastImage) return;
    lastImage = image;
    pendingImage = image;
    pendingIndex = index;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flushNow().catch((error: unknown) => log('[webtoon] saveProgress failed', error));
    }, DEBOUNCE_MS);
  }

  async function flushNow(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingImage !== null) {
      const image = pendingImage;
      const index = pendingIndex;
      pendingImage = null;
      const bookId = opts.bookId.value;
      const job = writeTail.catch(() => undefined).then(async () => {
        if (bookId !== null) await saveProgress(bookId, index, 'webtoon', undefined, image);
      });
      writeTail = job;
    }
    await writeTail;
  }

  async function ensureFinished(): Promise<boolean> {
    if (finishedMarked) return true;
    const bookId = opts.bookId.value;
    if (bookId === null) return false;
    if (finishedInFlight?.bookId === bookId) return finishedInFlight.p;
    const p = (async () => {
      try {
        await markFinished(bookId, true);
        if (opts.bookId.value === bookId) finishedMarked = true;
        return true;
      } catch (error: unknown) {
        log('[webtoon] markFinished failed', error);
        return false;
      } finally {
        if (finishedInFlight?.p === p) finishedInFlight = null;
      }
    })();
    finishedInFlight = { bookId, p };
    return p;
  }

  function finishNow(): Promise<boolean> {
    return ensureFinished();
  }

  function reset(): void {
    lastImage = null;
    pendingImage = null;
    finishedMarked = false;
    if (timer) clearTimeout(timer);
    if (stableTimer) clearTimeout(stableTimer);
    timer = null;
    stableTimer = null;
  }

  watch(opts.atBottom, (value) => {
    if (value) {
      if (stableTimer || finishedMarked) return;
      stableTimer = setTimeout(() => {
        stableTimer = null;
        void ensureFinished();
      }, STABLE_MS);
    } else if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  });

  watch(opts.bookId, (next, previous) => {
    if (previous !== null && next !== previous) reset();
  });

  onScopeDispose(() => {
    if (timer) clearTimeout(timer);
    if (stableTimer) clearTimeout(stableTimer);
    timer = null;
    stableTimer = null;
  });

  return { notifyTopChanged, flushNow, ensureFinished, finishNow, reset };
}
