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
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSlideshowStore } from '@/stores/slideshow';

interface Props {
  title: string;
  currentPage: number;
  totalPages: number;
  mode: 'single' | 'double';
  chromeVisible: boolean;
  /** 鼠标在 reader 容器内 (hover 时) — 控制轮播控制条显示 */
  hovered?: boolean;
}
const props = withDefaults(defineProps<Props>(), { hovered: false });

type Emits = {
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'toggle-mode'): void;
  (e: 'jump', page: number): void;
  (e: 'open-menu'): void;
};
const emit = defineEmits<Emits>();

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

/** 轮播控制条可见性: 播放中常驻, 或 hover 时显示 */
const showSlideshowControl = computed(() => slideshow.isPlaying || props.hovered);

/** 间隔 slider 当前值 (1-30s, 步长 0.5s) */
const intervalSeconds = computed(() => Math.round(slideshow.intervalMs / 1000));
</script>

<template>
  <div
    class="absolute inset-0 pointer-events-none flex flex-col justify-between text-text-primary select-none"
    data-test="overlay"
    data-test-ignore-touch-zones
  >
    <!-- 顶栏 -->
    <header v-if="chromeVisible" class="bg-black/60 backdrop-blur-md px-3 py-1.5 flex items-center gap-3 text-xs" data-test="overlay-top">
      <span class="flex-1 font-semibold truncate" data-test="title">{{ title }}</span>
      <span class="font-mono text-text-secondary tabular-nums" data-test="page-indicator">
        {{ currentPage }} / {{ totalPages }}
      </span>
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-white/10 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-mode"
        @click="emit('toggle-mode')"
      >
        {{ mode === 'single' ? t('reader.mode.single') : t('reader.mode.double') }}
      </button>
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-white/10 hover:text-text-primary transition-colors"
        data-test="btn-menu"
        :aria-label="t('reader.menu.title')"
        @click="emit('open-menu')"
      >
        ☰
      </button>
    </header>

    <!-- 轮播控制条 (独立 chrome) — 播放中常驻 / hover 时显示 -->
    <div
      v-if="showSlideshowControl"
      class="absolute bottom-12 left-1/2 -translate-x-1/2 pointer-events-auto
             bg-surface/80 backdrop-blur-xl border border-white/10 rounded-full
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

      <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />

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

      <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />

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

    <!-- 底栏 -->
    <footer v-if="chromeVisible" class="bg-black/60 backdrop-blur-md px-3 py-1.5 flex items-center gap-3 text-xs" data-test="overlay-bottom">
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-white/10 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-prev"
        :disabled="currentPage <= 1"
        @click="emit('prev')"
      >
        ← {{ t('reader.prev') }}
      </button>
      <form
        class="flex-1 flex items-center justify-center gap-2"
        data-test="jump-input"
        @submit="submitJump"
      >
        <label class="text-text-muted">{{ t('reader.jumpTo') }}</label>
        <input
          v-model.number="jumpValue"
          type="number"
          min="1"
          :max="totalPages"
          class="w-16 px-2 py-1 rounded bg-surface-1 border border-white/10 text-text-primary text-xs focus:outline-none focus:border-accent"
        />
        <button type="submit" class="px-2 py-1 rounded text-text-secondary hover:bg-white/10 hover:text-text-primary transition-colors">Go</button>
      </form>
      <button
        type="button"
        class="px-2 py-1 rounded text-text-secondary hover:bg-white/10 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-next"
        :disabled="currentPage >= totalPages"
        @click="emit('next')"
      >
        {{ t('reader.next') }} →
      </button>
    </footer>
  </div>
</template>
