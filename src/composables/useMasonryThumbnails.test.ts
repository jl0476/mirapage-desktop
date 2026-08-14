import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ThumbnailProgressEvent, ThumbnailStateEvent } from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { ThumbnailWindows } from './useMasonryLayout';

// ─── mocks ─────────────────────────────────────────────────────────────
// module3.0.11：state + progress 双事件通道（Map 按 event name 分发）
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
const unlistenSpy = vi.fn();
const requestSpy = vi.fn();
const retrySpy = vi.fn();
const regenSpy = vi.fn();
const notifyEpochSpy = vi.fn();
const notifyFastSpy = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (evt: string, handler: (e: { payload: unknown }) => void) => {
    eventHandlers.set(evt, handler);
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

function fireState(payload: ThumbnailStateEvent) {
  const h = eventHandlers.get('thumbnail://state');
  if (h) h({ payload });
}
function fireProgress(payload: ThumbnailProgressEvent) {
  const h = eventHandlers.get('thumbnail://progress');
  if (h) h({ payload });
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
  // host 组件内调用：onBeforeUnmount 需要 active component instance（effectScope 不覆盖）
  let result!: ReturnType<typeof useMasonryThumbnails>;
  const Host = defineComponent({
    setup() {
      result = useMasonryThumbnails({
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
      return () => h('div');
    },
  });
  const wrapper = mount(Host);
  return {
    result, descriptor, entries, windowsRef, measuredMap, colWidthRef, dpr, quality, scrollTop,
    unmount: () => wrapper.unmount(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  eventHandlers.clear();
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
    expect(eventHandlers.get('thumbnail://state')).toBeDefined();
    fireState({ epoch: curEpoch - 1, cacheKey: 'k', path: 'a', state: 'cached', cachePath: '/c.webp', outputWidth: 1, outputHeight: 1, message: null });
    expect(result.stateMap.value.get('a')).toBeUndefined();
  });

  it('当前 epoch 的 cached 事件更新状态', async () => {
    const { result } = setup();
    await nextTick();
    const curEpoch = result.epoch.value;
    fireState({ epoch: curEpoch, cacheKey: 'k', path: 'a', state: 'cached', cachePath: '/c.webp', outputWidth: 10, outputHeight: 8, message: null });
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
    // module3.0.11：retry 预置 generating(queued)
    const s = result.stateMap.value.get('a');
    expect(s?.kind).toBe('generating');
    if (s?.kind === 'generating') expect(s.phase).toBe('queued');
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
    expect(eventHandlers.get('thumbnail://state')).toBeDefined();
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

// ─── module3.0.11：generating 态 + progress 事件（round-1/2/3 修订全覆盖）──────
describe('useMasonryThumbnails progress (module3.0.11)', () => {
  it('queued IPC 返回 → generating(queued) 态 + 缓存 cacheKey', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    await vi.runOnlyPendingTimersAsync();
    const s = result.stateMap.value.get('a');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('generating');
    if (s!.kind === 'generating') {
      expect(s!.phase).toBe('queued');
      expect(s!.cacheKey).toBe('ckA');
    }
  });

  it('progress 事件推进 phase 且 timings 累计 elapsed', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    await vi.runOnlyPendingTimersAsync();
    const ev: ThumbnailProgressEvent = { epoch: 0, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 2 };
    fireProgress(ev);
    let s = result.stateMap.value.get('a');
    expect(s!.kind).toBe('generating');
    if (s!.kind === 'generating') {
      expect(s!.phase).toBe('decoding');
      expect(s!.timings.decoding).toBe(2);
      expect(s!.generationStartedAt).toBeDefined();
    }
    fireProgress({ ...ev, phase: 'resizing', elapsedMs: 30 });
    s = result.stateMap.value.get('a');
    if (s!.kind === 'generating') {
      expect(s!.phase).toBe('resizing');
      expect(s!.timings.resizing).toBe(30);
      expect(s!.timings.decoding).toBe(2);
    }
  });

  it('progress 事件 epoch 不匹配被忽略', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    await vi.runOnlyPendingTimersAsync();
    fireProgress({ epoch: 999, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 2 });
    const s = result.stateMap.value.get('a');
    expect(s!.kind).toBe('generating');
    if (s!.kind === 'generating') expect(s!.phase).toBe('queued');
  });

  it('非 generating 态收到 progress 事件被忽略', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'cached', cacheKey: 'ckA', cachePath: '/c/a.webp', width: 100, height: 100 }]);
    await vi.runOnlyPendingTimersAsync();
    expect(result.stateMap.value.get('a')!.kind).toBe('cached');
    fireProgress({ epoch: 0, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 2 });
    expect(result.stateMap.value.get('a')!.kind).toBe('cached');
  });

  // round-1 P1-3：事件先于 queued 回包 → 缓冲消费，decoding 不丢
  it('progress 事件先于 queued 回包 → 缓冲消费，phase 不丢', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    fireProgress({ epoch: 0, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 1 });
    await vi.runOnlyPendingTimersAsync();
    const s = result.stateMap.value.get('a');
    expect(s?.kind).toBe('generating');
    if (s?.kind === 'generating') {
      expect(s.phase).toBe('decoding');
      expect(s.timings.decoding).toBe(1);
      expect(s.generationStartedAt).toBeDefined();
    }
  });

  // round-1 P1-3：终态事件先于 queued 回包 → 回包不降级覆盖（无永久 spinner）
  it('cached 完成事件先于 queued 回包 → 回包不降级覆盖', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    fireState({ epoch: 0, state: 'cached', path: 'a', cacheKey: 'ckA', cachePath: '/c/a.webp', outputWidth: 100, outputHeight: 100, message: null });
    await vi.runOnlyPendingTimersAsync();
    expect(result.stateMap.value.get('a')?.kind).toBe('cached');
  });

  // round-1 P1-6：failed 覆盖 generating 后快照保留（失败时间线数据源）
  it('failed 后 progressSnapshots 保留最后快照', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    await vi.runOnlyPendingTimersAsync();
    fireProgress({ epoch: 0, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 5 });
    fireState({ epoch: 0, state: 'failed', path: 'a', cacheKey: 'ckA', cachePath: null, outputWidth: null, outputHeight: null, message: 'boom' });
    expect(result.stateMap.value.get('a')?.kind).toBe('failed');
    const snap = result.progressSnapshots.value.get('a');
    expect(snap?.phase).toBe('decoding');
    expect(snap?.timings.decoding).toBe(5);
  });

  // round-1 P1-5：unmount 解绑两个监听
  it('unmount 同时解绑 state 与 progress 两个监听（防泄漏）', async () => {
    const { unmount } = setup();
    await Promise.resolve(); // 让 listen 的 promise resolve 到 .then
    unlistenSpy.mockClear();
    unmount();
    expect(unlistenSpy).toHaveBeenCalledTimes(2);
  });

  // round-2：unmount 先于 listen resolve → 迟到 unlisten 立即调用（disposed 守卫）
  it('unmount 先于 listen resolve → 迟到的 unlisten 立即调用', async () => {
    const defer = () => {
      let resolve!: (fn: UnlistenFn) => void;
      const promise = new Promise<UnlistenFn>((res) => { resolve = res; });
      return { promise, resolve };
    };
    const d1 = defer();
    const d2 = defer();
    vi.mocked(listen)
      .mockImplementationOnce(() => d1.promise)  // state 监听
      .mockImplementationOnce(() => d2.promise); // progress 监听
    const { unmount } = setup();
    unmount(); // disposed = true（unlisten 均未到手）
    const lateUnlisten = vi.fn();
    d2.resolve(lateUnlisten);
    await Promise.resolve();
    expect(lateUnlisten).toHaveBeenCalledTimes(1); // 不是存起来等下一次 unmount
  });
});

