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
import { useLibraryStore } from '@/stores/library';
import { useReadStatusStore } from '@/stores/readStatus';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { markFinished } from '@/lib/tauri';
import { isImage } from '@/lib/mime';
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
  (e: 'regenerate-thumbnail', entry: MediaEntry): void;
}
const emit = defineEmits<Emits>();

const { t } = useI18n();
const library = useLibraryStore();
const readStatus = useReadStatusStore();
const fb = useFileBrowserStore();

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
  // v0.1.0-module3.0: 从 library（不是 browse_history）找同 sourceDescriptor+absolutePath 的 book_id
  // library.list 只会包含 is_favorite=1；temp-imported books 也已在 DB 中，refresh 后可见
  await library.refresh();
  const match = library.items.find((b) => {
    const sd = b.sourceDescriptor as unknown;
    if (typeof sd === 'string') {
      try {
        return JSON.parse(sd).rootPath === fb.rootPath;
      } catch {
        return false;
      }
    }
    return typeof sd === 'object' && sd !== null && 'rootPath' in sd
      && (sd as { rootPath: string }).rootPath === fb.rootPath;
  });
  // 注意: 这里只看 rootPath, 多本书无法区分精确目录, 仅做单文件夹重置.
  if (!match) {
    log('[RowContextMenu] no matching library book for entry', props.entry.path);
    emit('close');
    return;
  }
  try {
    await markFinished(match.id, false);
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
    class="fixed z-[1100] bg-surface-4 xp-bd rounded-md py-1 shadow-xl backdrop-blur-xl min-w-[160px] text-xs"
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
    <!-- 图片：强制重建缩略图（删旧缓存后重新生成） -->
    <button
      v-if="entry && !entry.isDirectory && isImage(entry.name)"
      data-test="regenerate-thumbnail"
      class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
      @click="emit('regenerate-thumbnail', entry); emit('close')"
    >
      ⟳ {{ t('fileBrowser.contextMenu.regenerateThumbnail') }}
    </button>
  </div>
</template>