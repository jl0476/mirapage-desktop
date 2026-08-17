import { effectScope, ref } from 'vue';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useWebtoonProgress } from './useWebtoonProgress';
import { saveProgress, markFinished } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  saveProgress: vi.fn(async () => undefined),
  markFinished: vi.fn(async () => undefined),
}));

function setup(bookId = ref<number | null>(105), atBottom = ref(false)) {
  return { bookId, atBottom, progress: useWebtoonProgress({ bookId, atBottom }) };
}

describe('useWebtoonProgress', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());

  it('300ms debounce 保存顶部图且同图去重', async () => {
    const { progress } = setup();
    progress.notifyTopChanged('p005.jpg', 4);
    progress.notifyTopChanged('p005.jpg', 4);
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    expect(saveProgress).toHaveBeenCalledOnce();
    expect(saveProgress).toHaveBeenCalledWith(105, 4, 'webtoon', undefined, 'p005.jpg');
  });

  it('flushNow 立即写入并等待串行链', async () => {
    const { progress } = setup();
    progress.notifyTopChanged('p005.jpg', 4);
    await progress.flushNow();
    expect(saveProgress).toHaveBeenCalledWith(105, 4, 'webtoon', undefined, 'p005.jpg');
  });

  it('bookId 变化 reset，同名首图和 finished 可再次写入', async () => {
    const { bookId, atBottom, progress } = setup();
    atBottom.value = true;
    await vi.runAllTimersAsync();
    expect(markFinished).toHaveBeenCalledWith(105, true);
    bookId.value = 206;
    await Promise.resolve();
    progress.notifyTopChanged('001.jpg', 0);
    await progress.flushNow();
    expect(saveProgress).toHaveBeenLastCalledWith(206, 0, 'webtoon', undefined, '001.jpg');
    expect(await progress.ensureFinished()).toBe(true);
    expect(markFinished).toHaveBeenLastCalledWith(206, true);
  });

  it('ensureFinished 按 bookId 去重且失败可重试', async () => {
    vi.mocked(markFinished).mockRejectedValueOnce(new Error('db'));
    const { progress } = setup();
    expect(await progress.ensureFinished()).toBe(false);
    expect(await progress.ensureFinished()).toBe(true);
    expect(markFinished).toHaveBeenCalledTimes(2);
  });

  it('finishNow 立即标记，scope dispose 清 timer 但保留 pending', async () => {
    const scope = effectScope();
    const atBottom = ref(false);
    const progress = scope.run(() => useWebtoonProgress({ bookId: ref(105), atBottom }))!;
    progress.notifyTopChanged('p009.jpg', 8);
    scope.stop();
    vi.advanceTimersByTime(5000);
    expect(markFinished).not.toHaveBeenCalled();
    await progress.flushNow();
    expect(saveProgress).toHaveBeenCalledWith(105, 8, 'webtoon', undefined, 'p009.jpg');
  });

  it('写失败不污染 writeTail：失败上抛后空 flush 照常 resolve（审查必修 #1）', async () => {
    vi.mocked(saveProgress).mockRejectedValueOnce(new Error('db lock'));
    const { progress } = setup();
    progress.notifyTopChanged('a.jpg', 0);
    // 失败写入：flushNow 上抛（跨卷 trySave 的 await 失败契约）
    await expect(progress.flushNow()).rejects.toThrow('db lock');
    // 空 flush（无 pending）：不得被旧 rejected tail 传染
    await expect(progress.flushNow()).resolves.toBeUndefined();
    // 后续写入恢复正常
    progress.notifyTopChanged('b.jpg', 1);
    await progress.flushNow();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(105, 1, 'webtoon', undefined, 'b.jpg');
  });
});
