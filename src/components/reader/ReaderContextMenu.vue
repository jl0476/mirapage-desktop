<script setup lang="ts">
/**
 * ReaderContextMenu.vue — 阅读器右键轻量上下文菜单（需求4）
 * 参照 RowContextMenu dropdown 风格。项：
 *   缩放(子菜单) / 模式 / 方向 / 幻灯片 / 跳页 / 返回
 * 点击空白或 ESC 关闭。
 *
 * v0.1.0-reader-review fixes:
 *  - mode/direction/scale 走 t() (CLAUDE.md §2.5)
 *  - border-white/10 → xp-bd (light 模式可见)
 *  - bg-white/10 分隔 → xp-divider-h
 *  - slideshow.control (工具栏名) → slideshow.toggle (动作动词)
 *  - 子菜单加 role="menu" + Escape 关闭
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

/** enum 值 → i18n key: kebab ('fit-screen') → camel ('fitScreen') */
function scaleLabel(m: ScaleMode): string {
  const camel = m.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return t('reader.scale.' + camel);
}

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
    class="fixed z-[1200] min-w-[180px] bg-surface-4 xp-bd rounded-lg py-1 shadow-xl backdrop-blur-xl"
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
        :aria-haspopup="'menu'"
        :aria-expanded="scaleOpen"
      >
        <span>{{ t('reader.menu.scale') }}</span>
        <span class="text-text-muted">{{ scaleLabel(props.scaleMode) }}</span>
      </button>
      <div
        v-if="scaleOpen"
        class="absolute left-full top-0 ml-1 min-w-[150px] bg-surface-4 xp-bd rounded-lg py-1 shadow-xl"
        role="menu"
        @click.stop
        @keydown.escape="scaleOpen = false"
      >
        <button
          v-for="m in SCALE_MODES"
          :key="m"
          class="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-surface-light"
          :class="m === props.scaleMode ? 'text-accent' : 'text-text-secondary'"
          data-test="ctx-scale-option"
          role="menuitem"
          @click.stop="onScaleSelect(m)"
        >{{ scaleLabel(m) }}</button>
      </div>
    </div>

    <div class="my-1 xp-divider-h" />

    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('cycle-mode')">
      <span>{{ t('reader.menu.mode') }}</span><span class="text-text-muted">{{ t('reader.mode.' + props.mode) }}</span>
    </button>
    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('cycle-direction')">
      <span>{{ t('reader.menu.direction') }}</span><span class="text-text-muted">{{ t('reader.direction.' + props.direction) }}</span>
    </button>
    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('toggle-slideshow')">
      <span>{{ t('slideshow.toggle') }}</span><span class="text-text-muted">{{ props.isSlideshowPlaying ? t('slideshow.pause') : t('slideshow.play') }}</span>
    </button>
    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('jump-page')">
      <span>{{ t('reader.menu.jump') }}</span>
    </button>

    <div class="my-1 xp-divider-h" />

    <button data-test="ctx-item" class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary" @click="onItemClick('back')">
      <span>← {{ t('reader.menu.back') }}</span>
    </button>
  </div>
</template>