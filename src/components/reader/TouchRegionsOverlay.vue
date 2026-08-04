<script setup lang="ts">
/**
 * TouchRegionsOverlay.vue — 9 宫格触控区可视化 (v0.1.0-reader-review)
 *
 * 主菜单"显示触控区"按钮切换显示. 渲染 3x3 网格, 每格显示
 * 当前 touchScheme (settings.touchScheme 或 DEFAULT_TOUCH_SCHEME) 映射的动作.
 *
 * 设计:
 *  - pointer-events-none, 不拦截底层 9 宫格点击 (用户可边看边测试)
 *  - z-50 高于 reader, 但低于 overlay chrome
 *  - 半透明 accent 色边 + 暗色填充, 任何底图都可读
 *  - 显示 "按 9 宫格再次触发可隐藏" 提示
 *
 * 注: TouchAction / TouchZone 枚举从 src/lib/readerSettings.ts 取 (CLAUDE.md §3.3)
 */
import { useI18n } from 'vue-i18n';
import { DEFAULT_TOUCH_SCHEME, TOUCH_ZONES, type TouchZone, type TouchAction } from '@/lib/readerSettings';

const { t } = useI18n();

interface Cell {
  zone: TouchZone;
  action: TouchAction;
}

/** 网格顺序: tl tm tr / ml mm mr / bl bm br */
const CELLS: Cell[] = TOUCH_ZONES.map((zone) => ({
  zone,
  action: DEFAULT_TOUCH_SCHEME[zone],
}));
</script>

<template>
  <div
    class="absolute inset-0 z-40 grid grid-cols-3 grid-rows-3 pointer-events-none p-2 gap-1"
    data-test="touch-regions-overlay"
    role="region"
    :aria-label="t('reader.showTouchRegions')"
  >
    <div
      v-for="cell in CELLS"
      :key="cell.zone"
      class="flex items-center justify-center rounded border-2 border-accent/60 bg-accent/10 backdrop-blur-sm"
      :data-test="`touch-region-${cell.zone}`"
    >
      <div class="flex flex-col items-center gap-0.5 text-center">
        <span class="font-mono text-[10px] uppercase tracking-wider text-accent">
          {{ cell.zone }}
        </span>
        <span class="text-xs font-medium text-text-primary">
          {{ t('settings.touchAction.' + cell.action) }}
        </span>
      </div>
    </div>
  </div>
</template>