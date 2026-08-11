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
 *
 * v0.1.0-reader-review fixes:
 *  - 新增 jumpDialog + openJumpDialog 处理 main menu 的 open-jump-input 事件
 *  - cycle-direction 改为切换 settings.defaultReadDirection (之前误改 slideshow.direction)
 *  - ctx menu direction 从 settings.defaultReadDirection 派生 (之前误用 slideshow.direction)
 *  - 显示触控区 ref 接入 + 透传给 ReaderScreen
 *  - 错误返回按钮 border-white/10 → xp-bd (light 模式可见)
 */
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { saveProgress, type BookItem, toggleLike, addBookmark, setFavorite } from '@/lib/tauri';
import { useReaderStore } from '@/stores/reader';
import { SpreadPlanner } from '@/lib/spreadPlanner';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { useReaderWheel } from '@/composables/useReaderWheel';
import { useKeepScreenOn } from '@/composables/useKeepScreenOn';
import {
  useReaderTouchZones,
  dispatchZoneAction,
} from '@/composables/useReaderTouchZones';
import { useReaderBookLoader, type ReaderBookSnapshot } from '@/composables/useReaderBookLoader';
import { log } from '@/lib/logger';
import ReaderScreen from '@/components/reader/ReaderScreen.vue';
import ReaderMainMenu from '@/components/reader/ReaderMainMenu.vue';
import ReaderContextMenu from '@/components/reader/ReaderContextMenu.vue';
import SlideshowToast from '@/components/reader/SlideshowToast.vue';
import type { ScaleMode } from '@/lib/readerSettings';

const route = useRoute();
const router = useRouter();
const reader = useReaderStore();
const slideshow = useSlideshowStore();
const settings = useSettingsStore();
const { t } = useI18n();
const loader = useReaderBookLoader();


const status = ref('loading' as 'loading' | 'ready' | 'error');
const errorMessage = ref('');
const pageUrls = ref([] as string[]);
// v0.1.0-module3.0.8: 当前阅读的图片名数组（按 sortedNames 顺序，与 reader.pages / reader.spreads 一一对应）
// 1) 注入 reader store: reader.imageNames, 供 emitChanged 计算 imageName 锚点
// 2) 局部 ref: 供 currentReadImageName() / resolveInitialSpreadIndex 同步访问
const imageNames = ref([] as string[]);
const containerRef = ref(null as HTMLElement | null);
const showMainMenu = ref(false);
// 需求4-C: 模板访问 book.isFavorite / book.id, loadBook 写入此 ref
const book = ref<BookItem | null>(null);
// 需求4-A: 右键轻量上下文菜单
const ctxMenu = ref({ visible: false, x: 0, y: 0 });
// v0.1.0-module3.0.3-hotfix3 (Bug 4): back btn 视觉反馈, 防止双击 & 让用户知道在跳转
const isGoingBack = ref(false);
// v0.1.0-reader-review: 跳页 dialog (主菜单"跳页"按钮 / 右键"跳页"都打开它)
const jumpDialogRef = ref<HTMLDialogElement | null>(null);
const jumpDialogValue = ref(1);
// v0.1.0-reader-review: 触控区可视化 overlay
const showTouchRegions = ref(false);

function onContextMenu(e: MouseEvent): void {
  // 只在 ready 状态 + reader 容器内触发；阻止浏览器默认菜单
  if (status.value !== 'ready') return;
  e.preventDefault();
  ctxMenu.value = { visible: true, x: e.clientX, y: e.clientY };
}
function closeCtxMenu(): void {
  ctxMenu.value.visible = false;
}
function onCtxScaleChange(m: ScaleMode): void {
  void settings.setScaleMode(m);
  closeCtxMenu();
}
function onCtxCycleMode(): void {
  // 修复: settings.update() 只持久化不更新 in-memory — 用专用 cycle 方法
  void settings.cycleReaderMode();
  closeCtxMenu();
}
function onCtxCycleDirection(): void {
  // 修复: 同上, 用 cycleReadDirection() 同时更新 in-memory + 持久化
  void settings.cycleReadDirection();
  closeCtxMenu();
}
function onCtxToggleSlideshow(): void {
  slideshow.toggle();
  closeCtxMenu();
}
function onCtxJumpPage(page: number): void {
  doJumpToPage(page);
  closeCtxMenu();
}
function onCtxBack(): void {
  void goBackToFileBrowser();
  closeCtxMenu();
}

