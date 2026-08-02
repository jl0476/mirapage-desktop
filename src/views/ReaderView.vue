/**
 * ReaderView.vue — v0.1.0-module2.0 阅读器路由 wrapper
 *
 * - mount: 解析 :bookId → listHistory 找 source_descriptor
 *          listDirectory 拿 MediaEntry[] 拼 convertFileSrc URL
 *          readerStore.openBook
 * - unmount: saveProgress 兜底 + closeBook
 * - 9 宫格 click (useReaderTouchZones) → 派发 reader store actions
 * - 跨卷 (pendingNextVolume) watch 处理
 * - 滚轮 / 鼠标按键 已 useReaderHotkeys() 接管 (内含 wheel listener)
 */
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { getBook, saveProgress, getProgress, listDirectory } from '@/lib/tauri';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { useReaderWheel } from '@/composables/useReaderWheel';
import { useKeepScreenOn } from '@/composables/useKeepScreenOn';
import {
  useReaderTouchZones,
  dispatchZoneAction,
} from '@/composables/useReaderTouchZones';
import { SpreadPlanner } from '@/lib/spreadPlanner';
import { isImage } from '@/lib/mime';
import { naturalSort } from '@/lib/naturalSort';
import { log } from '@/lib/logger';
import ReaderScreen from '@/components/reader/ReaderScreen.vue';
import ReaderMainMenu from '@/components/reader/ReaderMainMenu.vue';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';

const route = useRoute();
const router = useRouter();
const reader = useReaderStore();
const slideshow = useSlideshowStore();
const settings = useSettingsStore();
const fileBrowser = useFileBrowserStore();
const { t } = useI18n();

const status = ref('loading' as 'loading' | 'ready' | 'error');
const errorMessage = ref('');
const pageUrls = ref([] as string[]);
const containerRef = ref(null as HTMLElement | null);
const showMainMenu = ref(false);

const bookId = computed(() => Number(route.params.bookId));

