<script setup lang="ts">
/**
 * FileBrowser.vue — 模块 #1 主屏
 *
 * v0.1.0-module1.22: 全面重构 —
 *  - 排 / 视图 / 选中 / hideFinished 状态全在 store, FileBrowser 只消费
 *  - 原生 <select> 全部替换为 Xplorer 风格 dropdown (ShortcutDropdown / SortDropdown / ViewModeDropdown)
 *  - 单击接 store.selectFile (Ctrl/Shift 多选), 双击 emit open
 *  - 集成 StatusBar (3 段式) + EntryDetailPanel (1 选中时显示)
 *  - FileList 接收 sortedEntries (不再内部 sort)
 *
 * v0.1.0-module2.0: 触发阅读 / 加入书库 —
 *  - 移除双击 emit open (双击只进目录)
 *  - 选中目录后启用 toolbar 「立即阅读」按钮
 *  - EntryDetailPanel 显示 3 个 CTA: 立即阅读 / 加入书库 / 下载全部 (stub)
 *  - 右键菜单 (RowContextMenu) 加 立即阅读 / 加入书库 项
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getSetting, setSetting } from '@/lib/tauri';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useReadStatusStore } from '@/stores/readStatus';
import { useReaderActions } from '@/composables/useReaderActions';
import { log } from '@/lib/logger';
import FileList from './FileList.vue';
import Breadcrumb from './Breadcrumb.vue';
import RowContextMenu from './RowContextMenu.vue';
import SortDropdown from './SortDropdown.vue';
import ViewModeDropdown from './ViewModeDropdown.vue';
import ShortcutDropdown from './ShortcutDropdown.vue';
import StatusBar from './StatusBar.vue';
import EntryDetailPanel from './EntryDetailPanel.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

const { t } = useI18n();
const fb = useFileBrowserStore();
const shortcuts = useShortcutsStore();
const readStatus = useReadStatusStore();
const readerActions = useReaderActions({
  resolveRootPath: (entry) => {
    const base = fb.lastFetchedPath ?? '';
    return base ? `${base}/${entry.path}` : entry.path;
  },
  buildSourceDescriptor: (rootPath) => ({ type: 'local', rootPath }),
  onLibraryChanged: async () => {
    await readStatus.refresh();
  },
});

const showSaveDialog = ref(false);
const saveLabel = ref('');
// 右键菜单状态
const ctxMenu = ref<{ entry: MediaEntry; x: number; y: number } | null>(null);
// 1 选中时显示详情面板
const selectedEntry = computed<MediaEntry | null>(() => {
  if (fb.selectedPaths.size !== 1) return null;
  const path = [...fb.selectedPaths][0];
  return fb.sortedEntries.find((e) => e.path === path) ?? null;
});

const canSave = computed(() => fb.rootPath !== null);
const canUp = computed(() => fb.currentPath !== '');

/** 当前路径: rootPath + '/' + currentPath (空时仅 rootPath) */
const displayPath = computed(() => {
  if (!fb.rootPath) return '';
  return fb.currentPath ? `${fb.rootPath}/${fb.currentPath}` : fb.rootPath;
});

const LAST_ROOT_KEY = 'file_browser_last_root';

onMounted(async () => {
  await shortcuts.refresh();
  await readStatus.refresh();
  // v0.1.0-module1.22: 加载 sortField/sortAscending/viewMode/hideFinished 持久化
  await fb.loadLayout();
  // #1 启动时读上次根目录, 自动加载
  try {
    const stored = await getSetting(LAST_ROOT_KEY);
    if (stored && typeof stored === 'string' && stored.length > 0) {
      await fb.setRoot(stored);
    }
  } catch {
    // 静默回退: 显示 empty state
  }
});

// #1 rootPath 变化时持久化
watch(
  () => fb.rootPath,
  async (next) => {
    try {
      if (next) {
        await setSetting(LAST_ROOT_KEY, next);
      }
    } catch {
      // silent
    }
  },
);

// shortcut 切换 → 设 fb.rootPath
watch(
  () => shortcuts.activeId,
  async (id) => {
    if (id === null) return;
    const sc = shortcuts.items.find((s) => s.id === id);
    if (sc && sc.rootPath !== fb.rootPath) {
      await fb.setRoot(sc.rootPath);
    }
  },
);

