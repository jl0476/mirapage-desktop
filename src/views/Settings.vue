<script setup lang="ts">
/**
 * Settings.vue — v0.1.0-module3.0 重写
 * 6 section + 左侧 anchor nav + 9 宫格触控编辑器 + reset 按钮.
 * 视觉基线: Tailwind utility class (CLAUDE.md §1.1), 无 scoped hex 色.
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import {
  TOUCH_ACTIONS,
  type ScaleMode, type ReadDirection,
  type TouchZone, type TouchAction,
} from '@/lib/readerSettings';
import { useSectionAnchors } from '@/composables/useSectionAnchors';
import EnumRow from '@/components/settings/EnumRow.vue';
import BooleanRow from '@/components/settings/BooleanRow.vue';
import NumberRow from '@/components/settings/NumberRow.vue';

const { t } = useI18n();
const settings = useSettingsStore();

const sections = ['reader', 'appearance', 'behavior', 'slideshow', 'touch'] as const;
const { activeId, scrollTo } = useSectionAnchors([...sections]);

// ─── 枚举选项源 ───────────────────────────────────────────────────────
const readerModes = [
  { value: 'single', label: t('reader.mode.single') },
  { value: 'double', label: t('reader.mode.double') },
];

const scaleModes: Array<{ value: ScaleMode; label: string }> = [
  { value: 'fit-screen', label: t('settings.scale.fit-screen') },
  { value: 'fit-width', label: t('settings.scale.fit-width') },
  { value: 'fit-height', label: t('settings.scale.fit-height') },
  { value: 'original', label: t('settings.scale.original') },
  { value: 'full-screen', label: t('settings.scale.full-screen') },
  { value: 'stretch', label: t('settings.scale.stretch') },
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

const touchActionLabels = computed<Record<TouchAction, string>>(() => ({
  'none': t('settings.touchAction.none'),
  'prev-page': t('settings.touchAction.prevPage'),
  'next-page': t('settings.touchAction.nextPage'),
  'jump-first': t('settings.touchAction.jumpFirst'),
  'jump-last': t('settings.touchAction.jumpLast'),
  'open-main-menu': t('settings.touchAction.openMainMenu'),
  'slideshow-toggle': t('settings.touchAction.slideshowToggle'),
  'fit-width': t('settings.touchAction.fitWidth'),
  'folder-prev': t('settings.touchAction.folderPrev'),
  'folder-next': t('settings.touchAction.folderNext'),
  'open-file-browser': t('settings.touchAction.openFileBrowser'),
}));

// ─── 单格 dropdown 开/关状态 ──────────────────────────────────────────
const openCell = ref<TouchZone | null>(null);
const showResetConfirm = ref(false);

function toggleCell(zone: TouchZone): void {
  openCell.value = openCell.value === zone ? null : zone;
}

async function pickAction(zone: TouchZone, action: TouchAction): Promise<void> {
  openCell.value = null;
  await settings.setTouchAction(zone, action);
}

async function onResetTouch(): Promise<void> {
  showResetConfirm.value = false;
  await settings.resetTouchScheme();
}

// ─── 通用 setter (封装 store 字段 + DB) ─────────────────────────────
async function setReaderMode(v: string) {
  settings.readerDefaultMode = v as 'single' | 'double';
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
async function setTouchZonesEnabled(v: boolean) {
  settings.touchZonesEnabled = v;
  await settings.update('touch_zones_enabled', v);
}

const touchGridRows: TouchZone[][] = [
  ['tl', 'tm', 'tr'],
  ['ml', 'mm', 'mr'],
  ['bl', 'bm', 'br'],
];

// 点击空白处关闭单格 dropdown
function closeOpenCell(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('[data-touch-cell]')) {
    openCell.value = null;
  }
}
</script>

<template>
  <div
    class="flex h-full w-full bg-bg text-text-primary overflow-hidden"
    @mousedown="closeOpenCell"
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
            />
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

        <!-- Touch zones -->
        <section id="touch" data-test="section-touch" class="scroll-mt-4 bg-surface-1 border border-[color:var(--color-border-default)] rounded-lg p-6">
          <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-2">
            {{ t('settings.section.touch') }}
          </h3>
          <p class="text-xs text-text-secondary mb-4">{{ t('settings.touch.hint') }}</p>

          <div class="mb-4">
            <BooleanRow
              :label="t('settings.touch.enabled')"
              :value="settings.touchZonesEnabled"
              @change="setTouchZonesEnabled"
            />
          </div>

          <div class="inline-flex flex-col gap-1 mb-4">
            <div v-for="row in touchGridRows" :key="row.join(',')" class="flex gap-1">
              <div
                v-for="zone in row"
                :key="zone"
                class="relative"
                data-test="touch-cell"
                data-touch-cell
              >
                <button
                  type="button"
                  class="w-[88px] h-[60px] bg-surface-2 border border-[color:var(--color-border-default)] rounded-md text-xs px-1 hover:bg-surface-3 transition-colors flex items-center justify-center text-center"
                  @click.stop="toggleCell(zone)"
                >
                  {{ touchActionLabels[settings.touchScheme[zone]] }}
                </button>
                <ul
                  v-if="openCell === zone"
                  class="absolute z-10 left-0 top-full mt-1 min-w-[170px] bg-surface-4 border border-[color:var(--color-border-default)] rounded-lg py-1 shadow-xl backdrop-blur-xl"
                >
                  <li v-for="action in TOUCH_ACTIONS" :key="action">
                    <button
                      type="button"
                      class="block w-full text-left text-xs px-3 py-1.5 hover:bg-surface-light"
                      :class="settings.touchScheme[zone] === action ? 'text-accent' : ''"
                      @click.stop="pickAction(zone, action)"
                    >
                      {{ touchActionLabels[action] }}
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div>
            <button
              type="button"
              data-test="touch-reset"
              class="text-xs text-text-secondary hover:text-accent border border-[color:var(--color-border-default)] px-3 py-1 rounded-md"
              @click="showResetConfirm = true"
            >
              {{ t('settings.touch.reset') }}
            </button>
            <button
              v-if="showResetConfirm"
              type="button"
              data-test="reset-confirm"
              class="ml-2 text-xs text-error border border-error/40 px-3 py-1 rounded-md"
              @click="onResetTouch"
            >
              {{ t('settings.touch.resetConfirm') }}
            </button>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
