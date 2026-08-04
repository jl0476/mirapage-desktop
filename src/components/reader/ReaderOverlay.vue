<script setup lang="ts">
/**
 * ReaderOverlay.vue — v0.1.0-module2.0 升级
 *
 * - 顶栏：标题 + 页码 + 模式切换 + 主菜单
 * - 底栏：上一页 / 下一页 / 跳页
 * - 轮播控制条 (slideshow-control): play/pause + 间隔 slider + 方向切换
 *   - 播放中常驻; 平时 hover ReaderScreen 时显示 2 秒后隐藏
 * - chromeVisible 控制 chrome; 轮播控制条独立 (由 slideshow.isPlaying 或 hovered 决定)
 * - 支持单页/双页模式 label 切换
 *
 * **数据来源**:
 * - 受控 props: title / currentPage / totalPages / mode / chromeVisible
 * - 自管: slideshow.isPlaying / intervalMs / direction (从 useSlideshowStore 拿)
 *
 * v0.1.0-module3.0.2-reader-polish:
 *  - Cluster B #5: pointer-events 修复 — 外层 div pointer-events-none,
 *    每个 button / input / form 加 pointer-events-auto, 让 click 穿透到 OSD canvas
 *    不被 overlay 容器拦截, 同时保证按钮仍可点.
 *  - Cluster B #8: chrome 随 slideshow.isPlaying 自动隐藏 — autoHide = isPlaying.
 *    hovered 时解除 autoHide 临时显示, 2s 后重新隐藏.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSlideshowStore } from '@/stores/slideshow';
import type { ScaleMode } from '@/lib/readerSettings';

interface Props {
  title: string;
  currentPage: number;
  totalPages: number;
  mode: 'single' | 'double';
  chromeVisible: boolean;
  /** 鼠标在 reader 容器内 (hover 时) — 控制轮播控制条显示 */
  hovered?: boolean;
  /** 当前缩放模式 (受控; 切换时 emit scale-change) */
  scaleMode?: ScaleMode;
}
const props = withDefaults(defineProps<Props>(), { hovered: false, scaleMode: 'fit-screen' });

type Emits = {
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'toggle-mode'): void;
  (e: 'jump', page: number): void;
  (e: 'back-to-list'): void;       // 原 open-menu 改名 (需求5)
  (e: 'scale-change', mode: ScaleMode): void;
};
const emit = defineEmits<Emits>();

/** 6 种缩放模式 (对齐 PV ScaleMenuRow) */
const SCALE_MODES: ScaleMode[] = [
  'fit-screen', 'fit-width', 'fit-height',
  'original', 'full-screen', 'stretch',
];

// 缩放下拉 (CLAUDE.md §1.3 三层结构 + click-outside)
const scaleOpen = ref(false);
const scaleDropdownRef = ref<HTMLElement | null>(null);

function onScaleSelect(m: ScaleMode): void {
  emit('scale-change', m);
  scaleOpen.value = false;
}

function onScaleMouseDown(e: MouseEvent): void {
  if (!scaleDropdownRef.value?.contains(e.target as Node)) scaleOpen.value = false;
}

const { t } = useI18n();
const slideshow = useSlideshowStore();

const jumpValue = ref<number>(0);

function submitJump(ev: Event) {
  ev.preventDefault();
  const target = Number(jumpValue.value);
  if (!Number.isFinite(target) || target < 1) return;
  emit('jump', Math.min(target, props.totalPages));
  jumpValue.value = 0;
}

async function onIntervalChange(ev: Event) {
  const ms = Number((ev.target as HTMLInputElement).value);
  await slideshow.updateIntervalMs(ms);
}

async function onDirectionToggle() {
  await slideshow.updateDirection(slideshow.direction === 'forward' ? 'backward' : 'forward');
}

/** Cluster B #8: autoHide = isPlaying. 播放时 chrome 全部隐藏, 避免遮挡. */
const autoHide = computed(() => slideshow.isPlaying);

/** hover 触发: props.hovered 变 true 时点亮 hoveredVisible, 2s 后重置 */
const hoveredVisible = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function flashOnHover(): void {
  hoveredVisible.value = true;
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoveredVisible.value = false; }, 2000);
}

watch(() => props.hovered, (v) => {
  if (v) flashOnHover();
});

onMounted(() => document.addEventListener('mousedown', onScaleMouseDown));
onUnmounted(() => {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  document.removeEventListener('mousedown', onScaleMouseDown);
});

/** Cluster B #8: chrome 可见 = chromeVisible && !autoHide && (hovered || hoveredVisible) */
const chromeShow = computed(() =>
  props.chromeVisible && !autoHide.value && (props.hovered || hoveredVisible.value)
);

/** 轮播控制条: 播放中常驻, 或 hovered/hoveredVisible. (Cluster B #8 与 chrome 一起隐藏但保留显示语义) */
const slideshowControlShow = computed(() =>
  slideshow.isPlaying || props.hovered || hoveredVisible.value
);

/** 间隔 slider 当前值 (1-30s, 步长 0.5s) */
const intervalSeconds = computed(() => Math.round(slideshow.intervalMs / 1000));
</script>

