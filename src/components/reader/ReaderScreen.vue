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
 *
 * v0.1.0-reader-review fixes:
 *  - 删除 (singleViewerRef.value as { getViewer?: ... }) 类型断言 —
 *    SinglePageViewer.vue defineExpose 已返回完整 OSDViewerLike 类型,
 *    直接 .value?.getViewer?.() 即可, 断言绕过 TS 检查不安全
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
import WebtoonViewer from './WebtoonViewer.vue';
import ReaderOverlay from './ReaderOverlay.vue';
import { descriptorId, type SourceDescriptor } from '@/lib/sourceDescriptor';

interface Props {
  title: string;
  pageUrls: string[];
  spreads?: Array<{ start: number; end: number }>;
  initialSpreadIndex?: number;
  mode?: 'single' | 'double' | 'webtoon';
  pageNames?: string[];
  descriptor?: SourceDescriptor;
  relPath?: string;
  webtoonMaxWidth?: number;
  webtoonGap?: number;
  pageOverride?: number | null;
  /** v0.1.0-reader-review-fix: 阅读方向 (传给 DoublePageViewer 用于 RTL 镜像) */
  direction?: 'ltr' | 'rtl';
}
const props = withDefaults(defineProps<Props>(), {
  spreads: undefined,
  initialSpreadIndex: 0,
  mode: 'single',
  direction: 'ltr',
});

interface Emits {
  (e: 'back'): void;
  (e: 'toggle-mode'): void;
  (e: 'open-main-menu'): void;
  (e: 'chrome-hover-enter'): void;
  (e: 'chrome-hover-leave'): void;
  (e: 'scroll'): void;
  (e: 'wheel-delta', deltaY: number): void;
  (e: 'zoom-change', zoom: number): void;
  (e: 'scroll-past-bottom'): void;
}
const emit = defineEmits<Emits>();

const store = useReaderStore();
const slideshow = useSlideshowStore();
const settings = useSettingsStore();
// v0.1.0-reader-review-fix-17: 异步预加载策略.
//  - 不在 watch (pageUrls/mode/spreadIndex) 同步触发预加载 (会与 OSD 当前图加载抢带宽)
//  - 而是在 OSD 'open' 事件后 (首图已加载并 paint 完), 父级监听 image-loaded 异步触发 lookahead
//  - 翻页时: OSD 加载新首图 → image-loaded → 再预加载新 ±2 范围
//  - 缓存张数: 5 spread × 单页 1 张 / 双页 2 张 = 5-10 张 (单页 ~40MB, 双页 ~80MB)
const PRELOAD_RANGE = 2;

function preloadSpreadRange(): void {
  const total = props.pageUrls.length;
  if (total === 0) return;
  const singlePage = settings.readerDefaultMode === 'single';
  const spreads = SpreadPlanner.plan(total, true, singlePage);
  const idx = store.currentSpreadIndex;
  const startIdx = Math.max(0, idx - PRELOAD_RANGE);
  const endIdx = Math.min(spreads.length - 1, idx + PRELOAD_RANGE);
  let count = 0;
  for (let s = startIdx; s <= endIdx; s++) {
    const spread = spreads[s];
    if (!spread) continue;
    for (let p = spread.start; p < spread.end && p < total; p++) {
      const url = props.pageUrls[p];
      if (!url) continue;
      // fix-19: img.decode() 提前 async decode (浏览器 Image decode 在主线程同步,
      // 不 await decode 会让 OSD.open 时同步 decode → 阻塞 UI → "卡住".
      // decode() 返回 Promise, 不阻塞主线程, decode 完后图片已 decoded.
      // OSD.open 时图已 decoded → drawImage 几乎 instant, 无卡顿.
      const img = new Image();
      img.src = url;
      img.decode().catch(() => undefined);
      count++;
    }
  }
  log('[ReaderScreen/preload] preloaded', count, 'images around spread', idx);
}

/** OSD 首图加载完后 (image-loaded emit), 延迟 100ms 让 paint 完成, 再触发 lookahead */
function onFirstImageLoaded(): void {
  setTimeout(() => {
    log('[ReaderScreen] first image loaded, start async preload lookahead');
    preloadSpreadRange();
  }, 100);
}

const containerRef = ref<HTMLElement | null>(null);
const hovered = ref(false);
const singleViewerRef = ref<InstanceType<typeof SinglePageViewer> | null>(null);
const doubleViewerRef = ref<InstanceType<typeof DoublePageViewer> | null>(null);
const webtoonViewerRef = ref<InstanceType<typeof WebtoonViewer> | null>(null);

