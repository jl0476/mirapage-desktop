<script setup lang="ts">
/**
 * ReaderContextMenu.vue — 阅读器右键轻量上下文菜单（需求4）
 * 参照 RowContextMenu dropdown 风格。项：
 *   缩放(子菜单) / 模式 / 方向 / 幻灯片 / 跳页 / 返回
 * 点击空白或 ESC 关闭。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ScaleMode } from '@/lib/readerSettings';

interface Props {
  x: number;
  y: number;
  scaleMode: ScaleMode;
  mode: 'single' | 'double';
  direction: 'ltr' | 'rtl';
  isSlideshowPlaying: boolean;
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'scale-change', m: ScaleMode): void;
  (e: 'cycle-mode'): void;
  (e: 'cycle-direction'): void;
  (e: 'toggle-slideshow'): void;
  (e: 'jump-page'): void;
  (e: 'back'): void;
}>();

const { t } = useI18n();
const scaleOpen = ref(false);
const SCALE_MODES: ScaleMode[] = [
  'fit-screen', 'fit-width', 'fit-height',
  'original', 'full-screen', 'stretch',
];

function onScaleSelect(m: ScaleMode): void {
  emit('scale-change', m);
  scaleOpen.value = false;
  emit('close');
}

function onItemClick(action: 'cycle-mode' | 'cycle-direction' | 'toggle-slideshow' | 'jump-page' | 'back'): void {
  switch (action) {
    case 'cycle-mode': emit('cycle-mode'); break;
    case 'cycle-direction': emit('cycle-direction'); break;
    case 'toggle-slideshow': emit('toggle-slideshow'); break;
    case 'jump-page': emit('jump-page'); break;
    case 'back': emit('back'); break;
  }
  emit('close');
}

function onMouseDown(e: MouseEvent): void {
  // 点击菜单外关闭
  const el = e.target as HTMLElement;
  if (!el.closest('[data-test="reader-context-menu"]')) emit('close');
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onMouseDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    class="fixed z-[1200] min-w-[180px] bg-surface-4 border border-white/10 rounded-lg py-1 shadow-xl backdrop-blur-xl"
    :style="{ left: `${props.x}px`, top: `${props.y}px` }"
    data-test="reader-context-menu"
    role="menu"
  >
    <!-- 缩放（子菜单） -->
    <div
      class="relative"
      data-test="ctx-scale"
      @click="scaleOpen = !scaleOpen"
    >
      <button
        data-test="ctx-item"
        class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary"
      >
        <span>{{ t('reader.menu.scale') }}</span>
        <span class="text-text-muted">{{ props.scaleMode }}</span>
      </button>
      <div
        v-if="scaleOpen"
        class="absolute left-full top-0 ml-1 min-w-[150px] bg-surface-4 border border-white/10 rounded-lg py-1 shadow-xl"
        @click.stop
      >
        <button
          v-for="m in SCALE_MODES"
          :key="m"
          class="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-surface-light"
          :class="m === props.scaleMode ? 'text-accent' : 'text-text-secondary'"
          data-test="ctx-scale-option"
          @click.stop="onScaleSelect(m)"
        >{{ m }}</button>
      </div>
    </div>

    <div class="my-1 h-px bg-white/10" />

    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('cycle-mode')">
      <span>{{ t('reader.menu.mode') }}</span><span class="text-text-muted">{{ props.mode }}</span>
    </button>
    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('cycle-direction')">
      <span>{{ t('reader.menu.direction') }}</span><span class="text-text-muted">{{ props.direction }}</span>
    </button>
    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('toggle-slideshow')">
      <span>{{ t('slideshow.control') }}</span><span class="text-text-muted">{{ props.isSlideshowPlaying ? t('slideshow.pause') : t('slideshow.play') }}</span>
    </button>
    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('jump-page')">
      <span>{{ t('reader.menu.jump') }}</span>
    </button>

    <div class="my-1 h-px bg-white/10" />

    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('back')">
      <span>← {{ t('reader.menu.back') }}</span>
    </button>
  </div>
</template>
