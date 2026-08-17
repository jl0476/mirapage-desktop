import { ref } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useWebtoonDimensions } from './useWebtoonDimensions';
import { listImageDimensions } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listImageDimensions: vi.fn() };
});

describe('useWebtoonDimensions（module3.1.0）', () => {
  beforeEach(() => vi.clearAllMocks());

  function mk(relPath = '') {
    return useWebtoonDimensions(
      ref({ type: 'local', rootPath: 'R:\\c' }),
      ref(['a.jpg', 'b.jpg', 'c.jpg']),
      ref(relPath),
    );
  }

  it('ensureRange：拼 relPath 前缀请求 fullPath，响应反查 name 回填', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([
      { path: 'comics/vol01/a.jpg', width: 1000, height: 2000 },
    ]);
    const d = mk('comics/vol01');
    await d.ensureRange(0, 2);
    expect(listImageDimensions).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'R:\\c' },
      ['comics/vol01/a.jpg', 'comics/vol01/b.jpg'],
    );
    expect(d.measuredMap.value.get('a.jpg')).toEqual({ width: 1000, height: 2000 });
    await d.ensureRange(0, 2);
    expect(listImageDimensions).toHaveBeenCalledTimes(1);
  });

  it('relPath=""（书在根）：裸名直传', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([{ path: 'a.jpg', width: 100, height: 200 }]);
    const d = mk();
    await d.ensureRange(0, 1);
    expect(listImageDimensions).toHaveBeenCalledWith(expect.anything(), ['a.jpg']);
  });

  it('跨卷清空并让同名图重新测量', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([{ path: 'vol1/001.jpg', width: 1000, height: 2000 }]);
    const relPath = ref('vol1');
    const d = useWebtoonDimensions(ref({ type: 'local', rootPath: 'R:\\c' }), ref(['001.jpg']), relPath);
    await d.ensureRange(0, 1);
    expect(d.measuredMap.value.size).toBe(1);
    relPath.value = 'vol2';
    await Promise.resolve();
    expect(d.measuredMap.value.size).toBe(0);
    vi.mocked(listImageDimensions).mockClear().mockResolvedValue([{ path: 'vol2/001.jpg', width: 800, height: 3000 }]);
    await d.ensureRange(0, 1);
    expect(listImageDimensions).toHaveBeenCalledTimes(1);
    expect(d.measuredMap.value.get('001.jpg')).toEqual({ width: 800, height: 3000 });
  });

  it('跨卷陈旧响应按 epoch 丢弃', async () => {
    let resolveA!: (v: { path: string; width: number; height: number }[]) => void;
    vi.mocked(listImageDimensions).mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    const relPath = ref('vol1');
    const d = useWebtoonDimensions(ref({ type: 'local', rootPath: 'R:\\c' }), ref(['001.jpg']), relPath);
    void d.ensureRange(0, 1);
    relPath.value = 'vol2';
    await Promise.resolve();
    resolveA([{ path: 'vol1/001.jpg', width: 1000, height: 9999 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.measuredMap.value.size).toBe(0);
  });

  it('onBeforeApply 在 batch 写入前调用', async () => {
    vi.mocked(listImageDimensions).mockResolvedValue([{ path: 'a.jpg', width: 1000, height: 2000 }]);
    const calls: number[] = [];
    let d!: ReturnType<typeof useWebtoonDimensions>;
    d = useWebtoonDimensions(ref({ type: 'local', rootPath: 'R:\\c' }), ref(['a.jpg']), ref(''), {
      onBeforeApply: () => calls.push(d.measuredMap.value.size),
    });
    await d.ensureRange(0, 1);
    expect(calls).toEqual([0]);
    expect(d.measuredMap.value.size).toBe(1);
  });

  it('IPC 失败静默，失败项不写入 measuredMap', async () => {
    vi.mocked(listImageDimensions).mockRejectedValue(new Error('io'));
    const d = mk();
    await expect(d.ensureRange(0, 1)).resolves.toBeUndefined();
    expect(d.measuredMap.value.size).toBe(0);
  });

  it('整批 IPC 失败后允许重试：requested 清理，再次 ensureRange 重新发起请求', async () => {
    vi.mocked(listImageDimensions)
      .mockRejectedValueOnce(new Error('transient io'))
      .mockResolvedValueOnce([{ path: 'a.jpg', width: 800, height: 600 }]);
    const d = mk();
    await d.ensureRange(0, 1);
    expect(d.measuredMap.value.size).toBe(0);
    expect(listImageDimensions).toHaveBeenCalledTimes(1);
    // 若 requested 未清理，第二次同窗口 batch 为空不再请求（永久退化为估算）
    await d.ensureRange(0, 1);
    expect(listImageDimensions).toHaveBeenCalledTimes(2);
    expect(d.measuredMap.value.get('a.jpg')).toEqual({ width: 800, height: 600 });
  });
});
