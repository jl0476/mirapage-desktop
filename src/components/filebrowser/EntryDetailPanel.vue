<script setup lang="ts">
/**
 * EntryDetailPanel.vue — 文件/文件夹详情面板
 *
 * v0.1.0-module1.22: 选中 1 项时显示在 FileList 右侧.
 * 全部前端派生 (不调 Rust IPC), 字段缺失显示 '—'.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatBytes, formatDate } from '@/locales/helpers';
import { useSettingsStore } from '@/stores/settings';
import { extensionOf, mimeFromName, getMimeCategory } from '@/lib/mime';
import type { MediaEntry } from '@/lib/sourceDescriptor';

interface Props {
  entry: MediaEntry | null;
  rootPath: string | null;
}
const props = defineProps<Props>();

const { t } = useI18n();
const settings = useSettingsStore();

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
  const location = props.rootPath
    ? `${props.rootPath}/${e.path}`
    : e.path;
  return {
    name: e.name,
    location,
    size: e.isDirectory ? '—' : formatBytes(e.size),
    type,
    extension: ext,
    mime: mime ?? '—',
    modified: e.modifiedAt ? formatDate(e.modifiedAt * 1000, settings.locale) : '—',
    created: '—',
    accessed: '—',
  };
});
</script>

<template>
  <aside
    v-if="display"
    class="detail-panel flex flex-col gap-3 p-4 bg-surface-1 border border-white/10 rounded-md text-xs"
    data-test="entry-detail-panel"
    role="complementary"
    :aria-label="t('properties.title')"
  >
    <header class="flex items-center gap-2 pb-2 border-b border-white/5">
      <h3 class="m-0 text-sm font-semibold text-text-primary">
        {{ t('properties.title') }}
      </h3>
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
  </aside>
  <div
    v-else
    class="detail-panel-empty text-text-tertiary text-xs italic p-4"
    data-test="entry-detail-empty"
  >
    {{ t('properties.noFileSelected') }}
  </div>
</template>
