<script setup lang="ts">
// ThumbnailCacheSettings.vue — 缩略图缓存资源 / 清晰度 / 容量 / 位置设置（§11 §14）
// 挂在 Settings 页 masonry section 下。复用 EnumRow（与设置页其它行一致的 dropdown 模式）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useSettingsStore } from '@/stores/settings';
import {
  cancelThumbnailCacheMigration, clearThumbnailCache,
  getThumbnailCacheInfo, getThumbnailMigrationState, migrateThumbnailCache,
  resumeThumbnailCacheMigration, rollbackThumbnailCacheMigration,
  validateThumbnailCacheLocation, type ThumbnailMigrationState,
} from '@/lib/tauri';
import EnumRow from '@/components/settings/EnumRow.vue';
import type { ThumbnailQuality, ThumbnailResourceMode } from '@/lib/thumbnail';

const { t } = useI18n();
const s = useSettingsStore();

const advancedOpen = ref(false);
const cacheBytes = ref(0);
const cacheCount = ref(0);

// 迁移进度（thumbnail://migration-progress 事件）
interface MigrationProgress {
  phase?: string;
  completed?: number;
  totalFiles?: number;
  copiedBytes?: number;
  totalBytes?: number;
  error?: string;
}
const migrationProgress = ref<MigrationProgress | null>(null);
// 启动恢复：检测到未完成迁移的 manifest
const recovery = ref<ThumbnailMigrationState | null>(null);
let unlistenProgress: UnlistenFn | null = null;

const cacheRootDisplay = computed(() => s.thumbnailCacheRoot || t('settings.masonry.thumbnail.cacheRootSystemDefault'));

async function refreshInfo() {
  try {
    const info = await getThumbnailCacheInfo();
    cacheBytes.value = info.bytes;
    cacheCount.value = info.count;
  } catch {
    /* ignore */
  }
}

async function refreshRecovery() {
  try {
    recovery.value = await getThumbnailMigrationState();
  } catch {
    recovery.value = null;
  }
}

onMounted(async () => {
  await refreshInfo();
  await refreshRecovery();
  unlistenProgress = await listen<MigrationProgress>('thumbnail://migration-progress', (e) => {
    migrationProgress.value = e.payload;
    if (e.payload?.phase === 'completed' || e.payload?.phase === 'cancelled' || e.payload?.phase === 'failed') {
      recovery.value = null;
      void refreshInfo();
      // completed: 后端已持久化 fb_thumbnail_cache_root 到 DB，前端重读 settings 刷新位置显示
      //（否则 cacheRootDisplay 仍显示旧位置，虽然实际已迁移）
      if (e.payload?.phase === 'completed') void s.load();
    }
  });
});
onBeforeUnmount(() => { if (unlistenProgress) unlistenProgress(); });

/** 更改缓存位置：选目录 → 校验 → 迁移（移动现有缓存）。 */
async function onChangeLocation() {
  const picked = await open({ directory: true, multiple: false });
  if (!picked || typeof picked !== 'string') return;
  try {
    await validateThumbnailCacheLocation(picked);
  } catch (e) {
    migrationProgress.value = { phase: 'failed', error: String(e) };
    return;
  }
  // 移动现有缓存到新位置（spec §11.2 首选）
  await migrateThumbnailCache(picked, 'move');
}

async function onContinueMigration() {
  if (!recovery.value) return;
  await resumeThumbnailCacheMigration(recovery.value.targetRoot, recovery.value.mode);
}
async function onRollbackMigration() {
  if (!recovery.value) return;
  await rollbackThumbnailCacheMigration(recovery.value.targetRoot);
  recovery.value = null;
}
async function onCancelMigration() {
  await cancelThumbnailCacheMigration();
}

async function onClear() {
  await clearThumbnailCache();
  await refreshInfo();
}

const cacheMb = computed(() => Math.round(cacheBytes.value / 1_000_000));

const modeOptions = computed(() => [
  { value: 'powerSaver', label: t('settings.masonry.thumbnail.modePowerSaver') },
  { value: 'balanced', label: t('settings.masonry.thumbnail.modeBalanced') },
  { value: 'performance', label: t('settings.masonry.thumbnail.modePerformance') },
]);
const modeValue = computed(() => (modeOptions.value.some((o) => o.value === s.thumbnailResourceMode)
  ? s.thumbnailResourceMode
  : 'custom'));
const modeLabel = computed(() => {
  const found = modeOptions.value.find((o) => o.value === s.thumbnailResourceMode);
  return found ? found.label : t('settings.masonry.thumbnail.modeCustom');
});

const qualityOptions = [
  { value: 'standard', label: t('settings.masonry.thumbnail.qualityStandard') },
  { value: 'high', label: t('settings.masonry.thumbnail.qualityHigh') },
  { value: 'ultra', label: t('settings.masonry.thumbnail.qualityUltra') },
];
const cacheLimitOptions = [256, 512, 1024, 2048].map((m) => ({ value: String(m), label: `${m} MB` }));
const workerOptions = [1, 2, 3, 4, 6, 8, 12, 16].map((w) => ({ value: String(w), label: String(w) }));
const memoryOptions = [64, 128, 256, 512].map((m) => ({ value: String(m), label: `${m} MB` }));
const prefetchOptions = [0, 0.5, 1, 1.5, 2, 3].map((p) => ({ value: String(p), label: String(p) }));
const idleOptions = [0, 0.5, 1, 2].map((i) => ({ value: String(i), label: String(i) }));
</script>

