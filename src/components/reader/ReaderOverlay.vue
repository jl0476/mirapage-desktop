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
 *
 * v0.1.0-reader-review-fix-3:
 *  - **彻底改 chrome 配色策略**: 弃用 mix-blend-difference (在各种底图色上表现都不稳).
 *    改用 bg-surface/90 backdrop-blur-xl (实色 + 模糊): 在 dark theme 下 chrome 是
 *    半透深蓝紫 + 模糊, text-text-primary 白字始终可读. light theme 自动切浅色.
 *  - 间隔 slider @change → @input (实时跟手)
 *  - 缩放下拉 border-white/10 → xp-bd
 *  - 缩放下拉加 role="menu" + aria-haspopup/expanded
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import type { ScaleMode } from '@/lib/readerSettings';

interface Props {
  title: string;
  currentPage: number;
  totalPages: number;
  mode: 'single' | 'double' | 'webtoon';
  chromeVisible: boolean;
  /** v0.1.0-reader-review-fix-13: 鼠标 hover 状态 (父级控制, 同步给 watermark) */
  hovered: boolean;
  /** v0.1.0-reader-review-fix-13: 2s timer 后的悬停态 (鼠标移开 2s 内仍 visible) */
  hoveredVisible?: boolean;
  /** 鼠标在 reader 容器内 (hover 时) — 控制轮播控制条显示 */
  hoveredLegacy?: boolean;
  /** 当前缩放模式 (受控; 切换时 emit scale-change) */
  scaleMode?: ScaleMode;
}
const props = withDefaults(defineProps<Props>(), { hoveredLegacy: false, scaleMode: 'fit-screen', hoveredVisible: false });

type Emits = {
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'toggle-mode'): void;
  (e: 'jump', page: number): void;
  (e: 'back-to-list'): void;       // 原 open-menu 改名 (需求5)
  (e: 'open-main-menu'): void;     // 需求4: chrome 完整菜单按钮 → 唤出 ReaderMainMenu
  (e: 'scale-change', mode: ScaleMode): void;
  (e: 'chrome-hover-enter'): void;   // v0.1.0-reader-review-fix-7: chrome 自身 hover 维持显示
  (e: 'chrome-hover-leave'): void;
};
const emit = defineEmits<Emits>();

/** 5 种缩放模式 (对齐 PV ScaleMenuRow; stretch 因 OSD uniform scale 不支持真拉伸已移除) */
const SCALE_MODES: ScaleMode[] = [
  'fit-screen', 'fit-width', 'fit-height',
  'original', 'full-screen',
];

/** enum 值 → i18n key: kebab ('fit-screen') → camel ('fitScreen') */
function scaleLabel(m: ScaleMode): string {
  const camel = m.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return t('reader.scale.' + camel);
}

// 缩放下拉 (CLAUDE.md §1.3 三层结构 + click-outside)
const scaleOpen = ref(false);
const scaleDropdownRef = ref<HTMLElement | null>(null);

function onScaleSelect(m: ScaleMode): void {
  emit('scale-change', m);
  scaleOpen.value = false;
}

function onScalePointerDown(e: PointerEvent): void {
  // pointerdown: OSD 开启 Pointer Events 时图像区域只发 pointerdown 不发 mousedown
  const t = e.target as Node | null;
  if (!scaleDropdownRef.value?.contains(t)) scaleOpen.value = false;
}

const { t } = useI18n();
const slideshow = useSlideshowStore();
const settings = useSettingsStore();
/** module3.5.4: webtoon 下胶囊栏的间隔控件替换为滚动速度（px/s），方向按钮隐藏 */
const isWebtoon = computed(() => props.mode === 'webtoon');

const jumpValue = ref<number>(0);

function submitJump(ev: Event) {
  ev.preventDefault();
  const target = Number(jumpValue.value);
  if (!Number.isFinite(target) || target < 1) return;
  emit('jump', Math.min(target, props.totalPages));
  jumpValue.value = 0;
}

async function onIntervalChange(ev: Event) {
  // @input 触发: 实时跟手同步, 拖动期间也写入 store. slider 范围 1-30 步长 1,
  // 每次 IPC 是简单的 setSetting('slideshow_interval_ms') + DB UPDATE, 桌面端可接受.
  const ms = Number((ev.target as HTMLInputElement).value) * 1000;
  await slideshow.updateIntervalMs(ms);
}

