<script setup lang="ts">
/**
 * PaginationBar.vue — 列表底部分页栏（2026-08-18，四列表页共用）
 *
 * 受控：props page/pages/total，emit update:page。
 * 布局：« 首页 | ‹ 上一页 | 第 [跳页输入] / y 页 · 共 N 条 | 下一页 › | » 末页
 * 跳页输入：Enter/失焦提交，clamp 到 1..pages；非法输入回落当前页。
 * 单页（pages <= 1）时整栏隐藏。每页条数是全局设置（Settings 页 list_page_size），此处不放调整入口。
 */
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  page: number;
  pages: number;
  /** 总条数（显示"共 N 条"） */
  total: number;
}>();

const emit = defineEmits<{
  (e: 'update:page', v: number): void;
}>();

const { t } = useI18n();

const jumpValue = ref(String(props.page));
watch(() => props.page, (v) => { jumpValue.value = String(v); });

function jumpTo(target: number): void {
  // 非法输入（空串/NaN/<1）no-op：回落当前页显示，不跳转
  if (!Number.isFinite(target) || target < 1) {
    jumpValue.value = String(props.page);
    return;
  }
  const clamped = Math.min(Math.floor(target), props.pages);
  if (clamped !== props.page) emit('update:page', clamped);
  jumpValue.value = String(clamped);
}

function onJumpSubmit(): void {
  jumpTo(Number(jumpValue.value));
}

const ICON_CHEVRON_LEFT = 'M15 18l-6-6 6-6';
const ICON_CHEVRON_RIGHT = 'M9 18l6-6-6-6';
const ICON_DOUBLE_LEFT = 'M11 17l-5-5 5-5M18 17l-5-5 5-5';
const ICON_DOUBLE_RIGHT = 'M13 17l5-5-5-5M6 17l5-5-5-5';
</script>

<template>
  <footer
    v-if="props.pages > 1"
    class="flex items-center justify-center gap-2 mt-4 flex-wrap"
    data-test="pagination-bar"
  >
    <button
      type="button"
      class="flex items-center justify-center w-7 h-7 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="props.page <= 1"
      :title="t('common.firstPage')"
      data-test="pagination-first"
      @click="emit('update:page', 1)"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_DOUBLE_LEFT" />
      </svg>
    </button>
    <button
      type="button"
      class="flex items-center gap-1 px-3 py-1.5 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="props.page <= 1"
      data-test="pagination-prev"
      @click="emit('update:page', props.page - 1)"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_CHEVRON_LEFT" />
      </svg>
      {{ t('common.prevPage') }}
    </button>
    <span class="flex items-center gap-1.5 text-xs text-text-tertiary font-mono">
      {{ t('common.pagePrefix') }}
      <input
        v-model="jumpValue"
        type="number"
        min="1"
        :max="props.pages"
        class="w-12 px-1.5 py-0.5 text-xs xp-bd bg-surface text-text-primary text-center focus:outline-none focus:text-accent"
        data-test="pagination-jump"
        @keydown.enter.prevent="onJumpSubmit"
        @blur="onJumpSubmit"
      />
      {{ t('common.pageSuffix', { pages: props.pages }) }}
      <span class="text-text-muted" data-test="pagination-total">{{ t('common.totalItems', { count: props.total }) }}</span>
    </span>
    <button
      type="button"
      class="flex items-center gap-1 px-3 py-1.5 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="props.page >= props.pages"
      data-test="pagination-next"
      @click="emit('update:page', props.page + 1)"
    >
      {{ t('common.nextPage') }}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_CHEVRON_RIGHT" />
      </svg>
    </button>
    <button
      type="button"
      class="flex items-center justify-center w-7 h-7 rounded text-xs xp-bd bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="props.page >= props.pages"
      :title="t('common.lastPage')"
      data-test="pagination-last"
      @click="emit('update:page', props.pages)"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_DOUBLE_RIGHT" />
      </svg>
    </button>
  </footer>
</template>
