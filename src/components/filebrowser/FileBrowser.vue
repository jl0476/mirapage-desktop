<script setup lang="ts">
/**
 * FileBrowser.vue — 模块 #1 主屏
 * 5 元素工具栏 + Breadcrumb + FileList + 错误 toast + empty state + save dialog
 *
 * v0.1.0-module1.19: 全样式重写 —
 *   - emoji (📁 🔄 ⭐ ↑) 全部替换为 lucide SVG 图标
 *   - 旧 var(--accent) / var(--surface-1) 改用新 --color-* token
 *   - 工具栏 / save dialog 用 indigo accent + glassmorphism
 *   - empty state / error toast 用 Xplorer 风格 + glow
 *
 * v0.1.0-module1.21: 阅读状态染色 —
 *   - mount 时拉 readStatus.marks
 *   - 给 FileList 传 marks prop (key = historyKey + '|' + entry.path)
 *   - toolbar 加"隐藏已读完" Eye/EyeOff toggle
 *   - 右键菜单 "重置阅读进度" 通过 markFinished(false) + refresh marks
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getSetting, setSetting } from '@/lib/tauri';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useShortcutsStore } from '@/stores/shortcuts';
import { useReadStatusStore } from '@/stores/readStatus';
import { log } from '@/lib/logger';
import FileList from './FileList.vue';
import Breadcrumb from './Breadcrumb.vue';
import RowContextMenu from './RowContextMenu.vue';
import type { MediaEntry, ReadStatusMap } from '@/lib/sourceDescriptor';

const { t } = useI18n();
const fb = useFileBrowserStore();
const shortcuts = useShortcutsStore();
const readStatus = useReadStatusStore();

const showSaveDialog = ref(false);
const saveLabel = ref('');
const hideFinished = ref(false);
const HIDE_FINISHED_KEY = 'fb_hide_finished';

// 右键菜单状态
const ctxMenu = ref<{ entry: MediaEntry; x: number; y: number } | null>(null);

const canSave = computed(() => fb.rootPath !== null);
const canUp = computed(() => fb.currentPath !== '');

/**
 * v0.1.0-module1.21: marks 派生.
 * 直接返回 readStatus.marks — FileList 行按 entry.path 后缀匹配.
 * marks map: key = `${rootPath}|${bookId}` (来自 readStatus store),
 * value = 'reading' | 'finished'.
 * 当前 fileBrowser 只支持 local, 一层目录下 rootPath 唯一.
 */
const marksForCurrent = computed<ReadStatusMap>(() => {
  return readStatus.marks;
});

const visibleEntries = computed<MediaEntry[]>(() => {
  if (!hideFinished.value) return fb.entries;
  return fb.entries.filter((e) => {
    if (!e.isDirectory && !e.isArchive) return true;
    if (!fb.rootPath) return true;
    const matched = Object.entries(readStatus.marks).find(([k]) => k.startsWith(`${fb.rootPath}|`) && k.endsWith(`|${e.path}`));
    return matched?.[1] !== 'finished';
  });
});

const emit = defineEmits<{
  (e: 'open', entry: import('@/lib/sourceDescriptor').MediaEntry): void;
}>();

const LAST_ROOT_KEY = 'file_browser_last_root';

