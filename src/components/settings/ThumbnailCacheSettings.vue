<script setup lang="ts">
// ThumbnailCacheSettings.vue — 缩略图缓存资源 / 清晰度 / 容量设置（§11 §14）
// 挂在 Settings 页 masonry section 下。资源模式预设 + 高级参数（手改即 custom）。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import { getThumbnailCacheInfo, clearThumbnailCache } from '@/lib/tauri';
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

const modeOptions: { value: ThumbnailResourceMode; label: string }[] = [
  { value: 'powerSaver', label: t('settings.thumbnail.modePowerSaver') },
  { value: 'balanced', label: t('settings.thumbnail.modeBalanced') },
  { value: 'performance', label: t('settings.thumbnail.modePerformance') },
];
const qualityOptions: { value: ThumbnailQuality; label: string }[] = [
  { value: 'standard', label: t('settings.thumbnail.qualityStandard') },
  { value: 'high', label: t('settings.thumbnail.qualityHigh') },
  { value: 'ultra', label: t('settings.thumbnail.qualityUltra') },
];
const cacheLimitOptions = [256, 512, 1024, 2048];
const workerOptions = [1, 2, 3, 4];
const memoryOptions = [64, 128, 256, 512];
const prefetchOptions = [0, 0.5, 1, 1.5, 2, 3];
const idleOptions = [0, 0.5, 1, 2];

// 资源模式下拉：custom 时额外展示 custom 项（只读，手改高级参数后自动切 custom）
function pickMode(m: ThumbnailResourceMode) {
  void s.setThumbnailResourceMode(m);
}
</script>

<template>
  <div class="thumb-settings">
    <div class="row">
      <label class="label">{{ t('settings.thumbnail.resourceMode') }}</label>
      <select
        class="sel"
        :value="s.thumbnailResourceMode"
        @change="pickMode(($event.target as HTMLSelectElement).value as ThumbnailResourceMode)"
      >
        <option v-for="o in modeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        <option v-if="s.thumbnailResourceMode === 'custom'" value="custom">{{ t('settings.thumbnail.modeCustom') }}</option>
      </select>
    </div>

    <div class="row">
      <label class="label">{{ t('settings.thumbnail.quality') }}</label>
      <select class="sel" :value="s.thumbnailQuality" @change="s.setThumbnailQuality(($event.target as HTMLSelectElement).value as ThumbnailQuality)">
        <option v-for="o in qualityOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <div class="row">
      <label class="label">{{ t('settings.thumbnail.cacheLimit') }}</label>
      <select class="sel" :value="s.thumbnailCacheLimitMb" @change="s.setThumbnailCacheLimitMb(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="m in cacheLimitOptions" :key="m" :value="m">{{ m }} MB</option>
      </select>
    </div>

    <div class="row info">
      <span class="label">{{ t('settings.thumbnail.cacheUsed', { mb: cacheMb, count: cacheCount }) }}</span>
      <button class="link-btn" type="button" @click="onClear">{{ t('settings.thumbnail.clearCache') }}</button>
    </div>

    <button class="advanced-toggle" type="button" @click="advancedOpen = !advancedOpen">
      {{ advancedOpen ? '▾' : '▸' }} {{ t('settings.thumbnail.advanced') }}
    </button>
    <div v-if="advancedOpen" class="advanced">
      <div class="row">
        <label class="label">{{ t('settings.thumbnail.workerLimit') }}</label>
        <select class="sel" :value="s.thumbnailWorkerLimit" @change="s.setThumbnailWorkerLimit(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="w in workerOptions" :key="w" :value="w">{{ w }}</option>
        </select>
      </div>
      <div class="row">
        <label class="label">{{ t('settings.thumbnail.decodeMemory') }}</label>
        <select class="sel" :value="s.thumbnailDecodeMemoryMb" @change="s.setThumbnailDecodeMemoryMb(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="m in memoryOptions" :key="m" :value="m">{{ m }} MB</option>
        </select>
      </div>
      <div class="row">
        <label class="label">{{ t('settings.thumbnail.prefetchScreens') }}</label>
        <select class="sel" :value="s.thumbnailPrefetchScreens" @change="s.setThumbnailPrefetchScreens(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="p in prefetchOptions" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
      <div class="row">
        <label class="label">{{ t('settings.thumbnail.idleGeneration') }}</label>
        <input type="checkbox" :checked="s.thumbnailIdleGeneration" @change="s.setThumbnailIdleGeneration(($event.target as HTMLInputElement).checked)" />
      </div>
      <div v-if="s.thumbnailIdleGeneration" class="row">
        <label class="label">{{ t('settings.thumbnail.idlePrefetchScreens') }}</label>
        <select class="sel" :value="s.thumbnailIdlePrefetchScreens" @change="s.setThumbnailIdlePrefetchScreens(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="i in idleOptions" :key="i" :value="i">{{ i }}</option>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thumb-settings { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.label { font-size: 12px; color: var(--color-text-secondary); }
.sel {
  font-size: 12px; padding: 2px 6px; background: var(--color-surface-1);
  border: 1px solid var(--color-border-default); border-radius: 4px; color: var(--color-text-primary);
  min-width: 96px;
}
.link-btn { font-size: 12px; color: var(--color-accent); background: transparent; border: 0; cursor: pointer; }
.info .label { color: var(--color-text-muted); }
.advanced-toggle {
  align-self: flex-start; font-size: 12px; color: var(--color-accent);
  background: transparent; border: 0; cursor: pointer; padding: 0;
}
.advanced { display: flex; flex-direction: column; gap: 10px; padding-left: 12px; border-left: 2px solid var(--color-border-default); }
</style>
