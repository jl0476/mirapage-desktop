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
import { getBook, saveProgress } from '@/lib/tauri';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { useKeepScreenOn } from '@/composables/useKeepScreenOn';
import {
  useReaderTouchZones,
  dispatchZoneAction,
} from '@/composables/useReaderTouchZones';
import { SpreadPlanner } from '@/lib/spreadPlanner';
import { log } from '@/lib/logger';
import ReaderScreen from '@/components/reader/ReaderScreen.vue';
import ReaderMainMenu from '@/components/reader/ReaderMainMenu.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

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
  log('[ReaderView] loadBook start, bookId=', id);
  if (!id || isNaN(id)) {
    router.push('/');
    return;
  }
  try {
    log('[ReaderView] calling getBook', id);
    const book = await getBook(id);
    log('[ReaderView] getBook returned', book ? book.title : 'null');
    if (!book) {
      status.value = 'error';
      errorMessage.value = `找不到 bookId ${id}`;
      return;
    }
    const sd = book.sourceDescriptor;
    const path = (sd as { rootPath?: string }).rootPath ?? '';
    log('[ReaderView] resolved path=', path);
    if (!path) {
      status.value = 'error';
      errorMessage.value = 'source descriptor 缺 rootPath';
      return;
    }
    log('[ReaderView] setRoot', path);
    await fileBrowser.setRoot(path);
    const entries: MediaEntry[] = fileBrowser.entries;
    log('[ReaderView] entries from setRoot', entries.length);
    const IMAGES = /\.(jpe?g|png|webp|bmp|gif|avif|heic|heif)$/i;
    const imageEntries = entries
      .filter((e) => !e.isDirectory && !e.isArchive && IMAGES.test(e.name))
      .map((e) => e.name)
      .sort();
    log('[ReaderView] imageEntries', imageEntries.length, imageEntries.slice(0, 3));
    if (imageEntries.length === 0) {
      status.value = 'error';
      errorMessage.value = `${path} 下找不到图片`;
      return;
    }
    pageUrls.value = imageEntries.map((name) => convertFileSrc(`${path}/${name}`));
    log('[ReaderView] pageUrls sample', pageUrls.value[0]);
    reader.openBook({
      bookId: id,
      title: book.title || '无标题',
      pages: pageUrls.value,
      spreads: SpreadPlanner.plan(pageUrls.value.length, true),
      initialSpreadIndex: 0,
    });
    log('[ReaderView] reader.openBook done');
    status.value = 'ready';
  } catch (e) {
    log('[ReaderView] loadBook error', e);
    errorMessage.value = e instanceof Error ? e.message : String(e);
    status.value = 'error';
  }
}

async function onNextVolume() {
  if (!slideshow.consumePendingNextVolume()) return;
  if (settings.continueToNextVolume !== 'auto') return;
  log('[ReaderView] cross-volume intent (TODO: load next volume)');
  // v0.1.0-module2.0 暂未集成跨卷加载 — reader store 需扩展 sourceDescriptor / currentBookPath 字段.
  // 末页已 pause, 用户手动按 next-volume 按钮 (9 宫格右下) 或菜单触发.
}

onMounted(async () => {
  await loadBook();
  await slideshow.load();
});

onUnmounted(() => {
  if (reader.bookId !== null) {
    void saveProgress(reader.bookId, reader.currentSpreadIndex, 'single');
  }
  slideshow.pause();
  reader.closeBook();
});

const zoneActions = {
  openMainMenu: () => { showMainMenu.value = true; slideshow.pause(); },
  prevPage: () => { reader.prevPage(); slideshow.reset(); },
  nextPage: () => { reader.nextPage(); slideshow.reset(); },
  jumpToFirst: () => { reader.jumpToSpread(0); slideshow.reset(); },
  jumpToLast: () => { reader.jumpToSpread(Math.max(0, reader.spreads.length - 1)); slideshow.reset(); },
  toggleSlideshow: () => { slideshow.toggle(); },
  prevVolume: () => { log('[ReaderView] TODO prev-volume'); },
  nextVolume: () => { onNextVolume(); },
};

useReaderHotkeys();
const keepScreenOnRef = computed(() => settings.keepScreenOn);
useKeepScreenOn(keepScreenOnRef);
useReaderTouchZones({
  containerRef,
  onAction: (a) => dispatchZoneAction(a, zoneActions),
});

watch(
  () => slideshow.pendingNextVolume,
  (v) => { if (v) void onNextVolume(); },
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
    >
    </ReaderMainMenu>
  </main>
</template>
