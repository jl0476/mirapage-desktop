/**
 * ReaderMainMenu.vue — v0.1.0-module2.0 全屏阅读控制 Dialog
 *
 * 参考 Perfect-Viewer `ReaderMainMenu.kt`:
 * - 全屏半透明黑色 (bg-black/88)
 * - 不常驻 toolbar, 不自动 fade
 * - 中央 / 顶中 触发 (useReaderTouchZones 派发 openMenu)
 * - 切换模式/方向/缩放保持打开
 * - 跳页 / 路由 / 关闭按钮 关闭
 */
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
  show: boolean;
  title?: string;
  currentSpreadIndex: number;
  totalSpreads: number;
}
const props = withDefaults(defineProps<Props>(), {
  title: '',
  totalSpreads: 0,
});

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'back'): void;
  (e: 'jump-page', index: number): void;
  (e: 'cycle-mode'): void;
  (e: 'cycle-direction'): void;
}>();

const { t } = useI18n();

const localShow = ref(props.show);
watch(() => props.show, (v) => { localShow.value = v; });
watch(localShow, (v) => { emit('update:show', v); });

function close(): void { localShow.value = false; }
function onBack(): void { close(); emit('back'); }
function onJumpPage(): void { close(); emit('jump-page', 0); }
function onCycleMode(): void { emit('cycle-mode'); }
function onCycleDirection(): void { emit('cycle-direction'); }
</script>

<template>
  <Teleport to="body">
    <div
      v-if="localShow"
      class="fixed inset-0 z-[1100] bg-black/88 backdrop-blur-sm
             flex flex-col items-stretch p-8 gap-4 overflow-y-auto"
      role="dialog"
      :aria-label="t('reader.menu.title')"
      data-test="reader-main-menu"
    >
      <header class="flex items-center justify-between gap-3">
        <button
          class="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-back"
          @click="onBack"
        >
          ← {{ t('reader.menu.back') }}
        </button>
        <h2 class="text-base font-semibold text-text-primary truncate flex-1 text-center">
          {{ title }}
        </h2>
        <span class="text-xs text-text-muted font-mono">
          {{ currentSpreadIndex + 1 }} / {{ totalSpreads }}
        </span>
        <button
          class="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-jump"
          @click="onJumpPage"
        >
          {{ t('reader.menu.jump') }}
        </button>
      </header>

      <section class="flex flex-col gap-1">
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-mode"
          @click="onCycleMode"
        >
          {{ t('reader.menu.mode') }}
        </button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-direction"
          @click="onCycleDirection"
        >
          {{ t('reader.menu.direction') }}
        </button>
      </section>

      <div class="mt-auto flex justify-end">
        <button
          class="px-4 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-close"
          @click="close"
        >
          {{ t('reader.menu.close') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
