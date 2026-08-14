/**
 * ReaderView.vue — v0.1.0-module2.0 阅读器路由 wrapper
 *
 * - mount: 解析 :bookId → listHistory 找 source_descriptor
 *          listDirectory 拿 MediaEntry[] 拼 convertFileSrc URL
 *          readerStore.openBook
 * - unmount: saveProgress 兜底 + closeBook
 * - 跨卷 (pendingNextVolume) watch 处理
 * - 滚轮 / 鼠标按键 已 useReaderHotkeys() 接管 (内含 wheel listener)
 *
 * v0.1.0-reader-review fixes:
 *  - 新增 jumpDialog + openJumpDialog 处理 main menu 的 open-jump-input 事件
 *  - cycle-direction 改为切换 settings.defaultReadDirection (之前误改 slideshow.direction)
 *  - ctx menu direction 从 settings.defaultReadDirection 派生 (之前误用 slideshow.direction)
 *  - 错误返回按钮 border-white/10 → xp-bd (light 模式可见)
 *
 * 2026-08-12 跨卷任务 8 (spec §11): 编排层总装
 *  - route watch immediate 唯一入口（删 onMounted loadBook）—— 不变量 2
 *  - loadRouteBook 去重看 phase=ready（lastLoadedBookId + bookLoadPhase）—— 不变量 4
 *  - 失败不保留旧卷（reader.closeBook + 清 refs + status=error）—— 不变量 3
 *  - activeLoadSeq 非响应式局部变量（let）防 race —— P0-3
 *  - commitBookSnapshot 原子提交 (sourceDescriptor/currentRelPath 写入 reader store)
 *  - currentIdentity() 加载期返回 null (P1-1)
 *  - useCrossVolume 8 opts 注入（identity/navigateToVolume/saveCurrentProgressNow/
 *    pushToast/getContinueMode/pauseSlideshow/consumePendingNextVolume/canStart）
 *  - 末页 → reader.setOnAtLastNextAttempt → slideshow.pendingNextVolume
 *  - watch pendingNextVolume → crossVolume.maybeContinue(false, 'next')
 *  - Alt+→ 经 useReaderHotkeys({ nextVolume: () => crossVolume.maybeContinue(true,'next') })
 *  - ContinueNextVolumeToast 保留在 ReaderView (只 reader 场景显示, props 来自 crossVolume 实例)
 *  - onUnmounted: setOnAtLastNextAttempt(null) + activeLoadSeq++ + saveCurrentProgressNow
 *    兜底 + slideshow.pause + reader.closeBook
 */
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { type BookItem, addBookmark, setFavorite } from '@/lib/tauri';
import { useReaderStore } from '@/stores/reader';
import { SpreadPlanner } from '@/lib/spreadPlanner';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { useReaderWheel } from '@/composables/useReaderWheel';
import { useKeepScreenOn } from '@/composables/useKeepScreenOn';
import {
  useReaderBookLoader,
  type BookIdentity,
  type NextVolumeTarget,
  type ReaderBookSnapshot,
} from '@/composables/useReaderBookLoader';
import { useCrossVolume } from '@/composables/useCrossVolume';
import { useToast } from '@/composables/useToast';
import { log } from '@/lib/logger';
import ReaderScreen from '@/components/reader/ReaderScreen.vue';
import ReaderMainMenu from '@/components/reader/ReaderMainMenu.vue';
import ReaderContextMenu from '@/components/reader/ReaderContextMenu.vue';
import SlideshowToast from '@/components/reader/SlideshowToast.vue';
import ContinueNextVolumeToast from '@/components/reader/ContinueNextVolumeToast.vue';
import type { ScaleMode } from '@/lib/readerSettings';

const route = useRoute();
const router = useRouter();
const reader = useReaderStore();
const slideshow = useSlideshowStore();
const settings = useSettingsStore();
const { t } = useI18n();
const loader = useReaderBookLoader();
const toast = useToast();

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
// v0.1.0-module3.0.7 round-4 P1: onToggleLike 的 in-flight guard。
// 防止用户快速重开菜单双击导致两次都基于旧 isFavorite 计算 nextFav,
// 写出重复值(如 setFavorite(id,true) × 2)无法取消喜欢。
const likeToggleInFlight = ref(false);
// 需求4-A: 右键轻量上下文菜单
const ctxMenu = ref({ visible: false, x: 0, y: 0 });
// v0.1.0-module3.0.3-hotfix3 (Bug 4): back btn 视觉反馈, 防止双击 & 让用户知道在跳转
const isGoingBack = ref(false);
// v0.1.0-reader-review: 跳页 dialog (主菜单"跳页"按钮 / 右键"跳页"都打开它)
const jumpDialogRef = ref<HTMLDialogElement | null>(null);
const jumpDialogValue = ref(1);