async function loadBook() {
  status.value = 'loading';
  errorMessage.value = '';
  const id = bookId.value;
  log('[ReaderView/loadBook] start, bookId=', id, 'route=', route.fullPath);
  if (!id || isNaN(id)) {
    log('[ReaderView/loadBook] invalid bookId, redirect to /');
    router.push('/');
    return;
  }
  try {
    log('[ReaderView/loadBook] IPC[getBook] →', id);
    const book = await getBook(id);
    log('[ReaderView/loadBook] IPC[getBook] ←', book ? {
      id: book.id,
      title: book.title,
      absolutePath: book.absolutePath,
      coverEntryPath: book.coverEntryPath,
      coverEntryName: book.coverEntryName,
      pageCount: book.pageCount,
      lastReadAt: book.lastReadAt,
      isFavorite: book.isFavorite,
      sourceDescriptor: book.sourceDescriptor,
      sourceType: book.sourceType,
    } : 'null');
    if (!book) {
      status.value = 'error';
      errorMessage.value = `找不到 bookId ${id}`;
      log('[ReaderView/loadBook] ERROR: book is null for id', id);
      return;
    }
    // v0.1.0-module3.0.2: H1 修复后 Rust 端 fields 是 serde_json::Value,
    // IPC 边界自动拆成对象。Defensive parse 仍保留, 兼容老 DB 行 / 跨进程备份.
    // SourceDescriptor 是判别联合, 只 Local 变体有 rootPath.
    log('[ReaderView/loadBook] parseSourceDescriptor input type:', typeof book.sourceDescriptor);
    const sd = parseSourceDescriptor(book.sourceDescriptor);
    log('[ReaderView/loadBook] parseSourceDescriptor result:', sd);
    if (!sd || sd.type !== 'local' || !sd.rootPath) {
      status.value = 'error';
      errorMessage.value = 'source descriptor 解析失败或非本地资源';
      log('[ReaderView/loadBook] ERROR: sourceDescriptor invalid', { sd, rootPath: (sd as { rootPath?: string })?.rootPath });
      return;
    }
    const path = sd.rootPath;
    log('[ReaderView/loadBook] resolved rootPath=', path);
    // v0.1.0-module3.0.2-hotfix2 (H7): book.absolutePath 才是实际子目录.
    // sourceDescriptor.rootPath 是根, book.absolutePath 是 (sourceDescriptor, rootPath) 下的子目录.
    // 错误地用 rootPath setRoot 会拿到根目录 458 个杂项, 过滤图片 0 → '找不到图片'.
    const targetDir = book.absolutePath && book.absolutePath.length > 0
      ? book.absolutePath
      : path;
    log('[ReaderView/loadBook] targetDir selected:', {
      rootPath: path,
      absolutePath: book.absolutePath,
      effectiveTargetDir: targetDir,
      fallback: book.absolutePath === '' || book.absolutePath === path,
    });
    log('[ReaderView/loadBook] IPC[fileBrowser.setRoot] →', path);
    await fileBrowser.setRoot(path);
    log('[ReaderView/loadBook] IPC[fileBrowser.setRoot] ← ok, entries=', fileBrowser.entries.length);
    // 直接列子目录, 绕开 fileBrowser.entries (那是根目录的, 不是 absolutePath 子目录)
    log('[ReaderView/loadBook] IPC[listDirectory] →', { descriptor: sd, path: targetDir });
    const targetEntries: MediaEntry[] = await listDirectory(sd, targetDir);
    log('[ReaderView/loadBook] IPC[listDirectory] ←', targetEntries.length, 'entries; first 3:', targetEntries.slice(0, 3).map((e) => `${e.name}(dir=${e.isDirectory},arc=${e.isArchive})`));
    // v0.1.0-module3.0.2: M1 修复 — 用 lib/mime.isImage 与 lib/naturalSort
    // 与 FileBrowser / useReaderActions.enumerateCover 字节级对齐
    const imageEntries = targetEntries
      .filter((e) => !e.isDirectory && !e.isArchive && isImage(e.name))
      .map((e) => e.name);
    const sortedNames = naturalSort(imageEntries, (n) => n);
    log('[ReaderView/loadBook] imageEntries', sortedNames.length, sortedNames.slice(0, 5));
    if (sortedNames.length === 0) {
      status.value = 'error';
      errorMessage.value = `${targetDir} 下找不到图片`;
      log('[ReaderView/loadBook] ERROR: no images at', targetDir, '— targetDir vs rootPath mismatch?', { targetDir, rootPath: path, equal: targetDir === path });
      return;
    }
    pageUrls.value = sortedNames.map((name) => convertFileSrc(`${targetDir}/${name}`));
    log('[ReaderView/loadBook] pageUrls sample', pageUrls.value[0]);
    // v0.1.0-module3.0.2: H5 修复 — 取上次阅读位置
    log('[ReaderView/loadBook] IPC[getProgress] →', id);
    const initialSpreadIndex = await resolveInitialSpreadIndex(id, sortedNames.length);
    log('[ReaderView/loadBook] initialSpreadIndex=', initialSpreadIndex, '(pageCount=', sortedNames.length, ')');
    log('[ReaderView/loadBook] reader.openBook →', { bookId: id, title: book.title, pages: pageUrls.value.length, initialSpreadIndex });
    reader.openBook({
      bookId: id,
      title: book.title || '无标题',
      pages: pageUrls.value,
      spreads: SpreadPlanner.plan(pageUrls.value.length, true),
      initialSpreadIndex,
    });
    log('[ReaderView/loadBook] reader.openBook done, status=ready');
    status.value = 'ready';
  } catch (e) {
    log('[ReaderView/loadBook] EXCEPTION:', e, 'stack:', e instanceof Error ? e.stack : '');
    errorMessage.value = e instanceof Error ? e.message : String(e);
    status.value = 'error';
  }
}

/**
 * v0.1.0-module3.0.2: 防御性解析 sourceDescriptor
 *  - 新数据 (Rust serde_json::Value): 直接是 SourceDescriptor 对象
 *  - 老数据 (Rust String raw blob): JSON.parse 拆
 *  - 都坏了: 返回 null (上层走 error 路径)
 */
