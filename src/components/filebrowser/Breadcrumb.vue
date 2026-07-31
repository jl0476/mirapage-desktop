<script setup lang="ts">
/**
 * Breadcrumb.vue
 * 路径面包屑: 段点击 navigate, 整行可点击进入编辑模式 (Xplorer 风格).
 *
 * v0.1.0-module1.19: 重写样式 — 旧 var(--accent) / var(--surface-1) 等已废弃.
 *                  改用 Tailwind @apply + 新 token 名 (--color-accent 等).
 */
import { computed, nextTick, ref, watch } from 'vue';
import { PathUtils } from '@/lib/path';

interface Props {
  /** 根标签（如 "Home" / "Library"） */
  rootLabel: string;
  /** 当前子路径（相对 root），空 = 在根 */
  path: string;
}
const props = defineProps<Props>();

interface Emits {
  (e: 'navigate', toPath: string): void;
}
const emit = defineEmits<Emits>();

const crumbs = computed(() => PathUtils.crumbs(props.rootLabel, props.path));

function onCrumbClick(idx: number) {
  if (idx === crumbs.value.length - 1) return; // 当前段不可点
  emit('navigate', crumbs.value[idx].path);
}

/* ─── 可点击进入编辑模式 (Xplorer 风格) ──────────────── */
const isEditing = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
// 拼出完整路径 (root + path)
const fullPath = computed(() => {
  if (!props.path) return props.rootLabel;
  // Linux/Windows 简单判断: path 含 / 用 /, 含 \ 用 \
  const sep = props.path.includes('\\') ? '\\' : '/';
  return props.rootLabel + sep + props.path;
});

function startEditing() {
  isEditing.value = true;
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
}

function commit() {
  isEditing.value = false;
  const val = inputRef.value?.value?.trim() ?? '';
  if (val && val !== fullPath.value) {
    // 简单回退: 找 fullPath 的子路径 (去除 rootLabel 前缀)
    if (val.startsWith(props.rootLabel)) {
      let sub = val.slice(props.rootLabel.length);
      if (sub.startsWith('/') || sub.startsWith('\\')) sub = sub.slice(1);
      emit('navigate', sub);
    } else {
      // 整段路径不在 root 下, 放弃 (或 emit 完整路径让父处理)
      emit('navigate', val);
    }
  }
}

function cancel() {
  isEditing.value = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
}

/* ─── 简化路径校验 (占位, 后续可接 listDirectory 异步校验) ─ */
const validation = ref<'idle' | 'pending' | 'ok' | 'invalid'>('idle');
// 简化: 编辑中显示 pending, 退出后由 FileBrowser 反馈 (错误 toast 已覆盖 invalid 状态)
watch(isEditing, (v) => {
  validation.value = v ? 'pending' : 'idle';
});
</script>

<template>
  <nav
    class="flex items-center gap-1 px-2 py-1 bg-surface-1 backdrop-blur-md border border-white/10 rounded-md transition-[border-color,box-shadow] duration-100"
    aria-label="Breadcrumb"
  >
    <!-- 显示模式: 段链接 + 分隔符 + 末尾 pencil -->
    <div v-if="!isEditing" class="flex items-center gap-1 flex-1 min-w-0" data-test="display">
      <ol class="flex items-center list-none m-0 p-0 flex-1 min-w-0 overflow-x-auto">
        <template v-for="(c, idx) in crumbs" :key="c.path + '/' + c.label + '/' + idx">
          <li
            data-test="crumb"
            :aria-disabled="idx === crumbs.length - 1 ? 'true' : 'false'"
            class="inline-flex items-center whitespace-nowrap shrink-0"
          >
            <button
              type="button"
              class="crumb-btn"
              :disabled="idx === crumbs.length - 1"
              :title="c.path"
              @click="onCrumbClick(idx)"
            >{{ c.label }}</button>
          </li>
          <span
            v-if="idx < crumbs.length - 1"
            class="text-text-tertiary select-none px-1 font-mono text-xs"
            aria-hidden="true"
          >/</span>
        </template>
      </ol>
      <button
        type="button"
        class="flex items-center justify-center bg-transparent border-0 text-text-tertiary rounded p-1 cursor-pointer shrink-0 transition-[background,color,opacity] duration-100 opacity-60 hover:bg-surface-2 hover:text-text-primary hover:opacity-100"
        data-test="edit-path"
        :title="fullPath"
        :aria-label="'edit path: ' + fullPath"
        @click="startEditing"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
    </div>

    <!-- 编辑模式: input 替换显示 -->
    <div v-else class="flex-1 min-w-0 px-2" :class="validation" data-test="editor">
      <input
        ref="inputRef"
        type="text"
        class="path-input"
        :class="validation"
        :value="fullPath"
        spellcheck="false"
        autocomplete="off"
        @keydown="onKey"
        @blur="commit"
        data-test="path-input"
      />
    </div>
  </nav>
</template>

<style scoped>
/* ─── crumb 按钮 ─────────────────────────────────────── */
.crumb-btn {
  background: transparent;
  border: none;
  font: inherit;
  color: var(--color-text-secondary);
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
}
.crumb-btn:hover:not(:disabled) {
  background: var(--color-surface-2);
  color: var(--color-text-primary);
}
.crumb-btn:disabled {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
  cursor: default;
  font-family: var(--font-sans);
}

/* ─── path input (编辑模式) ──────────────────────────── */
.path-input {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  padding: 2px 0;
}
.path-input.ok { color: var(--color-success); }
.path-input.invalid { color: var(--color-error); }
.path-input.pending { color: var(--color-text-tertiary); }
</style>
