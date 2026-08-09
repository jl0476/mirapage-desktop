<script setup lang="ts">
// MasonryThumbnail.vue — 单张缩略图卡片状态机（§12）
// placeholder / queued / generating（CSS spinner）/ cached（淡入）/ original / failed（重试）
// 仅 transform: rotate 做 spinner；淡入只改 opacity。失败按钮 stopPropagation 只 emit retry。

import { computed, ref } from 'vue';
import type { ThumbnailState } from '@/lib/thumbnail';

const props = defineProps<{
  state?: ThumbnailState;
  alt: string;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'load-error'): void;
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

function onRetry(e: MouseEvent) {
  e.stopPropagation();
  emit('retry');
}

function onLoad() {
  loaded.value = true;
}

function onError() {
  emit('load-error');
}
</script>

<template>
  <div class="masonry-thumb">
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