async function onUp() {
  await fb.up();
}

async function onRefresh() {
  await fb.refresh();
}

async function onPickRoot() {
  try {
    const mod = (await import('@tauri-apps/plugin-dialog').catch(() => null)) as
      | { open?: (opts: unknown) => Promise<string | null> }
      | null;
    if (!mod?.open) return;
    const path = await mod.open({ directory: true });
    if (path && typeof path === 'string') {
      await fb.setRoot(path);
    }
  } catch {
    // silent
  }
}

function onSaveClick() {
  saveLabel.value = '';
  showSaveDialog.value = true;
}

function onSaveCancel() {
  showSaveDialog.value = false;
  saveLabel.value = '';
}

async function onSaveSubmit() {
  if (!fb.rootPath) return;
  const label = saveLabel.value.trim() || null;
  await shortcuts.add(fb.rootPath, label);
  showSaveDialog.value = false;
  saveLabel.value = '';
}

function truncatePath(p: string, head = 60, tail = 60): string {
  if (p.length <= head + tail + 5) return p;
  return `${p.slice(0, head)}…${p.slice(-tail)}`;
}

function errorMessage(kind: string, msg: string): string {
  if (kind === 'notFound' && msg.length > 200) {
    return t('error.pathTooLong') + ' — ' + truncatePath(msg, 50, 50);
  }
  const tr = truncatePath(msg);
  if (kind === 'notFound') return t('error.fileNotFound') + ': ' + tr;
  if (kind === 'permissionDenied') return t('error.permissionDenied') + ': ' + tr;
  return t('error.ioError') + ': ' + tr;
}

/**
 * FileList @open handler (双击进入)
 * v0.1.0-module2.0: 双击只进目录, 不再触发 reader. 进 reader 走:
 *  - toolbar 立即阅读按钮
 *  - EntryDetailPanel CTA
 *  - 右键菜单 readNow
 */
async function onEntryOpen(entry: MediaEntry) {
  log('[FileBrowser] onEntryOpen', entry.name, 'isDirectory=', entry.isDirectory, 'lastFetchedPath=', fb.lastFetchedPath);
  if (entry.isDirectory) {
    const newPath = fb.lastFetchedPath
      ? `${fb.lastFetchedPath}/${entry.path}`.replace(/\/+/g, '/')
      : entry.path;
    await fb.navigate(newPath);
    return;
  }
  // 文件行: 双击也无操作 (避免误触发)
  log('[FileBrowser] double-click on file is no-op (use right-click → read-now on containing folder)');
}

/** FileList @select handler (单击) → 走 store.selectFile 区分单选/Ctrl/Shift */
function onEntrySelect(entry: MediaEntry, event: MouseEvent | KeyboardEvent) {
  fb.selectFile(entry, event);
}

function onRowContextMenu(entry: MediaEntry, x: number, y: number) {
  ctxMenu.value = { entry, x, y };
}

function onCtxClose() {
  ctxMenu.value = null;
}

async function onBreadcrumbNavigate(path: string) {
  await fb.navigate(path);
}

const rootLabel = computed(() => {
  if (!fb.rootPath) return t('nav.fileBrowser');
  const parts = fb.rootPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fb.rootPath;
});

/* ─── Lucide SVG 图标路径 ─── */
const ICON_EYE = 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const ICON_EYE_OFF = 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22';
const ICON_UP = 'M5 12l7-7 7 7M12 19V5';
const ICON_REFRESH = 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5';
const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ICON_STAR = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';
const ICON_FOLDER_OPEN = 'M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2';
const ICON_ALERT = 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01';

// v0.1.0-module2.0: emit 'open' 已废弃 (双击只进目录, 触发阅读走 useReaderActions)
//  保留 emit 类型仅出于向后兼容 — 不再 emit

// selectedEntry 已在前面声明 (line 46, 复用 store.selectedPaths + sortedEntries)
const canReadNow = computed(() => selectedEntry.value?.isDirectory === true);

function onReadNowClick() {
  if (selectedEntry.value) {
    void readerActions.readNow(selectedEntry.value);
  }
}
function onAddToLibraryClick() {
  // 当前 v0.1.0-module2.0: addToLibrary 等于 readNow 不导航; 暂不暴露差异
  if (selectedEntry.value) {
    void readerActions.addToLibrary(selectedEntry.value);
  }
}

