/**
 * ReaderMainMenu.vue — 全屏阅读控制 Dialog（v0.1.0-module3.0.2 + 需求4-C）
 *
 * 参考 PerfectViewer `ReaderMainMenu.kt` 全套 5 组菜单项:
 * - 全屏半透明黑色 (bg-black/88)
 * - 不常驻 toolbar, 不自动 fade
 * - 中央 / 顶中 触发 (useReaderTouchZones 派发 openMenu)
 * - 切换模式/方向/缩放保持打开
 * - 跳页 / 路由 / 关闭按钮 关闭
 *
 * 5 组:
 * 1. 顶栏: 返回 + 标题 + 页码 + 跳页
 * 2. 导航组: 文件浏览器 / 书库 / 历史 / 账户 / 设置
 * 3. 阅读组: 模式 / 方向 / 缩放(下拉) / 幻灯片 / 幻灯片方向
 * 4. 书库工具组: 加入书库 / 喜欢 / 加书签 / 打开书签 / 显示触控区
 * 5. 关闭
 *
 * v0.1.0-reader-review fixes:
 *  - onJumpPage 改为 emit('open-jump-input') — 父级打开跳页 dialog
 *  - onShowTouchRegions emit('show-touch-regions') — 父级切换触控区可视化
 *  - mode/direction/scale/slideshowDirection 走 t() (CLAUDE.md §2.5)
 *  - bg-white/10 分隔条 → xp-divider-h (light 模式可见)
 *  - 5 个 lib 按钮 data-test 独立 id (测试靠 index 取会因 reorder 崩)
 *  - role="dialog" 加 aria-modal="true"
 */
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ScaleMode } from '@/lib/readerSettings';

interface Props {
  show: boolean;
  title?: string;
  currentSpreadIndex: number;
  totalSpreads: number;
  scaleMode?: ScaleMode;
  mode?: 'single' | 'double';
  direction?: 'ltr' | 'rtl';
  isSlideshowPlaying?: boolean;
  slideshowDirection?: 'forward' | 'backward';
  isLiked?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  title: '',
  totalSpreads: 0,
  scaleMode: 'fit-screen',
  mode: 'single',
  direction: 'ltr',
  isSlideshowPlaying: false,
  slideshowDirection: 'forward',
  isLiked: false,
});

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'back'): void;
  (e: 'open-jump-input'): void;           // 跳页 — 父级打开 dialog
  (e: 'show-touch-regions'): void;        // 显示触控区可视化
  (e: 'cycle-mode'): void;
  (e: 'cycle-direction'): void;
  (e: 'scale-change', m: ScaleMode): void;
  (e: 'toggle-slideshow'): void;
  (e: 'toggle-slideshow-direction'): void;
  (e: 'navigate', path: string): void;
  (e: 'add-to-library'): void;
  (e: 'toggle-like'): void;
  (e: 'add-bookmark'): void;
}>();

const { t } = useI18n();

const localShow = ref(props.show);
watch(() => props.show, (v) => { localShow.value = v; });
watch(localShow, (v) => { emit('update:show', v); });

const SCALE_MODES: ScaleMode[] = [
  'fit-screen', 'fit-width', 'fit-height',
  'original', 'full-screen', 'stretch',
];
const scaleOpen = ref(false);

/** enum 值 → i18n key: kebab ('fit-screen') → camel ('fitScreen') */
function scaleLabel(m: ScaleMode): string {
  const camel = m.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return t('reader.scale.' + camel);
}

function close(): void { localShow.value = false; }
function onBack(): void { close(); emit('back'); }
function onJumpPage(): void { close(); emit('open-jump-input'); }
function onShowTouchRegions(): void { close(); emit('show-touch-regions'); }
function onCycleMode(): void { emit('cycle-mode'); }
function onCycleDirection(): void { emit('cycle-direction'); }
function onScaleChange(m: ScaleMode): void { emit('scale-change', m); scaleOpen.value = false; }
function onToggleSlideshow(): void { emit('toggle-slideshow'); }
function onToggleSlideshowDirection(): void { emit('toggle-slideshow-direction'); }

interface NavItem { path: string; key: string }
const NAV_ITEMS: NavItem[] = [
  { path: '/', key: 'nav.fileBrowser' },
  { path: '/library', key: 'nav.library' },
  { path: '/history', key: 'nav.history' },
  { path: '/accounts', key: 'nav.accounts' },
  { path: '/settings', key: 'nav.settings' },
];

