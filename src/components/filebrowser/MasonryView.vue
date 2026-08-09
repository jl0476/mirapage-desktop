<script setup lang="ts">
// MasonryView.vue — 瀑布流视图容器
// 职责：管理 measuredMap、触发 header 预读、渲染可见区 MasonryRow。
// 复用 useVirtualList 的 containerRef/scroll/resize；布局由 useMasonryLayout 算。
import { ref, computed, watch, onMounted, onUnmounted, nextTick, toRef } from 'vue';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@/composables/useVirtualList';
import { useMasonryLayout, toRootRelativePath, type MasonryItem } from '@/composables/useMasonryLayout';
import { useMasonryThumbnails } from '@/composables/useMasonryThumbnails';
import { useMasonryBrowsePosition } from '@/composables/useMasonryBrowsePosition';
import { listImageDimensions } from '@/lib/tauri';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import { useSettingsStore } from '@/stores/settings';
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
  // v0.1.0-module3.0.8 (任务 8): 全序列图片名（来自 fb.sortedEntries 过滤图片），
  // 不受 UI 过滤（搜索/隐藏已读）影响 —— topmostImage.page 计算的下标。
  // FileBrowser 通过 prop 传（任务 10 加 FileList 转发链）。
  // 当前为可选 + 默认 []：FileList 还未传（MasonryView 单独使用或测试时仍可工作），
  // useMasonryBrowsePosition 拿到 [] 时 canonicalImageNames.indexOf 永远 -1，
  // page 始终 0（无害 —— masonry 目录目前仅 FileBrowser 触发）。
  canonicalImageNames?: string[];
}
const props = withDefaults(defineProps<Props>(), {
  canonicalImageNames: () => [] as string[],
});

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
  // v0.1.0-module3.0.8 (任务 8): 启动浏览位置监听 + 查 progress + 可选自动滚
  await browsePosition.start();
});
onUnmounted(() => ro?.disconnect());

/** v0.1.0-module3.0.8 (任务 8): 目录切换时让 composable 重新初始化（spec §3.4 做法 A）。
 *  用 stop+start 模式：停止滚动监听 + 清理 lastWrittenPath，再 start 触发
 *  restoreAndScroll（查 progress + 可选自动滚）。 */
watch(
  () => [props.descriptor, props.currentPath] as const,
  () => {
    browsePosition.stop();
    void browsePosition.start();
  },
);

// settings store 在 useMasonryLayout 之前声明（依赖其 thumbnail*Screens 字段）
const settingsStore = useSettingsStore();

const { layout, visibleRange, needPrefetch, nextBatchPaths, colWidth, thumbnailWindows } = useMasonryLayout({
  entries: entriesRef,
  containerWidth,
  containerHeight: viewportHeight,
  colCount: toRef(props, 'colCount'),
  hGap: toRef(props, 'hGap'),
  vGap: toRef(props, 'vGap'),
  scrollTop,
  measuredMap,
  // P1-4: 像素窗口由设置驱动（节能/均衡/高性能预读范围不同）
  thumbnailAheadScreens: computed(() => settingsStore.thumbnailPrefetchScreens),
  thumbnailIdleGeneration: computed(() => settingsStore.thumbnailIdleGeneration),
  thumbnailIdleScreens: computed(() => settingsStore.thumbnailIdlePrefetchScreens),
});

// 缩略图队列（替代原脱离 DOM 的原图预读）。dpr 用设备像素比；quality 来自设置 store。
const dpr = ref(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
const thumbQuality = computed(() => settingsStore.thumbnailQuality);
const { stateMap: thumbStateMap, retry: retryThumbnail, regenerate: regenerateThumbnail, retryBatch: retryBatchFn, regenerateBatch: regenerateBatchFn } = useMasonryThumbnails({
  descriptor: toRef(props, 'descriptor'),
  currentPath: toRef(props, 'currentPath'),
  entries: entriesRef,
  thumbnailWindows,
  measuredMap,
  colWidth,
  dpr,
  quality: thumbQuality,
  scrollTop,
  originalUrlFor: (e) => convertFileSrc(joinPath(joinPath(props.rootPath, props.currentPath), e.name)),
});

// 暴露给父级 FileBrowser（移动到 browsePosition 定义后，见下方）

/** v0.1.0-module3.0.8 (任务 8): scrollToEntry 渐进校正（spec §4.2 P1 修复）。
 *  - 立即跳到当前 layout 估算位置（layout 首帧就含所有 entries 的估算位置）
 *  - 然后 watch `layout.value.map.get(targetPath)?.top`：目标上方任意图片
 *    尺寸到达都会改变目标的 layout.top（spec v4 P1 修复：不是 measuredMap），
 *    触发渐进校正（最多 SCROLL_CORRECTION_LIMIT 次，SCROLL_CORRECTION_TIMEOUT_MS 后停）
 *  - 目标不在 entries（filter）→ 返回 false，不强制取消过滤跳转（spec v4 决策） */
const SCROLL_CORRECTION_LIMIT = 5;
const SCROLL_CORRECTION_TIMEOUT_MS = 3000;

async function scrollToEntry(imageName: string): Promise<boolean> {
  const target = props.entries.find((e) => e.name === imageName);
  if (!target) {
    log('[MasonryView] scrollToEntry: imageName not in current entries (filter?)', imageName);
    return false;
  }
  // 等目标进入 layout map（layout 必然含所有 entries，最多等 200ms）
  let item: MasonryItem | undefined;
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    item = layout.value.map.get(target.path);
    if (item) break;
    await nextTick();
  }
  if (!item) {
    log('[MasonryView] scrollToEntry: layout map missing after timeout', imageName);
    return false;
  }
  if (containerRef.value) containerRef.value.scrollTop = item.top;

  // P1 修复：watch 目标图自身的 layout.top（不是 measuredMap 条目）。
  //   目标上方任意图片的尺寸到达都会改变目标的 layout.top，
  //   但目标本身的 measuredMap 不会变；watch measuredMap 抓不到。
  const targetPath = target.path;
  let corrections = 0;
  const stop = watch(
    () => layout.value.map.get(targetPath)?.top,
    (newTop) => {
      if (newTop === undefined) return;
      if (corrections >= SCROLL_CORRECTION_LIMIT) return;
      if (containerRef.value) {
        containerRef.value.scrollTop = newTop;
        corrections += 1;
      }
    },
    { flush: 'post' },
  );
  setTimeout(() => stop(), SCROLL_CORRECTION_TIMEOUT_MS);
  log('[MasonryView] scrollToEntry: jumped + started anchor correction', imageName);
  return true;
}

