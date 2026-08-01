<script setup lang="ts">
/**
 * ShortcutDropdown.vue — 替换 FileBrowser 原生 <select> 丑陋下拉
 *
 * v0.1.0-module1.22: 美化 — Xplorer 风格 chevron 弹层.
 *  trigger 显示当前选中 shortcut 名 (若无选 → "未选快捷方式")
 *  弹层: 首项 "未选快捷方式" (点击清空), 后续按创建时间倒序列出快捷方式
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useShortcutsStore } from '@/stores/shortcuts';

const { t } = useI18n();
const shortcuts = useShortcutsStore();
const open = ref(false);
const dropdownRef = ref<HTMLDivElement | null>(null);

const ICON_CHEVRON_DOWN = 'M6 9l6 6 6-6';

function onSelect(id: number | null) {
  if (id === null) {
    shortcuts.setActive(null);
  } else if (id !== shortcuts.activeId) {
    const sc = shortcuts.items.find((s) => s.id === id);
    if (sc) {
      shortcuts.setActive(id);
    }
  }
  open.value = false;
}

function onMouseDown(e: MouseEvent) {
  if (!dropdownRef.value?.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener('mousedown', onMouseDown));
onUnmounted(() => document.removeEventListener('mousedown', onMouseDown));

const currentLabel = () => {
  if (shortcuts.activeId === null) return t('fileBrowser.noShortcut');
  const sc = shortcuts.items.find((s) => s.id === shortcuts.activeId);
  if (!sc) return t('fileBrowser.noShortcut');
  return sc.label || sc.rootPath.split(/[\\/]/).pop() || sc.rootPath;
};
</script>

<template>
  <div ref="dropdownRef" class="relative">
    <button
      type="button"
      class="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-light hover:text-text-primary transition-colors max-w-[140px]"
      data-test="shortcut-dropdown"
      @click="open = !open"
    >
      <span class="truncate">{{ currentLabel() }}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" class="opacity-60 shrink-0" aria-hidden="true">
        <path :d="ICON_CHEVRON_DOWN" />
      </svg>
    </button>
    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1 min-w-[200px] max-h-[280px] overflow-y-auto bg-surface-4 border border-white/10 rounded-lg py-1 shadow-xl backdrop-blur-xl"
      role="menu"
      data-test="shortcut-dropdown-menu"
    >
      <button
        type="button"
        class="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-surface-light transition-colors"
        :class="shortcuts.activeId === null ? 'text-accent' : 'text-text-secondary'"
        role="menuitem"
        data-test="shortcut-opt-none"
        @click="onSelect(null)"
      >
        {{ t('fileBrowser.noShortcut') }}
      </button>
      <div class="border-t border-white/5 my-1" />
      <button
        v-for="s in shortcuts.items"
        :key="s.id"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-light transition-colors"
        :class="s.id === shortcuts.activeId ? 'text-accent' : 'text-text-secondary'"
        role="menuitem"
        :data-test="`shortcut-opt-${s.id}`"
        @click="onSelect(s.id)"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        <span class="truncate">{{ s.label || s.rootPath.split(/[\\/]/).pop() || s.rootPath }}</span>
      </button>
    </div>
  </div>
</template>
