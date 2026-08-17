<script setup lang="ts">
/**
 * Settings.vue — v0.1.0-module3.0 重写
 * 7 section + 左侧 anchor nav.
 * 视觉基线: Tailwind utility class (CLAUDE.md §1.1), 无 scoped hex 色.
 */
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import { useMaintenanceStore } from '@/stores/maintenance';
import {
  type ScaleMode, type ReadDirection,
} from '@/lib/readerSettings';
import { useSectionAnchors } from '@/composables/useSectionAnchors';
import EnumRow from '@/components/settings/EnumRow.vue';
import BooleanRow from '@/components/settings/BooleanRow.vue';
import ThumbnailCacheSettings from '@/components/settings/ThumbnailCacheSettings.vue';
import NumberRow from '@/components/settings/NumberRow.vue';

const { t } = useI18n();
const settings = useSettingsStore();
const maintenance = useMaintenanceStore();

const sections = ['fileBrowser', 'reader', 'appearance', 'behavior', 'slideshow', 'masonry', 'maintenance'] as const;
const { activeId, scrollTo } = useSectionAnchors([...sections]);

// ─── 维护（spec §8）──────────────────────────────────────────────────
onMounted(() => {
  maintenance.loadSummary();
});
const mb = (bytes: number) => Math.round((bytes || 0) / 1_000_000);
async function setAutoEnabled(v: boolean) { await maintenance.saveConfig({ autoCleanupEnabled: v }); }
async function setMaxEntries(v: number) { await maintenance.saveConfig({ historyMaxEntries: v }); }
async function setRetentionDays(v: number) { await maintenance.saveConfig({ historyRetentionDays: v }); }
async function setProtectDays(v: number) { await maintenance.saveConfig({ historyProtectDays: v }); }
const showPreview = ref(false);
async function doPreview() { await maintenance.fetchPreview(); showPreview.value = true; }
async function doRun() {
  if (!window.confirm(t('settings.maintenance.runConfirm'))) return;
  showPreview.value = false;
  await maintenance.runConfirmed();
}

// ─── 枚举选项源 ───────────────────────────────────────────────────────
const readerModes = [
  { value: 'single', label: t('reader.mode.single') },
  { value: 'double', label: t('reader.mode.double') },
  { value: 'webtoon', label: t('reader.mode.webtoon') },
];

const scaleModes: Array<{ value: ScaleMode; label: string }> = [
  { value: 'fit-screen', label: t('settings.scale.fit-screen') },
  { value: 'fit-width', label: t('settings.scale.fit-width') },
  { value: 'fit-height', label: t('settings.scale.fit-height') },
  { value: 'original', label: t('settings.scale.original') },
  { value: 'full-screen', label: t('settings.scale.full-screen') },
];

const directions = [
  { value: 'ltr', label: t('settings.direction.ltr') },
  { value: 'rtl', label: t('settings.direction.rtl') },
];

const continueModes = [
  { value: 'off', label: t('reader.continue.off') },
  { value: 'auto', label: t('reader.continue.auto') },
  { value: 'manual', label: t('reader.continue.manual') },
];

const themes = [
  { value: 'system', label: t('settings.appearance.themeSystem') },
  { value: 'dark', label: t('settings.appearance.themeDark') },
  { value: 'light', label: t('settings.appearance.themeLight') },
];

const languages = [
  { value: 'system', label: t('lang.system') },
  { value: 'zh-CN', label: t('lang.zh-CN') },
  { value: 'en-US', label: t('lang.en-US') },
];

const slideshowDirs = [
  { value: 'forward', label: t('settings.slideshow.directionForward') },
  { value: 'backward', label: t('settings.slideshow.directionBackward') },
];

