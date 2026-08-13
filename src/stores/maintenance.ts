/**
 * 维护 store（v0.1.0-database-retention-and-cleanup，spec §8）。
 *
 * 消费 maintenance IPC：加载摘要 / 编辑并保存配置 / 预览（只读）/ 立即维护（确认后执行）。
 * 所有 IPC 调用经 `@/lib/tauri`。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  getMaintenanceSummary,
  getMaintenancePreview,
  runMaintenance,
  updateMaintenanceSettings,
  type MaintenanceSummary,
  type MaintenancePreview,
  type MaintenanceRunResult,
  type UpdateMaintenanceSettings,
} from '@/lib/tauri';
import { log } from '@/lib/logger';

export const useMaintenanceStore = defineStore('maintenance', () => {
  /** 最近一次摘要（Settings 页加载用）。 */
  const summary = ref<MaintenanceSummary | null>(null);
  /** 最近一次预览（只读，不写库）。 */
  const preview = ref<MaintenancePreview | null>(null);
  /** 最近一次执行结果。 */
  const lastRun = ref<MaintenanceRunResult | null>(null);
  /** 加载/执行中标志。 */
  const loading = ref(false);

  /** 加载摘要（Settings 进入时调）。 */
  async function loadSummary(): Promise<void> {
    loading.value = true;
    try {
      summary.value = await getMaintenanceSummary();
    } catch (e) {
      log('ERROR', 'maintenance', `loadSummary failed: ${String(e)}`);
    } finally {
      loading.value = false;
    }
  }

  /** 保存配置（只写设置，不触发执行）。成功后刷新摘要。 */
  async function saveConfig(patch: UpdateMaintenanceSettings): Promise<boolean> {
    try {
      await updateMaintenanceSettings(patch);
      await loadSummary();
      return true;
    } catch (e) {
      log('ERROR', 'maintenance', `saveConfig failed: ${String(e)}`);
      return false;
    }
  }

  /** 拉取预览（只读，不写库不删文件，spec §8）。 */
  async function fetchPreview(): Promise<MaintenancePreview | null> {
    try {
      preview.value = await getMaintenancePreview();
      return preview.value;
    } catch (e) {
      log('ERROR', 'maintenance', `fetchPreview failed: ${String(e)}`);
      return null;
    }
  }

  /** 立即维护（前端已确认）。执行后刷新摘要 + 返回结果。 */
  async function runConfirmed(): Promise<MaintenanceRunResult | null> {
    loading.value = true;
    try {
      const result = await runMaintenance();
      lastRun.value = result;
      await loadSummary();
      return result;
    } catch (e) {
      log('ERROR', 'maintenance', `runConfirmed failed: ${String(e)}`);
      return null;
    } finally {
      loading.value = false;
    }
  }

  return { summary, preview, lastRun, loading, loadSummary, saveConfig, fetchPreview, runConfirmed };
});