function parseSourceDescriptor(raw: unknown): SourceDescriptor | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && 'rootPath' in parsed
        ? (parsed as SourceDescriptor)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && 'rootPath' in raw && typeof (raw as { rootPath: unknown }).rootPath === 'string') {
    return raw as SourceDescriptor;
  }
  return null;
}

/**
 * v0.1.0-module3.0.2 (H5): 恢复上次阅读位置
 *  - 调 getProgress(bookId) 拿 last read page
 *  - page→spread 映射 (SpreadPlanner.spreadIndexForPage)
 *  - 无 progress / 失败: 默认 0
 *
 * v0.1.0-module3.0.2-hotfix1 (N3): 末页钳位
 *  - 还原到末页会让 slideshow.tick() atLast() 立刻 pause + setPendingNextVolume,
 *    用户感知"刚开就跨卷".
 *  - 修法: 把 initialSpreadIndex 钳到 last - 1 (倒数第二页),
 *    让用户先正常翻页, 而不是看到跨卷 flag 触发.
 *  - 多 spread 的漫画钳到 last - 1; 单 spread 的极端情况不动 (无 last - 1).
 */
async function resolveInitialSpreadIndex(bookId: number, pageCount: number): Promise<number> {
  try {
    const progress = await getProgress(bookId);
    if (!progress) return 0;
    const spreads = SpreadPlanner.plan(pageCount, true);
    const last = spreads.length - 1;
    if (last < 0) return 0;
    const idx = SpreadPlanner.spreadIndexForPage(progress.page, spreads);
    const clamped = Math.max(0, Math.min(idx, last));
    // 末页钳位: 不在末 spread (last - 1)
    return clamped >= last ? Math.max(0, last - 1) : clamped;
  } catch (e) {
    log('[ReaderView] resolveInitialSpreadIndex fallback 0:', e);
    return 0;
  }
}

/**
 * v0.1.0-module3.0.2: H6 修复 — 入口立刻 consumePendingNextVolume
 * (不论 settings), 防止 flag 永远 true 死循环
 */
async function onNextVolume() {
  const flag = slideshow.pendingNextVolume;
  log('[ReaderView/onNextVolume] entered, pendingNextVolume=', flag, 'continueToNextVolume=', settings.continueToNextVolume);
  if (!slideshow.consumePendingNextVolume()) {
    log('[ReaderView/onNextVolume] no flag set, skip');
    return;
  }
  if (settings.continueToNextVolume !== 'auto') {
    log('[ReaderView/onNextVolume] flag consumed but setting != auto, skip actual load');
    return;
  }
  log('[ReaderView/onNextVolume] cross-volume intent (TODO: load next volume)');
  // v0.1.0-module2.0 暂未集成跨卷加载 — reader store 需扩展 sourceDescriptor / currentBookPath 字段.
  // 末页已 pause, 用户手动按 next-volume 按钮 (9 宫格右下) 或菜单触发.
}

onMounted(async () => {
  log('[ReaderView/onMounted] start');
  await loadBook();
  await slideshow.load();
  log('[ReaderView/onMounted] done; reader.status=', reader.status);
});

// v0.1.0-module3.0.2: M2 修复 — store 防抖路径存 spreads[start] (page),
// unmount 路径必须对齐, 否则末页前的 spread 恢复会被 spreadIndex 覆盖.
function currentReadPage(): number {
  const spread = reader.spreads[reader.currentSpreadIndex];
  const page = spread?.start ?? reader.currentSpreadIndex;
  log('[ReaderView/currentReadPage] spreadIndex=', reader.currentSpreadIndex, 'page=', page, 'spreads.length=', reader.spreads.length);
  return page;
}

onUnmounted(() => {
  log('[ReaderView/onUnmounted] start; bookId=', reader.bookId, 'currentSpreadIndex=', reader.currentSpreadIndex);
  if (reader.bookId !== null) {
    const page = currentReadPage();
    log('[ReaderView/onUnmounted] IPC[saveProgress] →', { bookId: reader.bookId, page, mode: 'single' });
    void saveProgress(reader.bookId, page, 'single');
  }
  slideshow.pause();
  reader.closeBook();
  log('[ReaderView/onUnmounted] done');
});

