<script setup lang="ts">
/**
 * ArchivePasswordDialog.vue — 压缩包会话密码弹窗（任务 13）
 *
 * 受控组件：父级管 show / busy / errorKind；提交 emit submit(password)，
 * 取消（遮罩 / Esc / 取消按钮，仅非 busy）emit cancel。
 * 密码仅在本次运行期间保留（store 会话密码库），组件本地不缓存：
 * show false→true 清空 + focus；wrongPassword 清空 + focus；提交即清空。
 */
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ArchiveAccessError } from '@/lib/tauri';

interface Props {
  show: boolean;
  archiveName: string;
  busy: boolean;
  errorKind: ArchiveAccessError['kind'] | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'submit', password: string): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18n();

const password = ref('');
const visible = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

async function focusInput(): Promise<void> {
  await nextTick();
  inputRef.value?.focus();
}

// show false→true：清空上次输入（含明文切换态），聚焦输入框
watch(() => props.show, (v) => {
  if (v) {
    password.value = '';
    visible.value = false;
    void focusInput();
  }
});

// wrongPassword 回包：清空错误密码并重新聚焦（留在弹窗可重试）
watch(() => props.errorKind, (k) => {
  if (k === 'wrongPassword') {
    password.value = '';
    void focusInput();
  }
});

function onSubmit(): void {
  if (props.busy) return;
  const value = password.value;
  password.value = ''; // 提交后立即清空——错误密码不留在 DOM
  emit('submit', value);
}

function onCancel(): void {
  if (props.busy) return;
  emit('cancel');
}

/* ─── Lucide SVG 图标路径（内嵌，不引 lucide 包） ─── */
const ICON_EYE = 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const ICON_EYE_OFF = 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22';
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.show"
      class="fixed inset-0 z-[1400] bg-black/60 backdrop-blur-sm flex items-center justify-center"
      data-test="archive-password-dialog"
      @click.self="onCancel"
      @keydown.esc="onCancel"
    >
      <div class="w-[360px] bg-surface-1 xp-bd rounded-lg p-6 flex flex-col gap-3 text-text-primary shadow-xl">
        <h3 class="m-0 text-base font-semibold flex items-center gap-2">
          {{ t('fileBrowser.archive.passwordTitle') }}
        </h3>
        <p class="m-0 text-xs text-text-secondary truncate" :title="props.archiveName">
          {{ props.archiveName }}
        </p>
        <p
          v-if="props.errorKind === 'wrongPassword'"
          data-test="archive-password-error"
          class="m-0 text-xs text-error"
        >
          {{ t('fileBrowser.archive.wrongPassword') }}
        </p>
        <div class="relative flex items-center">
          <input
            ref="inputRef"
            v-model="password"
            :type="visible ? 'text' : 'password'"
            data-test="archive-password-input"
            autocomplete="off"
            spellcheck="false"
            class="w-full px-3 py-2 pr-8 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
            @keydown.enter="onSubmit"
          />
          <button
            type="button"
            class="absolute right-1.5 flex items-center justify-center w-6 h-6 bg-transparent border-0 text-text-tertiary cursor-pointer hover:text-text-primary"
            :title="t('fileBrowser.archive.showPassword')"
            :aria-label="t('fileBrowser.archive.showPassword')"
            @click="visible = !visible"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <path v-if="visible" :d="ICON_EYE" />
              <path v-else :d="ICON_EYE_OFF" />
            </svg>
          </button>
        </div>
        <p class="m-0 text-xs text-text-tertiary">
          {{ t('fileBrowser.archive.passwordHint') }}
        </p>
        <div class="flex justify-end gap-2 mt-1">
          <button
            type="button"
            data-test="archive-password-cancel"
            :disabled="props.busy"
            class="px-3 py-1.5 xp-bd bg-transparent text-text-secondary rounded cursor-pointer text-xs transition-[background,color] duration-100 hover:bg-surface-2 hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            @click="onCancel"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            data-test="archive-password-submit"
            :disabled="props.busy"
            class="px-4 py-1.5 bg-accent border border-accent text-white rounded cursor-pointer text-xs font-semibold shadow-[0_0_10px_rgba(99,102,241,0.4)] transition-[background,transform] duration-100 hover:bg-accent-hover active:translate-y-px disabled:opacity-40 disabled:cursor-not-allowed"
            @click="onSubmit"
          >
            {{ t('common.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