function onReadNowFromCtx(entry: MediaEntry) {
  void readerActions.readNow(entry);
}
function onAddToLibraryFromCtx(entry: MediaEntry) {
  void readerActions.addToLibrary(entry);
}
</script>

<template>
  <main class="flex flex-col h-full gap-2 p-4" data-test="file-browser">
    <!-- empty state -->
    <div
      v-if="fb.rootPath === null"
      class="flex-1 flex flex-col items-center justify-center gap-5 p-8"
      data-test="empty-state"
    >
      <div
        class="w-16 h-16 rounded-2xl bg-surface-1 border border-white/10 flex items-center justify-center backdrop-blur-md"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
             stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path :d="ICON_FOLDER_OPEN" />
        </svg>
      </div>
      <p class="text-text-muted text-sm m-0">{{ t('fileBrowser.noShortcut') }}</p>
      <button
        data-test="btn-pick"
        class="flex items-center gap-2 px-5 py-2.5 bg-accent text-white border-0 rounded-md font-semibold cursor-pointer shadow-[0_0_12px_rgba(99,102,241,0.45)] transition-[background,transform,box-shadow] duration-100 hover:bg-accent-hover hover:shadow-[0_0_18px_rgba(99,102,241,0.65)] active:translate-y-px"
        @click="onPickRoot"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path :d="ICON_FOLDER" />
        </svg>
        {{ t('fileBrowser.pickRoot') }}
      </button>
      <RouterLink
        to="/shortcuts"
        class="text-accent no-underline text-sm transition-colors duration-100 hover:text-accent-hover hover:underline"
        data-test="link-to-shortcuts"
      >
        {{ t('fileBrowser.goShortcuts') }} →
      </RouterLink>
    </div>

    <!-- main view -->
    <template v-else>
      <!-- Toolbar -->
      <header
        class="bg-surface border-b border-white/5 px-3 py-1.5 flex items-center gap-1 flex-wrap"
        data-test="toolbar"
      >
        <button data-test="btn-up" class="tb-btn" :disabled="!canUp" @click="onUp">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_UP" />
          </svg>
          {{ t('fileBrowser.up') }}
        </button>
        <button data-test="btn-refresh" class="tb-btn" :disabled="fb.loading" @click="onRefresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_REFRESH" />
          </svg>
          {{ t('fileBrowser.refresh') }}
        </button>
        <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />
        <ShortcutDropdown />
        <button data-test="btn-pick" class="tb-btn" @click="onPickRoot">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_FOLDER" />
          </svg>
          {{ t('fileBrowser.pickRoot') }}
        </button>
        <button data-test="btn-save" class="tb-btn" :disabled="!canSave" @click="onSaveClick">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_STAR" />
          </svg>
          {{ t('fileBrowser.saveAsShortcut') }}
        </button>
        <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />
        <button
          data-test="btn-read-now"
          class="tb-btn text-accent"
          :disabled="!canReadNow"
          :title="canReadNow ? t('fileBrowser.readNow') : t('fileBrowser.noImagesInFolder')"
          @click="onReadNowClick"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
          {{ t('fileBrowser.readNow') }}
        </button>
        <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />
        <button
          data-test="btn-hide-finished"
          class="tb-btn"
          :title="fb.hideFinished ? t('fileBrowser.showFinished') : t('fileBrowser.hideFinished')"
          @click="fb.setHideFinished(!fb.hideFinished)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path v-if="fb.hideFinished" :d="ICON_EYE" />
            <path v-else :d="ICON_EYE_OFF" />
          </svg>
        </button>
        <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />
        <SortDropdown />
        <ViewModeDropdown />
      </header>

      <Breadcrumb
        :root-label="rootLabel"
        :path="fb.currentPath"
        data-test="breadcrumb"
        @navigate="onBreadcrumbNavigate"
      />

      <!-- Error toast -->
      <p
        v-if="fb.error"
        class="flex items-center gap-3 px-4 py-3 bg-error/8 border border-error rounded text-sm text-text-primary shadow-[0_0_10px_rgba(248,113,113,0.3)]"
        data-test="error-toast"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="var(--color-error)" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path :d="ICON_ALERT" />
        </svg>
        <span data-test="error-message" class="text-error flex-1 min-w-0 break-all">
          {{ errorMessage(fb.error.kind, fb.error.message) }}
        </span>
        <span class="flex gap-2 shrink-0">
          <button
            v-if="fb.currentPath !== ''"
            data-test="error-up"
            class="px-3 py-1 border border-error bg-transparent text-error rounded-xs text-xs cursor-pointer transition-colors duration-100 hover:bg-error/20"
            @click="onUp"
          >
            ↑ {{ t('fileBrowser.up') }}
          </button>
          <button
            data-test="error-refresh"
            class="px-3 py-1 border border-error bg-transparent text-error rounded-xs text-xs cursor-pointer transition-colors duration-100 hover:bg-error/20"
            @click="onRefresh"
          >
            {{ t('fileBrowser.refresh') }}
          </button>
        </span>
      </p>

      <!-- Main: 左侧 FileList + 右侧 DetailPanel (1 选中时) -->
      <div class="flex-1 flex gap-2 min-h-0 overflow-hidden">
        <FileList
          class="flex-1 min-w-0"
          :entries="fb.sortedEntries"
          :loading="fb.loading"
          :marks="readStatus.marks"
          :selected-paths="fb.selectedPaths"
          :view-mode="fb.viewMode"
          data-test="filelist"
          @open="onEntryOpen"
          @select="onEntrySelect"
          @contextmenu="onRowContextMenu"
        />
        <EntryDetailPanel
          v-if="selectedEntry"
          :entry="selectedEntry"
          :root-path="fb.rootPath"
          class="w-72 shrink-0 overflow-y-auto"
          @read-now="onReadNowClick"
          @add-to-library="onAddToLibraryClick"
        />
      </div>

      <p v-if="fb.loading" class="text-text-tertiary text-xs m-0 px-3 py-2">
        {{ t('common.loading') }}
      </p>

      <!-- StatusBar (v0.1.0-module1.22 新增) -->
      <StatusBar
        :total="fb.sortedEntries.length"
        :selected-count="fb.selectedCount"
        :selection-size-bytes="fb.selectionSizeBytes"
        :current-path="displayPath"
      />

      <!-- Save dialog -->
      <div
        v-if="showSaveDialog"
        class="absolute inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-[1000]"
        data-test="save-dialog"
        @click.self="onSaveCancel"
      >
        <div class="bg-surface-4 border border-white/10 rounded-lg p-6 flex flex-col gap-4 min-w-[380px] shadow-lg">
          <h3 class="m-0 text-base font-semibold text-text-primary flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="#6366f1" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <path :d="ICON_STAR" />
            </svg>
            {{ t('fileBrowser.saveAsShortcut') }}
          </h3>
          <label class="flex flex-col gap-2 text-xs text-text-secondary">
            {{ t('fileBrowser.shortcutLabel') }}
            <input
              v-model="saveLabel"
              data-test="save-label-input"
              class="px-3 py-2 bg-surface-inset border border-white/10 text-text-primary rounded text-sm transition-[border-color,box-shadow] duration-100 outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
            />
          </label>
          <div class="flex justify-end gap-2 mt-2">
            <button
              class="px-4 py-2 border border-white/10 bg-transparent text-text-secondary rounded cursor-pointer transition-[background,color] duration-100 hover:bg-surface-2 hover:text-text-primary"
              @click="onSaveCancel"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              data-test="btn-save-submit"
              class="flex items-center gap-1.5 px-4 py-2 bg-accent border border-accent text-white rounded cursor-pointer font-semibold shadow-[0_0_10px_rgba(99,102,241,0.4)] transition-[background,transform] duration-100 hover:bg-accent-hover active:translate-y-px"
              @click="onSaveSubmit"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <RowContextMenu
      v-if="ctxMenu"
      :entry="ctxMenu.entry"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      @close="onCtxClose"
      @read-now="onReadNowFromCtx"
      @add-to-library="onAddToLibraryFromCtx"
    />
  </main>
</template>

<style scoped>
/* ─── 工具栏按钮统一 base (Xplorer 风格) ─── */
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
}
.tb-btn:hover:not(:disabled) {
  background: var(--color-surface-light);
  color: var(--color-text-primary);
}
.tb-btn:active:not(:disabled) {
  color: var(--color-accent);
}
.tb-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
