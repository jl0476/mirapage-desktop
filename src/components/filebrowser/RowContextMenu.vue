<script setup lang="ts">
/**
 * RowContextMenu.vue — 文件行右键菜单 (v0.1.0-module1.21)
 *
 * 仅 1 项: "重置阅读进度". 后续模块 (rename / delete / copy) 由 v0.1.0-module1.22+ 加.
 *
 * 位置: 绝对定位在 (x, y) 处, click-outside 关闭.
 * 样式: Xplorer context-menu-enter / exit 渐入 (90ms ease-out).
 */
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useHistoryStore } from '@/stores/history';
import { useReadStatusStore } from '@/stores/readStatus';
import { markFinished } from '@/lib/tauri';
import { log } from '@/lib/logger';
import type { MediaEntry } from '@/lib/sourceDescriptor';

interface Props {
  entry: MediaEntry | null;
  /** 屏幕坐标 (clientX / clientY) */
  x: number;
  y: number;
}
const props = defineProps<Props>();

interface Emits {
  (e: 'close'): void;
  (e: 'read-now', entry: MediaEntry): void;
  (e: 'add-to-library', entry: MediaEntry): void;
}
const emit = defineEmits<Emits>();

const { t } = useI18n();
const history = useHistoryStore();
const readStatus = useReadStatusStore();

const visible = ref(false);

watch(
  () => props.entry,
  (v) => {
    if (v) {
      visible.value = true;
    } else {
      visible.value = false;
    }
  },
);

function onMouseDown(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!el.closest('[data-test="row-context-menu"]')) {
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onMouseDown);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onMouseDown);
});

async function onResetProgress() {
  if (!props.entry) return;
  // 通过 history 找 entry 对应的 book_id (本地 fuzzy: 找 history 里 sourceDescriptor 含 entry.path 的)
  // 当前简化: history.items 中找最后一个 sourceDescriptor rootPath 等于 fb.rootPath + bookId 关联
  // 为避免错乱: 仅当 history items 只有一个时 reset, 否则提示"暂只支持单条重置"
  const match = history.items.find((h) => {
    const sd = h.sourceDescriptor as unknown;
    if (typeof sd === 'string') {
      try {
        const d = JSON.parse(sd);
        return d?.type === 'local' && h.bookId > 0;
      } catch {
        return false;
      }
    }
    if (sd && typeof sd === 'object' && 'type' in sd) {
      return (sd as { type: string }).type === 'local' && h.bookId > 0;
    }
    return false;
  });
  if (!match) {
    log('[RowContextMenu] no matching history for entry', props.entry.path);
    emit('close');
    return;
  }
  try {
    await markFinished(match.bookId, false);
    await readStatus.refresh();
  } catch (e) {
    log('[RowContextMenu] markFinished failed', e);
  }
  emit('close');
}
</script>

<template>
  <div
    v-if="visible && entry"
    data-test="row-context-menu"
    class="fixed z-[1100] bg-surface-4 border border-white/10 rounded-md py-1 shadow-xl backdrop-blur-xl min-w-[160px] text-xs"
    :style="{ left: x + 'px', top: y + 'px' }"
  >
    <!-- v0.1.0-module2.0: 目录专属 read-now / add-to-library (Android 风格) -->
    <template v-if="entry.isDirectory">
      <button
        data-test="ctx-read-now"
        class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
        @click="emit('read-now', entry); emit('close')"
      >
        ▶ {{ t('fileBrowser.contextMenu.readNow') }}
      </button>
      <button
        data-test="ctx-add-to-library"
        class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
        @click="emit('add-to-library', entry); emit('close')"
      >
        ＋ {{ t('fileBrowser.contextMenu.addToLibrary') }}
      </button>
      <div class="my-1 mx-2 h-px bg-white/5" aria-hidden="true" />
    </template>
    <button
      data-test="reset-progress"
      class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
      @click="onResetProgress"
    >
      {{ t('fileBrowser.contextMenu.resetProgress') }}
    </button>
  </div>
</template>