// ─── 通用 setter (封装 store 字段 + DB) ─────────────────────────────
async function setReaderMode(v: string) {
  settings.readerDefaultMode = v as 'single' | 'double' | 'webtoon';
  await settings.update('reader_default_mode', v);
}
async function setScaleMode(v: string) {
  settings.defaultScaleMode = v as ScaleMode;
  await settings.update('default_scale_mode', v);
}
async function setDirection(v: string) {
  settings.defaultReadDirection = v as ReadDirection;
  await settings.update('default_read_direction', v);
}
async function setContinue(v: string) {
  settings.continueToNextVolume = v as 'off' | 'auto' | 'manual';
  await settings.update('continue_to_next_volume', v);
}
async function setTheme(v: string) {
  settings.themeMode = v as 'system' | 'dark' | 'light';
  await settings.update('theme_mode', v);
}
async function setLocale(v: string) {
  settings.locale = v as 'system' | 'zh-CN' | 'en-US';
  await settings.update('locale', v);
}
async function setKeepScreenOn(v: boolean) {
  settings.keepScreenOn = v;
  await settings.update('keep_screen_on', v);
}
async function setSlideshowInterval(v: number) {
  const n = Math.max(1, Math.min(30, Number(v) || 1));
  settings.slideshowIntervalMs = n * 1000;
  await settings.update('slideshow_interval_ms', n * 1000);
}
async function setSlideshowDirection(v: string) {
  settings.slideshowDirection = v as 'forward' | 'backward';
  await settings.update('slideshow_direction', v);
}
async function setSlideshowLoop(v: boolean) {
  settings.slideshowLoop = v;
  await settings.update('slideshow_loop', v);
}
// v0.1.0-module3.0.8 (任务 12): masonry 浏览位置 2 开关 setter
async function setRecordBrowsePosition(v: boolean) {
  await settings.setRecordBrowsePosition(v);}
async function setRestoreBrowsePositionOnEnter(v: boolean) {
  await settings.setRestoreBrowsePositionOnEnter(v);
}
// v0.1.0-module3.0.11: 角标点击弹详情开关
async function setThumbnailDetailPopover(v: boolean) {
  await settings.setThumbnailDetailPopover(v);
}
</script>

