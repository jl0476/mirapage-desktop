<script setup lang="ts">
/**
 * RowContextMenu.vue — 文件行右键菜单 (v0.1.0-module1.21)
 *
 * 单图（entry）或多选（entries）模式：多选时 regenerate 显示"N 张"，
 * 目录专属项（read-now / add-to-library）多选时隐藏。
 * 位置: 绝对定位 (x, y), click-outside 关闭.
 * 样式: Xplorer context-menu-enter / exit 渐入 (90ms ease-out).
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReadStatusStore } from '@/stores/readStatus';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { isImage } from '@/lib/mime';
import { resetProgressByLocation } from '@/lib/tauri';
import { PathUtils } from '@/lib/path';
import { log } from '@/lib/logger';
import type { MediaEntry, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

interface Props {
  /** 单图模式（与 entries 互斥） */
  entry?: MediaEntry | null;
  /** 多选模式（右键选中集内且 size>1 时使用，与 entry 互斥） */
  entries?: MediaEntry[] | null;
  /** 屏幕坐标 (clientX / clientY) */
  x: number;
  y: number;
  /** module3.0.14：该 entry 已喜欢态（父级状态表传入） */
  likeFavorite?: boolean;
}
const props = defineProps<Props>();

interface Emits {
  (e: 'close'): void;
  (e: 'read-now', entry: MediaEntry): void;
  (e: 'toggle-like', entry: MediaEntry): void;
  /** 单图: entry; 多选: entries 数组。统一用此签名。 */
  (e: 'regenerate-thumbnail', items: MediaEntry[]): void;
}
const emit = defineEmits<Emits>();

const { t } = useI18n();
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

// module3.0.14：按位置精确重置（旧实现查 favorites 列表 + 只比 rootPath，非收藏书落空、
// 同根多本认错人）。书 = 阅读目录：目录项拼 entry.path（相对 lastFetchedPath），
// 图片/文件项直接用所在目录（library 行身份是其阅读目录，不是图片文件）。
async function onResetProgress() {
  if (!firstItem.value) return;
  const base = fb.lastFetchedPath;
  if (fb.rootPath === null || base === null) {
    emit('close');
    return;
  }
  const absPath = firstItem.value.isDirectory
    ? PathUtils.join(base, firstItem.value.path)
    : base;
  try {
    const descriptor: SourceDescriptorLocal = { type: 'local', rootPath: fb.rootPath };
    const ok = await resetProgressByLocation(descriptor, absPath);
    if (!ok) log('[RowContextMenu] resetProgressByLocation no-op', absPath);
    await readStatus.refresh();
  } catch (e) {
    log('[RowContextMenu] resetProgressByLocation failed', e);
  }
  emit('close');
}

function onRegenerate() {
  if (currentItems.value.length === 0) return;
  emit('regenerate-thumbnail', currentItems.value);
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
        @click="emit('toggle-like', firstItem); emit('close')"
      >
        {{ likeFavorite ? t('reader.liked') : '＋ ' + t('reader.like') }}
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
  </div>
</template>