<script setup lang="ts">
/**
 * ReaderScreen.vue
 * 阅读器端到端整合：viewer + overlay + reader store 状态联动 + 输入绑定
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
import { computed, watch } from 'vue';
import { useReaderStore } from '@/stores/reader';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { SpreadPlanner } from '@/lib/spreadPlanner';
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

// 派生 spreads: 如果 props 没传,从 pageUrls + 默认 coverStandalone = true 算
const finalSpreads = computed(() => {
  if (props.spreads) return props.spreads;
  return SpreadPlanner.plan(props.pageUrls.length, true);
});

watch(
  () => [props.title, props.pageUrls, props.spreads, props.initialSpreadIndex, props.mode],
  () => {
    store.openBook({
      bookId: store.bookId ?? 0,
      title: props.title,
      pages: props.pageUrls,
      spreads: finalSpreads.value,
      initialSpreadIndex: props.initialSpreadIndex,
    });
  },
  { immediate: true },
);

// 绑定键盘 / 鼠标 / 滚轮到 reader store
useReaderHotkeys();

// current page indicator
const currentPage = computed(() => {
  const spread = finalSpreads.value[store.currentSpreadIndex];
  return spread ? spread.start + 1 : 0;
});
const totalPages = computed(() => props.pageUrls.length);

// 单页模式只看 spread 首张图
const singlePageUrl = computed(() => {
  const idx = finalSpreads.value[store.currentSpreadIndex]?.start ?? 0;
  return props.pageUrls[idx] ?? '';
});

function onPrev() {
  store.prevPage();
}
function onNext() {
  store.nextPage();
}
function onToggleMode() {
  emit('toggle-mode');
}
function onJump(page: number) {
  // 跳到该页所在的 spread
  const target = page - 1;
  const idx = SpreadPlanner.spreadIndexForPage(target, finalSpreads.value);
  store.jumpToSpread(idx);
}
function onBack() {
  emit('back');
}
</script>

<template>
  <div class="reader-screen">
    <!-- viewer -->
    <SinglePageViewer v-if="mode === 'single'" :image-url="singlePageUrl" />
    <DoublePageViewer
      v-else
      :page-urls="props.pageUrls"
      :spreads="finalSpreads"
      :current-spread-index="store.currentSpreadIndex"
    />

    <!-- overlay (隐藏 chrome 时不渲染) -->
    <ReaderOverlay
      :title="props.title"
      :current-page="currentPage"
      :total-pages="totalPages"
      :mode="props.mode"
      :chrome-visible="store.chromeVisible"
      @next="onNext"
      @prev="onPrev"
      @toggle-mode="onToggleMode"
      @jump="onJump"
      @open-menu="onBack"
    />
  </div>
</template>

<style scoped>
.reader-screen {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #000;
}
</style>