const zoneActions = {
  openMainMenu: () => { showMainMenu.value = true; slideshow.pause(); },
  prevPage: () => { reader.prevPage(); slideshow.reset(); },
  nextPage: () => { reader.nextPage(); slideshow.reset(); },
  jumpToFirst: () => { reader.jumpToSpread(0); slideshow.reset(); },
  jumpToLast: () => { reader.jumpToSpread(Math.max(0, reader.spreads.length - 1)); slideshow.reset(); },
  toggleSlideshow: () => { slideshow.toggle(); },
  prevVolume: () => { log('[ReaderView/zoneActions] prevVolume TODO (cross-volume prev)'); },
  nextVolume: () => { onNextVolume(); },
};

// v0.1.0-module3.0.2: M5 修复 — 把写好的 useReaderWheel 实际挂上 (containerRef),
// preventDefault 阻止页面滚动 + OSD 内部滚轮缩放. ReaderScreen 那边 SinglePageViewer
// 已经 scrollToZoom=false, 此处 containerRef 接 wheel 接管翻页.
useReaderHotkeys();
useReaderWheel({
  containerRef,
  onPrev: () => { reader.prevPage(); slideshow.reset(); },
  onNext: () => { reader.nextPage(); slideshow.reset(); },
});

const keepScreenOnRef = computed(() => settings.keepScreenOn);
useKeepScreenOn(keepScreenOnRef);

// v0.1.0-module3.0.2: M4 修复 — 让 9 宫格自动忽略 overlay 内的 button/input 点击,
// 避免 overlay 按钮被 9 宫格拦截双触发. 用 [data-test-ignore-touch-zones] 属性 marker.
useReaderTouchZones({
  containerRef,
  ignoreSelector: '[data-test-ignore-touch-zones]',
  onAction: (a) => dispatchZoneAction(a, zoneActions),
});

watch(
  () => slideshow.pendingNextVolume,
  (v) => {
    log('[ReaderView/watch] pendingNextVolume →', v);
    if (v) void onNextVolume();
  },
);
</script>

<template>
  <main
    ref="containerRef"
    class="flex h-full bg-bg select-none"
    data-test="reader-view"
  >
    <p v-if="status === 'loading'" class="m-auto text-text-muted text-sm">
      {{ t('common.loading') }}
    </p>

    <div
      v-else-if="status === 'error'"
      class="m-auto flex flex-col items-center gap-3 p-8"
      data-test="reader-error"
    >
      <p class="text-error text-sm">{{ errorMessage }}</p>
      <button
        class="px-3 py-1.5 rounded border border-white/10 bg-surface-1 text-text-secondary text-xs hover:bg-surface-light hover:text-text-primary transition-colors"
        data-test="reader-back-btn"
        @click="router.push('/')"
      >
        ← {{ t('common.back') }}
      </button>
    </div>

    <ReaderScreen
      v-else-if="status === 'ready' && reader.status === 'ready'"
      class="flex-1 min-h-0"
      :page-urls="pageUrls"
      :spreads="reader.spreads"
      :initial-spread-index="reader.currentSpreadIndex"
      :mode="settings.readerDefaultMode"
      :title="reader.title"
      @back="router.push('/')"
      @toggle-mode="settings.readerDefaultMode === 'single' ? settings.update('reader_default_mode', 'double') : settings.update('reader_default_mode', 'single')"
    />

    <ReaderMainMenu
      v-model:show="showMainMenu"
      :title="reader.title"
      :current-spread-index="reader.currentSpreadIndex"
      :total-spreads="reader.spreads.length"
      @jump-page="(i: number) => reader.jumpToSpread(i)"
      @back="router.push('/')"
      @cycle-mode="settings.update('reader_default_mode', settings.readerDefaultMode === 'single' ? 'double' : 'single')"
      @cycle-direction="slideshow.updateDirection(slideshow.direction === 'forward' ? 'backward' : 'forward')"
    >
    </ReaderMainMenu>
  </main>
</template>