<template>
  <div
    class="flex h-full w-full bg-bg text-text-primary overflow-hidden"
  >
    <!-- 左侧锚点 nav (light 模式用 surface-2 浅灰底, 与主内容白底区分) -->
    <aside
      class="shrink-0 w-[220px] h-full overflow-y-auto bg-surface-2 border-r border-[color:var(--color-border-default)] px-3 py-4 sticky top-0"
    >
      <h2 class="text-lg font-semibold mb-3 px-2">{{ t('settings.title') }}</h2>
      <ol class="flex flex-col gap-0.5 list-none m-0 p-0">
        <li v-for="s in sections" :key="s">
          <button
            type="button"
            :data-test="`anchor-${s}`"
            class="w-full text-left text-sm rounded-md px-3 py-1.5 hover:bg-surface-3 transition-colors"
            :class="activeId === s ? 'bg-surface-3 text-accent font-medium' : 'text-text-secondary'"
            @click="scrollTo(s)"
          >
            {{ t(`settings.section.${s}`) }}
          </button>
        </li>
      </ol>
    </aside>

    <!-- 右侧滚动内容 -->
    <main class="flex-1 min-w-0 h-full overflow-y-auto px-8 py-6">
      <header class="mb-6">
        <RouterLink to="/" class="text-xs text-text-secondary hover:text-accent">
          ← {{ t('settings.back') }}
        </RouterLink>
        <h1 class="text-2xl font-bold mt-2">{{ t('settings.title') }}</h1>
      </header>

      <div class="flex flex-col gap-6 max-w-[800px]">
        <!-- v0.1.0-module3.0.8 (任务 12): File Browser - masonry 浏览位置 2 开关
             注意：section title 用 `settings.section.fileBrowser`（与现有 6 个 section 一致：
             reader / appearance / behavior / slideshow / touch / masonry 都用 `settings.section.X`，
             所以新 section 也走同一命名空间），内部 BooleanRow label/description 走
             `settings.fileBrowser.{recordBrowsePosition,...}` 的二级分组。 -->
        <section id="fileBrowser" data-test="settings-filebrowser" class="scroll-mt-4 bg-surface-1 xp-bd rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.fileBrowser') }}
          </h3>
          <div class="flex flex-col gap-3">
            <BooleanRow
              :label="t('settings.fileBrowser.recordBrowsePosition')"
              :description="t('settings.fileBrowser.recordBrowsePositionDesc')"
              :value="settings.recordBrowsePosition"
              data-test="record-browse-position"
              @change="setRecordBrowsePosition"
            />
            <BooleanRow
              :label="t('settings.fileBrowser.restoreBrowsePosition')"
              :description="t('settings.fileBrowser.restoreBrowsePositionDesc')"
              :value="settings.restoreBrowsePositionOnEnter"
              :disabled="!settings.recordBrowsePosition"
              data-test="restore-browse-position"
              @change="setRestoreBrowsePositionOnEnter"
            />
            <!-- module3.0.11：角标点击弹生成详情开关（spec §7） -->
            <BooleanRow
              :label="t('settings.fileBrowser.thumbnailDetailPopover')"
              :description="t('settings.fileBrowser.thumbnailDetailPopoverDesc')"
              :value="settings.thumbnailDetailPopover"
              data-test="thumbnail-detail-popover"
              @change="setThumbnailDetailPopover"
            />
          </div>
        </section>

        <!-- Reader defaults -->
        <section id="reader" data-test="section-reader" class="scroll-mt-4 bg-surface-1 border border-[color:var(--color-border-default)] rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.reader') }}
          </h3>
          <div class="flex flex-col gap-3">
            <EnumRow
              :label="t('settings.reader.mode')"
              :value="settings.readerDefaultMode"
              :options="readerModes"
              @change="setReaderMode"
            />
            <EnumRow
              :label="t('settings.reader.scale')"
              :value="settings.defaultScaleMode"
              :options="scaleModes"
              @change="setScaleMode"
            />
            <EnumRow
              :label="t('settings.reader.direction')"
              :value="settings.defaultReadDirection"
              :options="directions"
              @change="setDirection"
              :disabled="settings.readerDefaultMode === 'webtoon'"
            />
            <div v-if="settings.readerDefaultMode === 'webtoon'" class="flex flex-col gap-3" data-test="webtoon-settings">
              <NumberRow :label="t('settings.reader.webtoon.maxWidth')" :value="settings.webtoonMaxWidth" :min="0" :max="4000" suffix="px" @change="settings.setWebtoonMaxWidth" />
              <NumberRow :label="t('settings.reader.webtoon.gap')" :value="settings.webtoonGap" :min="0" :max="24" suffix="px" @change="settings.setWebtoonGap" />
              <NumberRow :label="t('settings.reader.webtoon.scrollSpeed')" :value="settings.webtoonScrollSpeed" :min="10" :max="300" suffix="px/s" @change="settings.setWebtoonScrollSpeed" />
            </div>
            <EnumRow
              :label="t('settings.reader.continue')"
              :value="settings.continueToNextVolume"
              :options="continueModes"
              @change="setContinue"
            />
          </div>
        </section>

        <!-- Appearance -->
        <section id="appearance" data-test="section-appearance" class="scroll-mt-4 bg-surface-1 border border-[color:var(--color-border-default)] rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.appearance') }}
          </h3>
          <div class="flex flex-col gap-3">
            <EnumRow
              :label="t('settings.appearance.theme')"
              :value="settings.themeMode"
              :options="themes"
              @change="setTheme"
            />
          </div>
        </section>

        <!-- Behavior -->
        <section id="behavior" data-test="section-behavior" class="scroll-mt-4 bg-surface-1 border border-[color:var(--color-border-default)] rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.behavior') }}
          </h3>
          <div class="flex flex-col gap-3">
            <BooleanRow
              :label="t('settings.behavior.keepScreenOn')"
              :value="settings.keepScreenOn"
              @change="setKeepScreenOn"
            />
            <EnumRow
              :label="t('settings.behavior.language')"
              :value="settings.locale"
              :options="languages"
              @change="setLocale"
            />
          </div>
        </section>

        <!-- Slideshow -->
        <section id="slideshow" data-test="section-slideshow" class="scroll-mt-4 bg-surface-1 border border-[color:var(--color-border-default)] rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.slideshow') }}
          </h3>
          <div class="flex flex-col gap-3">
            <NumberRow
              :label="t('settings.slideshow.interval')"
              :value="Math.round(settings.slideshowIntervalMs / 1000)"
              :min="1"
              :max="30"
              :suffix="t('settings.slideshow.intervalLabel', { seconds: Math.round(settings.slideshowIntervalMs / 1000) })"
              @change="setSlideshowInterval"
            />
            <EnumRow
              :label="t('settings.slideshow.direction')"
              :value="settings.slideshowDirection"
              :options="slideshowDirs"
              @change="setSlideshowDirection"
            />
            <BooleanRow
              :label="t('settings.slideshow.loop')"
              :value="settings.slideshowLoop"
              @change="setSlideshowLoop"
            />
          </div>
        </section>

        <!-- Masonry -->
        <section id="masonry" data-test="section-masonry" class="scroll-mt-4 bg-surface-1 border border-[color:var(--color-border-default)] rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.masonry') }}
          </h3>
          <div class="flex flex-col gap-3">
            <div>
              <div class="flex items-center justify-between mb-1">
                <span class="text-sm text-text-secondary">{{ t('settings.masonry.defaultCols') }}</span>
                <span class="text-xs text-accent font-mono">{{ settings.masonryDefaultCols }}</span>
              </div>
              <input type="range" min="2" max="8" step="1" :value="settings.masonryDefaultCols"
                     class="w-full accent-accent cursor-pointer" data-test="masonry-default-cols"
                     @input="(e) => settings.setMasonryDefaultCols(Number((e.target as HTMLInputElement).value))" />
            </div>
            <div>
              <div class="flex items-center justify-between mb-1">
                <span class="text-sm text-text-secondary">{{ t('settings.masonry.defaultHGap') }}</span>
                <span class="text-xs text-accent font-mono">{{ settings.masonryDefaultHGap }}px</span>
              </div>
              <input type="range" min="0" max="24" step="1" :value="settings.masonryDefaultHGap"
                     class="w-full accent-accent cursor-pointer" data-test="masonry-default-hgap"
                     @input="(e) => settings.setMasonryDefaultHGap(Number((e.target as HTMLInputElement).value))" />
            </div>
            <div>
              <div class="flex items-center justify-between mb-1">
                <span class="text-sm text-text-secondary">{{ t('settings.masonry.defaultVGap') }}</span>
                <span class="text-xs text-accent font-mono">{{ settings.masonryDefaultVGap }}px</span>
              </div>
              <input type="range" min="0" max="24" step="1" :value="settings.masonryDefaultVGap"
                     class="w-full accent-accent cursor-pointer" data-test="masonry-default-vgap"
                     @input="(e) => settings.setMasonryDefaultVGap(Number((e.target as HTMLInputElement).value))" />
            </div>
          </div>

          <!-- 缩略图缓存资源 / 清晰度 / 容量（v0.1.0-module3.0.7） -->
          <hr class="my-4 border-[color:var(--color-border-default)]" />
          <ThumbnailCacheSettings />
        </section>

        <!-- 存储与数据维护（spec §8）-->
        <section id="maintenance" data-test="section-maintenance" class="scroll-mt-4 bg-surface-1 xp-bd rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-4">
            {{ t('settings.section.maintenance') }}
          </h3>
          <div class="flex flex-col gap-3">
            <BooleanRow
              :label="t('settings.maintenance.autoEnabled')"
              :description="t('settings.maintenance.autoEnabledDesc')"
              :value="maintenance.summary?.autoEnabled ?? true"
              data-test="maintenance-auto-enabled"
              @change="setAutoEnabled"
            />

            <div class="xp-bdt pt-3 mt-1">
              <p class="text-xs font-semibold text-text-secondary mb-2">{{ t('settings.maintenance.historyTitle') }}</p>
              <p v-if="maintenance.summary" class="text-xs text-text-muted mb-3" data-test="maintenance-history-count">
                {{ t('settings.maintenance.historyCount', { count: maintenance.summary.historyTotal, max: maintenance.summary.historyMaxEntries }) }}
              </p>
              <div class="flex flex-col gap-3">
                <NumberRow
                  :label="t('settings.maintenance.historyDays')"
                  :value="maintenance.summary?.historyRetentionDays ?? 365"
                  :min="0" :max="3650"
                  data-test="maintenance-retention-days"
                  @change="setRetentionDays"
                />
                <NumberRow
                  :label="t('settings.maintenance.historyProtect')"
                  :value="maintenance.summary?.historyProtectDays ?? 7"
                  :min="0" :max="30"
                  data-test="maintenance-protect-days"
                  @change="setProtectDays"
                />
                <NumberRow
                  :label="t('settings.maintenance.historyMaxEntries')"
                  :value="maintenance.summary?.historyMaxEntries ?? 2000"
                  :min="0" :max="100000"
                  data-test="maintenance-max-entries"
                  @change="setMaxEntries"
                />
              </div>
            </div>

            <div class="xp-bdt pt-3 mt-1">
              <p class="text-xs font-semibold text-text-secondary mb-2">{{ t('settings.maintenance.thumbnailTitle') }}</p>
              <p v-if="maintenance.summary" class="text-xs text-text-muted mb-3" data-test="maintenance-thumbnail-used">
                {{ t('settings.maintenance.thumbnailUsed', { mb: mb(maintenance.summary.thumbnailTotalBytes), limitMb: mb(maintenance.summary.thumbnailLimitBytes), count: maintenance.summary.thumbnailCount }) }}
              </p>
            </div>

            <div class="flex items-center gap-2 xp-bdt pt-3 mt-1">
              <button class="tb-btn" data-test="maintenance-preview-btn" @click="doPreview">
                {{ t('settings.maintenance.previewBtn') }}
              </button>
              <button class="tb-btn text-accent" data-test="maintenance-run-btn" :disabled="maintenance.loading" @click="doRun">
                {{ maintenance.loading ? t('settings.maintenance.running') : t('settings.maintenance.runBtn') }}
              </button>
            </div>

            <!-- 预览弹层（只读）-->
            <div v-if="showPreview && maintenance.preview" class="xp-bd rounded-lg p-3 bg-surface-2" data-test="maintenance-preview">
              <p class="text-xs font-semibold text-text-primary mb-2">{{ t('settings.maintenance.previewTitle') }}</p>
              <p class="text-xs text-text-muted">
                {{ t('settings.maintenance.previewHistoryDelete', { count: maintenance.preview.history.daysCandidates + maintenance.preview.history.countCandidates, days: maintenance.preview.history.daysCandidates, count2: maintenance.preview.history.countCandidates }) }}
              </p>
              <p class="text-xs text-text-muted">
                {{ t('settings.maintenance.previewProtected', { n: maintenance.preview.history.protectedInWindow, exceed: maintenance.preview.history.protectedExceedsLimit }) }}
              </p>
            </div>

            <!-- 最近结果 -->
            <div v-if="maintenance.lastRun" class="xp-bdt pt-3 mt-1" data-test="maintenance-last-run">
              <p class="text-xs font-semibold text-text-secondary mb-1">{{ t('settings.maintenance.resultTitle') }}</p>
              <p class="text-xs text-text-muted">
                {{ t('settings.maintenance.resultDeleted', { history: maintenance.lastRun.historyDeleted, mb: mb(maintenance.lastRun.thumbnailFreedBytes), dirty: maintenance.lastRun.thumbnailDirtyCleaned }) }}
                · {{ maintenance.lastRun.source === 'manual' ? t('settings.maintenance.resultManual') : t('settings.maintenance.resultAuto') }}
              </p>
            </div>
            <p v-else-if="maintenance.summary && maintenance.summary.lastRunAt === 0" class="text-xs text-text-muted" data-test="maintenance-never-run">
              {{ t('settings.maintenance.neverRun') }}
            </p>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
