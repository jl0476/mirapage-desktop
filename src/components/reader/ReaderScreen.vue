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
 *
 * v0.1.0-module3.0.2-reader-polish (Cluster C):
 *  - useReaderScale 接线: 单/双页 viewer 暴露 getBounds, 父级 setScaleMode
 *    触发 watcher 调 applyScale.
 *  - 当前 spread 切换 (prev/next/jump) → 重 apply 当前 scale (因为 OSD
 *    viewport 在新图加载后还在用旧 transform).
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useReaderScale, type OSDViewerLike } from '@/composables/useReaderScale';
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
const settings = useSettingsStore();
const containerRef = ref<HTMLElement | null>(null);
const hovered = ref(false);
const singleViewerRef = ref<InstanceType<typeof SinglePageViewer> | null>(null);
const doubleViewerRef = ref<InstanceType<typeof DoublePageViewer> | null>(null);

/** Cluster C: useReaderScale — 监听 settings.currentScaleMode 变化 → applyScale
 *  viewerRef 通过 ref 函数从 SinglePageViewer / DoublePageViewer 拿.
 *  注: mode 必须是可写 ref (settings 字段直接 ref, computed 是 readonly). */
const scaleViewerRef = ref<OSDViewerLike | null>(null);
const scaleModeRef = ref(settings.currentScaleMode);
// 同步 settings.currentScaleMode → scaleModeRef, 让 useReaderScale watcher 触发
watch(() => settings.currentScaleMode, (m) => { scaleModeRef.value = m; });
useReaderScale({ viewerRef: scaleViewerRef, mode: scaleModeRef });

/** Cluster C: 翻页后重 apply 当前 scale (新图加载完 OSD viewport 还在旧 transform) */
watch(
  () => store.currentSpreadIndex,
  () => {
    // 让子组件暴露 viewer 之后下一 tick 重 apply
    setTimeout(() => {
      const newViewer = props.mode === 'single'
        ? singleViewerRef.value && typeof (singleViewerRef.value as { getViewer?: () => OSDViewerLike | null }).getViewer === 'function'
          ? (singleViewerRef.value as { getViewer: () => OSDViewerLike | null }).getViewer()
          : null
        : null;  // double mode 通过 getBounds 间接应用 (未来扩展)
      if (newViewer) {
        scaleViewerRef.value = newViewer;
        // 触发 watcher 重 apply (直接写 modeRef.value 会触发)
        const cur = scaleModeRef.value;
        scaleModeRef.value = 'fit-screen';
        scaleModeRef.value = cur;
      }
    }, 50);
  },
);

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

// v0.1.0-module3.0.2-reader-polish (Cluster C):
// singleViewerRef 挂上后, 让 scaleViewerRef = getViewer() 触发 useReaderScale watcher
watch(singleViewerRef, (el) => {
  if (el && typeof (el as { getViewer?: () => OSDViewerLike | null }).getViewer === 'function') {
    const viewer = (el as { getViewer: () => OSDViewerLike | null }).getViewer();
    if (viewer) {
      scaleViewerRef.value = viewer;
      // 触发初始 apply
      const cur = scaleModeRef.value;
      scaleModeRef.value = 'fit-screen';
      scaleModeRef.value = cur;
    }
  }
}, { flush: 'post' });

watch(doubleViewerRef, (el) => {
  // 双页模式: 通过 getBounds 计算 (但 useReaderScale 需要 viewer 实例)
  // 简化: 暂不支持双页 scale, 仅单页生效 (Cluster C #6 范围限定)
  if (el) log('[ReaderScreen] double viewer mounted, scale not applied (Cluster C #6: single-only)');
}, { flush: 'post' });

// 父级 props 变化时 (mode 切换 / 跳页) 同步更新 store
watch(
  () => [props.mode, props.initialSpreadIndex],
  () => {
    if (props.initialSpreadIndex !== store.currentSpreadIndex) {
      store.jumpToSpread(props.initialSpreadIndex);
    }
  },
);

// v0.1.0-module3.0.2 (H3): useReaderHotkeys 已在 ReaderView 调一次, 此处删除避免双注册
// (window.addEventListener 重复挂载 → 一次按键触发两次 nextPage)
// 单/双页 viewer mount / unmount 各自 OSD 初始化与 destroy 不依赖 hotkey
// 翻页/跳页绑定 reader store action 即可 (singlePageUrl/currentPage computed)

onMounted(() => {
  // v0.1.0-module3.0.2 (H2): 注入 slideshow 翻页回调
  // store 内部 setInterval 触发 tick 时, 实际执行 reader store action
  slideshow.setAdvance(() => store.nextPage());
  slideshow.setPrev(() => store.prevPage());
  slideshow.setIsAtLast(() => store.isAtLastSpread);
  void slideshow.load();
});

onUnmounted(() => {
  slideshow.pause();
  // v0.1.0-module3.0.2-hotfix1 (N1): 复位 callbacks 避免闭包泄漏
  // 闭包捕获本组件内的 `store` 引用, 跨路由后 store 不会自动清,
  // 下次 slideshow.start() 仍会调旧 store.nextPage (Pinia 模块单例).
  // 复位成 noop 让 schedule 内部 setInterval 不再触发坏闭包.
  slideshow.setAdvance(() => undefined);
  slideshow.setPrev(() => undefined);
  slideshow.setIsAtLast(() => false);
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
    <!-- viewer (Cluster C: 单页用 ref, 双页用 ref) -->
    <SinglePageViewer
      v-if="mode === 'single'"
      :ref="(el: unknown) => { singleViewerRef = el as InstanceType<typeof SinglePageViewer> | null }"
      :image-url="singlePageUrl"
    />
    <DoublePageViewer
      v-else
      :ref="(el: unknown) => { doubleViewerRef = el as InstanceType<typeof DoublePageViewer> | null }"
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
      :scale-mode="settings.currentScaleMode"
      @next="onNext"
      @prev="onPrev"
      @toggle-mode="onToggleMode"
      @jump="onJump"
      @back-to-list="onBack"
      @scale-change="(m) => settings.setScaleMode(m)"
    />
  </div>
</template>