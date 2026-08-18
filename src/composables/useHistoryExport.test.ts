import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { exportBrowseHistory } from '@/lib/tauri';
import { useHistoryExport } from './useHistoryExport';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, exportBrowseHistory: vi.fn() };
});

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: {
    'zh-CN': {
      history: {
        export: '导出',
        exporting: '导出中…',
        exported: '已导出 {count} 条',
        exportFailed: '导出失败',
      },
    },
  },
});

function setup() {
  return useHistoryExport(i18n.global.t);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe('useHistoryExport', () => {
  it('idle 初始态按钮文本为「导出」', () => {
    const { buttonText, state } = setup();
    expect(state.value).toBe('idle');
    expect(buttonText.value).toBe('导出');
  });

  it('成功：exported=true → done 文案含条数，3s 后回落 idle', async () => {
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: true, path: 'X:/a.json', totalCount: 42 });
    const { buttonText, state, trigger } = setup();

    await trigger();
    expect(state.value).toBe('done');
    expect(buttonText.value).toBe('已导出 42 条');
    expect(exportBrowseHistory).toHaveBeenCalledWith(expect.stringMatching(/^browse_history_\d{8}_\d{6}\.json$/));

    vi.advanceTimersByTime(3000);
    expect(state.value).toBe('idle');
  });

  it('取消：exported=false 静默回 idle（无 3s 等待）', async () => {
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: false, path: null, totalCount: 0 });
    const { state, trigger } = setup();
    await trigger();
    expect(state.value).toBe('idle');
  });

  it('失败：异常 → failed 文案，3s 后回落', async () => {
    vi.mocked(exportBrowseHistory).mockRejectedValue(new Error('disk'));
    const { buttonText, state, trigger } = setup();
    await trigger();
    expect(state.value).toBe('failed');
    expect(buttonText.value).toBe('导出失败');
    vi.advanceTimersByTime(3000);
    expect(state.value).toBe('idle');
  });

  it('exporting 中重复 trigger 被忽略', async () => {
    let resolveFn: (v: { exported: boolean; path: string | null; totalCount: number }) => void = () => {};
    vi.mocked(exportBrowseHistory).mockImplementation(
      () => new Promise((res) => { resolveFn = res; })
    );
    const { trigger } = setup();
    const p1 = trigger();
    const p2 = trigger(); // exporting 中
    resolveFn({ exported: false, path: null, totalCount: 0 });
    await Promise.all([p1, p2]);
    expect(exportBrowseHistory).toHaveBeenCalledTimes(1);
  });
});