// 2026-08-12 跨卷任务 8 (spec §11.1): route watch 唯一入口状态
// lastLoadedBookId: 上次成功 load 的 bookId, 用于去重（phase=ready 时跳过）
// bookLoadPhase: load 生命周期（idle/loading/ready/error）, canStart 依赖 ready
// visibleReader: 模板控制, 加载期隐藏旧卷画面（不保留旧卷, 不变量 3）
// activeLoadSeq: 非响应式局部变量（let, 非 const 非 ref）—— P0-3
//   模板不消费; await 后若 seq !== activeLoadSeq 即丢弃; onUnmounted += 1 使在途失效。
const lastLoadedBookId = ref<number | null>(null);
const bookLoadPhase = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const visibleReader = ref(false);
let activeLoadSeq = 0;

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

// v0.1.0-module3.0.7: Reader 主菜单 ❤️ toggle handler。
// 关键: IPC 成功后同步本地 book ref,否则同会话无法反复切换
// (book 是 get_book 单次查的快照,不刷则下次点击仍读旧 isFavorite,
//  第二次会再写 setFavorite(id, true),无法取消喜欢 — round-1 P1 反馈)。
//
// round-4 P1 并发竞态修复: in-flight guard 防止重入。
// 若无 guard,用户在 await setFavorite 期间再次点击,两次都基于同一个旧值
// 计算 nextFav,会写出重复值。guard 让第二次点击被静默忽略(IPC 本地 ~10ms,
// 用户从关菜单到再开菜单通常 >100ms,感知不到)。
async function onToggleLike(): Promise<void> {
  if (!book.value?.id) return;
  if (likeToggleInFlight.value) return;
  likeToggleInFlight.value = true;
  try {
    const nextFav = !book.value.isFavorite;
    await setFavorite(book.value.id, nextFav);
    book.value = { ...book.value, isFavorite: nextFav };
  } finally {
    likeToggleInFlight.value = false;
  }
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

// 2026-08-12 跨卷任务 8 (spec §11.1): 不再用 computed 包 route.params.bookId,
// loadRouteBook 直接接 watch source 参数。

// Cluster A: route.query.at 是双击图片 / 选中图片立即阅读时携带的起始图片名
// (useReaderActions.readFromImage 写入). ReaderView 优先用此图所在 spread,
// 而不是 saved progress. 用户显式选择 — 不做末页钳位 (避免"刚开就跨卷"逻辑仅适用于自动恢复).
const initialImageName = computed<string | null>(() => {
  const v = route.query.at;
  return typeof v === 'string' ? decodeURIComponent(v) : null;
});

// 2026-08-12 跨卷任务 8 (spec §11.1): route watch 唯一入口 (替代 onMounted loadBook)
// 首次挂载靠 immediate: true; bookId 变化 (跨卷) 靠 watcher 触发。
// 删 onMounted(loadBook) 以避免双加载 (不变量 2)。
watch(
  () => Number(route.params.bookId),
  (id) => void loadRouteBook(id),
  { immediate: true },
);

async function loadRouteBook(bookId: number): Promise<void> {
  // 不变量 4: 去重只看 phase='ready' (失败 / 取消后可重试)
  if (bookId === lastLoadedBookId.value && bookLoadPhase.value === 'ready') return;

  const seq = ++activeLoadSeq;
  bookLoadPhase.value = 'loading';
  visibleReader.value = false;  // 不变量 3: route 变即进 loading (失败不保留旧卷)

  try {
    const snapshot = await loader.loadBookById(bookId, {
      explicitImageName: initialImageName.value ?? undefined,
    });
    // P0-3: 旧卷晚返回丢弃 (activeLoadSeq 自增后, 旧 seq 不再匹配)
    if (seq !== activeLoadSeq) return;
    commitBookSnapshot(snapshot);
    lastLoadedBookId.value = bookId;
    bookLoadPhase.value = 'ready';
    status.value = 'ready';
    visibleReader.value = true;
    log('[ReaderView/loadRouteBook] committed, bookId=', bookId, 'seq=', seq);
  } catch (error) {
    if (seq !== activeLoadSeq) return;
    // 不变量 3: 失败不保留旧卷 (route 已是新 bookId, 不该展示旧画面)
    reader.closeBook();
    pageUrls.value = [];
    imageNames.value = [];
    book.value = null;
    bookLoadPhase.value = 'error';
    status.value = 'error';
    errorMessage.value = error instanceof Error ? error.message : String(error);
    log('[ReaderView/loadRouteBook] FAILED, bookId=', bookId, 'seq=', seq, 'err=', error);
  }
}

/**
 * v0.1.0-module3.0.8: 原子提交 Loader 返回的不可变 Snapshot.
 * 2026-08-12 跨卷任务 8: 加 sourceDescriptor / currentRelPath 写入 reader.openBook
 * (跨卷 CrossVolumeController.identity() 依赖这 2 字段).
 */
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
    sourceDescriptor: snapshot.descriptor,
    currentRelPath: snapshot.relPath,
  });
  reader.imageNames = snapshot.imageNames;
}

