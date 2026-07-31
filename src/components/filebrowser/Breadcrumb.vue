<script setup lang="ts">
/**
 * Breadcrumb.vue — Xplorer NavigationBar 风格
 *
 * v0.1.0-module1.20: 完整对齐 xplorer-next/apps/client/src/components/explorer/NavigationBar.tsx
 *  - 段之间用 ChevronRight 图标 (12px) 替代 / 字符
 *  - 第一段是 Windows 盘符 / Linux 根时显示 HardDrive 图标
 *  - 整条点击进编辑模式 (不只 pencil 图标)
 *  - 编辑模式: input 左侧 6px validation dot (valid=绿, invalid=红, checking=黄)
 *  - 轻量校验: 用 fb.lastFetchedPath / fb.entries 作锚点, 不调 IPC
 */
import { computed, nextTick, ref, watch } from 'vue';
import { PathUtils } from '@/lib/path';

interface Props {
  /** 根标签（如 "C:" / "Home" / "Library"） */
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

/* ─── 整条点击进编辑模式 (Xplorer NavigationBar 行为) ──── */
const isEditing = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

/** 完整路径 (root + path) — 编辑模式的初始值 */
const fullPath = computed(() => {
  if (!props.path) return props.rootLabel;
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
    if (val.startsWith(props.rootLabel)) {
      let sub = val.slice(props.rootLabel.length);
      if (sub.startsWith('/') || sub.startsWith('\\')) sub = sub.slice(1);
      emit('navigate', sub);
    } else {
      // 整段路径不在 root 下, 放弃
      emit('navigate', val);
    }
  }
}

function cancel() {
  isEditing.value = false;
}

/* ─── Validation dot ─────────────────────────────────────── */
type Validation = 'idle' | 'checking' | 'valid' | 'invalid';
const validation = ref<Validation>('idle');
const inputValue = ref('');

let validateTimer: ReturnType<typeof setTimeout> | null = null;

/** 编辑模式: 同步 inputValue; debounce 300ms 后做轻量校验 */
watch(isEditing, (v) => {
  if (v) {
    inputValue.value = fullPath.value;
    validation.value = 'checking';
    scheduleValidate();
  } else {
    validation.value = 'idle';
    if (validateTimer) clearTimeout(validateTimer);
  }
});

function scheduleValidate() {
  if (validateTimer) clearTimeout(validateTimer);
  validateTimer = setTimeout(doValidate, 300);
}

/**
 * 轻量校验: 不调 IPC, 只用 props.rootLabel + props.path 推断
 * - 输入 == 当前 fullPath → valid
 * - 输入以 rootLabel 起头, 余下子路径未越界 → valid
 * - 其它 → invalid (Xplorer 同款实现: 模糊校验不查 fs, 仅看形态)
 */
function doValidate() {
  const v = inputValue.value.trim();
  if (!v) {
    validation.value = 'invalid';
    return;
  }
  if (v === fullPath.value) {
    validation.value = 'valid';
    return;
  }
  // 在 root 之下: 子路径不应包含 '..' 或 rootLabel 之外的上跳
  if (v.startsWith(props.rootLabel)) {
    const sub = v.slice(props.rootLabel.length).replace(/^[\\/]/, '');
    if (!sub.includes('..')) {
      validation.value = 'valid';
      return;
    }
  }
  validation.value = 'invalid';
}

function onInput(e: Event) {
  inputValue.value = (e.target as HTMLInputElement).value;
  validation.value = 'checking';
  scheduleValidate();
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

/** 第一段是否需要 HardDrive 图标 (盘符 C: / Linux /) */
const firstSegmentNeedsDrive = computed(() => {
  const first = crumbs.value[0];
  if (!first) return false;
  return /^[A-Za-z]:$/.test(first.label) || first.label === '/';
});

/** 段间 ChevronRight icon (lucide) */
const ICON_CHEVRON_RIGHT = 'M9 18l6-6-6-6';
/** HardDrive icon (lucide) */
const ICON_HARD_DRIVE = 'M22 12H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z';
</script>

<template>
  <nav
    class="bg-surface border-b border-white/5 px-3 py-1"
    aria-label="Breadcrumb"
  >
    <div
      class="bg-bg border border-white/10 relative flex min-w-0 items-center rounded px-2 py-0.5 transition-[border-color] duration-200"
      :class="validation !== 'idle' && validation !== 'checking' ? (
        validation === 'valid' ? 'border-success' : 'border-error'
      ) : ''"
      @click.self="startEditing"
    >
      <!-- 显示模式: 段链接 + 分隔符 + 末尾 pencil -->
      <div
        v-if="!isEditing"
        class="flex h-full cursor-text items-center gap-0.5 overflow-x-auto flex-1 min-w-0"
        data-test="display"
      >
        <template v-for="(c, idx) in crumbs" :key="c.path + '/' + c.label + '/' + idx">
          <button
            type="button"
            class="crumb-btn max-w-[160px] truncate flex-shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors duration-100"
            :class="idx === crumbs.length - 1
              ? 'font-semibold text-text-primary'
              : 'text-text-muted hover:bg-surface-light hover:text-text-primary'"
            :title="c.path"
            :aria-current="idx === crumbs.length - 1 ? 'location' : undefined"
            :aria-label="`navigate to ${c.label}`"
            :data-test="idx === 0 ? 'crumb-root' : 'crumb'"
            :disabled="idx === crumbs.length - 1"
            @click="onCrumbClick(idx)"
          >
            <svg
              v-if="idx === 0 && firstSegmentNeedsDrive"
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round"
              stroke-linejoin="round" class="inline-block mr-1 -mt-0.5"
              aria-hidden="true"
            >
              <path :d="ICON_HARD_DRIVE" />
            </svg>
            {{ c.label }}
          </button>
          <svg
            v-if="idx < crumbs.length - 1"
            width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" class="text-text-muted opacity-60 shrink-0"
            aria-hidden="true"
          >
            <path :d="ICON_CHEVRON_RIGHT" />
          </svg>
        </template>
        <button
          type="button"
          class="ml-1 p-0.5 rounded text-text-muted hover:bg-surface-light hover:text-text-primary opacity-60 hover:opacity-100 transition-all duration-100 shrink-0"
          data-test="edit-path"
          :title="fullPath"
          aria-label="edit path"
          @click.stop="startEditing"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
      </div>

      <!-- 编辑模式: validation dot + input -->
      <div
        v-else
        class="flex w-full items-center gap-1.5"
        data-test="editor"
      >
        <span
          v-if="validation !== 'idle'"
          :class="[
            'w-1.5 h-1.5 rounded-full shrink-0 transition-colors duration-200',
            validation === 'valid' ? 'bg-success' :
            validation === 'invalid' ? 'bg-error' :
            'bg-warning'
          ]"
          :title="validation === 'valid' ? '路径存在' :
                  validation === 'invalid' ? '路径无效' : '校验中…'"
        />
        <input
          ref="inputRef"
          type="text"
          class="path-input w-full bg-transparent text-xs outline-none"
          :value="inputValue"
          spellcheck="false"
          autocomplete="off"
          data-test="path-input"
          @input="onInput"
          @keydown="onKey"
          @blur="commit"
        />
      </div>
    </div>
  </nav>
</template>

<style scoped>
.path-input {
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  padding: 2px 0;
}
</style>