// v0.1.0-module3.0.3-hotfix (Bug 2): 集中封装「reader → file browser」回退逻辑.
// v0.1.0-module3.0.3-hotfix3 (Bug 4): 不在这里调 restoreNavigationContext (双 fetch),
// 只 router.push('/'). FileBrowser.onMounted 会消费 saved context 并恢复 currentPath.
// 没有保存上下文 (从 library/bookmarks 进入 reader 的情况) 时, FileBrowser.onMounted
// fallthrough 到 setRoot(LAST_ROOT_KEY) 也能正确加载.
async function goBackToFileBrowser(): Promise<void> {
  if (isGoingBack.value) return;  // 防双击
  isGoingBack.value = true;
  try {
    await router.push('/');
  } finally {
    // router.push 是异步的, 完成后组件已 unmount. 但保险起见延迟复位,
    // 防止用户连点 / 多次触发.
    setTimeout(() => { isGoingBack.value = false; }, 1000);
  }
}

// v0.1.0-reader-review-fix-5: 模板 @event="expr()" 会立即求值得到 Promise, 把 Promise 当 handler (错).
// Vue 期望 handler 是函数. @event="funcName" 会让 Vue 自动调 funcName($event).
// @event="() => func()" 用箭头函数包裹, 每次点击才调 — async 函数推荐.
function onToggleSlideshowDirection(): void {
  void slideshow.updateDirection(slideshow.direction === 'forward' ? 'backward' : 'forward');
}

// v0.1.0-reader-review: 跳页 dialog
function openJumpDialog(): void {
  jumpDialogValue.value = reader.currentSpreadIndex + 1;
  jumpDialogRef.value?.showModal();
  // 自动 focus input (showModal 后需 nextTick 才能 querySelector)
  void nextTick(() => {
    jumpDialogRef.value?.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
  });
}
function closeJumpDialog(): void {
  jumpDialogRef.value?.close();
}
/** 跳页核心: 页码 → spread → jumpToSpread. 主菜单 dialog 和右键子菜单共用. */
function doJumpToPage(page: number): void {
  if (!Number.isFinite(page) || page < 1) return;
  const total = pageUrls.value.length;
  if (total === 0) return;
  const target = Math.min(Math.max(1, Math.floor(page)), total) - 1;
  const singlePage = settings.readerDefaultMode === 'single';
  const spreads = SpreadPlanner.plan(total, true, singlePage);
  const idx = SpreadPlanner.spreadIndexForPage(target, spreads);
  reader.jumpToSpread(idx);
  slideshow.reset();
}

function submitJumpDialog(ev: Event): void {
  ev.preventDefault();
  doJumpToPage(Number(jumpDialogValue.value));
  closeJumpDialog();
}

function onShowTouchRegions(): void {
  showTouchRegions.value = !showTouchRegions.value;
}

const bookId = computed(() => Number(route.params.bookId));

// Cluster A: route.query.at 是双击图片 / 选中图片立即阅读时携带的起始图片名
// (useReaderActions.readFromImage 写入). ReaderView 优先用此图所在 spread,
// 而不是 saved progress. 用户显式选择 — 不做末页钳位 (避免"刚开就跨卷"逻辑仅适用于自动恢复).
const initialImageName = computed<string | null>(() => {
  const v = route.query.at;
  return typeof v === 'string' ? decodeURIComponent(v) : null;
});

async function loadBook() {
  status.value = 'loading';
  errorMessage.value = '';
  const id = bookId.value;
  log('[ReaderView/loadBook] start, bookId=', id, 'route=', route.fullPath);
  if (!id || isNaN(id)) {
    log('[ReaderView/loadBook] invalid bookId, redirect to /');
    void goBackToFileBrowser();
    return;
  }
  try {
    const snapshot = await loader.loadBookById(id, {
      explicitImageName: initialImageName.value ?? undefined,
    });
    commitBookSnapshot(snapshot);
    log('[ReaderView/loadBook] reader.openBook done, status=ready');
    status.value = 'ready';
  } catch (e) {
    log('[ReaderView/loadBook] EXCEPTION:', e, 'stack:', e instanceof Error ? e.stack : '');
    errorMessage.value = e instanceof Error ? e.message : String(e);
    status.value = 'error';
  }
}