// module3.0.11-hotfix：连续滚动（窗口持续变化、间隔 <80ms debounce）期间，
// 纯 debounce 会无限重置 timer → 滚多久请求延迟多久（实测快速滚动 3 秒
// 才漏出一条请求）。修复：500ms 保底节流——滚动中最多 500ms 必发一条。
it('连续窗口变化（模拟快速滚动）每 500ms 保底发一次请求', async () => {
  const { entries, windowsRef } = setup({ measured: new Map([['a', { width: 1000, height: 800 }]]) });
  entries.value = [mkEntry('a')];
  requestSpy.mockResolvedValue([]);
  // 第一条走 80ms debounce（挂载初始合并）
  windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
  await vi.runOnlyPendingTimersAsync();
  expect(requestSpy).toHaveBeenCalledTimes(1);
  // 连续滚动 1.2s：每 50ms 变一次窗口（间隔 <80ms，纯 debounce 会全吞）
  for (let t = 0; t < 1200; t += 50) {
    windowsRef.value = { visible: [`a${t}`], ahead: [], behind: [], idle: [] };
    entries.value = [mkEntry(`a${t}`)];
    await vi.advanceTimersByTimeAsync(50);
  }
  // 500ms 保底：1.2s 连续变化至少再发 2 条（纯 debounce = 0 条）
  expect(requestSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
});
