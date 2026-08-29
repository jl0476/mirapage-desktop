<script setup lang="ts">
// MasonryThumbnail.vue — 单张缩略图卡片状态机（§12）
// placeholder / queued / generating（CSS spinner）/ cached（淡入）/ original / failed（重试）
// 仅 transform: rotate 做 spinner；淡入只改 opacity。失败按钮 stopPropagation 只 emit retry。

import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ThumbnailState } from '@/lib/thumbnail';

const props = withDefaults(defineProps<{
  state?: ThumbnailState;
  alt: string;
  /** 角标是否可交互（MasonryView 绑 settingsStore.thumbnailDetailPopover 逐层下传）。
   *  false = 纯指示：disabled（cursor: default、不派发用户点击）。round-3 spec §7.2。 */
  badgeInteractive?: boolean;
}>(), {
  badgeInteractive: true,
});

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'load-error'): void;
  (e: 'show-progress', el: HTMLElement): void;
  /** img 加载完成且 natural 尺寸有效（缩略图保比例 → 即真实宽高比）。
   *  MasonryView 拿它喂 measuredMap 布局比例（§16.2.1 ①：只用于布局，
   *  不进 classify 的 sourceDims——缓存命中时 natural 是缩略图档位尺寸）。 */
  (e: 'measured', width: number, height: number): void;
}>();

const loaded = ref(false);

const imgSrc = computed(() => {
  const s = props.state;
  if (s?.kind === 'cached') return s.path;
  if (s?.kind === 'original') return s.url;
  return '';
});

const showSpinner = computed(() => {
  const k = props.state?.kind;
  // undefined（尚未进入窗口/请求未返回）也显示 spinner，避免白屏；
  // header 失败的图现在也会请求（传 0 尺寸），spinner 是正确反馈。
  return !k || k === 'queued' || k === 'generating' || (k === 'cached' && !loaded.value);
});

const isFailed = computed(() => props.state?.kind === 'failed');

// module3.0.11：阶段角标（generating）+ 错误角标（failed，round-2 必修——
// 失败详情 popover 的唯一主动入口，否则事后无法再打开时间线/重试）。
const showPhaseBadge = computed(() => {
  const k = props.state?.kind;
  return k === 'generating' || k === 'failed';
});

const { t } = useI18n();

const phaseLabel = computed(() => {
  const s = props.state;
  if (s?.kind === 'failed') return t('thumbnail.popover.failed');
  if (s?.kind !== 'generating') return '';
  return t(`thumbnail.phase.${s.phase}`);
});

/** round-4：角标短文字标签（图标旁，i18n thumbnail.badge.*）。 */
const badgeText = computed(() => {
  const s = props.state;
  if (s?.kind === 'failed') return t('thumbnail.badge.failed');
  if (s?.kind !== 'generating') return '';
  return t(`thumbnail.badge.${s.phase}`);
});

// round-1 P2：直传角标元素（currentTarget 在派发期间有效，须在 handler 内取）。
// round-3：badgeInteractive=false 守卫——dispatchEvent 会绕过 disabled 派发
//（测试/程序化路径），handler 内再拦一道。
function onBadgeClick(e: MouseEvent) {
  if (!props.badgeInteractive) return;
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  if (el) emit('show-progress', el);
}

function onRetry(e: MouseEvent) {
  e.stopPropagation();
  emit('retry');
}

function onLoad(e: Event) {
  loaded.value = true;
  // 2026-08-27：上报 natural 尺寸（布局层只用比例）。0 = 解码失败/未真解码，不上报。
  const el = e.target;
  if (el instanceof HTMLImageElement && el.naturalWidth > 0 && el.naturalHeight > 0) {
    emit('measured', el.naturalWidth, el.naturalHeight);
  }
}

function onError() {
  emit('load-error');
}
</script>

<template>
  <div class="masonry-thumb">
    <button
      v-if="showPhaseBadge"
      class="phase-badge"
      :class="{ fail: props.state?.kind === 'failed' }"
      type="button"
      :disabled="!badgeInteractive"
      :title="phaseLabel"
      :aria-label="phaseLabel"
      @click.stop="onBadgeClick"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <!-- round-2 必修：failed 错误角标（失败详情 popover 的唯一主动入口） -->
        <path v-if="props.state?.kind === 'failed'" d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'queued'" d="M12 6v6l4 2" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'decoding'" d="M12 3v10m0 0-4-4m4 4 4-4" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'resizing'" d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        <path v-else-if="props.state?.kind === 'generating' && props.state.phase === 'encoding'" d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
        <path v-else d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      </svg>
      <!-- round-4：角标加短文字（spec §5.1，i18n thumbnail.badge.*） -->
      <span class="phase-badge-text">{{ badgeText }}</span>
    </button>
    <img
      v-if="imgSrc"
      :src="imgSrc"
      :alt="alt"
      class="thumbnail-image"
      :class="{ 'is-ready': loaded }"
      loading="lazy"
      decoding="async"
      @load="onLoad"
      @error="onError"
    />
    <div
      v-if="showSpinner"
      class="thumb-spinner"
      role="status"
      aria-label="loading"
    />
    <div v-if="isFailed" class="thumb-failed">
      <svg class="thumb-error-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      </svg>
      <button class="retry-btn" @click="onRetry">↻ {{ $t?.('fileBrowser.thumbnailRetry') ?? 'retry' }}</button>
    </div>
  </div>
</template>

<style scoped>
.masonry-thumb {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--color-surface-1);
}

.thumbnail-image {
  display: block;
  width: 100%;
  height: auto;
  opacity: 0;
}
.thumbnail-image.is-ready {
  opacity: 1;
  transition: opacity 120ms ease-out;
}

/* module3.0.11：阶段角标——卡片顶部居中胶囊（spec §5.1，round-4 图标+文字） */
.phase-badge {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  /* round-4：宽度由固定 18px 改 auto（容纳图标+短文字） */
  height: 14px;
  padding: 0 5px;
  border: none;
  border-radius: 3px;
  background: rgb(99 102 241 / 0.92);
  color: #fff;
  cursor: pointer;
  z-index: 3;
  line-height: 1;
  white-space: nowrap;
}
.phase-badge-text {
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.2px;
}
.phase-badge:hover { background: rgb(99 102 241); }
/* round-2 必修：failed 错误角标（失败详情 popover 入口） */
.phase-badge.fail { background: rgb(248 113 113 / 0.92); }
.phase-badge.fail:hover { background: rgb(248 113 113); }
/* round-3：纯指示态（开关关）——disabled 按钮显式 default 光标（Chromium 默认即是，显式兜底） */
.phase-badge:disabled { cursor: default; }

/* spinner：仅 transform: rotate，无滤镜/模糊/box-shadow */
.thumb-spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  border: 2px solid var(--color-border-default);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: thumb-spin 0.8s linear infinite;
}
@keyframes thumb-spin {
  to {
    transform: rotate(360deg);
  }
}

.thumb-failed {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-secondary);
  background: var(--color-surface-1);
}
.thumb-error-icon {
  color: var(--color-error);
}
.retry-btn {
  font-size: 12px;
  padding: 2px 8px;
  color: var(--color-accent);
  background: transparent;
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  cursor: pointer;
}
.retry-btn:hover {
  background: var(--color-surface-light);
}

@media (prefers-reduced-motion: reduce) {
  .thumb-spinner {
    animation: none;
    border-top-color: var(--color-accent);
  }
  .thumbnail-image.is-ready {
    transition: none;
  }
}
</style>
