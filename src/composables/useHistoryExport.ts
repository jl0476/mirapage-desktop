/**
 * 阅览记录导出状态机（module3.1.2，History 页与 Settings maintenance 共享）。
 *
 * idle → (trigger) → exporting → exported=true → done --3s--> idle
 *                               → exported=false（取消）→ idle（静默）
 *                               → 异常 → failed --3s--> idle
 * exporting 中重复 trigger 忽略；组件卸载清理定时器。
 */
import { computed, onUnmounted, ref } from 'vue';
import type { ComposerTranslation } from 'vue-i18n';
import { exportBrowseHistory } from '@/lib/tauri';
import { browseHistoryExportFileName } from '@/lib/format';

export type HistoryExportState = 'idle' | 'exporting' | 'done' | 'failed';

export function useHistoryExport(t: ComposerTranslation) {
  const state = ref<HistoryExportState>('idle');
  const exportedCount = ref(0);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const buttonText = computed(() => {
    switch (state.value) {
      case 'exporting':
        return t('history.exporting');
      case 'done':
        return t('history.exported', { count: exportedCount.value });
      case 'failed':
        return t('history.exportFailed');
      default:
        return t('history.export');
    }
  });

  function scheduleReset() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      state.value = 'idle';
    }, 3000);
  }

  async function trigger(): Promise<void> {
    if (state.value === 'exporting') return;
    state.value = 'exporting';
    try {
      const r = await exportBrowseHistory(browseHistoryExportFileName());
      if (r.exported) {
        exportedCount.value = r.totalCount;
        state.value = 'done';
        scheduleReset();
      } else {
        state.value = 'idle'; // 用户取消对话框：静默
      }
    } catch {
      state.value = 'failed';
      scheduleReset();
    }
  }

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
  });

  return { state, buttonText, trigger };
}
