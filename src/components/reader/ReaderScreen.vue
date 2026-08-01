<script setup lang="ts">
/**
 * ReaderScreen.vue
 * 阅读器端到端整合：viewer + overlay + reader store 状态联动 + 输入绑定
 *
 * v0.1.0-module2.0: 接线 slideshow
 * - onMounted: slideshow.load() (从 settings 读 intervalMs/direction/loop)
 * - onUnmounted: slideshow.pause() + store.closeBook
 * - 任何翻页 (prev/next/jump) → slideshow.reset() (重启 timer)
 * - mouseenter/mouseleave 在容器上 → hovered state 控制轮播控制条显示
 *
 * Props 提供初始页表/spreads；openBook 在父路由/调用方完成后，
 * 阅读器只需 watch 翻页（reader.prevPage/nextPage/jumpToSpread）。
 *
 * 模式 ('single' | 'double')：
 * - 'single'：用 SinglePageViewer 显示当前 spread 首张图
 * - 'double'：用 DoublePageViewer 按 spreads 渲染
 *
 * 事件:
 * - back:用户返回文件浏览器
 * - toggle-mode:用户点模式切换(single↔double)
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { SpreadPlanner } from '@/lib/spreadPlanner';
import { log } from '@/lib/logger';
import SinglePageViewer from './SinglePageViewer.vue';
import DoublePageViewer from './DoublePageViewer.vue';
import ReaderOverlay from './ReaderOverlay.vue';

interface Props {
  title: string;
  pageUrls: string[];
  spreads?: Array<{ start: number; end: number }>;
  initialSpreadIndex?: number;
  mode?: 'single' | 'double';
}
const props = withDefaults(defineProps<Props>(), {
  spreads: undefined,
  initialSpreadIndex: 0,
  mode: 'single',
});

interface Emits {
  (e: 'back'): void;
  (e: 'toggle-mode'): void;
}
const emit = defineEmits<Emits>();

const store = useReaderStore();
const slideshow = useSlideshowStore();
const containerRef = ref<HTMLElement | null>(null);
const hovered = ref(false);

// 派生 spreads: 如果 props 没传,从 pageUrls + 默认 coverStandalone = true 算
const finalSpreads = computed(() => {
  if (props.spreads) return props.spreads;
  return SpreadPlanner.plan(props.pageUrls.length, true);
});

// 第一次 mount 时 openBook 一次 (ReaderView 通常已 open 过, 这是兜底)
onMounted(() => {
  log('[ReaderScreen] mount, store.bookId=', store.bookId, 'status=', store.status,
    'pages.length=', store.pages.length, 'spreads.length=', store.spreads.length);
  if (store.bookId === null) {
    log('[ReaderScreen] store not initialized, calling openBook fallback');
    store.openBook({
      bookId: store.bookId ?? 0,
      title: props.title,
      pages: props.pageUrls,
      spreads: finalSpreads.value,
      initialSpreadIndex: props.initialSpreadIndex,
    });
  }
});

// 父级 props 变化时 (mode 切换 / 跳页) 同步更新 store
watch(
  () => [props.mode, props.initialSpreadIndex],
  () => {
    if (props.initialSpreadIndex !== store.currentSpreadIndex) {
      store.jumpToSpread(props.initialSpreadIndex);
    }
  },
);

// 绑定键盘 / 鼠标 / 滚轮到 reader store
useReaderHotkeys();

onMounted(() => {
  void slideshow.load();
});

onUnmounted(() => {
  slideshow.pause();
});

// current page indicator
const currentPage = computed(() => {
  const spread = finalSpreads.value[store.currentSpreadIndex];
  return spread ? spread.start + 1 : 0;
});
const totalPages = computed(() => props.pageUrls.length);

// 单页模式只看 spread 首张图
const singlePageUrl = computed(() => {
  const idx = finalSpreads.value[store.currentSpreadIndex]?.start ?? 0;
  const url = props.pageUrls[idx] ?? '';
  log('[ReaderScreen] singlePageUrl', { idx, url, totalPages: props.pageUrls.length });
  return url;
});

function onPrev() {
  store.prevPage();
  slideshow.reset();
}
function onNext() {
  store.nextPage();
  slideshow.reset();
}
function onToggleMode() {
  emit('toggle-mode');
}
function onJump(page: number) {
  // 跳到该页所在的 spread
  const target = page - 1;
  const idx = SpreadPlanner.spreadIndexForPage(target, finalSpreads.value);
  store.jumpToSpread(idx);
  slideshow.reset();
}
function onBack() {
  emit('back');
}

function onContainerMouseEnter() {
  hovered.value = true;
}
function onContainerMouseLeave() {
  hovered.value = false;
}
</script>

<template>
  <div
    ref="containerRef"
    class="reader-screen relative w-full h-full overflow-hidden bg-black"
    data-test="reader-screen"
    @mouseenter="onContainerMouseEnter"
    @mouseleave="onContainerMouseLeave"
  >
    <!-- viewer -->
    <SinglePageViewer v-if="mode === 'single'" :image-url="singlePageUrl" />
    <DoublePageViewer
      v-else
      :page-urls="props.pageUrls"
      :spreads="finalSpreads"
      :current-spread-index="store.currentSpreadIndex"
    />

    <!-- overlay (隐藏 chrome 时不渲染; 轮播控制条独立 hover 控) -->
    <ReaderOverlay
      :title="props.title"
      :current-page="currentPage"
      :total-pages="totalPages"
      :mode="props.mode"
      :chrome-visible="store.chromeVisible"
      :hovered="hovered"
      @next="onNext"
      @prev="onPrev"
      @toggle-mode="onToggleMode"
      @jump="onJump"
      @open-menu="onBack"
    />
  </div>
</template>