onMounted(async () => {
  await shortcuts.refresh();
  // v0.1.0-module1.21: 拉历史 + progress 派生 marks
  await readStatus.refresh();
  // 读取 hide-finished 设置
  try {
    const stored = await getSetting(HIDE_FINISHED_KEY);
    hideFinished.value = stored === '1';
  } catch {
    // silent
  }
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

// #8 隐藏已读完 toggle 持久化
watch(hideFinished, async (v) => {
  try {
    await setSetting(HIDE_FINISHED_KEY, v ? '1' : '0');
  } catch {
    // silent
  }
});

async function onUp() {
  await fb.up();
}

async function onRefresh() {
  await fb.refresh();
}

async function onShortcutChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (value === '') {
    // #8 修复: 仅取消激活, 不清 rootPath (让用户保留当前目录浏览)
    shortcuts.setActive(null);
    return;
  }
  const id = Number(value);
  // #8 修复: 切回已激活的 shortcut, no-op (避免重复 fetch)
  if (id === shortcuts.activeId) return;
  const sc = shortcuts.items.find((s) => s.id === id);
  if (sc) {
    shortcuts.setActive(id);
    await fb.setRoot(sc.rootPath);
  }
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

/**
 * 截断路径用于错误显示. 长路径 (Windows MAX_PATH ~260) 在深层嵌套时
 * 难看也容易截断 UI — 头 60 + "..." + 尾 60.
 */
function truncatePath(p: string, head = 60, tail = 60): string {
  if (p.length <= head + tail + 5) return p;
  return `${p.slice(0, head)}…${p.slice(-tail)}`;
}

function errorMessage(kind: string, msg: string): string {
  // Windows MAX_PATH ~260 字符限制检测. 深层嵌套目录或长文件夹名
  // 会触发 NotFound, 但实际是 path too long.
  if (kind === 'notFound' && msg.length > 200) {
    return t('error.pathTooLong') + ' — ' + truncatePath(msg, 50, 50);
  }
  const tr = truncatePath(msg);
  if (kind === 'notFound') return t('error.fileNotFound') + ': ' + tr;
  if (kind === 'permissionDenied') return t('error.permissionDenied') + ': ' + tr;
  return t('error.ioError') + ': ' + tr;
}

/**
 * #3 FileList @open handler
 * - 目录: navigate 进入 (currentPath 拼上 entry.path)
 * - 文件/压缩包: emit 'open' 给父组件 (模块 #2 接管 reader 路由)
 */
async function onEntryOpen(entry: import('@/lib/sourceDescriptor').MediaEntry) {
  log('[FileBrowser] onEntryOpen', entry.name, 'isDirectory=', entry.isDirectory, 'lastFetchedPath=', fb.lastFetchedPath);
  if (entry.isDirectory) {
    // 用 lastFetchedPath (而非 currentPath) 拼接, 避免快速连点两个目录
    // 时把第二次点击当成第一次的子目录
    const newPath = fb.lastFetchedPath
      ? `${fb.lastFetchedPath}/${entry.path}`.replace(/\/+/g, '/')
      : entry.path;
    log('[FileBrowser] navigate to', newPath);
    await fb.navigate(newPath);
    return;
  }
  emit('open', entry);
}

function onRowContextMenu(entry: MediaEntry, x: number, y: number) {
  ctxMenu.value = { entry, x, y };
}

function onCtxClose() {
  ctxMenu.value = null;
}

/**
 * Breadcrumb @navigate handler
 * - 接收累积路径, 调 fb.navigate 重定位 currentPath
 * - 路径 '' (根) → 回到根目录列表
 */
async function onBreadcrumbNavigate(path: string) {
  log('[FileBrowser] breadcrumb navigate to', path);
  await fb.navigate(path);
}

/**
 * #1 UI 显示当前根目录: 用 rootPath basename 作 Breadcrumb 根标签
 */
const rootLabel = computed(() => {
  if (!fb.rootPath) return t('nav.fileBrowser');
  const parts = fb.rootPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fb.rootPath;
});

/* ─── Lucide SVG 图标路径 (24×24 viewBox, stroke 2, round) ─── */
const ICON_UP = 'M5 12l7-7 7 7M12 19V5';
const ICON_REFRESH = 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5';
const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ICON_STAR = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';
const ICON_FOLDER_OPEN = 'M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2';
const ICON_ALERT = 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01';
const ICON_EYE = 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const ICON_EYE_OFF = 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22';
</script>

<template>
  <main
    class="flex flex-col h-full gap-3 p-4"
    data-test="file-browser"
  >
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
      <!-- Toolbar: 5 个操作按钮 (Xplorer 风格: 顶部细线 + text-xs 小按钮 + 1px 分隔条) -->
      <header
        class="bg-surface border-b border-white/5 px-3 py-1.5 flex items-center gap-1 flex-wrap"
        data-test="toolbar"
      >
        <button
          data-test="btn-up"
          class="tb-btn"
          :disabled="!canUp"
          @click="onUp"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_UP" />
          </svg>
          {{ t('fileBrowser.up') }}
        </button>
        <button
          data-test="btn-refresh"
          class="tb-btn"
          :disabled="fb.loading"
          @click="onRefresh"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_REFRESH" />
          </svg>
          {{ t('fileBrowser.refresh') }}
        </button>
        <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />
        <select
          data-test="shortcut-dropdown"
          class="tb-select"
          :value="shortcuts.activeId ?? ''"
          @change="onShortcutChange"
        >
          <option value="">{{ t('fileBrowser.noShortcut') }}</option>
          <option
            v-for="s in shortcuts.items"
            :key="s.id"
            :value="s.id"
          >
            {{ s.label || s.rootPath.split(/[\\/]/).pop() }}
          </option>
        </select>
        <button
          data-test="btn-pick"
          class="tb-btn"
          @click="onPickRoot"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_FOLDER" />
          </svg>
          {{ t('fileBrowser.pickRoot') }}
        </button>
        <button
          data-test="btn-save"
          class="tb-btn"
          :disabled="!canSave"
          @click="onSaveClick"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_STAR" />
          </svg>
          {{ t('fileBrowser.saveAsShortcut') }}
        </button>
        <span class="w-px h-4 bg-white/10 shrink-0" aria-hidden="true" />
        <button
          data-test="btn-hide-finished"
          class="tb-btn"
          :title="hideFinished ? t('fileBrowser.showFinished') : t('fileBrowser.hideFinished')"
          @click="hideFinished = !hideFinished"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path v-if="hideFinished" :d="ICON_EYE" />
            <path v-else :d="ICON_EYE_OFF" />
          </svg>
          {{ hideFinished ? t('fileBrowser.showFinished') : t('fileBrowser.hideFinished') }}
        </button>
      </header>

      <Breadcrumb
        :root-label="rootLabel"
        :path="fb.currentPath"
        data-test="breadcrumb"
        @navigate="onBreadcrumbNavigate"
      />

      <!-- Error toast (glow red) -->
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

      <FileList
        :entries="visibleEntries"
        :loading="fb.loading"
        :marks="marksForCurrent"
        data-test="filelist"
        @open="onEntryOpen"
        @contextmenu="onRowContextMenu"
      />

      <p
        v-if="fb.loading"
        class="text-text-tertiary text-xs m-0 px-3 py-2"
      >
        {{ t('common.loading') }}
      </p>

      <!-- Save dialog (glassmorphism) -->
      <div
        v-if="showSaveDialog"
        class="absolute inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-[1000]"
        data-test="save-dialog"
        @click.self="onSaveCancel"
      >
        <div
          class="bg-surface-4 border border-white/10 rounded-lg p-6 flex flex-col gap-4 min-w-[380px] shadow-lg"
        >
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

    <!-- 右键菜单 (v0.1.0-module1.21: 仅 "重置阅读进度") -->
    <RowContextMenu
      v-if="ctxMenu"
      :entry="ctxMenu.entry"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      @close="onCtxClose"
    />
  </main>
</template>

<style scoped>
/* ─── 工具栏按钮统一 base (Xplorer OperationBar 风格) ─── */
.tb-btn,
.tb-select {
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
.tb-btn:hover:not(:disabled),
.tb-select:hover:not(:disabled) {
  background: var(--color-surface-light);
  color: var(--color-text-primary);
}
.tb-btn:active:not(:disabled) {
  color: var(--color-accent);
}
.tb-btn:disabled,
.tb-select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tb-select {
  padding-right: 24px;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.5)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 4px center;
  background-size: 12px;
}
</style>