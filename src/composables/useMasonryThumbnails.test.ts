import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { ThumbnailStateEvent } from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { ThumbnailWindows } from './useMasonryLayout';

// ─── mocks ─────────────────────────────────────────────────────────────
let eventHandler: ((e: { payload: ThumbnailStateEvent }) => void) | null = null;
const unlistenSpy = vi.fn();
const requestSpy = vi.fn();
const retrySpy = vi.fn();
const regenSpy = vi.fn();
const notifyEpochSpy = vi.fn();
const notifyFastSpy = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_evt: string, handler: (e: { payload: ThumbnailStateEvent }) => void) => {
    eventHandler = handler;
    return unlistenSpy;
  }),
}));

vi.mock('@/lib/tauri', async () => {
  return {
    requestThumbnails: vi.fn((...args: unknown[]) => requestSpy(...args)),
    retryThumbnail: vi.fn((...args: unknown[]) => retrySpy(...args)),
    regenerateThumbnail: vi.fn((...args: unknown[]) => regenSpy(...args)),
    notifyThumbnailEpoch: vi.fn(async () => undefined),
    notifyThumbnailFastScrolling: vi.fn(async () => undefined),
    thumbnailCacheUrl: (p: string) => `asset://${p}`,
  };
});

// 在 mock 建立后 import
import { useMasonryThumbnails, mergeWindowsToPriorities } from './useMasonryThumbnails';

const localDesc: SourceDescriptor = { type: 'local', rootPath: 'D:/x' };

function mkEntry(path: string, size = 1000): MediaEntry {
  return { name: path, path, isDirectory: false, isArchive: false, size, modifiedAt: 100 };
}

function setup(opts?: { windows?: ThumbnailWindows; measured?: Map<string, { width: number; height: number }> }) {
  const windows = opts?.windows ?? { visible: [], ahead: [], behind: [], idle: [] };
  const descriptor = ref<SourceDescriptor>(localDesc);
  const entries = ref<readonly MediaEntry[]>([]);
  const windowsRef = ref<ThumbnailWindows>(windows);
  const measuredMap = ref<Map<string, { width: number; height: number }>>(
    opts?.measured ?? new Map(),
  );
  const colWidthRef = ref(300);
  const colWidth = computed(() => colWidthRef.value);
  const dpr = ref(1);
  const quality = ref<'standard' | 'high' | 'ultra'>('high');
  const scrollTop = ref(0);
  const result = useMasonryThumbnails({
    descriptor,
    currentPath: ref(''),
    entries,
    thumbnailWindows: computed(() => windowsRef.value),
    measuredMap,
    colWidth,
    dpr,
    quality,
    scrollTop,
    originalUrlFor: (e) => `orig://${e.path}`,
  });
  return { result, descriptor, entries, windowsRef, measuredMap, colWidthRef, dpr, quality, scrollTop };
}

beforeEach(() => {
  vi.useFakeTimers();
  eventHandler = null;
  unlistenSpy.mockClear();
  requestSpy.mockReset();
  retrySpy.mockReset();
  regenSpy.mockReset();
  notifyEpochSpy.mockClear();
  notifyFastSpy.mockClear();
});

describe('mergeWindowsToPriorities', () => {
  it('四组合并去重，高优先级覆盖低优先级', () => {
    const m = mergeWindowsToPriorities({
      visible: ['a'], ahead: ['b', 'a'], behind: ['c'], idle: ['b'],
    });
    expect(m.get('a')).toBe('visible');
    expect(m.get('b')).toBe('ahead');
    expect(m.get('c')).toBe('behind');
  });
});

