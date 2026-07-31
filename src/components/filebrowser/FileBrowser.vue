<script setup lang="ts">
/**
 * FileBrowser.vue — 模块 #1 主屏
 * 5 元素工具栏 + Breadcrumb + FileList + 错误 toast + empty state + save dialog
 * 规格：docs/superpowers/specs/2026-07-30-module-1-file-browser-design.md §4.6
 *
 * 模块 #1 v2 反馈修复:
 * - #1 记住上次根目录: settings.file_browser_last_root 持久化
 * - #3 FileList @open handler: 目录 navigate / 文件 emit
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getSetting, setSetting } from '@/lib/tauri';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useShortcutsStore } from '@/stores/shortcuts';
import { log } from '@/lib/logger';
import FileList from './FileList.vue';
import Breadcrumb from './Breadcrumb.vue';

const { t } = useI18n();
const fb = useFileBrowserStore();
const shortcuts = useShortcutsStore();

const showSaveDialog = ref(false);
const saveLabel = ref('');

const canSave = computed(() => fb.rootPath !== null);
const canUp = computed(() => fb.currentPath !== '');

const emit = defineEmits<{
  (e: 'open', entry: import('@/lib/sourceDescriptor').MediaEntry): void;
}>();

const LAST_ROOT_KEY = 'file_browser_last_root';

onMounted(async () => {
  await shortcuts.refresh();
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
</script>

<template>
  <main class="file-browser" data-test="file-browser">
    <!-- empty state -->
    <div
      v-if="fb.rootPath === null"
      class="empty-state"
      data-test="empty-state"
    >
      <p class="hint">{{ t('fileBrowser.noShortcut') }}</p>
      <button data-test="btn-pick" class="primary" @click="onPickRoot">
        📁 {{ t('fileBrowser.pickRoot') }}
      </button>
      <RouterLink
        to="/shortcuts"
        class="link"
        data-test="link-to-shortcuts"
      >
        {{ t('fileBrowser.goShortcuts') }} →
      </RouterLink>
    </div>

    <!-- main view -->
    <template v-else>
      <header class="toolbar" data-test="toolbar">
        <button
          data-test="btn-up"
          :disabled="!canUp"
          @click="onUp"
        >
          ↑ {{ t('fileBrowser.up') }}
        </button>
        <button
          data-test="btn-refresh"
          :disabled="fb.loading"
          @click="onRefresh"
        >
          🔄 {{ t('fileBrowser.refresh') }}
        </button>
        <select
          data-test="shortcut-dropdown"
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
        <button data-test="btn-pick" @click="onPickRoot">
          📁 {{ t('fileBrowser.pickRoot') }}
        </button>
        <button
          data-test="btn-save"
          :disabled="!canSave"
          @click="onSaveClick"
        >
          ⭐ {{ t('fileBrowser.saveAsShortcut') }}
        </button>
      </header>

      <Breadcrumb
        :root-label="rootLabel"
        :path="fb.currentPath"
        data-test="breadcrumb"
        @navigate="onBreadcrumbNavigate"
      />

      <p
        v-if="fb.error"
        class="error-toast"
        data-test="error-toast"
      >
        <span data-test="error-message">{{ errorMessage(fb.error.kind, fb.error.message) }}</span>
        <div class="error-actions">
          <button
            v-if="fb.currentPath !== ''"
            data-test="error-up"
            @click="onUp"
          >
            ↑ {{ t('fileBrowser.up') }}
          </button>
          <button data-test="error-refresh" @click="onRefresh">
            {{ t('fileBrowser.refresh') }}
          </button>
        </div>
      </p>

      <FileList
        :entries="fb.entries"
        :loading="fb.loading"
        data-test="filelist"
        @open="onEntryOpen"
      />

      <p v-if="fb.loading" class="loading">
        {{ t('common.loading') }}
      </p>

      <!-- save dialog -->
      <div
        v-if="showSaveDialog"
        class="save-dialog-backdrop"
        data-test="save-dialog"
        @click.self="onSaveCancel"
      >
        <div class="save-dialog">
          <h3>{{ t('fileBrowser.saveAsShortcut') }}</h3>
          <label>
            {{ t('fileBrowser.shortcutLabel') }}
            <input
              v-model="saveLabel"
              data-test="save-label-input"
            />
          </label>
          <div class="actions">
            <button @click="onSaveCancel">{{ t('common.cancel') }}</button>
            <button
              data-test="btn-save-submit"
              class="primary"
              @click="onSaveSubmit"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
.file-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  gap: 12px;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
}
.empty-state .hint {
  color: var(--color-muted, #888);
  font-size: 14px;
}
.empty-state .primary {
  padding: 8px 20px;
  background: var(--color-primary, #4a9eff);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.empty-state .link {
  color: var(--color-primary, #4a9eff);
  text-decoration: none;
  font-size: 13px;
}
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.toolbar button,
.toolbar select {
  padding: 4px 10px;
  border: 1px solid var(--color-border, #444);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}
.toolbar button:disabled,
.toolbar select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.error-toast {
  background: #4d2a2a;
  border: 1px solid #ff6b6b;
  border-radius: 4px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.error-toast button {
  margin-left: 0;
  padding: 4px 10px;
  border: 1px solid #ff6b6b;
  background: transparent;
  color: #ff6b6b;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.error-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.loading {
  color: var(--color-muted, #888);
  font-size: 12px;
}
.save-dialog-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.save-dialog {
  background: var(--color-bg-elevated, #2a2a2a);
  border: 1px solid var(--color-border, #555);
  border-radius: 8px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 360px;
}
.save-dialog h3 {
  margin: 0;
  font-size: 16px;
}
.save-dialog label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.save-dialog input {
  padding: 6px 8px;
  background: #1a1a1a;
  border: 1px solid #555;
  color: inherit;
  border-radius: 4px;
}
.save-dialog .actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.save-dialog .actions .primary {
  background: var(--color-primary, #4a9eff);
  color: white;
  border: 1px solid var(--color-primary, #4a9eff);
  padding: 6px 16px;
  border-radius: 4px;
  cursor: pointer;
}
.save-dialog .actions button:not(.primary) {
  padding: 6px 16px;
  border: 1px solid var(--color-border, #555);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  cursor: pointer;
}
</style>
