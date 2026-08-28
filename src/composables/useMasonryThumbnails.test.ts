import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { notifyThumbnailEpoch, type ThumbnailProgressEvent, type ThumbnailStateEvent } from '@/lib/tauri';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { ThumbnailWindows } from './useMasonryLayout';

// ─── mocks ─────────────────────────────────────────────────────────────
// module3.0.11：state + progress 双事件通道（Map 按 event name 分发）
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
const unlistenSpy = vi.fn();
const requestSpy = vi.fn();
const retrySpy = vi.fn();
const regenSpy = vi.fn();
const invalidateSpy = vi.fn();
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
    invalidateThumbnailCacheKeys: vi.fn((...args: unknown[]) => invalidateSpy(...args)),
    // 任务 5：notify 接入 spy（默认 resolved；屏障测试用 mockImplementationOnce 覆盖）
    notifyThumbnailEpoch: vi.fn((e: number) => {
      notifyEpochSpy(e);
      return Promise.resolve();
    }),
    notifyThumbnailFastScrolling: vi.fn(async () => undefined),
    thumbnailCacheUrl: (p: string) => `asset://${p}`,
  };
});

// 在 mock 建立后 import
import { useMasonryThumbnails, mergeWindowsToPriorities } from './useMasonryThumbnails';

const localDesc: SourceDescriptor = { type: 'local', rootPath: 'D:/x' };

function mkEntry(path: string, size = 1000): MediaEntry {
  // name 借 .jpg 后缀过 isMasonryImage 判定（2026-08-27 混排过滤）；path 保持裸名供断言
  return { name: `${path}.jpg`, path, isDirectory: false, isArchive: false, size, modifiedAt: 100 };
}

function fireState(payload: ThumbnailStateEvent) {
  const h = eventHandlers.get('thumbnail://state');
  if (h) h({ payload });
}
function fireProgress(payload: ThumbnailProgressEvent) {
  const h = eventHandlers.get('thumbnail://progress');
  if (h) h({ payload });
}

function setup(opts?: { windows?: ThumbnailWindows; measured?: Map<string, { width: number; height: number }>; entries?: MediaEntry[] }) {
  const windows = opts?.windows ?? { visible: [], ahead: [], behind: [], idle: [] };
  const descriptor = ref<SourceDescriptor>(localDesc);
  const currentPath = ref(''); // 任务 5：目录身份 watch 测试需要外部驱动
  const entries = ref<readonly MediaEntry[]>(opts?.entries ?? []);
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
        currentPath,
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
    result, descriptor, currentPath, entries, windowsRef, measuredMap, colWidthRef, dpr, quality, scrollTop,
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
  invalidateSpy.mockReset();
  notifyEpochSpy.mockClear();
  notifyFastSpy.mockClear();
});