/** v0.1.0-module3.0.8 (任务 8): 浏览位置 composable（任务 7 实现）。
 *  - 监听 scrollTop + 300ms debounce 写入顶部可见图（progress image_name + page）
 *  - 进目录查 progress，可选自动 scrollToEntry（autoRestoreOnMount 开关）
 *  - 提供 jumpToLast 给 toolbar「↶ 跳到上次」按钮（任务 10）
 *  - 目录切换由 spec §3.4 做法 A（MasonryView 内部 watch + stop+start）
 *  - enabled / autoRestoreOnMount 默认 true（任务 9 会接入 settings 开关） */
const browsePosition = useMasonryBrowsePosition({
  descriptor: toRef(props, 'descriptor'),
  currentPath: toRef(props, 'currentPath'),
  renderEntries: entriesRef,
  canonicalImageNames: computed(() => props.canonicalImageNames),
  layoutMap: computed(() => layout.value.map),
  scrollTop,
  scrollToEntry,
  enabled: computed(() => true),
  autoRestoreOnMount: computed(() => true),
});

// 暴露给父级 FileBrowser：
//  - 缩略图操作（右键菜单重建/重试）
//  - 任务 8：scrollToEntry / jumpToLast / browsePosition（masonry 浏览位置）
defineExpose({
  regenerate: regenerateThumbnail,
  regenerateBatch: regenerateBatchFn,
  retry: retryThumbnail,
  retryBatch: retryBatchFn,
  scrollToEntry,
  jumpToLast: () => browsePosition.jumpToLast(),
  browsePosition,
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

// 可见区 items（含缩略图状态）
const visibleItems = computed(() => {
  const { start, end } = visibleRange.value;
  const map = layout.value.map;
  const tmap = thumbStateMap.value;
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
        thumbState: tmap.get(e.path),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
});

/** 加载中: entries 空 (fetch 中) 或首屏一张都没测量完成 (Rust header 未到).
 *  容忍个别 header 解析失败 (EXIF JPEG SOF0 超出 8KB 读取范围 -> image_dimensions
 *  返回 None -> 该 path 不进 measuredMap): 首屏有任意一张 measured 即认为加载完成,
 *  未测量的用估算高度 fallback (inputs 已有 avgRatio 估算). 之前要求全部 measured,
 *  个别失败导致永久 loading (3.0.7 接缩略图队列后暴露, 因 overlay 盖住卡片). */
const loading = computed(() => {
  if (props.entries.length === 0) return true;
  const r = visibleRange.value;
  if (r.end === 0) return true;
  const mm = measuredMap.value;
  if (!(mm instanceof Map)) return true;
  for (let i = r.start; i < r.end; i++) {
    const e = props.entries[i];
    if (e && mm.has(e.path)) return false; // 有任意 measured 即加载完成
  }
  return true;
});
</script>

<template>
  <div ref="containerRef" class="masonry-container" role="grid" tabindex="0">
    <div class="masonry-content" :style="{ height: layout.totalHeight + 'px', position: 'relative' }">
      <MasonryRow
        v-for="v in visibleItems"
        :key="v.entry.path"
        :entry="v.entry"
        :thumb-state="v.thumbState"
        :width="v.item.width"
        :height="v.item.height"
        :top="v.item.top"
        :left="v.item.left"
        :mark="v.mark"
        :selected="v.selected"
        @row-click="(e, ev) => emit('row-click', e, ev)"
        @row-dblclick="(e, ev) => emit('row-dblclick', e, ev)"
        @row-contextmenu="(e, ev) => emit('row-contextmenu', e, ev)"
        @row-retry="(e) => retryThumbnail(e.path)"
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