/** 显式重试（失败 / 取消后）。lastLoadedBookId 置 null 跳过 ready 去重。
 *  本版 UI 未挂重试按钮, 但保留为公开函数 (暴露给未来 error UI 或调试用)。
 *  当前通过 defineExpose 暴露 (vm.retryCurrentBook 可调)。 */
async function retryCurrentBook(): Promise<void> {
  lastLoadedBookId.value = null;
  await loadRouteBook(Number(route.params.bookId));
}

defineExpose({ retryCurrentBook });

/**
 * 2026-08-12 跨卷任务 8 (spec §11.2): Controller 注入的 navigateToVolume.
 * 步骤 ⑤⑥: loader.ensureBookId (DB UPSERT) + router.replace (at 清空).
 * 步骤 ①②③④ 已在 Controller.navigateResolvedTarget 完成 (identity 校验 + trySave + slideshow.pause + 再校验).
 */
async function navigateToVolume(target: NextVolumeTarget): Promise<void> {
  const bookId = await loader.ensureBookId(target);
  await router.replace({ name: 'reader', params: { bookId }, query: {} });
}

/**
 * 2026-08-12 跨卷任务 8 (spec §11.2 P1-1): 当前卷身份.
 * 加载期 (bookLoadPhase !== 'ready') 或 reader store 与 route 不一致时返回 null.
 * Controller.canStart + identity 双重保护：加载期 maybeContinue 直接 return,
 * 即使 hotkey/watch 绕过 UI busy 检查也无法发起跨卷.
 */
function currentIdentity(): BookIdentity | null {
  if (bookLoadPhase.value !== 'ready') return null;
  if (reader.bookId === null || reader.sourceDescriptor === null) return null;
  if (reader.bookId !== Number(route.params.bookId)) return null;
  return {
    descriptor: reader.sourceDescriptor,
    relPath: reader.currentRelPath,
    bookId: reader.bookId,
  };
}

/**
 * 2026-08-12 跨卷任务 8 (spec §11.3): CrossVolumeController 实例化.
 * 10 个 opts 全注入（identity / navigateToVolume / saveCurrentProgressNow / pushToast /
 * getContinueMode / pauseSlideshow / consumePendingNextVolume / canStart /
 * isSlideshowPlaying / resumeSlideshow）.
 * A7 修复: isSlideshowPlaying 在 maybeContinue 入口捕获 isPlaying 状态;
 *          resumeSlideshow 是 slideshow.start() —— Controller 内部已用 wasSlideshowPlaying guard,
 *          所以 ReaderView 这边直接调 start 即可.
 * ReaderView 单实例所有权（Toast 不调 useCrossVolume, P0-2 修复）.
 */
const crossVolume = useCrossVolume({
  identity: currentIdentity,
  navigateToVolume,
  saveCurrentProgressNow: () => reader.saveCurrentProgressNow(),
  pushToast: (k, p?: Record<string, unknown>) => toast.push(t(k, p ?? {})),
  getContinueMode: () => settings.continueToNextVolume,
  pauseSlideshow: () => slideshow.pause(),
  consumePendingNextVolume: () => slideshow.consumePendingNextVolume(),
  canStart: () => bookLoadPhase.value === 'ready',
  isSlideshowPlaying: () => slideshow.isPlaying,
  resumeSlideshow: () => slideshow.start(),
});

