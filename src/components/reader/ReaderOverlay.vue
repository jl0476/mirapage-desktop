<script setup lang="ts">
/**
 * ReaderOverlay.vue
 * 阅读器 UI 浮层（DESIGn §12.5）：
 * - 顶栏：标题 + 页码 + 模式切换 + 主菜单
 * - 底栏：上一页 / 下一页 / 跳页对话框
 * - chromeVisible 控制可见性（按 Esc/M/C 切）
 * - 支持单页/双页模式 label 切换
 */
interface Props {
  title: string;
  currentPage: number;
  totalPages: number;
  mode: 'single' | 'double';
  chromeVisible: boolean;
}
const props = defineProps<Props>();

type Emits = {
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'toggle-mode'): void;
  (e: 'jump', page: number): void;
  (e: 'open-menu'): void;
};
const emit = defineEmits<Emits>();

import { ref } from 'vue';

const jumpValue = ref<number>(0);

function submitJump(ev: Event) {
  ev.preventDefault();
  const target = Number(jumpValue.value);
  if (!Number.isFinite(target) || target < 1) return;
  emit('jump', Math.min(target, props.totalPages));
  jumpValue.value = 0;
}
</script>

<template>
  <div
    v-if="chromeVisible"
    data-test="overlay"
    class="reader-overlay"
  >
    <header class="top">
      <span data-test="title" class="title">{{ title }}</span>
      <span
        data-test="page-indicator"
        class="page"
      >{{ currentPage }} / {{ totalPages }}</span>
      <button
        type="button"
        data-test="btn-mode"
        @click="emit('toggle-mode')"
      >{{ mode === 'single' ? '单页' : '双页' }}</button>
      <button
        type="button"
        data-test="btn-menu"
        @click="emit('open-menu')"
      >☰</button>
    </header>

    <footer class="bottom">
      <button
        type="button"
        data-test="btn-prev"
        :disabled="currentPage <= 1"
        @click="emit('prev')"
      >← 上一页</button>
      <form
        data-test="jump-input"
        @submit="submitJump"
      >
        <label>
          跳页:
          <input
            v-model.number="jumpValue"
            type="number"
            min="1"
            :max="totalPages"
          />
        </label>
        <button type="submit">Go</button>
      </form>
      <button
        type="button"
        data-test="btn-next"
        :disabled="currentPage >= totalPages"
        @click="emit('next')"
      >下一页 →</button>
    </footer>
  </div>
</template>

<style scoped>
.reader-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-size: 13px;
  color: #fff;
}

.reader-overlay > * {
  pointer-events: auto;
}

.top,
.bottom {
  background: rgba(0, 0, 0, 0.7);
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.top .title {
  flex: 1;
  font-weight: 600;
}

.top .page {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

button {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #555;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.bottom form {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
}

.bottom form input {
  width: 60px;
  padding: 2px 4px;
}
</style>