<template>
  <div
    class="absolute inset-0 pointer-events-none flex flex-col justify-between text-text-primary select-none"
    data-test="overlay"
    data-test-ignore-touch-zones
  >
    <!-- 顶栏 (Cluster B #5 pointer-events-auto + #8 chromeShow 替换 chromeVisible) -->
    <header v-if="chromeShow" class="bg-black/40 backdrop-blur-xl px-3 py-1.5 flex items-center gap-3 text-xs pointer-events-auto mix-blend-difference" data-test="overlay-top">
      <span class="flex-1 font-semibold truncate mix-blend-difference" data-test="title">{{ title }}</span>
      <span class="font-mono text-text-secondary tabular-nums mix-blend-difference" data-test="page-indicator">
        {{ currentPage }} / {{ totalPages }}
      </span>
      <div class="relative" ref="scaleDropdownRef">
        <button
          type="button"
          class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="scale-trigger"
          :aria-label="t('reader.menu.scale')"
          @click="scaleOpen = !scaleOpen"
        >
          {{ props.scaleMode }}
        </button>
        <div
          v-if="scaleOpen"
          class="absolute right-0 top-full z-50 mt-1 min-w-[170px] bg-surface-4 border border-white/10 rounded-lg py-1 shadow-xl backdrop-blur-xl"
        >
          <button
            v-for="m in SCALE_MODES"
            :key="m"
            type="button"
            class="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-surface-light"
            :class="m === props.scaleMode ? 'text-accent' : 'text-text-secondary'"
            data-test="scale-option"
            @click="onScaleSelect(m)"
          >
            <span>{{ m }}</span>
          </button>
        </div>
      </div>
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-mode"
        @click="emit('toggle-mode')"
      >
        {{ mode === 'single' ? t('reader.mode.single') : t('reader.mode.double') }}
      </button>
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors mix-blend-difference"
        data-test="btn-back"
        :aria-label="t('reader.menu.back')"
        @click="emit('back-to-list')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
    </header>

    <!-- 轮播控制条 (Cluster B #8: 跟随 isPlaying/hover, #5 pointer-events-auto 已存在) -->
    <div
      v-if="slideshowControlShow"
      class="absolute bottom-12 left-1/2 -translate-x-1/2 pointer-events-auto
             bg-surface/80 backdrop-blur-xl xp-bd rounded-full
             px-3 py-1.5 flex items-center gap-2 text-xs shadow-xl"
      data-test="slideshow-control"
      role="toolbar"
      :aria-label="t('slideshow.control')"
    >
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors flex items-center gap-1"
        :class="{ 'text-accent': slideshow.isPlaying }"
        data-test="slideshow-toggle"
        :aria-label="slideshow.isPlaying ? t('slideshow.pause') : t('slideshow.play')"
        @click="slideshow.toggle()"
      >
        <svg v-if="slideshow.isPlaying" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 5v14l12-7z" />
        </svg>
        <span>{{ slideshow.isPlaying ? t('slideshow.pause') : t('slideshow.play') }}</span>
      </button>

      <span class="xp-divider-v shrink-0" aria-hidden="true" />

      <span class="text-text-muted">{{ t('slideshow.interval') }}</span>
      <input
        type="range"
        class="w-20 accent-accent cursor-pointer"
        min="1"
        max="30"
        step="1"
        :value="intervalSeconds"
        data-test="slideshow-interval"
        :aria-label="t('slideshow.interval')"
        @change="onIntervalChange"
      />
      <span class="font-mono text-text-secondary tabular-nums w-8 text-right">{{ intervalSeconds }}s</span>

      <span class="xp-divider-v shrink-0" aria-hidden="true" />

      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
        data-test="slideshow-direction"
        :aria-label="t('slideshow.direction')"
        @click="onDirectionToggle"
      >
        <svg v-if="slideshow.direction === 'forward'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
      </button>
    </div>

    <!-- 底栏 (Cluster B #5/#8: pointer-events-auto + chromeShow) -->
    <footer v-if="chromeShow" class="bg-black/40 backdrop-blur-xl px-3 py-1.5 flex items-center gap-3 text-xs pointer-events-auto mix-blend-difference" data-test="overlay-bottom">
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-prev"
        :disabled="currentPage <= 1"
        @click="emit('prev')"
      >
        ← {{ t('reader.prev') }}
      </button>
      <form
        class="flex-1 flex items-center justify-center gap-2 pointer-events-auto"
        data-test="jump-input"
        @submit="submitJump"
      >
        <label class="text-text-muted">{{ t('reader.jumpTo') }}</label>
        <input
          v-model.number="jumpValue"
          type="number"
          min="1"
          :max="totalPages"
          class="w-16 px-2 py-1 rounded bg-surface-1 xp-bd text-text-primary text-xs focus:outline-none focus:border-accent"
        />
        <button type="submit" class="px-2 py-1 rounded text-text-secondary hover:bg-white/10 hover:text-text-primary transition-colors">Go</button>
      </form>
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-next"
        :disabled="currentPage >= totalPages"
        @click="emit('next')"
      >
        {{ t('reader.next') }} →
      </button>
    </footer>
  </div>
</template>
