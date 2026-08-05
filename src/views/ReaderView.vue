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
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { getBook, saveProgress, getProgress, listDirectory, toggleLike, addBookmark, setFavorite } from '@/lib/tauri';
import { useReaderStore } from '@/stores/reader';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { sortEntries } from '@/lib/fileSort';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useReaderHotkeys } from '@/composables/useReaderHotkeys';
import { useReaderWheel } from '@/composables/useReaderWheel';
import { useKeepScreenOn } from '@/composables/useKeepScreenOn';
import {
  useReaderTouchZones,
  dispatchZoneAction,
} from '@/composables/useReaderTouchZones';
import { SpreadPlanner } from '@/lib/spreadPlanner';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import ReaderScreen from '@/components/reader/ReaderScreen.vue';
import ReaderMainMenu from '@/components/reader/ReaderMainMenu.vue';
import ReaderContextMenu from '@/components/reader/ReaderContextMenu.vue';
import type { ScaleMode } from '@/lib/readerSettings';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';

const route = useRoute();
const router = useRouter();
const reader = useReaderStore();
const slideshow = useSlideshowStore();
const settings = useSettingsStore();
const { t } = useI18n();

const status = ref('loading' as 'loading' | 'ready' | 'error');
const errorMessage = ref('');
const pageUrls = ref([] as string[]);
const containerRef = ref(null as HTMLElement | null);
const showMainMenu = ref(false);
// 需求4-C: 模板访问 book.isFavorite / book.id, loadBook 写入此 ref
const book = ref<Awaited<ReturnType<typeof getBook>> | null>(null);
// 需求4-A: 右键轻量上下文菜单
const ctxMenu = ref({ visible: false, x: 0, y: 0 });
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
  router.push('/');
  closeCtxMenu();
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
    router.push('/');
    return;
  }
  try {
    log('[ReaderView/loadBook] IPC[getBook] →', id);
    book.value = await getBook(id);
    const b = book.value;
    log('[ReaderView/loadBook] IPC[getBook] ←', b ? {
      id: b.id,
      title: b.title,
      absolutePath: b.absolutePath,
      coverEntryPath: b.coverEntryPath,
      coverEntryName: b.coverEntryName,
      pageCount: b.pageCount,
      lastReadAt: b.lastReadAt,
      isFavorite: b.isFavorite,
      sourceDescriptor: b.sourceDescriptor,
      sourceType: b.sourceType,
    } : 'null');
    if (!b) {
      status.value = 'error';
      errorMessage.value = `找不到 bookId ${id}`;
      log('[ReaderView/loadBook] ERROR: book is null for id', id);
      return;
    }
    // v0.1.0-module3.0.2: H1 修复后 Rust 端 fields 是 serde_json::Value,
    // IPC 边界自动拆成对象。Defensive parse 仍保留, 兼容老 DB 行 / 跨进程备份.
    // SourceDescriptor 是判别联合, 只 Local 变体有 rootPath.
    log('[ReaderView/loadBook] parseSourceDescriptor input type:', typeof b.sourceDescriptor);
    const sd = parseSourceDescriptor(b.sourceDescriptor);
    log('[ReaderView/loadBook] parseSourceDescriptor result:', sd);
    if (!sd || sd.type !== 'local' || !sd.rootPath) {
      status.value = 'error';
      errorMessage.value = 'source descriptor 解析失败或非本地资源';
      log('[ReaderView/loadBook] ERROR: sourceDescriptor invalid', { sd, rootPath: (sd as { rootPath?: string })?.rootPath });
      return;
    }
    const path = sd.rootPath;
    log('[ReaderView/loadBook] resolved rootPath=', path);
    // v0.1.0-module3.0.2-hotfix5 (H10): b.absolutePath 是相对 rootPath 的子目录路径
    // (useReaderActions 传 entry.path = 裸子目录名), 不是绝对路径. convertFileSrc
    // 内部期望绝对路径 (Rust fs::read), 必须拼 rootPath 前缀.
    // 兼容历史数据: 如果 absolutePath 已包含盘符 ('Q:\xxx'), 视为已绝对.
    const rootPath = path.replace(/[\\/]+$/, '');
    const isAlreadyAbs = b.absolutePath && /^[A-Za-z]:[\\/]/.test(b.absolutePath);
    const absDir = b.absolutePath && b.absolutePath.length > 0
      ? (isAlreadyAbs ? b.absolutePath : joinPath(rootPath, b.absolutePath))
      : rootPath;
    log('[ReaderView/loadBook] absDir computed:', {
      rootPath,
      absolutePath: b.absolutePath,
      isAlreadyAbs,
      absDir,
    });
    // v0.1.0-module3.0.2-hotfix6 (H11): 删 setRoot (省 1 IPC)
    // ReaderView 不需要 fileBrowser.entries (rootPath 根目录 entries 没用),
    // 只列 absDir 子目录. setRoot 内部已经调 fetch('')=listDirectory(rootPath),
    // 是冗余 IPC (~500ms round-trip + 458 entry 处理), 直接 listDirectory(absDir)
    // 一次完成.
    log('[ReaderView/loadBook] IPC[listDirectory] →', { descriptor: sd, path: absDir });
    const targetEntries: MediaEntry[] = await listDirectory(sd, absDir);
    log('[ReaderView/loadBook] IPC[listDirectory] ←', targetEntries.length, 'entries; first 3:', targetEntries.slice(0, 3).map((e) => `${e.name}(dir=${e.isDirectory},arc=${e.isArchive})`));
    // v0.1.0-module3.0.2-reader-polish (issue: reader 排序应与 file browser 一致):
    // 之前用 naturalSort(name) 硬编码字母序, 忽略用户在 file browser 改的排序 (modifiedAt / size, asc/desc).
    // 现用 fileBrowser.effectiveSortField / .effectiveSortAscending (含 per-folder override),
    // 与 FileList 渲染顺序完全一致; ?at= 仍按 name 找 index, 不受排序影响.
    const fb = useFileBrowserStore();
    const imageEntries: MediaEntry[] = targetEntries
      .filter((e) => !e.isDirectory && !e.isArchive && isImage(e.name));
    const sortedEntries = sortEntries(imageEntries, fb.effectiveSortField, fb.effectiveSortAscending);
    const sortedNames = sortedEntries.map((e) => e.name);
    log('[ReaderView/loadBook] imageEntries', sortedNames.length, sortedNames.slice(0, 5), '(sort=', fb.effectiveSortField, fb.effectiveSortAscending, ')');
    if (sortedNames.length === 0) {
      status.value = 'error';
      errorMessage.value = `${absDir} 下找不到图片`;
      log('[ReaderView/loadBook] ERROR: no images at', absDir);
      return;
    }
    // v0.1.0-module3.0.2-hotfix4 (H9): convertFileSrc 内部已经 encode, 不 pre-encode
    // v0.1.0-module3.0.2-hotfix7 (H13): singlePage mode 参数
    // 单页模式 spread 大小 = 1 (除 cover), 滚轮一次跳 1 张图.
    // 双页模式 spread 大小 = 2 (除 cover + 末张), 跳 2 张.
    const isSinglePage = settings.readerDefaultMode === 'single';
    log('[ReaderView/loadBook] spread mode=', isSinglePage ? 'single' : 'double');
    pageUrls.value = sortedNames.map((name) => convertFileSrc(joinPath(absDir, name)));
    log('[ReaderView/loadBook] pageUrls sample', pageUrls.value[0]);
    log('[ReaderView/loadBook] IPC[getProgress] →', id);
    const initialSpreadIndex = await resolveInitialSpreadIndex(id, sortedNames.length, isSinglePage, sortedNames);
    log('[ReaderView/loadBook] initialSpreadIndex=', initialSpreadIndex, '(pageCount=', sortedNames.length, ')');
    log('[ReaderView/loadBook] reader.openBook →', { bookId: id, title: b.title, pages: pageUrls.value.length, initialSpreadIndex, isSinglePage });
    reader.openBook({
      bookId: id,
      title: b.title || '无标题',
      pages: pageUrls.value,
      spreads: SpreadPlanner.plan(pageUrls.value.length, true, isSinglePage),
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
 * v0.1.0-module3.0.2-hotfix5: 跨平台 path join (Windows '\\' / POSIX '/')
 *  - 用于 rootPath + absolutePath 或 absolutePath + filename 拼接
 *  - 保留 Windows '\\' 分隔符, 让 convertFileSrc encode 后 Rust fs::read 正确处理
 *  - 不 trim 各 segment 内部分隔符 (例如 absolutePath 'root/漫画' 中的 '/' 不动),
 *    只在 segment 边界加 1 个 '\\'
 */
function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter((s) => s && s.length > 0)
    .map((s) => s.replace(/[\\/]+$/, ''));  // 只去尾部分隔符
  return cleaned.join('\\');
}

/**
 * v0.1.0-module3.0.2-hotfix3 (H8): percent-encode path segments
 *  - 老 pageUrls = convertFileSrc('Q:\\dir\\(林星阑) - 秀人网模特 红衣黑丝\\c (1).jpg')
 *    生成 'http://asset.localhost/Q:\\...\\(林星阑) - ...\\c (1).jpg'
 *  - 括号 / 空格 / 中文未 encode, WebView2 fetch asset:// 路径解析失败
 *    OSD tile-load-failed, 翻页后图片不显示
 *  - 修: encodeURIComponent 每段, 保留分隔符 (Windows '\\' / POSIX '/')
 *  - 注意: drive letter 'Q:' 必须保留, 所以 split '\\' / '/' 后只 encode
 *    非 drive-letter 段
 */
// v0.1.0-module3.0.2-hotfix3 撤回 — encodePathForUrl 不需要 (H9)
// Tauri 2 的 convertFileSrc 内部已经 percent-encode path (调用了
// encodeURI). 前端再 encode 会双重编码: '%2528' 解码一次是 '%28',
// 不是 '(' — Tauri Rust 端拿 '%28...' 当字面字符串找不到文件.
// 直接传 raw path 即可, 让 convertFileSrc 内部统一处理.

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
 *
 * v0.1.0-module3.0.2-reader-polish (Cluster A): 优先 ?at=imageName
 *  - 双击图片 / 选中图片立即阅读时, 用 imageEntry.name 在 sortedNames 找 index
 *  - page→spread 映射同 saved progress 路径
 *  - 末页钳位仍生效
 */
async function resolveInitialSpreadIndex(
  bookId: number,
  pageCount: number,
  singlePage: boolean = false,
  imageNames: string[] = [],
): Promise<number> {
  // 优先: Cluster A 入口 (双击/选中图片) — 用户显式选择, 不做末页钳位
  const atName = initialImageName.value;
  if (atName && imageNames.includes(atName)) {
    const idx = imageNames.indexOf(atName);
    const spreads = SpreadPlanner.plan(pageCount, true, singlePage);
    const last = spreads.length - 1;
    if (last < 0) return 0;
    const target = SpreadPlanner.spreadIndexForPage(idx, spreads);
    const clamped = Math.max(0, Math.min(target, last));
    log('[ReaderView/resolveInitialSpreadIndex] from ?at=', atName, '→ idx=', idx, '→ spread=', clamped, '(last=', last, ') [no last-clamp for explicit choice]');
    return clamped;
  }
  // 缺省: 读 saved progress (H5)
  try {
    const progress = await getProgress(bookId);
    if (!progress) return 0;
    const spreads = SpreadPlanner.plan(pageCount, true, singlePage);
    const last = spreads.length - 1;
    if (last < 0) return 0;
    const idx = SpreadPlanner.spreadIndexForPage(progress.page, spreads);
    const clamped = Math.max(0, Math.min(idx, last));
    log('[ReaderView/resolveInitialSpreadIndex] from saved progress page=', progress.page, '→ spread=', clamped, '(last=', last, ')');
    return clamped >= last ? Math.max(0, last - 1) : clamped;
  } catch (e) {
    log('[ReaderView/resolveInitialSpreadIndex] fallback 0:', e);
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
  // v0.1.0-module3.0: 新增 fit-width + open-file-browser 回调
  fitWidth: () => {
    // Cluster C: 调 setScaleMode 立即 apply + 持久化 (was: 只写 defaultScaleMode 下次生效)
    void settings.setScaleMode('fit-width');
  },
  openFileBrowser: () => { router.push('/'); },
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
        class="px-3 py-1.5 rounded xp-bd bg-surface-1 text-text-secondary text-xs hover:bg-surface-light hover:text-text-primary transition-colors"
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
      :show-touch-regions="showTouchRegions"
      :direction="settings.defaultReadDirection"
      @back="router.push('/')"
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
      @back="router.push('/')"
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
  </main>
</template>