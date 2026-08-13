/**
 * maintenance store 测试（v0.1.0-database-retention-and-cleanup 任务 6）。
 * 验证：loadSummary 拉摘要 / saveConfig 只写设置不执行 / fetchPreview 只读 / runConfirmed 执行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getMaintenanceSummary: vi.fn(),
  getMaintenancePreview: vi.fn(),
  runMaintenance: vi.fn(),
  updateMaintenanceSettings: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { useMaintenanceStore } from './maintenance';
import {
  getMaintenanceSummary,
  getMaintenancePreview,
  runMaintenance,
  updateMaintenanceSettings,
} from '@/lib/tauri';

const SUMMARY = {
  historyTotal: 120,
  historyMaxEntries: 2000,
  historyRetentionDays: 365,
  historyProtectDays: 7,
  autoEnabled: true,
  lastRunAt: 0,
  lastResultJson: '{}',
  thumbnailTotalBytes: 50_000_000,
  thumbnailCount: 200,
  thumbnailLimitBytes: 512_000_000,
};
const PREVIEW = {
  history: {
    total: 120,
    daysCandidates: 5,
    countCandidates: 0,
    protectedInWindow: 3,
    protectedExceedsLimit: false,
  },
  thumbnailTotalBytes: 50_000_000,
  thumbnailLimitBytes: 512_000_000,
};

describe('maintenance store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(getMaintenanceSummary).mockResolvedValue(SUMMARY);
    vi.mocked(getMaintenancePreview).mockResolvedValue(PREVIEW);
    vi.mocked(runMaintenance).mockResolvedValue({
      historyDeleted: 5,
      thumbnailFreedBytes: 0,
      thumbnailDirtyCleaned: 0,
      protectedExceedsLimit: false,
      source: 'manual',
    });
    vi.mocked(updateMaintenanceSettings).mockResolvedValue(undefined);
  });

  it('loadSummary 填充 summary', async () => {
    const store = useMaintenanceStore();
    await store.loadSummary();
    expect(getMaintenanceSummary).toHaveBeenCalledOnce();
    expect(store.summary?.historyTotal).toBe(120);
    expect(store.summary?.thumbnailCount).toBe(200);
  });

  it('saveConfig 关闭自动维护只保存配置，不调用执行命令', async () => {
    const store = useMaintenanceStore();
    const ok = await store.saveConfig({ autoCleanupEnabled: false });
    expect(ok).toBe(true);
    expect(updateMaintenanceSettings).toHaveBeenCalledWith({ autoCleanupEnabled: false });
    // 不应触发 runMaintenance（执行）
    expect(runMaintenance).not.toHaveBeenCalled();
    // 保存后刷新摘要
    expect(getMaintenanceSummary).toHaveBeenCalled();
  });

  it('fetchPreview 只读，不写设置不执行', async () => {
    const store = useMaintenanceStore();
    const p = await store.fetchPreview();
    expect(getMaintenancePreview).toHaveBeenCalledOnce();
    expect(p?.history.daysCandidates).toBe(5);
    expect(updateMaintenanceSettings).not.toHaveBeenCalled();
    expect(runMaintenance).not.toHaveBeenCalled();
  });

  it('runConfirmed 执行维护并刷新摘要', async () => {
    const store = useMaintenanceStore();
    const result = await store.runConfirmed();
    expect(runMaintenance).toHaveBeenCalledOnce();
    expect(result?.historyDeleted).toBe(5);
    expect(store.lastRun?.source).toBe('manual');
    // 执行后刷新摘要
    expect(getMaintenanceSummary).toHaveBeenCalled();
  });
});