/** Parent-facing webtoon controls. WebtoonViewer expose values are getters (proxyRefs). */
function getWebtoonViewer(): InstanceType<typeof WebtoonViewer> | null {
  return webtoonViewerRef.value;
}
defineExpose({ getWebtoonViewer });

// v0.1.0-reader-review-fix-7: chrome hover 仅由 trigger zone + chrome 自身控制.
// 之前容器 mouseenter/mouseleave 太宽 (整个 reader 都触发), 用户希望只在
// chrome/slideshow 区域 hover 才显示. 现在 trigger zone 顶/底各 40px (v-if="!hovered"
// 让 chrome 显示时消失, 避免遮挡按钮).
// fix-13: hoveredVisible 提升到 ReaderScreen 共享, 让 watermark 跟 chrome 同步 (避免重叠)
const hoveredVisible = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function flashOnHover(): void {
  hoveredVisible.value = true;
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoveredVisible.value = false; }, 2000);
}
function onTriggerEnter(): void { hovered.value = true; flashOnHover(); }
function onChromeHoverEnter(): void { hovered.value = true; flashOnHover(); }
function onChromeHoverLeave(): void {
  hovered.value = false;
  // 2s 内如果不再 hover, hoveredVisible 自动 false (timer 已设)
}

/** Cluster C: useReaderScale — 监听 settings.currentScaleMode 变化 → applyScale
 *  viewerRef 通过 ref 函数从 SinglePageViewer / DoublePageViewer 拿.
 *  注: mode 必须是可写 ref (settings 字段直接 ref, computed 是 readonly). */
const scaleViewerRef = ref<OSDViewerLike | null>(null);
const scaleModeRef = ref(settings.currentScaleMode);
// 同步 settings.currentScaleMode → scaleModeRef, 让 useReaderScale watcher 触发
watch(() => settings.currentScaleMode, (m) => { scaleModeRef.value = m; });
useReaderScale({ viewerRef: scaleViewerRef, mode: scaleModeRef, containerRef });

