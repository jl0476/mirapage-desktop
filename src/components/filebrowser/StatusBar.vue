<script setup lang="ts">
/**
 * StatusBar.vue — Xplorer 3 段式文件浏览器状态栏
 *
 * v0.1.0-module1.22:
 *  - 左: 总条目数 + 选中条目数 + 选中字节数
 *  - 中: 当前路径 (truncate, title 是 full path)
 *  - 右: 暂留空 (git / free-space 不在模块 #1.22 范围)
 *
 * v0.1.0-module3.1.1 (三段等宽):
 *  - 左/中/右 各 flex-1 等宽, 中段 justify-center 让路径真正居中
 *  - 右段 slot name="right" 占位 → 任务 2 已移除 slot, 改为内部渲染下一卷按钮
 *
 * v0.1.0-module3.1.1 (任务 2 功能 B 展示层):
 *  - 接收 nextVolumeTitle / nextVolumeLoading / nextVolumeDisabled props
 *  - emit next-volume
 *  - 右段四态: undefined 不渲染 / loading 「…」 / null 「已是最后一卷」灰 disabled /
 *    有值「下一卷: {title}」可点
 *
 * v0.1.0-module3.1.1 (任务 4 功能 D 跑马灯):
 *  - .next-volume-name 固定 max-width:160px, 溢出时 hover 触发 translateX 滚动
 *  - JS 测量 scrollWidth vs clientWidth 判定 needs-marquee (ResizeObserver 兜底)
 *  - button 补 min-w-0 max-w-full (否则默认 min-width:auto 不收缩, 架空 truncate)
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatBytes } from '@/locales/helpers';

interface Props {
  total: number;
  selectedCount: number;
  selectionSizeBytes: number;
  currentPath: string;
  /** v0.1.0-module3.0.3: 父级可覆盖左段文案 (搜索态显示 "找到 N 项") */
  itemsText?: string;
  /** 预查到的下一卷名; null=无下一卷(查完确定); undefined=未传入(不渲染右段) */
  nextVolumeTitle?: string | null;
  /** 预查中(防抖/在途), 右段显示「…」 */
  nextVolumeLoading?: boolean;
  /** 禁用点击: swapping/根目录/无 lastFetchedPath */
  nextVolumeDisabled?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  itemsText: undefined,
  nextVolumeTitle: undefined,
  nextVolumeLoading: false,
  nextVolumeDisabled: false,
});

const emit = defineEmits<{ (e: 'next-volume'): void }>();

const { t } = useI18n();

const itemsLabel = computed(() =>
  props.itemsText ?? t('fileBrowser.statusBar.items', { count: props.total }),
);
const selectedLabel = computed(() =>
  t('fileBrowser.statusBar.selected', { count: props.selectedCount }),
);
const selectionSizeLabel = computed(() => formatBytes(props.selectionSizeBytes));

const nextVolumeLabel = computed(() => {
  // loading 优先于 undefined: 预查中尚不知标题, 也需显示「…」(测试要求)
  if (props.nextVolumeLoading) return '…';
  if (props.nextVolumeTitle === undefined) return null; // 不渲染
  if (props.nextVolumeTitle === null) return t('fileBrowser.statusBar.noNextVolume');
  return t('fileBrowser.statusBar.nextVolume', { title: props.nextVolumeTitle });
});

const nextVolumeDisabledActual = computed(() =>
  props.nextVolumeDisabled || props.nextVolumeTitle === null || props.nextVolumeLoading,
);

/* ————— 任务 4: 卷名 hover 跑马灯 (JS 测量 scrollWidth) ————— */
const nextVolumeNameEl = ref<HTMLElement | null>(null);
const marqueeOffset = ref(0);
const needsMarquee = ref(false);

function measureMarquee() {
  const el = nextVolumeNameEl.value;
  if (!el) return;
  const span = el.querySelector('span') ?? el;
  needsMarquee.value = span.scrollWidth > el.clientWidth + 1;
  marqueeOffset.value = needsMarquee.value ? span.scrollWidth - el.clientWidth : 0;
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  measureMarquee();
  if (nextVolumeNameEl.value) {
    ro = new ResizeObserver(() => measureMarquee());
    ro.observe(nextVolumeNameEl.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <footer
    class="statusbar bg-surface xp-bdt px-3 h-6 flex items-center justify-between gap-2 text-xs text-text-secondary select-none flex-shrink-0"
    data-test="statusbar"
    role="status"
    aria-live="polite"
  >
    <!-- Left: items + selected (flex-1, 左对齐) -->
    <div class="flex-1 flex items-center gap-3 min-w-0 justify-start">
      <span data-test="statusbar-items">{{ itemsLabel }}</span>
      <span
        v-if="selectedCount > 0"
        class="text-text-primary"
        data-test="statusbar-selected"
      >
        {{ selectedLabel }}
        <span class="text-text-muted font-mono ml-1">({{ selectionSizeLabel }})</span>
      </span>
    </div>
    <!-- Center: current path (flex-1, 居中) -->
    <div
      class="flex-1 flex items-center justify-center min-w-0 px-2"
      :title="currentPath"
      data-test="statusbar-path"
    >
      <span class="truncate opacity-80 font-mono">{{ currentPath }}</span>
    </div>
    <!-- Right: 下一卷 (flex-1, 右对齐) -->
    <div class="flex-1 flex items-center justify-end min-w-0" data-test="statusbar-right">
      <button
        v-if="nextVolumeLabel !== null"
        data-test="statusbar-next-volume"
        type="button"
        class="next-volume-btn flex items-center gap-1 px-2 py-0.5 min-w-0 max-w-full text-text-muted hover:text-accent hover:bg-surface-light transition-colors disabled:text-text-tertiary disabled:hover:bg-transparent disabled:cursor-not-allowed"
        :disabled="nextVolumeDisabledActual"
        :title="nextVolumeLabel"
        @click="emit('next-volume')"
      >
        <span
          ref="nextVolumeNameEl"
          class="next-volume-name"
          :class="{ 'needs-marquee': needsMarquee }"
          :style="{ '--marquee-offset': `-${marqueeOffset}px` }"
        >{{ nextVolumeLabel }}</span>
        <svg
          v-if="nextVolumeTitle"
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 4l10 8-10 8V4zM19 5v14" />
        </svg>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.next-volume-name {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  display: inline-block;
  vertical-align: middle;
}
/* hover 滚动: 不溢出时(needs-marquee false)无效果 */
.next-volume-name.needs-marquee {
  cursor: pointer;
}
.next-volume-btn:hover .next-volume-name.needs-marquee {
  animation: statusbar-marquee 4s linear forwards;
}
@keyframes statusbar-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(var(--marquee-offset, 0)); }
}
</style>
