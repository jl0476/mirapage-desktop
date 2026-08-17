<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
import { autoScrollDelta, captureAnchor, clampZoom, computeLayout, restoreAnchor, topVisibleIndex, visibleWindow } from '@/lib/webtoonLayout';
import { useWebtoonDimensions } from '@/composables/useWebtoonDimensions';

const props = withDefaults(defineProps<{
  urls: string[]; names: string[]; descriptor: SourceDescriptor; relPath: string; maxWidth?: number; gap?: number;
}>(), { maxWidth: 0, gap: 0 });
const emit = defineEmits<{
  (e: 'scroll-past-bottom'): void; (e: 'scroll'): void; (e: 'wheel-delta', deltaY: number): void; (e: 'zoom-change', z: number): void;
}>();
const scrollEl = ref<HTMLElement | null>(null); const scrollTop = ref(0); const viewportHeight = ref(600); const containerWidth = ref(800);
const zoom = ref(1); let lastNonUnityZoom = 2;
let pendingAnchor: ReturnType<typeof captureAnchor> = null;
const baseWidth = computed(() => { const w = containerWidth.value > 0 ? containerWidth.value : 800; return props.maxWidth > 0 ? Math.min(w, props.maxWidth) : w; });
const { measuredMap, ensureRange } = useWebtoonDimensions(computed(() => props.descriptor), computed(() => props.names), computed(() => props.relPath), {
  onBeforeApply: () => { if (scrollTop.value > 0) pendingAnchor = captureAnchor(layout.value, scrollTop.value); },
});
const layout = computed(() => computeLayout(props.names, measuredMap.value, baseWidth.value * zoom.value, props.gap));
let activeCorrection: { finish: () => void } | null = null;
watch(measuredMap, () => { if (activeCorrection) { pendingAnchor = null; return; } if (!pendingAnchor) return; const y = restoreAnchor(layout.value, pendingAnchor); pendingAnchor = null; if (y !== null && scrollEl.value && Math.abs(y - scrollEl.value.scrollTop) > .5) scrollEl.value.scrollTop = y; }, { flush: 'post' });
const windowRange = computed(() => visibleWindow(layout.value, scrollTop.value, viewportHeight.value));
const windowItems = computed(() => { const out: { name: string; url: string; top: number; height: number }[] = []; for (let i = windowRange.value.start; i < windowRange.value.end && i < props.names.length; i++) out.push({ name: props.names[i], url: props.urls[i], top: layout.value.tops[i], height: layout.value.heights[i] }); return out; });
const atBottom = computed(() => { const el = scrollEl.value; return !!el && scrollTop.value + viewportHeight.value >= layout.value.totalHeight - 4; });
function getTopVisibleImage() { return props.names[topVisibleIndex(layout.value, scrollTop.value)] ?? null; }
function scrollToImage(name: string): void {
  const target = () => { const i = props.names.indexOf(name); return i >= 0 ? layout.value.tops[i] : -1; }; let y = target(); if (y < 0 || !scrollEl.value) return;
  activeCorrection?.finish(); scrollEl.value.scrollTop = y; let count = 0; let done = false; const stopAt = Date.now() + 3000;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); un(); if (activeCorrection?.finish === finish) activeCorrection = null; };
  const un = watch(measuredMap, () => { if (done) return; if (count >= 5 || Date.now() > stopAt) return finish(); const ny = target(); if (ny >= 0 && ny !== y) { y = ny; count++; if (scrollEl.value) scrollEl.value.scrollTop = y; } if (count >= 5) finish(); });
  const timer = setTimeout(finish, 3000); activeCorrection = { finish };
}
let pendingZoomAnchor: { top: number; left: number; zoom: number; x: number; y: number; hasX: boolean } | null = null; let zoomRestoreScheduled = false;
function setZoom(value: number, anchorX?: number, anchorY?: number): void {
  const next = clampZoom(value); if (next === zoom.value) return; const el = scrollEl.value;
  if (el && anchorY !== undefined && !pendingZoomAnchor) pendingZoomAnchor = { top: el.scrollTop, left: el.scrollLeft, zoom: zoom.value, x: anchorX ?? 0, y: anchorY, hasX: anchorX !== undefined };
  zoom.value = next; if (next !== 1) lastNonUnityZoom = next; emit('zoom-change', next);
  if (pendingZoomAnchor && el && !zoomRestoreScheduled) { zoomRestoreScheduled = true; void nextTick(() => { zoomRestoreScheduled = false; const a = pendingZoomAnchor; pendingZoomAnchor = null; const target = scrollEl.value; if (!a || !target) return; const k = zoom.value / a.zoom; if (a.hasX) target.scrollLeft = (a.left + a.x) * k - a.x; target.scrollTop = (a.top + a.y) * k - a.y; }); }
}
function onWheel(e: WheelEvent): void { if (e.ctrlKey) { e.preventDefault(); const r = scrollEl.value?.getBoundingClientRect(); const d = e.deltaY < 0 ? 1.1 : 1 / 1.1; setZoom(zoom.value * d, r ? e.clientX - r.left : undefined, r ? e.clientY - r.top : undefined); return; } emit('wheel-delta', e.deltaY); if (e.deltaY > 0 && atBottom.value) emitBottom(); }
let lastBottom = 0; function emitBottom() { const n = Date.now(); if (n - lastBottom >= 800) { lastBottom = n; emit('scroll-past-bottom'); } }
function onDblclick(e: MouseEvent) { const r = scrollEl.value?.getBoundingClientRect(); const x = r ? e.clientX - r.left : undefined; const y = r ? e.clientY - r.top : undefined; setZoom(zoom.value === 1 ? lastNonUnityZoom : 1, x, y); }
function autoScrollStep(dt: number, speed: number, factor: number) { const el = scrollEl.value; if (el) el.scrollTop = Math.max(0, Math.min(el.scrollHeight, el.scrollTop + autoScrollDelta(speed, factor, dt))); }
function onScroll() { const el = scrollEl.value; if (!el) return; scrollTop.value = el.scrollTop; viewportHeight.value = el.clientHeight; containerWidth.value = el.clientWidth; emit('scroll'); }
let ro: ResizeObserver | null = null;
onMounted(() => { onScroll(); if (typeof ResizeObserver !== 'undefined' && scrollEl.value) { ro = new ResizeObserver(onScroll); ro.observe(scrollEl.value); } emit('zoom-change', zoom.value); void ensureRange(windowRange.value.start, windowRange.value.end); });
onUnmounted(() => ro?.disconnect());
watch(windowRange, r => void ensureRange(r.start, r.end));
defineExpose({ scrollToImage, getTopVisibleImage, isAtBottom: () => atBottom.value, setZoom, getZoom: () => zoom.value, autoScrollStep, getScrollEl: () => scrollEl.value });
</script>
<template><div ref="scrollEl" class="webtoon-scroll" @scroll.passive="onScroll" @wheel="onWheel" @dblclick="onDblclick"><div class="webtoon-strip" :style="{ width: (baseWidth * zoom) + 'px', height: layout.totalHeight + 'px' }"><div v-for="it in windowItems" :key="it.name" class="webtoon-item" :style="{ position: 'absolute', top: it.top + 'px', left: 0, width: '100%', height: it.height + 'px' }"><img :src="it.url" :alt="it.name" decoding="async" draggable="false" /></div></div></div></template>
<style scoped>.webtoon-scroll{height:100%;overflow:auto;background:var(--color-bg);scrollbar-width:none}.webtoon-scroll::-webkit-scrollbar{display:none}.webtoon-strip{position:relative;margin:0 auto}.webtoon-item img{display:block;width:100%;height:100%;object-fit:contain}</style>
