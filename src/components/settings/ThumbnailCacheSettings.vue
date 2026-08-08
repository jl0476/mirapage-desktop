<script setup lang="ts">
// ThumbnailCacheSettings.vue — 缩略图缓存资源 / 清晰度 / 容量设置（§11 §14）
// 挂在 Settings 页 masonry section 下。复用 EnumRow（与设置页其它行一致的 dropdown 模式）。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import { getThumbnailCacheInfo, clearThumbnailCache } from '@/lib/tauri';
import EnumRow from '@/components/settings/EnumRow.vue';
import type { ThumbnailQuality, ThumbnailResourceMode } from '@/lib/thumbnail';

const { t } = useI18n();
const s = useSettingsStore();

const advancedOpen = ref(false);
const cacheBytes = ref(0);
const cacheCount = ref(0);

async function refreshInfo() {
  try {
    const info = await getThumbnailCacheInfo();
    cacheBytes.value = info.bytes;
    cacheCount.value = info.count;
  } catch {
    /* ignore */
  }
}
onMounted(refreshInfo);

async function onClear() {
  await clearThumbnailCache();
  await refreshInfo();
}

const cacheMb = computed(() => Math.round(cacheBytes.value / 1_000_000));

const modeOptions = computed(() => [
  { value: 'powerSaver', label: t('settings.thumbnail.modePowerSaver') },
  { value: 'balanced', label: t('settings.thumbnail.modeBalanced') },
  { value: 'performance', label: t('settings.thumbnail.modePerformance') },
]);
const modeValue = computed(() => (modeOptions.value.some((o) => o.value === s.thumbnailResourceMode)
  ? s.thumbnailResourceMode
  : 'custom'));
const modeLabel = computed(() => {
  const found = modeOptions.value.find((o) => o.value === s.thumbnailResourceMode);
  return found ? found.label : t('settings.thumbnail.modeCustom');
});

const qualityOptions = [
  { value: 'standard', label: t('settings.thumbnail.qualityStandard') },
  { value: 'high', label: t('settings.thumbnail.qualityHigh') },
  { value: 'ultra', label: t('settings.thumbnail.qualityUltra') },
];
const cacheLimitOptions = [256, 512, 1024, 2048].map((m) => ({ value: String(m), label: `${m} MB` }));
const workerOptions = [1, 2, 3, 4].map((w) => ({ value: String(w), label: String(w) }));
const memoryOptions = [64, 128, 256, 512].map((m) => ({ value: String(m), label: `${m} MB` }));
const prefetchOptions = [0, 0.5, 1, 1.5, 2, 3].map((p) => ({ value: String(p), label: String(p) }));
const idleOptions = [0, 0.5, 1, 2].map((i) => ({ value: String(i), label: String(i) }));
</script>

<template>
  <div class="thumb-settings">
    <EnumRow
      :label="t('settings.thumbnail.resourceMode')"
      :value="modeValue"
      :options="modeValue === 'custom'
        ? [...modeOptions, { value: 'custom', label: modeLabel }]
        : modeOptions"
      @change="(v) => s.setThumbnailResourceMode(v as ThumbnailResourceMode)"
    />
    <EnumRow
      :label="t('settings.thumbnail.quality')"
      :value="s.thumbnailQuality"
      :options="qualityOptions"
      @change="(v) => s.setThumbnailQuality(v as ThumbnailQuality)"
    />
    <EnumRow
      :label="t('settings.thumbnail.cacheLimit')"
      :value="String(s.thumbnailCacheLimitMb)"
      :options="cacheLimitOptions"
      @change="(v) => s.setThumbnailCacheLimitMb(Number(v))"
    />

    <div class="info">
      <span class="info-label">{{ t('settings.thumbnail.cacheUsed', { mb: cacheMb, count: cacheCount }) }}</span>
      <button class="link-btn" type="button" @click="onClear">{{ t('settings.thumbnail.clearCache') }}</button>
    </div>

    <button class="advanced-toggle" type="button" @click="advancedOpen = !advancedOpen">
      {{ advancedOpen ? '▾' : '▸' }} {{ t('settings.thumbnail.advanced') }}
    </button>
    <div v-if="advancedOpen" class="advanced">
      <EnumRow
        :label="t('settings.thumbnail.workerLimit')"
        :value="String(s.thumbnailWorkerLimit)"
        :options="workerOptions"
        @change="(v) => s.setThumbnailWorkerLimit(Number(v))"
      />
      <EnumRow
        :label="t('settings.thumbnail.decodeMemory')"
        :value="String(s.thumbnailDecodeMemoryMb)"
        :options="memoryOptions"
        @change="(v) => s.setThumbnailDecodeMemoryMb(Number(v))"
      />
      <EnumRow
        :label="t('settings.thumbnail.prefetchScreens')"
        :value="String(s.thumbnailPrefetchScreens)"
        :options="prefetchOptions"
        @change="(v) => s.setThumbnailPrefetchScreens(Number(v))"
      />
      <label class="bool-row">
        <span class="bool-label">{{ t('settings.thumbnail.idleGeneration') }}</span>
        <input
          type="checkbox"
          :checked="s.thumbnailIdleGeneration"
          @change="s.setThumbnailIdleGeneration(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <EnumRow
        v-if="s.thumbnailIdleGeneration"
        :label="t('settings.thumbnail.idlePrefetchScreens')"
        :value="String(s.thumbnailIdlePrefetchScreens)"
        :options="idleOptions"
        @change="(v) => s.setThumbnailIdlePrefetchScreens(Number(v))"
      />
    </div>
  </div>
</template>

<style scoped>
.thumb-settings { display: flex; flex-direction: column; gap: 10px; }
.info { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.info-label { font-size: 12px; color: var(--color-text-muted); }
.link-btn { font-size: 12px; color: var(--color-accent); background: transparent; border: 0; cursor: pointer; }
.advanced-toggle {
  align-self: flex-start; font-size: 12px; color: var(--color-accent);
  background: transparent; border: 0; cursor: pointer; padding: 0;
}
.advanced { display: flex; flex-direction: column; gap: 10px; padding-left: 12px; border-left: 2px solid var(--color-border-default); }
.bool-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bool-label { font-size: 13px; color: var(--color-text-secondary); }
</style>