/** module3.5.4: 间隔直接输入（秒）——Enter/失焦提交，钳 1-30；非法输入回退当前值 */
async function commitIntervalInput(ev: Event): Promise<void> {
  const el = ev.target as HTMLInputElement;
  const n = Number(el.value);
  if (el.value === '' || !Number.isFinite(n)) {
    el.value = String(intervalSeconds.value);
    return;
  }
  await slideshow.updateIntervalMs(Math.max(1, Math.min(30, Math.round(n))) * 1000);
}

/** module3.5.4: webtoon 滚动速度（px/s，写持久化设置；滚轮临时倍率独立不碰） */
async function onSpeedChange(ev: Event): Promise<void> {
  await settings.setWebtoonScrollSpeed(Number((ev.target as HTMLInputElement).value));
}

/** module3.5.4: 速度直接输入——Enter/失焦提交；非法回退（store 内钳 10-300） */
async function commitSpeedInput(ev: Event): Promise<void> {
  const el = ev.target as HTMLInputElement;
  const n = Number(el.value);
  if (el.value === '' || !Number.isFinite(n)) {
    el.value = String(settings.webtoonScrollSpeed);
    return;
  }
  await settings.setWebtoonScrollSpeed(n);
}

async function onDirectionToggle() {
  await slideshow.updateDirection(slideshow.direction === 'forward' ? 'backward' : 'forward');
}

/** v0.1.0-reader-review-fix-13: chrome 默认隐藏, 仅 hovered / hoveredVisible 时显示.
 *  - hovered + hoveredVisible 都是 props (父级 ReaderScreen 控制 timer)
 *  - chromeVisible=false 仍然 override (父级控制)
 */
const chromeShow = computed(() => props.chromeVisible && (props.hovered || props.hoveredVisible));

/** 轮播控制条: 同 chrome 逻辑 */
const slideshowControlShow = computed(() => props.chromeVisible && (props.hovered || props.hoveredVisible));

/** 间隔 slider 当前值 (1-30s, 步长 0.5s) */
const intervalSeconds = computed(() => Math.round(slideshow.intervalMs / 1000));

onMounted(() => window.addEventListener('pointerdown', onScalePointerDown, true));
onUnmounted(() => window.removeEventListener('pointerdown', onScalePointerDown, true));
</script>

