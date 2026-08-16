<script setup lang="ts">
/**
 * EntryDetailPanel.vue — 文件/文件夹详情面板
 *
 * v0.1.0-module1.22: 选中 1 项时显示在 FileList 右侧.
 * 全部前端派生 (不调 Rust IPC), 字段缺失显示 '—'.
 *
 * v0.1.0-module2.0: 选中目录时显示 3 CTA (参考 Android 底部 「下载全部/立即阅读/加入书库」):
 *  - 立即阅读 (主按钮, 仅目录 enable)
 *  - 加入书库 (次按钮, 仅目录 enable)
 *  - 下载全部 (stub, 永远 disabled, 显示 tooltip)
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatBytes, formatDateTime } from '@/locales/helpers';
import { useSettingsStore } from '@/stores/settings';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { PathUtils } from '@/lib/path';
import { extensionOf, mimeFromName, getMimeCategory } from '@/lib/mime';
import type { MediaEntry } from '@/lib/sourceDescriptor';

interface Props {
  entry: MediaEntry | null;
  rootPath: string | null;
  /** module3.0.14：该 entry 已喜欢态（父级状态表传入） */
  likeFavorite?: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'read-now'): void;
  (e: 'toggle-like'): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();
const settings = useSettingsStore();
const fb = useFileBrowserStore();

const display = computed(() => {
  if (!props.entry) return null;
  const e = props.entry;
  // 目录不显示扩展名 (避免名字里的 '.' 误识别, e.g. "VOL.11")
  // 压缩包显示真实扩展 (.cbz / .zip 等); 普通文件显示扩展
  const ext =
    e.isDirectory
      ? '—'
      : extensionOf(e.name) ?? '—';
  const mime = mimeFromName(e.name);
  // 类型: 目录 / 压缩包 / mime 大类 / 文件 (全部走 i18n key, 不用 mime.split('/')[0] 硬编码英文)
  const type = e.isDirectory
    ? t('properties.typeDirectory')
    : e.isArchive
      ? t('properties.typeArchive')
      : (() => {
          const cat = getMimeCategory(mime);
          if (cat === 'image') return t('properties.typeImage');
          if (cat === 'video') return t('properties.typeVideo');
          if (cat === 'audio') return t('properties.typeAudio');
          if (cat === 'text') return t('properties.typeText');
          return t('properties.typeFile');
        })();
  // v0.1.0-module3.0.3-hotfix10: location 拼 currentPath 上下文. 之前只用 rootPath + e.path
  // 丢失 currentPath (e.g. 用户在 output/ 看 260301 应为 U:/H/AI/output/260301 不是
  // U:/H/AI/260301). 用 lastFetchedPath 而非 currentPath (避免 navigate race condition
  // 与 useReaderActions 一致). PathUtils.join 只接 2 个参数, 嵌套二次拼接.
  const currentPath = fb.lastFetchedPath;
  const location = props.rootPath
    ? (currentPath
      ? PathUtils.join(PathUtils.join(props.rootPath, currentPath), e.path)
      : PathUtils.join(props.rootPath, e.path))
    : e.path;
  return {
    name: e.name,
    location,
    size: e.isDirectory ? '—' : formatBytes(e.size),
    type,
    extension: ext,
    mime: mime ?? '—',
    modified: e.modifiedAt ? formatDateTime(e.modifiedAt * 1000, settings.locale) : '—',
    created: '—',
    accessed: '—',
  };
});

const isDirectory = computed(() => props.entry?.isDirectory === true);
</script>

<template>
  <aside
    v-if="display"
    class="detail-panel flex flex-col gap-3 p-4 bg-surface-1 xp-bd rounded-md text-xs"
    data-test="entry-detail-panel"
    role="complementary"
    :aria-label="t('properties.title')"
  >
    <header class="flex items-center gap-2 pb-2 xp-bdb-subtle">
      <h3 class="m-0 text-sm font-semibold text-text-primary flex-1">
        {{ t('properties.title') }}
      </h3>
      <button
        type="button"
        class="flex items-center justify-center w-5 h-5 rounded text-text-muted
               hover:text-text-primary hover:bg-surface-light transition-colors"
        data-test="entry-detail-close"
        :title="t('common.cancel')"
        :aria-label="t('common.cancel')"
        @click="emit('close')"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </header>
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-baseline">
      <dt class="text-text-muted">{{ t('properties.labelName') }}</dt>
      <dd class="text-text-primary truncate" :title="display.name">{{ display.name }}</dd>

      <dt class="text-text-muted">{{ t('properties.labelLocation') }}</dt>
      <dd class="text-text-secondary truncate font-mono" :title="display.location">{{ display.location }}</dd>

      <dt class="text-text-muted">{{ t('properties.labelSize') }}</dt>
      <dd class="text-text-primary font-mono">{{ display.size }}</dd>

      <dt class="text-text-muted">{{ t('properties.labelType') }}</dt>
      <dd class="text-text-primary">{{ display.type }}</dd>

      <dt class="text-text-muted">{{ t('properties.labelExtension') }}</dt>
      <dd class="text-text-primary font-mono">{{ display.extension }}</dd>

      <template v-if="display.mime !== '—'">
        <dt class="text-text-muted">MIME</dt>
        <dd class="text-text-secondary font-mono">{{ display.mime }}</dd>
      </template>

      <dt class="text-text-muted">{{ t('properties.labelModified') }}</dt>
      <dd class="text-text-primary font-mono">{{ display.modified }}</dd>

      <dt class="text-text-muted">{{ t('properties.labelCreated') }}</dt>
      <dd class="text-text-tertiary font-mono">{{ display.created }}</dd>

      <dt class="text-text-muted">{{ t('properties.labelAccessed') }}</dt>
      <dd class="text-text-tertiary font-mono">{{ display.accessed }}</dd>
    </dl>

    <!-- v0.1.0-module2.0: 目录专属 3 CTA (Android 模式移植) -->
    <div
      v-if="isDirectory"
      class="flex flex-col gap-1.5 pt-3 xp-bdt-subtle"
      data-test="entry-detail-actions"
    >
      <button
        type="button"
        class="w-full px-3 py-2 rounded text-xs font-semibold text-white
               bg-accent hover:bg-accent-hover transition-colors
               disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="entry-detail-read-now"
        :disabled="!isDirectory"
        @click="emit('read-now')"
      >
        ▶ {{ t('fileBrowser.readNow') }}
      </button>
      <button
        type="button"
        class="w-full px-3 py-2 rounded text-xs text-text-secondary
               xp-bd bg-surface hover:bg-surface-light hover:text-text-primary
               transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        data-test="entry-detail-add-to-library"
        :disabled="!isDirectory"
        @click="emit('toggle-like')"
      >
        {{ likeFavorite ? t('reader.liked') : '＋ ' + t('reader.like') }}
      </button>
      <button
        type="button"
        class="w-full px-3 py-2 rounded text-xs text-text-tertiary
               xp-bd-subtle bg-surface-1 cursor-not-allowed"
        data-test="entry-detail-download-all"
        disabled
        :title="t('fileBrowser.downloadAllUnavailable')"
      >
        ⊟ {{ t('fileBrowser.downloadAll') }}
      </button>
    </div>
  </aside>
  <div
    v-else
    class="detail-panel-empty text-text-tertiary text-xs italic p-4"
    data-test="entry-detail-empty"
  >
    {{ t('properties.noFileSelected') }}
  </div>
</template>