/** Cluster C: 翻页后重 apply 当前 scale (新图加载完 OSD viewport 还在旧 transform) */
watch(
  () => store.currentSpreadIndex,
  () => {
    // 让子组件暴露 viewer 之后下一 tick 重 apply
    setTimeout(() => {
      const newViewer = props.mode === 'single'
        ? singleViewerRef.value?.getViewer?.() ?? null
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
// singleViewerRef 挂上后, 让 scaleViewerRef = getViewer() 触发 useReaderScale watcher.
// v0.1.0-reader-review-fix: 加 retry 机制 — Vue 生命周期中 ref 函数可能在 child
// onMounted 之前调用, 此时 OSD viewer 变量未赋值. 轮询 getViewer 直到非 null.
let scaleViewerRetryTimer: ReturnType<typeof setTimeout> | null = null;
function trySetScaleViewerRef(el: InstanceType<typeof SinglePageViewer> | null, attempt: number = 0): void {
  if (!el) return;
  const viewer = el.getViewer?.() ?? null;
  if (viewer) {
    scaleViewerRef.value = viewer;
    // 触发初始 apply (用 toggle 触发 watch)
    const cur = scaleModeRef.value;
    scaleModeRef.value = 'fit-screen';
    scaleModeRef.value = cur;
    log('[ReaderScreen] scaleViewerRef set, attempt=', attempt);
  } else if (attempt < 30) {
    scaleViewerRetryTimer = setTimeout(() => trySetScaleViewerRef(el, attempt + 1), 50);
  } else {
    log('[ReaderScreen] getViewer still null after 30 attempts, give up');
  }
}
watch(singleViewerRef, (el) => {
  if (scaleViewerRetryTimer !== null) {
    clearTimeout(scaleViewerRetryTimer);
    scaleViewerRetryTimer = null;
  }
  trySetScaleViewerRef(el);
}, { flush: 'post' });

// v0.1.0-reader-review-fix: 双页模式支持 scale + getViewer
watch(doubleViewerRef, (el) => {
  if (!el) return;
  log('[ReaderScreen] double viewer mounted, set scaleViewerRef');
  // 双页 viewer 通过 getViewer() 暴露首个 page slot 的 OSD instance
  const viewer = (el as { getViewer?: () => unknown }).getViewer?.() ?? null;
  if (viewer) {
    scaleViewerRef.value = viewer as OSDViewerLike;
    const cur = scaleModeRef.value;
    scaleModeRef.value = 'fit-screen';
    scaleModeRef.value = cur;
  } else {
    // 重试 (子组件 SinglePageViewer onMounted 可能晚于父级 flush:post watcher)
    let attempt = 0;
    const retry = setInterval(() => {
      attempt++;
      const v = (el as { getViewer?: () => unknown }).getViewer?.() ?? null;
      if (v) {
        clearInterval(retry);
        scaleViewerRef.value = v as OSDViewerLike;
        const cur = scaleModeRef.value;
        scaleModeRef.value = 'fit-screen';
        scaleModeRef.value = cur;
        log('[ReaderScreen] double getViewer retry ok, attempt=', attempt);
      } else if (attempt > 30) {
        clearInterval(retry);
      }
    }, 50);
  }
}, { flush: 'post' });

// 父级 props 变化时 (mode 切换 / 跳页) 同步更新 store
watch(
  () => [props.mode, props.initialSpreadIndex],
  () => {
    log('[ReaderScreen] props watcher: mode=', props.mode, 'initialSpreadIndex=', props.initialSpreadIndex, 'currentSpreadIndex=', store.currentSpreadIndex);
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
  slideshow.setAdvance(() => {
    if (props.mode !== 'webtoon') store.nextPage();
  });
  slideshow.setPrev(() => {
    if (props.mode !== 'webtoon') store.prevPage();
  });
  slideshow.setIsAtLast(() => props.mode === 'webtoon' ? false : store.isAtLastSpread);
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
  if (props.mode === 'webtoon') return (props.pageOverride ?? 0) + 1;
  const spread = finalSpreads.value[store.currentSpreadIndex];
  return spread ? spread.start + 1 : 0;
});
const totalPages = computed(() => props.pageUrls.length);

const webtoonKey = computed(() => {
  const descriptor = props.descriptor;
  const id = descriptor ? descriptorId(descriptor) : 'unknown';
  return `webtoon-${id}|${props.relPath ?? ''}`;
});

// 单页模式只看 spread 首张图
const singlePageUrl = computed(() => {
  const idx = finalSpreads.value[store.currentSpreadIndex]?.start ?? 0;
  const url = props.pageUrls[idx] ?? '';
  log('[ReaderScreen] singlePageUrl', { idx, url, totalPages: props.pageUrls.length });
  return url;
});

function scrollByScreen(dir: 1 | -1): void {
  const el = webtoonViewerRef.value?.getScrollEl();
  if (!el) return;
  el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: 'auto' });
}
function onPrev() {
  if (props.mode === 'webtoon') { scrollByScreen(-1); return; }
  store.prevPage();
  slideshow.reset();
}
function onNext() {
  if (props.mode === 'webtoon') {
    // 底部再点 ▶ = 翻页模型的「末页再翻」：转发 scroll-past-bottom 走跨卷链，
    // 否则是死按钮（scrollBy 被钳位无效果）——审查建议 #2。
    if (webtoonViewerRef.value?.isAtBottom()) { emit('scroll-past-bottom'); return; }
    scrollByScreen(1);
    return;
  }
  store.nextPage();
  slideshow.reset();
}
function onToggleMode() {
  emit('toggle-mode');
}
function onJump(page: number) {
  if (props.mode === 'webtoon') {
    const pageNames = props.pageNames ?? [];
    const clamped = Math.max(0, Math.min(page - 1, pageNames.length - 1));
    const name = pageNames[clamped];
    if (name) webtoonViewerRef.value?.scrollToImage(name);
    return;
  }
  // 跳到该页所在的 spread
  const target = page - 1;
  const idx = SpreadPlanner.spreadIndexForPage(target, finalSpreads.value);
  store.jumpToSpread(idx);
  slideshow.reset();
}
function onBack() {
  emit('back');
}

function onContainerMouseEnter(): void {
  // 保留但不做任何事 (fix-7: hover 由 trigger zone 控制, 不靠容器整体)
}
function onContainerMouseLeave(): void {
  hovered.value = false;
}
</script>

<template>
  <div
    ref="containerRef"
    class="reader-screen relative w-full h-full overflow-hidden bg-black text-white"
    data-test="reader-screen"
    @mouseenter="onContainerMouseEnter"
    @mouseleave="onContainerMouseLeave"
  >
    <!-- viewer (Cluster C: 单页用 ref, 双页用 ref; v0.1.0-reader-review-fix: 加 :key 强制 re-mount on mode change) -->
    <!-- v0.1.0-reader-review-fix-12: KeepAlive 缓存 viewer, mode 切换不重建 OSD -->
    <KeepAlive>
      <SinglePageViewer
        v-if="mode === 'single'"
        :key="`single-${mode}`"
        :ref="(el: unknown) => { singleViewerRef = el as InstanceType<typeof SinglePageViewer> | null }"
        :image-url="singlePageUrl"
        @image-loaded="onFirstImageLoaded"
      />
      <WebtoonViewer
        v-else-if="mode === 'webtoon' && descriptor"
        :key="webtoonKey"
        ref="webtoonViewerRef"
        :urls="props.pageUrls"
        :names="props.pageNames ?? []"
        :descriptor="descriptor"
        :rel-path="props.relPath ?? ''"
        :max-width="props.webtoonMaxWidth"
        :gap="props.webtoonGap"
        @scroll="emit('scroll')"
        @wheel-delta="(delta) => emit('wheel-delta', delta)"
        @zoom-change="(zoom) => emit('zoom-change', zoom)"
        @scroll-past-bottom="emit('scroll-past-bottom')"
      />
      <DoublePageViewer
        v-else-if="mode === 'double'"
        :key="`double-${mode}`"
        :ref="(el: unknown) => { doubleViewerRef = el as InstanceType<typeof DoublePageViewer> | null }"
        :page-urls="props.pageUrls"
        :spreads="finalSpreads"
        :current-spread-index="store.currentSpreadIndex"
        :direction="props.direction"
        @image-loaded="onFirstImageLoaded"
      />
    </KeepAlive>

    <!-- overlay (隐藏 chrome 时不渲染; 轮播控制条独立 hover 控) -->
    <ReaderOverlay
      :title="props.title"
      :current-page="currentPage"
      :total-pages="totalPages"
      :mode="props.mode"
      :chrome-visible="store.chromeVisible"
      :hovered="hovered"
      :hovered-visible="hoveredVisible"
      :scale-mode="settings.currentScaleMode"
      @next="onNext"
      @prev="onPrev"
      @toggle-mode="onToggleMode"
      @jump="onJump"
      @back-to-list="onBack"
      @open-main-menu="emit('open-main-menu')"
      @scale-change="(m) => settings.setScaleMode(m)"
      @chrome-hover-enter="onChromeHoverEnter"
      @chrome-hover-leave="onChromeHoverLeave"
    />

    <!-- v0.1.0-reader-review-fix-7: 屏幕顶/底 trigger zone (各 40px).
         fix-8: v-if="!hovered" 让 chrome 显示时 trigger zone 消失 (避免遮挡按钮).
         默认 (hovered=false) trigger zone 存在 → mouseenter 触发 hovered=true → 显示 chrome;
         trigger zone 此时被 v-if 移除, 鼠标移到 chrome (已经在屏幕顶部) → chrome-hover-enter 维持. -->
    <div
      v-if="!hovered"
      class="absolute top-0 inset-x-0 h-10 z-30"
      data-test="trigger-zone-top"
      @mouseenter="onTriggerEnter"
    ></div>
    <div
      v-if="!hovered"
      class="absolute bottom-0 inset-x-0 h-10 z-30"
      data-test="trigger-zone-bottom"
      @mouseenter="onTriggerEnter"
    ></div>

    <!-- v0.1.0-reader-review-fix-11: watermark — chrome 隐藏时显示书名 + 页码.
         fix-13: 用 hoveredVisible 而非 !hovered, 与 chrome 显示同步
         (chrome 显示 = hovered || hoveredVisible; watermark 隐藏 = !(!hovered && !hoveredVisible))
         永远 pointer-events-none, 不拦截 OSD 点击 -->
    <div
      v-if="!hovered && !hoveredVisible"
      class="absolute top-3 inset-x-3 flex justify-between pointer-events-none text-xs text-white drop-shadow-md z-20"
      data-test="watermark"
    >
      <span class="font-semibold truncate" data-test="watermark-title">{{ props.title }}</span>
      <span class="font-mono tabular-nums shrink-0 ml-3" data-test="watermark-page">{{ currentPage }} / {{ totalPages }}</span>
    </div>
  </div>
</template>