<template>
  <div
    class="absolute inset-0 pointer-events-none flex flex-col justify-between text-white select-none"
    data-test="overlay"
  >
    <!-- 顶栏 (fix-8: text-white + drop-shadow, 字号 text-sm) -->
    <header v-if="chromeShow" class="bg-surface/90 backdrop-blur-xl px-3 py-1.5 flex items-center gap-3 text-sm text-white pointer-events-auto shadow-lg" data-test="overlay-top" @mouseenter="emit('chrome-hover-enter')" @mouseleave="emit('chrome-hover-leave')">
      <span class="flex-1 font-semibold truncate" data-test="title">{{ title }}</span>
      <span class="font-mono tabular-nums" data-test="page-indicator">
        {{ currentPage }} / {{ totalPages }}
      </span>
      <div class="relative" ref="scaleDropdownRef">
        <button
          type="button"
          class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="scale-trigger"
          :aria-label="scaleLabel(props.scaleMode)"
          aria-haspopup="menu"
          :aria-expanded="scaleOpen"
          :disabled="mode === 'webtoon'"
          @click="scaleOpen = !scaleOpen"
        >
          {{ scaleLabel(props.scaleMode) }}
        </button>
        <div
          v-if="scaleOpen"
          class="absolute right-0 top-full z-50 mt-1 min-w-[170px] bg-surface-4 xp-bd rounded-lg py-1 shadow-xl backdrop-blur-xl isolate"
          role="menu"
        >
          <button
            v-for="m in SCALE_MODES"
            :key="m"
            type="button"
            class="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-surface-light hover:text-text-primary"
            :class="m === props.scaleMode ? 'text-accent' : 'text-text-secondary'"
            data-test="scale-option"
            role="menuitem"
            @click="onScaleSelect(m)"
          >
            <span>{{ scaleLabel(m) }}</span>
          </button>
        </div>
      </div>
      <button
        type="button"
        class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-mode"
        @click="emit('toggle-mode')"
      >
        {{ mode === 'webtoon' ? t('reader.mode.webtoon') : t('reader.mode.' + mode) }}
      </button>
      <button
        type="button"
        class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors"
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
      <button
        type="button"
        class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors"
        data-test="btn-menu"
        :aria-label="t('reader.menu.title')"
        @click="emit('open-main-menu')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </header>

    <!-- 轮播控制条 (fix-7: 自身 hover 维持显示) -->
    <div
      v-if="slideshowControlShow"
      class="absolute bottom-12 left-1/2 -translate-x-1/2 pointer-events-auto
             bg-surface/90 backdrop-blur-xl rounded-full
             px-3 py-1.5 flex items-center gap-2 text-sm text-white shadow-xl"
      data-test="slideshow-control"
      role="toolbar"
      :aria-label="t('slideshow.control')"
      @mouseenter="emit('chrome-hover-enter')"
      @mouseleave="emit('chrome-hover-leave')"
    >
      <button
        type="button"
        class="px-2 py-1 rounded hover:bg-surface-light hover:text-text-primary transition-colors flex items-center gap-1"
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

      <template v-if="!isWebtoon">
        <span>{{ t('slideshow.interval') }}</span>
        <input
          type="range"
          class="w-20 accent-accent cursor-pointer"
          min="1"
          max="30"
          step="1"
          :value="intervalSeconds"
          data-test="slideshow-interval"
          :aria-label="t('slideshow.interval')"
          @input="onIntervalChange"
        />
        <input
          type="number"
          min="1"
          max="30"
          class="w-12 px-1.5 py-0.5 rounded bg-surface-1 xp-bd text-text-primary text-xs text-center focus:outline-none focus:border-accent"
          data-test="slideshow-interval-input"
          :aria-label="t('slideshow.interval')"
          :value="intervalSeconds"
          @change="commitIntervalInput"
        />
        <span class="font-mono tabular-nums w-4 text-right">s</span>
      </template>
      <template v-else>
        <span>{{ t('slideshow.scrollSpeed') }}</span>
        <input
          type="range"
          class="w-20 accent-accent cursor-pointer"
          min="10"
          max="300"
          step="10"
          :value="settings.webtoonScrollSpeed"
          data-test="webtoon-speed"
          :aria-label="t('slideshow.scrollSpeed')"
          @input="onSpeedChange"
        />
        <input
          type="number"
          min="10"
          max="300"
          class="w-14 px-1.5 py-0.5 rounded bg-surface-1 xp-bd text-text-primary text-xs text-center focus:outline-none focus:border-accent"
          data-test="webtoon-speed-input"
          :aria-label="t('slideshow.scrollSpeed')"
          :value="settings.webtoonScrollSpeed"
          @change="commitSpeedInput"
        />
        <span class="font-mono tabular-nums text-xs">px/s</span>
      </template>

      <span class="xp-divider-v shrink-0" aria-hidden="true" />

      <button
        type="button"
        class="px-2 py-1 rounded hover:bg-surface-light hover:text-text-primary transition-colors"
        v-if="!isWebtoon"
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

    <!-- 底栏 (fix-8: text-white + shadow-lg) -->
    <footer v-if="chromeShow" class="bg-surface/90 backdrop-blur-xl px-3 py-1.5 flex items-center gap-3 text-sm text-white pointer-events-auto shadow-lg" data-test="overlay-bottom" @mouseenter="emit('chrome-hover-enter')" @mouseleave="emit('chrome-hover-leave')">
      <button
        type="button"
        class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
        <label>{{ t('reader.jumpTo') }}</label>
        <input
          v-model.number="jumpValue"
          type="number"
          min="1"
          :max="totalPages"
          class="w-16 px-2 py-1 rounded bg-surface-1 xp-bd text-text-primary text-xs focus:outline-none focus:border-accent"
        />
        <button type="submit" class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors">Go</button>
      </form>
      <button
        type="button"
        class="px-2 py-1 rounded text-white hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="btn-next"
        :disabled="currentPage >= totalPages"
        @click="emit('next')"
      >
        {{ t('reader.next') }} →
      </button>
    </footer>
  </div>
</template>