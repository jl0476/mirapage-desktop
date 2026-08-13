<script setup lang="ts">
/**
 * RowContextMenu.vue — 文件行右键菜单 (v0.1.0-module1.21)
 *
 * 单图（entry）或多选（entries）模式：多选时 regenerate/retry 显示"N 张"，
 * 目录专属项（read-now / add-to-library）多选时隐藏。
 * 位置: 绝对定位 (x, y), click-outside 关闭.
 * 样式: Xplorer context-menu-enter / exit 渐入 (90ms ease-out).
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';
import { useReadStatusStore } from '@/stores/readStatus';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { markFinished } from '@/lib/tauri';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';
import type { MediaEntry } from '@/lib/sourceDescriptor';

interface Props {
  /** 单图模式（与 entries 互斥） */
  entry?: MediaEntry | null;
  /** 多选模式（右键选中集内且 size>1 时使用，与 entry 互斥） */
  entries?: MediaEntry[] | null;
  /** 屏幕坐标 (clientX / clientY) */
  x: number;
  y: number;
}
const props = defineProps<Props>();

interface Emits {
  (e: 'close'): void;
  (e: 'read-now', entry: MediaEntry): void;
  (e: 'add-to-library', entry: MediaEntry): void;
  /** 单图: entry; 多选: entries 数组。统一用此签名。 */
  (e: 'regenerate-thumbnail', items: MediaEntry[]): void;
  (e: 'retry', items: MediaEntry[]): void;
}
const emit = defineEmits<Emits>();

const { t } = useI18n();
const library = useLibraryStore();
const readStatus = useReadStatusStore();
const fb = useFileBrowserStore();

const visible = ref(false);

// 单图/多选兼容：优先 entries，fallback entry
const currentItems = computed<MediaEntry[]>(() => {
  if (props.entries && props.entries.length > 0) return props.entries;
  if (props.entry) return [props.entry];
  return [];
});
const isBatch = computed(() => currentItems.value.length > 1);
const firstItem = computed(() => currentItems.value[0]);

watch(
  () => [props.entry, props.entries] as const,
  ([e, es]) => {
    visible.value = !!(e || (es && es.length > 0));
  },
  // immediate：FileBrowser v-if="ctxMenu" 每次 right-click -> close 卸载组件，
  // 下次 mount 时 entry/entries 已是初始值，watch 不触发 -> visible 保持 false -> 菜单不弹。
  // immediate 让 mount 时据 entry/entries 初始 visible。
  { immediate: true },
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
  if (!firstItem.value) return;
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
    log('[RowContextMenu] no matching library book for entry', firstItem.value.path);
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

function onRegenerate() {
  if (currentItems.value.length === 0) return;
  emit('regenerate-thumbnail', currentItems.value);
  emit('close');
}

function onRetry() {
  if (currentItems.value.length === 0) return;
  emit('retry', currentItems.value);
  emit('close');
}
</script>

<template>
  <div
    v-if="visible && currentItems.length > 0"
    data-test="row-context-menu"
    class="fixed z-[1100] bg-surface-4 xp-bd rounded-md py-1 shadow-xl backdrop-blur-xl min-w-[160px] text-xs"
    :style="{ left: x + 'px', top: y + 'px' }"
  >
    <!-- 目录专属 read-now / add-to-library：仅单选（多选隐藏） -->
    <template v-if="!isBatch && firstItem && firstItem.isDirectory">
      <button
        data-test="ctx-read-now"
        class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
        @click="emit('read-now', firstItem); emit('close')"
      >
        ▶ {{ t('fileBrowser.contextMenu.readNow') }}
      </button>
      <button
        data-test="ctx-add-to-library"
        class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
        @click="emit('add-to-library', firstItem); emit('close')"
      >
        ＋ {{ t('reader.like') }}
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
    <!-- 图片：强制重建缩略图（删旧缓存后重新生成），支持多选 -->
    <button
      v-if="firstItem && !firstItem.isDirectory && isImage(firstItem.name)"
      data-test="regenerate-thumbnail"
      class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
      @click="onRegenerate"
    >
      ⟳ {{ isBatch
        ? t('fileBrowser.contextMenu.regenerateThumbnailN', { n: currentItems.length })
        : t('fileBrowser.contextMenu.regenerateThumbnail') }}
    </button>
    <!-- 图片：重试（不删缓存，重新排队），支持多选 -->
    <button
      v-if="firstItem && !firstItem.isDirectory && isImage(firstItem.name)"
      data-test="retry-thumbnail"
      class="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors duration-100"
      @click="onRetry"
    >
      ↻ {{ isBatch
        ? t('fileBrowser.contextMenu.retryThumbnailN', { n: currentItems.length })
        : t('fileBrowser.contextMenu.retryThumbnail') }}
    </button>
  </div>
</template>