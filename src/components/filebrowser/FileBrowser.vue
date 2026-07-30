<script setup lang="ts">
/**
 * FileBrowser.vue — 模块 #1 主屏
 * 5 元素工具栏 + Breadcrumb + FileList + 错误 toast + empty state + save dialog
 * 规格：docs/superpowers/specs/2026-07-30-module-1-file-browser-design.md §4.6
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { useShortcutsStore } from '@/stores/shortcuts';
import FileList from './FileList.vue';
import Breadcrumb from './Breadcrumb.vue';

const { t } = useI18n();
const fb = useFileBrowserStore();
const shortcuts = useShortcutsStore();

const showSaveDialog = ref(false);
const saveLabel = ref('');

const canSave = computed(() => fb.rootPath !== null);
const canUp = computed(() => fb.currentPath !== '');

onMounted(async () => {
  await shortcuts.refresh();
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
    shortcuts.setActive(null);
    await fb.setRoot(null);
    return;
  }
  const id = Number(value);
  const sc = shortcuts.items.find((s) => s.id === id);
  if (sc) {
    shortcuts.setActive(id);
    await fb.setRoot(sc.rootPath);
  }
}

async function onPickRoot() {
  // 动态 import 避免 happy-dom 测试环境出错（plugin-dialog 不可用）
  try {
    const mod = (await import('@tauri-apps/plugin-dialog').catch(() => null)) as
      | { open?: (opts: unknown) => Promise<string | null> }
      | null;
    if (!mod?.open) return; // 浏览器/测试环境无此 API — 让用户手动用 Save 按钮
    const path = await mod.open({ directory: true });
    if (path && typeof path === 'string') {
      await fb.setRoot(path);
    }
  } catch {
    // silent fail — 不打断体验
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
        :root-label="t('nav.fileBrowser')"
        :path="fb.currentPath"
        data-test="breadcrumb"
      />

      <p
        v-if="fb.error"
        class="error-toast"
        data-test="error-toast"
      >
        <span>{{ fb.error.message }}</span>
        <button data-test="error-refresh" @click="onRefresh">
          {{ t('fileBrowser.refresh') }}
        </button>
      </p>

      <FileList
        :entries="fb.entries"
        data-test="filelist"
        @open="(e) => $emit('open', e)"
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
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid #ff6b6b;
  background: transparent;
  color: #ff6b6b;
  border-radius: 4px;
  cursor: pointer;
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