<template>
  <div class="thumb-settings">
    <EnumRow
      :label="t('settings.masonry.thumbnail.resourceMode')"
      :value="modeValue"
      :options="modeValue === 'custom'
        ? [...modeOptions, { value: 'custom', label: modeLabel }]
        : modeOptions"
      @change="(v) => s.setThumbnailResourceMode(v as ThumbnailResourceMode)"
    />
    <EnumRow
      :label="t('settings.masonry.thumbnail.quality')"
      :value="s.thumbnailQuality"
      :options="qualityOptions"
      @change="(v) => s.setThumbnailQuality(v as ThumbnailQuality)"
    />
    <EnumRow
      :label="t('settings.masonry.thumbnail.cacheLimit')"
      :value="String(s.thumbnailCacheLimitMb)"
      :options="cacheLimitOptions"
      @change="(v) => s.setThumbnailCacheLimitMb(Number(v))"
    />

    <div class="info">
      <span class="info-label">{{ t('settings.masonry.thumbnail.cacheUsed', { mb: cacheMb, count: cacheCount }) }}</span>
      <button class="link-btn" type="button" @click="onClear">{{ t('settings.masonry.thumbnail.clearCache') }}</button>
    </div>

    <!-- 缓存位置（§11）-->
    <div class="row location">
      <span class="label">{{ t('settings.masonry.thumbnail.cacheLocation') }}</span>
      <div class="location-right">
        <span class="location-path" :title="cacheRootDisplay">{{ cacheRootDisplay }}</span>
        <button class="link-btn" type="button" :disabled="!!migrationProgress" @click="onChangeLocation">
          {{ t('settings.masonry.thumbnail.changeLocation') }}
        </button>
      </div>
    </div>

    <!-- 迁移进度 -->
    <div v-if="migrationProgress" class="progress">
      <span class="info-label">
        {{ t('settings.masonry.thumbnail.migrating') }}：
        {{ migrationProgress.completed ?? 0 }} / {{ migrationProgress.totalFiles ?? 0 }}
        ({{ Math.round(((migrationProgress.copiedBytes ?? 0) / Math.max(1, migrationProgress.totalBytes ?? 1)) * 100) }}%)
      </span>
      <button v-if="migrationProgress.phase === 'moving' || migrationProgress.phase === 'preparing'" class="link-btn" type="button" @click="onCancelMigration">
        {{ t('common.cancel') }}
      </button>
      <span v-if="migrationProgress.phase === 'failed'" class="error">{{ migrationProgress.error }}</span>
    </div>

    <!-- 启动恢复：检测到未完成迁移 -->
    <div v-if="recovery" class="recovery">
      <span class="info-label">{{ t('settings.masonry.thumbnail.recoveryDetected') }}</span>
      <button class="link-btn" type="button" @click="onContinueMigration">{{ t('settings.masonry.thumbnail.continueMigration') }}</button>
      <button class="link-btn" type="button" @click="onRollbackMigration">{{ t('settings.masonry.thumbnail.rollbackMigration') }}</button>
    </div>

    <button class="advanced-toggle" type="button" @click="advancedOpen = !advancedOpen">
      {{ advancedOpen ? '▾' : '▸' }} {{ t('settings.masonry.thumbnail.advanced') }}
    </button>
    <div v-if="advancedOpen" class="advanced">
      <EnumRow
        :label="t('settings.masonry.thumbnail.workerLimit')"
        :value="String(s.thumbnailWorkerLimit)"
        :options="workerOptions"
        @change="(v) => s.setThumbnailWorkerLimit(Number(v))"
      />
      <EnumRow
        :label="t('settings.masonry.thumbnail.decodeMemory')"
        :value="String(s.thumbnailDecodeMemoryMb)"
        :options="memoryOptions"
        @change="(v) => s.setThumbnailDecodeMemoryMb(Number(v))"
      />
      <EnumRow
        :label="t('settings.masonry.thumbnail.prefetchScreens')"
        :value="String(s.thumbnailPrefetchScreens)"
        :options="prefetchOptions"
        @change="(v) => s.setThumbnailPrefetchScreens(Number(v))"
      />
      <label class="bool-row">
        <span class="bool-label">{{ t('settings.masonry.thumbnail.idleGeneration') }}</span>
        <input
          type="checkbox"
          :checked="s.thumbnailIdleGeneration"
          @change="s.setThumbnailIdleGeneration(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <EnumRow
        v-if="s.thumbnailIdleGeneration"
        :label="t('settings.masonry.thumbnail.idlePrefetchScreens')"
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
.info-label { font-size: 12px; color: var(--color-text-secondary); }
.link-btn { font-size: 12px; color: var(--color-accent); background: transparent; border: 0; cursor: pointer; }
.advanced-toggle {
  align-self: flex-start; font-size: 12px; color: var(--color-accent);
  background: transparent; border: 0; cursor: pointer; padding: 0;
}
.advanced { display: flex; flex-direction: column; gap: 10px; padding-left: 12px; border-left: 2px solid var(--color-border-default); }
.bool-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bool-label { font-size: 14px; color: var(--color-text-secondary); }
.location { align-items: flex-start; }
.location-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.location-path { font-size: 12px; color: var(--color-text-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: right; }
.progress, .recovery { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--color-border-default); border-radius: 4px; }
.error { color: var(--color-error); font-size: 12px; }
</style>