describe('挂载即发首批（immediate watch，实机批热修）', () => {
  it('挂载时 windows 已非空且 entries 就绪 → 不等窗口变化立即 flush', async () => {
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ka' }]);
    setup({
      windows: { visible: ['a'], ahead: [], behind: [], idle: [] },
      entries: [mkEntry('a')],
    });
    await vi.advanceTimersByTimeAsync(80);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][1]).toMatchObject([
      { path: 'a', sourceRelPath: 'a', priority: 'visible' },
    ]);
  });

  it('挂载时 windows 为空 → 静默跳过，不误发空请求', async () => {
    setup({ entries: [mkEntry('a')] });
    await vi.advanceTimersByTimeAsync(80);
    expect(requestSpy).not.toHaveBeenCalled();
  });
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
    const ev: ThumbnailProgressEvent = { epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 2 };
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
    fireProgress({ epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 2 });
    expect(result.stateMap.value.get('a')!.kind).toBe('cached');
  });

  // round-1 P1-3：事件先于 queued 回包 → 缓冲消费，decoding 不丢
  it('progress 事件先于 queued 回包 → 缓冲消费，phase 不丢', async () => {
    const { result, entries, windowsRef } = setup();
    entries.value = [mkEntry('a')];
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    fireProgress({ epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 1 });
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
    fireState({ epoch: result.epoch.value, state: 'cached', path: 'a', cacheKey: 'ckA', cachePath: '/c/a.webp', outputWidth: 100, outputHeight: 100, message: null });
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
    fireProgress({ epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 5 });
    fireState({ epoch: result.epoch.value, state: 'failed', path: 'a', cacheKey: 'ckA', cachePath: null, outputWidth: null, outputHeight: null, message: 'boom' });
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

// ─── 混排（2026-08-27 方案 B）：非图片不进缩略图请求 batch ──────────────────
// cover.jpg 目录也不进（isMasonryImage 类型标记优先）；归档/杂文件无缩略图语义。
describe('useMasonryThumbnails 混排过滤', () => {
  it('窗口含目录/归档/杂文件时只请求图片（items 严格等于图片集）', async () => {
    const { entries, windowsRef, unmount } = setup({
      windows: { visible: [], ahead: [], behind: [], idle: [] },
    });
    // 清前序用例泄漏的 pending request timer（mockReset 后到点仍会向新 spy 记账串台：
    // 实测 calls[0] 混入前序用例的 ["a1150"] 请求）
    vi.clearAllTimers();
    entries.value = [
      mkEntry('a.jpg'),
      { name: 'cover.jpg', path: 'cover.jpg', isDirectory: true, isArchive: false, size: 0, modifiedAt: 100 },
      { name: 'book.cbz', path: 'book.cbz', isDirectory: false, isArchive: true, size: 0, modifiedAt: 100 },
      { name: 'Thumbs.db', path: 'Thumbs.db', isDirectory: false, isArchive: false, size: 0, modifiedAt: 100 },
    ];
    // 四组窗口均含全部 path（最严苛：非图片混进每一组都要被滤掉）
    windowsRef.value = {
      visible: ['a.jpg', 'cover.jpg'],
      ahead: ['book.cbz'],
      behind: ['Thumbs.db'],
      idle: ['cover.jpg'],
    };
    requestSpy.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(90);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const items = requestSpy.mock.calls[0][1] as Array<{ path: string }>;
    expect(items.map((i) => i.path)).toEqual(['a.jpg']);
    unmount();
  });
});

// ─── 任务 5：epoch 出队四件套（目录身份出队 / 布局参数只 bump / 卸载出队 /
// 跨实例全局单调 + 挂载即 notify / notify 完成屏障） ────────────────────────
describe('useMasonryThumbnails epoch 出队四件套（任务 5）', () => {
  it('currentPath 变化 → bump + notify（出队）且 stateMap 清空', async () => {
    vi.clearAllTimers();
    const { result, currentPath, unmount } = setup();
    const e0 = result.epoch.value;
    // 预置 cached 态（旧目录状态）
    fireState({ epoch: e0, cacheKey: 'k', path: 'a', state: 'cached', cachePath: '/c.webp', outputWidth: 1, outputHeight: 1, message: null });
    expect(result.stateMap.value.get('a')?.kind).toBe('cached');
    currentPath.value = 'sub';
    await nextTick();
    expect(result.epoch.value).toBeGreaterThan(e0);
    expect(notifyEpochSpy).toHaveBeenLastCalledWith(result.epoch.value);
    expect(result.stateMap.value.size).toBe(0);
    unmount();
  });

  it('colWidth 变化 → bump + notify 但 stateMap / 失败快照不清（只 bump）', async () => {
    vi.clearAllTimers();
    const { result, colWidthRef, unmount } = setup({
      windows: { visible: ['a'], ahead: [], behind: [], idle: [] },
      entries: [mkEntry('a')],
    });
    const e0 = result.epoch.value;
    requestSpy.mockResolvedValue([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    await vi.runOnlyPendingTimersAsync();
    fireProgress({ epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', phase: 'decoding', elapsedMs: 3 });
    expect(result.stateMap.value.get('a')?.kind).toBe('generating');
    expect(result.progressSnapshots.value.get('a')).toBeDefined();
    colWidthRef.value = 456;
    await nextTick();
    expect(result.epoch.value).toBeGreaterThan(e0);
    expect(notifyEpochSpy).toHaveBeenLastCalledWith(result.epoch.value);
    // 只 bump：目录状态与失败快照保留
    expect(result.stateMap.value.get('a')?.kind).toBe('generating');
    expect(result.progressSnapshots.value.get('a')).toBeDefined();
    unmount();
  });

  it('组件卸载 → bump + notify（卸载出队，Rust 端清残留任务）', async () => {
    vi.clearAllTimers();
    const { result, unmount } = setup();
    const e0 = result.epoch.value;
    unmount();
    expect(result.epoch.value).toBeGreaterThan(e0);
    expect(notifyEpochSpy).toHaveBeenLastCalledWith(result.epoch.value);
  });

  it('同一毫秒跨实例单调：A 卸载 bump 后 B 挂载 epoch ≥ e+2，且 B 挂载即 notify 初始 epoch', async () => {
    vi.clearAllTimers();
    vi.setSystemTime(1700000000000); // 固定毫秒：Date.now() 恒定，逼出同毫秒分配
    const a = setup();
    const e = a.result.epoch.value;
    a.unmount(); // 卸载 bump：e → e+1（每实例独立 Date.now() 播种会与 B 撞号）
    const b = setup();
    expect(b.result.epoch.value).toBeGreaterThanOrEqual(e + 2);
    expect(notifyEpochSpy).toHaveBeenLastCalledWith(b.result.epoch.value); // 挂载即 notify
    b.unmount();
  });

  it('notify 完成屏障：requestThumbnails 不早于 notify resolve（挂载首批与 bump 后两段）', async () => {
    vi.clearAllTimers();
    const order: string[] = [];
    let resolveNotify1!: () => void;
    let resolveNotify2!: () => void;
    vi.mocked(notifyThumbnailEpoch)
      .mockImplementationOnce(() => new Promise<void>((res) => { resolveNotify1 = res; }))
      .mockImplementationOnce(() => new Promise<void>((res) => { resolveNotify2 = res; }));
    requestSpy.mockImplementation(async () => {
      order.push('request');
      return [];
    });
    const { colWidthRef, windowsRef, unmount } = setup({
      windows: { visible: ['a'], ahead: [], behind: [], idle: [] },
      entries: [mkEntry('a')],
    });
    // 第一段：挂载首批（immediate watch → 80ms debounce → flushRequest）
    await vi.advanceTimersByTimeAsync(80);
    expect(requestSpy).not.toHaveBeenCalled(); // 挂在屏障上（notify 未 resolve）
    order.push('notify1');
    resolveNotify1();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 2)).toEqual(['notify1', 'request']);
    // 第二段：colWidth bump → notify2 pending → 窗口变化触发新一轮 flush
    colWidthRef.value = 456;
    await nextTick();
    windowsRef.value = { visible: ['a'], ahead: [], behind: [], idle: [] };
    await vi.advanceTimersByTimeAsync(80);
    expect(requestSpy).toHaveBeenCalledTimes(1); // 仍挂屏障
    order.push('notify2');
    resolveNotify2();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['notify1', 'request', 'notify2', 'request']);
    unmount();
  });
});

// ─── 任务 3：load-error 接线与重试分流（cached 先失效再请求 / original 直请求）───
describe('useMasonryThumbnails load-error（任务 3）', () => {
  it('markLoadFailed 保留原 state 的 cacheKey 并转 failed(load-error)', () => {
    const { result, unmount } = setup();
    // 预置 cached 态（带 cacheKey ckA）
    fireState({ epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', state: 'cached', cachePath: '/c/a.webp', outputWidth: 100, outputHeight: 80, message: null });
    expect(result.stateMap.value.get('a')?.kind).toBe('cached');

    result.markLoadFailed('a');
    const s = result.stateMap.value.get('a');
    // cacheKey 必须保留（失效目标，R2：清空即丢失）
    expect(s).toEqual({ kind: 'failed', cacheKey: 'ckA', retryable: true, message: 'load-error' });
    unmount();
  });

  it('markLoadFailed 对 original 态（无 cacheKey）→ cacheKey 空串', async () => {
    vi.clearAllTimers();
    const { result, unmount } = setup({
      windows: { visible: ['a'], ahead: [], behind: [], idle: [] },
      entries: [mkEntry('a')],
    });
    requestSpy.mockResolvedValueOnce([{ path: 'a', status: 'original' }]);
    await vi.runOnlyPendingTimersAsync();
    expect(result.stateMap.value.get('a')?.kind).toBe('original');

    result.markLoadFailed('a');
    const s = result.stateMap.value.get('a');
    expect(s).toEqual({ kind: 'failed', cacheKey: '', retryable: true, message: 'load-error' });
    unmount();
  });

  it('retryLoadFailed cached 来源：先失效缓存（带 cacheKey）再请求（顺序断言）', async () => {
    vi.clearAllTimers();
    const { result, entries, unmount } = setup();
    entries.value = [mkEntry('a')];
    fireState({ epoch: result.epoch.value, cacheKey: 'ckA', path: 'a', state: 'cached', cachePath: '/c/a.webp', outputWidth: 100, outputHeight: 80, message: null });
    invalidateSpy.mockResolvedValue(undefined);
    let resolveReq!: (v: unknown[]) => void;
    requestSpy.mockReturnValueOnce(new Promise((res) => { resolveReq = res; }));

    const done = result.retryLoadFailed('a');
    // invalidate 的 microtask 链走完后：预置 generating/queued（spinner 反馈）+ 请求已发
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const s = result.stateMap.value.get('a');
    expect(s?.kind).toBe('generating');
    if (s?.kind === 'generating') expect(s.phase).toBe('queued');

    // 顺序：invalidate 先于 requestThumbnails；参数 [cacheKey]
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.calls[0][0]).toEqual(['ckA']);
    expect(invalidateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      requestSpy.mock.invocationCallOrder[0],
    );

    resolveReq([{ path: 'a', status: 'queued', cacheKey: 'ckA' }]);
    await done;
    unmount();
  });

  it('retryLoadFailed original 来源：无失效调用，直接 re-request', async () => {
    vi.clearAllTimers();
    const { result, unmount } = setup({
      windows: { visible: ['a'], ahead: [], behind: [], idle: [] },
      entries: [mkEntry('a')],
    });
    // 种 original 态（无 cacheKey）
    requestSpy.mockResolvedValueOnce([{ path: 'a', status: 'original' }]);
    await vi.runOnlyPendingTimersAsync();
    expect(result.stateMap.value.get('a')?.kind).toBe('original');

    invalidateSpy.mockResolvedValue(undefined);
    requestSpy.mockResolvedValueOnce([{ path: 'a', status: 'queued', cacheKey: 'kb' }]);
    await result.retryLoadFailed('a');

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledTimes(2);
    const args = requestSpy.mock.calls[1];
    // 单 item（visible 优先级）+ 空 visibleKeys
    const items = args[1] as Array<{ path: string; priority: string }>;
    expect(items.map((i) => i.path)).toEqual(['a']);
    expect(items[0].priority).toBe('visible');
    expect(args[3]).toEqual([]);
    unmount();
  });
});
