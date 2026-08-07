<script setup lang="ts">
// MasonryView.vue — 瀑布流视图容器
// 职责：管理 measuredMap、触发 header 预读、渲染可见区 MasonryRow。
// 复用 useVirtualList 的 containerRef/scroll/resize；布局由 useMasonryLayout 算。
import { ref, computed, watch, onMounted, onUnmounted, nextTick, toRef } from 'vue';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@/composables/useVirtualList';
import { useMasonryLayout, toRootRelativePath } from '@/composables/useMasonryLayout';
import { listImageDimensions } from '@/lib/tauri';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import MasonryRow from './MasonryRow.vue';
import type { MediaEntry, ReadStatusMap, SourceDescriptor } from '@/lib/sourceDescriptor';

interface Props {
  entries: MediaEntry[];
  marks: ReadStatusMap;
  selectedPaths: Set<string>;
  descriptor: SourceDescriptor;
  rootPath: string;
  currentPath: string;   // relPath, 拼图片绝对路径用
  colCount: number;
  hGap: number;
  vGap: number;
}
const props = defineProps<Props>();

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'row-click', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-dblclick', entry: MediaEntry, event: MouseEvent): void;
  (e: 'row-contextmenu', entry: MediaEntry, event: MouseEvent): void;
}>();

// useVirtualList 只为拿 containerRef/scrollTop/viewportHeight/ResizeObserver
// rowHeight 占位 1（实际布局由 useMasonryLayout 算，不用 visibleEntries）
const entriesRef = computed(() => props.entries);
const { containerRef, scrollTop, viewportHeight } = useVirtualList(entriesRef, { rowHeight: 1 });

const containerWidth = ref(0);
const measuredMap = ref<Map<string, { width: number; height: number }>>(new Map());

// ResizeObserver 拿 containerWidth
let ro: ResizeObserver | null = null;
onMounted(async () => {
  await nextTick();
  if (!containerRef.value) return;
  ro = new ResizeObserver(() => {
    if (containerRef.value) containerWidth.value = containerRef.value.clientWidth;
  });
  ro.observe(containerRef.value);
  containerWidth.value = containerRef.value.clientWidth || 1;
  // 首次预读
  triggerPrefetch();
});
onUnmounted(() => ro?.disconnect());

const { layout, visibleRange, needPrefetch, nextBatchPaths, prefetchPaths } = useMasonryLayout({
  entries: entriesRef,
  containerWidth,
  containerHeight: viewportHeight,
  colCount: toRef(props, 'colCount'),
  hGap: toRef(props, 'hGap'),
  vGap: toRef(props, 'vGap'),
  scrollTop,
  measuredMap,
});

// 预读 header
async function triggerPrefetch() {
  if (!needPrefetch.value) return;
  const relPaths = nextBatchPaths.value;
  if (relPaths.length === 0) return;
  try {
    // F1: entry.path 相对 currentPath(=lastFetchedPath); Rust read_file 期望相对 rootPath 的完整路径。
    // 拼 currentPath 前缀调 IPC; 返回的 dims.path 是 fullPath, 反查 relPath 作 measuredMap key
    // (与 entries e.path 一致, useMasonryLayout.inputs 用 e.path 查 measuredMap)。
    const fullByRel = new Map<string, string>();
    const fullPaths = relPaths.map((rp) => {
      const fp = toRootRelativePath(props.currentPath, rp);
      fullByRel.set(fp, rp);
      return fp;
    });
    const dims = await listImageDimensions(props.descriptor, fullPaths);
    const m = new Map(measuredMap.value);
    for (const d of dims) {
      const rel = fullByRel.get(d.path) ?? d.path;
      m.set(rel, { width: d.width, height: d.height });
    }
    measuredMap.value = m;
  } catch (e) {
    log('[MasonryView] prefetch failed', e);
  }
}
watch(needPrefetch, () => { void triggerPrefetch(); });