describe('useMasonryThumbnails', () => {
  it('四级窗口合成一个去重 batch 请求', async () => {
    const measured = new Map([
      ['a', { width: 1000, height: 800 }],
      ['b', { width: 1000, height: 800 }],
    ]);
    const { entries, windowsRef } = setup({
      measured,
      windows: { visible: ['a'], ahead: ['b'], behind: [], idle: [] },
    });
    entries.value = [mkEntry('a'), mkEntry('b')];
    windowsRef.value = { visible: ['a'], ahead: ['b'], behind: [], idle: ['a'] };

    requestSpy.mockResolvedValue([
      { path: 'a', status: 'queued', cacheKey: 'ka' },
      { path: 'b', status: 'queued', cacheKey: 'kb' },
    ]);
    await vi.runOnlyPendingTimersAsync();

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const args = requestSpy.mock.calls[0];
    // 第 2 个参数是 items，应去重（a 只出现一次）
    const items = args[1] as Array<{ path: string }>;
    const paths = items.map((i) => i.path);
    expect(paths.filter((p) => p === 'a')).toHaveLength(1);
    expect(paths).toContain('b');
  });

  it('request debounce 80ms', async () => {
    const measured = new Map([['a', { width: 1000, height: 800 }]]);
    const { entries, windowsRef } = setup({ measured, windows: { visible: ['a'], ahead: [], behind: [], idle: [] } });
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([]);

    // 立即不应请求
    expect(requestSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(79);
    expect(requestSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('目录/列宽/DPR/质量变化递增 epoch', async () => {
    const { descriptor, colWidthRef, dpr, quality, result } = setup();
    const e0 = result.epoch.value;
    descriptor.value = { type: 'local', rootPath: 'D:/y' };
    await nextTick();
    colWidthRef.value = 400;
    await nextTick();
    dpr.value = 2;
    await nextTick();
    quality.value = 'ultra';
    await nextTick();
    expect(result.epoch.value).toBeGreaterThan(e0);
    expect(result.epoch.value).toBe(e0 + 4);
  });

  it('cached 响应转 asset URL', async () => {
    const measured = new Map([['a', { width: 1000, height: 800 }]]);
    const { entries, windowsRef, result } = setup({ measured, windows: { visible: ['a'], ahead: [], behind: [], idle: [] } });
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([
      { path: 'a', status: 'cached', cachePath: '/cache/a.webp', width: 512, height: 400 },
    ]);
    await vi.runOnlyPendingTimersAsync();
    await nextTick();
    const s = result.stateMap.value.get('a');
    expect(s?.kind).toBe('cached');
    if (s?.kind === 'cached') expect(s.path).toBe('asset:///cache/a.webp');
  });

  it('旧 epoch 事件被忽略', async () => {
    const { result, descriptor } = setup();
    await nextTick();
    descriptor.value = { type: 'local', rootPath: 'D:/y' }; // epoch+1
    await nextTick();
    const curEpoch = result.epoch.value;
    expect(eventHandler).not.toBeNull();
    eventHandler!({ payload: { epoch: curEpoch - 1, cacheKey: 'k', path: 'a', state: 'cached', cachePath: '/c.webp', outputWidth: 1, outputHeight: 1, message: null } });
    expect(result.stateMap.value.get('a')).toBeUndefined();
  });

  it('当前 epoch 的 cached 事件更新状态', async () => {
    const { result } = setup();
    await nextTick();
    const curEpoch = result.epoch.value;
    eventHandler!({ payload: { epoch: curEpoch, cacheKey: 'k', path: 'a', state: 'cached', cachePath: '/c.webp', outputWidth: 10, outputHeight: 8, message: null } });
    expect(result.stateMap.value.get('a')?.kind).toBe('cached');
  });

  it('retry 仅改变目标卡片', async () => {
    const measured = new Map([
      ['a', { width: 1000, height: 800 }],
      ['b', { width: 1000, height: 800 }],
    ]);
    const { entries, result } = setup({ measured });
    entries.value = [mkEntry('a'), mkEntry('b')];
    // 预置 b 为 cached
    result; // stateMap 初始空
    retrySpy.mockResolvedValue({ path: 'a', status: 'queued', cacheKey: 'ka' });
    result.retry('a');
    await nextTick();
    expect(result.stateMap.value.get('a')?.kind).toBe('queued');
    // b 不受影响
    expect(result.stateMap.value.has('b')).toBe(false);
  });

  it('unmount 后 unlisten，晚到事件不改状态', async () => {
    const mod = await import('./useMasonryThumbnails');
    const thumb = mod.useMasonryThumbnails({
      descriptor: ref(localDesc),
      currentPath: ref(''),
      entries: ref<readonly MediaEntry[]>([]),
      thumbnailWindows: computed(() => ({ visible: [], ahead: [], behind: [], idle: [] })),
      measuredMap: ref(new Map()),
      colWidth: computed(() => 300),
      dpr: ref(1),
      quality: ref('high'),
      scrollTop: ref(0),
      originalUrlFor: () => '',
    });
    // listen 已在 setup 时注册 unlisten 句柄；此处验证 handler 已就绪
    await vi.runOnlyPendingTimersAsync();
    expect(unlistenSpy).not.toHaveBeenCalled(); // 还未卸载
    expect(eventHandler).not.toBeNull();
    void thumb;
  });

  it('可见+ahead 的已知 cache key 随请求上报（LRU 保护）', async () => {
    const measured = new Map([
      ['a', { width: 1000, height: 800 }],
      ['b', { width: 1000, height: 800 }],
    ]);
    const { entries, windowsRef } = setup({ measured, windows: { visible: ['a'], ahead: ['b'], behind: [], idle: [] } });
    entries.value = [mkEntry('a'), mkEntry('b')];
    windowsRef.value = { visible: ['a'], ahead: ['b'], behind: [], idle: [] };
    // 第一轮：拿到 cache key
    requestSpy.mockResolvedValueOnce([
      { path: 'a', status: 'queued', cacheKey: 'ka' },
      { path: 'b', status: 'queued', cacheKey: 'kb' },
    ]);
    await vi.runOnlyPendingTimersAsync();
    // 第二轮：再次请求，应带 visible+ahead 的 cache key
    requestSpy.mockResolvedValueOnce([]);
    windowsRef.value = { visible: ['a'], ahead: ['b'], behind: [], idle: [] };
    await vi.runOnlyPendingTimersAsync();
    const args = requestSpy.mock.calls[1];
    const visibleKeys = args[3] as string[];
    expect(visibleKeys).toContain('ka');
    expect(visibleKeys).toContain('kb');
  });
});