function onNav(path: string): void {
  close();
  emit('navigate', path);
}

function onAddToLibrary(): void { close(); emit('add-to-library'); }
function onToggleLike(): void { close(); emit('toggle-like'); }
function onAddBookmark(): void { close(); emit('add-bookmark'); }
function onOpenBookmarks(): void {
  close();
  emit('navigate', '/bookmarks');
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="localShow"
      class="fixed inset-0 z-[1100] bg-black/88 backdrop-blur-sm
             flex flex-col items-stretch p-8 gap-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-label="t('reader.menu.title')"
      data-test="reader-main-menu"
    >
      <!-- 1. 顶栏 -->
      <header class="flex items-center justify-between gap-3">
        <button
          class="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-back"
          @click="onBack"
        >
          ← {{ t('reader.menu.back') }}
        </button>
        <h2 class="text-base font-semibold text-text-primary truncate flex-1 text-center">
          {{ title }}
        </h2>
        <span class="text-xs text-text-muted font-mono">
          {{ currentSpreadIndex + 1 }} / {{ totalSpreads }}
        </span>
        <button
          class="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-jump"
          @click="onJumpPage"
        >
          {{ t('reader.menu.jump') }}
        </button>
      </header>

      <!-- 2. 导航组 -->
      <section class="flex flex-col gap-1">
        <button
          v-for="n in NAV_ITEMS"
          :key="n.path"
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-nav"
          @click="onNav(n.path)"
        >{{ t(n.key) }}</button>
      </section>

      <div class="xp-divider-h" />

      <!-- 3. 阅读组 -->
      <section class="flex flex-col gap-1">
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-mode"
          @click="onCycleMode"
        >
          {{ t('reader.menu.mode') }} · {{ t('reader.mode.' + mode) }}
        </button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-direction"
          @click="onCycleDirection"
        >
          {{ t('reader.menu.direction') }} · {{ t('reader.direction.' + direction) }}
        </button>
        <div class="relative" data-test="menu-scale">
          <button
            class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
            :aria-haspopup="'menu'"
            :aria-expanded="scaleOpen"
            @click="scaleOpen = !scaleOpen"
          >
            {{ t('reader.menu.scale') }} · {{ scaleLabel(scaleMode) }}
          </button>
          <div
            v-if="scaleOpen"
            class="ml-3 flex flex-col gap-1 mt-1"
            role="menu"
          >
            <button
              v-for="m in SCALE_MODES"
              :key="m"
              class="text-left px-3 py-1.5 rounded text-xs hover:bg-surface-light hover:text-text-primary transition-colors"
              :class="m === scaleMode ? 'text-accent' : 'text-text-secondary'"
              data-test="menu-scale-option"
              role="menuitem"
              @click="onScaleChange(m)"
            >{{ scaleLabel(m) }}</button>
          </div>
        </div>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-slideshow"
          @click="onToggleSlideshow"
        >
          {{ isSlideshowPlaying ? t('slideshow.pause') : t('slideshow.play') }}
        </button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-slideshow-direction"
          @click="onToggleSlideshowDirection"
        >
          {{ t('slideshow.direction') }} · {{ t('slideshow.direction' + slideshowDirection.charAt(0).toUpperCase() + slideshowDirection.slice(1)) }}
        </button>
      </section>

      <div class="xp-divider-h" />

      <!-- 4. 书库工具组 (data-test 独立 id, 测试按 id 选而非 index) -->
      <section class="flex flex-col gap-1">
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-lib-add"
          @click="onAddToLibrary"
        >{{ t('fileBrowser.addToLibrary') }}</button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-lib-like"
          @click="onToggleLike"
        >{{ isLiked ? t('reader.unlike') : t('reader.like') }}</button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-lib-bookmark"
          @click="onAddBookmark"
        >{{ t('bookmarks.add') }}</button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-lib-bookmarks"
          @click="onOpenBookmarks"
        >{{ t('reader.openBookmarks') }}</button>
        <button
          class="w-full text-left px-3 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-lib-regions"
          @click="onShowTouchRegions"
        >{{ t('reader.showTouchRegions') }}</button>
      </section>

      <!-- 5. 关闭 -->
      <div class="mt-auto flex justify-end">
        <button
          class="px-4 py-2 rounded text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
          data-test="menu-close"
          @click="close"
        >
          {{ t('reader.menu.close') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>