// 图片字节预读: 视口前后 2 屏行的图用 new Image() 提前 fetch + decode 进浏览器缓存,
// 滚动到时 <img> 命中缓存, 无网络+解码延迟 (对齐阅读器 preload 策略)。
// 注意: Image() 不挂 DOM, 浏览器 fetch+decode 后缓存, GC 回收 Image 对象。
const prefetchedSet = new Set<string>();
function prefetchImage(path: string): void {
  if (prefetchedSet.has(path)) return;
  const e = props.entries.find((en) => en.path === path);
  if (!e || !isImage(e.name)) return;
  prefetchedSet.add(path);
  const baseDir = joinPath(props.rootPath, props.currentPath);
  const url = convertFileSrc(joinPath(baseDir, e.name));
  const img = new Image();
  img.src = url;
}
watch(prefetchPaths, (paths) => {
  for (const p of paths) prefetchImage(p);
});

// 路径拼接（Windows \ 分隔符，ReaderView.joinPath 模式）
function joinPath(...parts: string[]): string {
  const cleaned = parts.filter((s) => s && s.length > 0).map((s) => s.replace(/[\\/]+$/, ''));
  return cleaned.join('\\');
}

// mark 查找：${rootPath}|${entry.path} 格式（readStatus 实际格式）
function getMark(entry: MediaEntry): 'reading' | 'finished' | 'none' {
  const key = `${props.rootPath}|${entry.path}`;
  const v = props.marks[key];
  if (v === 'reading') return 'reading';
  if (v === 'finished') return 'finished';
  return 'none';
}

// 可见区 items（含 src 算好）
const visibleItems = computed(() => {
  const { start, end } = visibleRange.value;
  const map = layout.value.map;
  const baseDir = joinPath(props.rootPath, props.currentPath);
  return props.entries
    .slice(start, end)
    .filter((e) => isImage(e.name))
    .map((e) => {
      const item = map.get(e.path);
      if (!item) return null;
      return {
        entry: e,
        item,
        mark: getMark(e),
        selected: props.selectedPaths.has(e.path),
        src: convertFileSrc(joinPath(baseDir, e.name)),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
});

/** 加载中: entries 空 (fetch 中) 或首屏可见图片未全部测量完成 (Rust header 未到) */
const loading = computed(() => {
  if (props.entries.length === 0) return true;
  const r = visibleRange.value;
  if (r.end === 0) return true;
  const mm = measuredMap.value;
  if (!(mm instanceof Map)) return true;
  for (let i = r.start; i < r.end; i++) {
    const e = props.entries[i];
    if (!e || !mm.has(e.path)) return true;
  }
  return false;
});
</script>

<template>
  <div ref="containerRef" class="masonry-container" role="grid" tabindex="0">
    <div class="masonry-content" :style="{ height: layout.totalHeight + 'px', position: 'relative' }">
      <MasonryRow
        v-for="v in visibleItems"
        :key="v.entry.path"
        :entry="v.entry"
        :src="v.src"
        :width="v.item.width"
        :height="v.item.height"
        :top="v.item.top"
        :left="v.item.left"
        :mark="v.mark"
        :selected="v.selected"
        @row-click="(e, ev) => emit('row-click', e, ev)"
        @row-dblclick="(e, ev) => emit('row-dblclick', e, ev)"
        @row-contextmenu="(e, ev) => emit('row-contextmenu', e, ev)"
      />
    </div>
    <!-- 加载提示: 首屏图片测量/字节未就绪时显示, 完成后自动隐藏 -->
    <div
      v-if="loading"
      class="masonry-loading"
      data-test="masonry-loading"
      role="status"
      aria-live="polite"
    >
      <svg
        class="animate-spin"
        width="32" height="32" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
        <path d="M22 12a10 10 0 0 1-10 10" />
      </svg>
      <span>{{ t('fileBrowser.masonryLoading') }}</span>
    </div>
  </div>
</template>

<style scoped>
.masonry-container {
  position: relative;
  overflow: auto;
  height: 100%;
  width: 100%;
  outline: none;
}
.masonry-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-muted);
  font-size: 13px;
  pointer-events: none;
  z-index: 10;
}
</style>