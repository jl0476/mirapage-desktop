<script setup lang="ts">
// MasonrySettingsPopup.vue — 工具栏 ⚙ 弹出面板（列数 + 列间距 + 行间距）
// 仅 masonry viewMode 出现。click-outside 关闭（SortDropdown 模式）。
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
  colCount: number;
  hGap: number;
  vGap: number;
}
defineProps<Props>();
const emit = defineEmits<{
  (e: 'change', partial: { colCount?: number; hGap?: number; vGap?: number }): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();
const rootRef = ref<HTMLElement | null>(null);

function onMouseDown(e: MouseEvent) {
  if (!rootRef.value?.contains(e.target as Node)) {
    emit('close');
  }
}
onMounted(() => document.addEventListener('mousedown', onMouseDown));
onUnmounted(() => document.removeEventListener('mousedown', onMouseDown));

function onColChange(e: Event) {
  emit('change', { colCount: Number((e.target as HTMLInputElement).value) });
}
function onHGapChange(e: Event) {
  emit('change', { hGap: Number((e.target as HTMLInputElement).value) });
}
function onVGapChange(e: Event) {
  emit('change', { vGap: Number((e.target as HTMLInputElement).value) });
}
</script>

<template>
  <div ref="rootRef"
       class="absolute right-0 top-full z-50 mt-1 min-w-[220px] bg-surface-4 xp-bd rounded-lg p-3 shadow-xl backdrop-blur-xl"
       role="dialog" data-test="masonry-popup">
    <div class="flex flex-col gap-3">
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-text-muted">{{ t('settings.masonry.colCount') }}</span>
          <span class="text-xs text-accent font-mono">{{ colCount }}</span>
        </div>
        <input type="range" min="2" max="8" step="1" :value="colCount"
               class="w-full accent-accent cursor-pointer" data-test="slider-cols" @input="onColChange" />
      </div>
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-text-muted">{{ t('settings.masonry.hGap') }}</span>
          <span class="text-xs text-accent font-mono">{{ hGap }}px</span>
        </div>
        <input type="range" min="0" max="24" step="1" :value="hGap"
               class="w-full accent-accent cursor-pointer" data-test="slider-hgap" @input="onHGapChange" />
      </div>
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-text-muted">{{ t('settings.masonry.vGap') }}</span>
          <span class="text-xs text-accent font-mono">{{ vGap }}px</span>
        </div>
        <input type="range" min="0" max="24" step="1" :value="vGap"
               class="w-full accent-accent cursor-pointer" data-test="slider-vgap" @input="onVGapChange" />
      </div>
      <p class="text-[10px] text-text-tertiary m-0 leading-relaxed">{{ t('settings.masonry.perFolderHint') }}</p>
    </div>
  </div>
</template>