// 末页跨卷意图 (spec §9 reader.nextPage atLast → onAtLastNextAttempt 回调):
// 写 slideshow.pendingNextVolume → 下方统一 watch 消费。
reader.setOnAtLastNextAttempt(() => { slideshow.pendingNextVolume = true; });

// 单一 watch 消费 pendingNextVolume (手动末页 + slideshow 末页统一).
watch(
  () => slideshow.pendingNextVolume,
  (v) => {
    log('[ReaderView/watch] pendingNextVolume →', v);
    if (v) void crossVolume.maybeContinue(false, 'next');  // 看模式
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

/**
 * v0.1.0-module3.0.2: M5 修复 — mode 切换时重算 spreads + 保持当前页码.
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

/**
 * v0.1.0-module3.0.2: M5 修复 — 把写好的 useReaderWheel 实际挂上 (containerRef),
 * preventDefault 阻止页面滚动 + OSD 内部滚轮缩放. ReaderScreen 那边 SinglePageViewer
 * 已经 scrollToZoom=false, 此处 containerRef 接 wheel 接管翻页.
 * 2026-08-12 跨卷任务 8: useReaderHotkeys 加 actions 参数 (nextVolume → crossVolume.maybeContinue).
 */
useReaderHotkeys({
  nextVolume: () => { void crossVolume.maybeContinue(true, 'next'); },
});
useReaderWheel({
  containerRef,
  onPrev: () => { reader.prevPage(); slideshow.reset(); },
  onNext: () => { reader.nextPage(); slideshow.reset(); },
});

const keepScreenOnRef = computed(() => settings.keepScreenOn);
useKeepScreenOn(keepScreenOnRef);

// 2026-08-12 跨卷任务 8: onUnmounted 清理回调 + activeLoadSeq++ + saveCurrentProgressNow 兜底.
// 不变量 10 + 11.
onUnmounted(() => {
  log('[ReaderView/onUnmounted] start; bookId=', reader.bookId, 'currentSpreadIndex=', reader.currentSpreadIndex);
  reader.setOnAtLastNextAttempt(null);  // 不变量 11: 清理 Pinia store 持有的旧组件闭包
  activeLoadSeq += 1;                    // P0-3: 使在途 Loader 失效, 卸载后不执行提交
  if (reader.bookId !== null) {
    void reader.saveCurrentProgressNow();  // 兜底 (不依赖 store 防抖, 立即 await)
  }
  slideshow.pause();
  reader.closeBook();
  log('[ReaderView/onUnmounted] done');
});
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
      v-else-if="status === 'ready' && reader.status === 'ready' && visibleReader"
      class="flex-1 min-h-0"
      :page-urls="pageUrls"
      :spreads="reader.spreads"
      :initial-spread-index="reader.currentSpreadIndex"
      :mode="settings.readerDefaultMode"
      :title="reader.title"
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
      @back="goBackToFileBrowser()"
      @cycle-mode="() => settings.cycleReaderMode()"
      @cycle-direction="() => settings.cycleReadDirection()"
      @scale-change="(m: ScaleMode) => settings.setScaleMode(m)"
      @toggle-slideshow="() => slideshow.toggle()"
      @toggle-slideshow-direction="onToggleSlideshowDirection"
      @navigate="(p: string) => router.push(p)"
      @toggle-like="onToggleLike"
      @add-bookmark="book?.id != null && addBookmark(book.id, reader.currentSpreadIndex, null)"
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
    <!-- 2026-08-12 跨卷任务 8: 跨卷 manual 模式底部胶囊 (纯 props/emits, 不调 useCrossVolume) -->
    <!-- ToastHost 已上移到 App.vue 顶层 (跨卷审查 I1), 让 FileBrowser 跨卷 toast 也能渲染 -->
    <ContinueNextVolumeToast
      :target="crossVolume.pendingCrossVolume.value"
      :loading="crossVolume.phase.value === 'navigating'"
      @jump="() => crossVolume.confirmManual()"
      @close="() => crossVolume.dismissManual()"
    />
  </main>
</template>