function commitBookSnapshot(snapshot: ReaderBookSnapshot): void {
  book.value = snapshot.book;
  pageUrls.value = snapshot.pageUrls;
  imageNames.value = snapshot.imageNames;
  reader.openBook({
    bookId: snapshot.book.id,
    title: snapshot.book.title || '无标题',
    pages: snapshot.pageUrls,
    spreads: snapshot.spreads,
    initialSpreadIndex: snapshot.initialSpreadIndex,
  });
  reader.imageNames = snapshot.imageNames;
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

/**
 * v0.1.0-reader-review-fix-10: mode 切换时重算 spreads + 保持当前页码.
 *  - 双页 spreads = {0,1},{1,3},{3,5},... size=2
 *  - 单页 spreads = {0,1},{1,2},{2,3},... size=1
 *  - 不重算 → wheel nextPage 跳 2 张图 (spread 是双页 size)
 *  - 同时按当前页号 (old spread.start) 在新 spreads 里找对应 spread, 重设 spreadIndex.
 *    否则同一 spreadIndex 在新 spreads 里指向不同页号 (用户报告: 单页第8切双页变14)
 */
function recomputeSpreadsForMode(): void {
  const total = pageUrls.value.length;
  if (total === 0) return;
  const singlePage = settings.readerDefaultMode === 'single';
  const oldSpreads = reader.spreads;
  // 找到当前页 (0-indexed) 在旧 spreads 里的位置
  const oldSpread = oldSpreads[reader.currentSpreadIndex];
  const currentPage0 = oldSpread?.start ?? reader.currentSpreadIndex;
  const newSpreads = SpreadPlanner.plan(total, true, singlePage);
  // 在新 spreads 里找包含 currentPage0 的 spread
  const newIndex = SpreadPlanner.spreadIndexForPage(currentPage0, newSpreads);
  reader.spreads = newSpreads;
  reader.currentSpreadIndex = newIndex;
  log('[ReaderView/recomputeSpreadsForMode] mode=', settings.readerDefaultMode, 'page=', currentPage0 + 1, '→ spreadIndex=', newIndex, '(spreads.length=', newSpreads.length, ')');
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

// v0.1.0-module3.0.8: 当前 spread 起始图的文件名（用于 progress.image_name 锚点）.
// onUnmounted 显式双写到 saveProgress, 与 emitChanged 内部 saveProgress 形成冗余路径
// (unmount 不等 debounce 500ms, 立刻同步写).
function currentReadImageName(): string | null {
  const idx = reader.currentSpreadIndex;
  const sp = reader.spreads[idx];
  if (!sp) return null;
  return imageNames.value[sp.start] ?? null;
}

onUnmounted(() => {
  log('[ReaderView/onUnmounted] start; bookId=', reader.bookId, 'currentSpreadIndex=', reader.currentSpreadIndex);
  if (reader.bookId !== null) {
    const page = currentReadPage();
    const imageName = currentReadImageName();
    log('[ReaderView/onUnmounted] IPC[saveProgress] →', { bookId: reader.bookId, page, mode: 'single', imageName });
    void saveProgress(reader.bookId, page, 'single', undefined, imageName ?? undefined);
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
  // v0.1.0-module3.0: 新增 fit-width + open-file-browser 回调
  fitWidth: () => {
    // Cluster C: 调 setScaleMode 立即 apply + 持久化 (was: 只写 defaultScaleMode 下次生效)
    void settings.setScaleMode('fit-width');
  },
  openFileBrowser: () => { void goBackToFileBrowser(); },
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

// v0.1.0-reader-review-fix-7: mode 切换重算 spreads (双页 ↔ 单页 size 不同)
// + 加 log 验证 Pinia 反应. settings.$subscribe 也可作为 fallback 触发.
watch(
  () => settings.readerDefaultMode,
  (newMode, oldMode) => {
    log('[ReaderView/watch] readerDefaultMode', oldMode, '→', newMode);
    recomputeSpreadsForMode();
  },
);
</script>

<template>
  <main
    ref="containerRef"
    class="flex h-full bg-bg select-none"
    data-test="reader-view"
    @contextmenu="onContextMenu"
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
        class="px-3 py-1.5 rounded xp-bd bg-surface-1 text-text-secondary text-xs hover:bg-surface-light hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-wait"
        :disabled="isGoingBack"
        data-test="reader-back-btn"
        @click="goBackToFileBrowser()"
      >
        {{ isGoingBack ? '...' : '← ' + t('common.back') }}
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
      :show-touch-regions="showTouchRegions"
      :direction="settings.defaultReadDirection"
      @back="goBackToFileBrowser()"
      @toggle-mode="() => settings.cycleReaderMode()"
      @open-main-menu="showMainMenu = true"
    />

    <ReaderMainMenu
      v-model:show="showMainMenu"
      :title="reader.title"
      :current-spread-index="reader.currentSpreadIndex"
      :total-spreads="reader.spreads.length"
      :scale-mode="settings.currentScaleMode"
      :mode="settings.readerDefaultMode"
      :direction="settings.defaultReadDirection"
      :is-slideshow-playing="slideshow.isPlaying"
      :slideshow-direction="slideshow.direction"
      :is-liked="(book?.isFavorite ?? false)"
      @open-jump-input="openJumpDialog"
      @show-touch-regions="onShowTouchRegions"
      @back="goBackToFileBrowser()"
      @cycle-mode="() => settings.cycleReaderMode()"
      @cycle-direction="() => settings.cycleReadDirection()"
      @scale-change="(m: ScaleMode) => settings.setScaleMode(m)"
      @toggle-slideshow="() => slideshow.toggle()"
      @toggle-slideshow-direction="onToggleSlideshowDirection"
      @navigate="(p: string) => router.push(p)"
      @add-to-library="book?.id != null && setFavorite(book.id, true)"
      @toggle-like="book?.id != null && toggleLike(book.id)"
      @add-bookmark="book?.id != null && addBookmark(book.id, currentReadPage(), null)"
    >
    </ReaderMainMenu>

    <ReaderContextMenu
      v-if="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :scale-mode="settings.currentScaleMode"
      :mode="settings.readerDefaultMode"
      :direction="settings.defaultReadDirection"
      :is-slideshow-playing="slideshow.isPlaying"
      :total-pages="pageUrls.length"
      @close="closeCtxMenu"
      @scale-change="onCtxScaleChange"
      @cycle-mode="onCtxCycleMode"
      @cycle-direction="onCtxCycleDirection"
      @toggle-slideshow="onCtxToggleSlideshow"
      @jump-page="onCtxJumpPage"
      @back="onCtxBack"
    />

    <!-- 跳页 dialog (主菜单"跳页" / 右键"跳页" 都打开) -->
    <dialog
      ref="jumpDialogRef"
      class="m-auto inset-0 bg-surface-1 xp-bd rounded-lg p-6 backdrop:bg-black/60 text-text-primary"
      data-test="jump-dialog"
    >
      <form class="flex flex-col gap-3" @submit="submitJumpDialog">
        <h3 class="text-base font-semibold">{{ t('reader.menu.jump') }}</h3>
        <label class="flex items-center gap-2 text-xs text-text-secondary">
          <span>{{ t('reader.jumpTo') }}</span>
          <input
            v-model.number="jumpDialogValue"
            type="number"
            min="1"
            :max="pageUrls.length"
            class="w-20 px-2 py-1 rounded bg-surface-inset xp-bd text-text-primary text-sm focus:outline-none focus:border-accent"
            data-test="jump-dialog-input"
          />
          <span class="text-text-muted">/ {{ pageUrls.length }}</span>
        </label>
        <div class="flex justify-end gap-2 mt-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
            data-test="jump-dialog-cancel"
            @click="closeJumpDialog"
          >{{ t('common.cancel') }}</button>
          <button
            type="submit"
            class="px-3 py-1.5 rounded text-xs bg-accent text-white hover:bg-accent-hover transition-colors"
            data-test="jump-dialog-go"
          >Go</button>
        </div>
      </form>
    </dialog>

    <!-- v0.1.0-module3.0.3: 幻灯片切换提示胶囊 (监听 isPlaying flip; 自带 1500ms auto-hide) -->
    <SlideshowToast />
  </main>
</template>