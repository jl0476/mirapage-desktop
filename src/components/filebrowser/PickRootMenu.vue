<script setup lang="ts">
/**
 * PickRootMenu.vue — 「选择根目录」下拉（module3.5.0 后续：网络账户可达）
 *
 * 三类入口：
 * 1. 将当前目录设为根目录（仅远程 SMB/WebDAV 会话且已进入子目录时出现——
 *    把当前目录提升为浏览根，跨重启记忆，与本地选根同级）
 * 2. 本地文件夹…（原生目录对话框，原有行为）
 * 3. 网络账户列表（SMB share 根 / WebDAV baseUrl 根；每次打开时刷新账户）
 *
 * variant: 'toolbar'（工具栏 tb-btn 样式）| 'cta'（空态大按钮样式）。
 * 账户打开动作经 emit 交 FileBrowser（openDescriptorAt 单点），本组件不碰 store。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { listAccounts, type AccountItem } from '@/lib/tauri';
import { accountRootDescriptor, type SourceDescriptor } from '@/lib/sourceDescriptor';

withDefaults(
  defineProps<{
    /** 远程会话且 currentPath 非空时才允许提升当前目录为根 */
    canSetRootHere?: boolean;
    variant?: 'toolbar' | 'cta';
  }>(),
  { canSetRootHere: false, variant: 'toolbar' },
);

const emit = defineEmits<{
  (e: 'pickLocal'): void;
  (e: 'setRootHere'): void;
  (e: 'openAccount', descriptor: SourceDescriptor): void;
}>();

const { t } = useI18n();
const open = ref(false);
const dropdownRef = ref<HTMLDivElement | null>(null);
const accounts = ref<AccountItem[]>([]);
const loadingAccounts = ref(false);

const ICON_FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ICON_PIN = 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 z';
const ICON_SERVER = 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12';
const ICON_CHEVRON_DOWN = 'M6 9l6 6 6-6';

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    // 每次打开刷新（账户增删即时反映；单次 IPC 代价可忽略）
    loadingAccounts.value = true;
    try {
      accounts.value = await listAccounts();
    } catch {
      accounts.value = [];
    } finally {
      loadingAccounts.value = false;
    }
  }
}

function onPickLocal(): void {
  open.value = false;
  emit('pickLocal');
}

function onSetRootHere(): void {
  open.value = false;
  emit('setRootHere');
}

function onOpenAccount(acct: AccountItem): void {
  open.value = false;
  emit('openAccount', accountRootDescriptor(acct));
}

function onMouseDown(e: MouseEvent) {
  if (!dropdownRef.value?.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener('mousedown', onMouseDown));
onUnmounted(() => document.removeEventListener('mousedown', onMouseDown));
</script>

<template>
  <div ref="dropdownRef" class="relative">
    <button
      v-if="variant === 'toolbar'"
      type="button"
      class="tb-btn shrink-0"
      data-test="btn-pick"
      @click="toggle"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" class="shrink-0" aria-hidden="true">
        <path :d="ICON_FOLDER" />
      </svg>
      {{ t('fileBrowser.pickRoot') }}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" class="opacity-60 shrink-0" aria-hidden="true">
        <path :d="ICON_CHEVRON_DOWN" />
      </svg>
    </button>
    <button
      v-else
      type="button"
      data-test="btn-pick"
      class="flex items-center gap-2 px-5 py-2.5 bg-accent text-white border-0 rounded-md font-semibold cursor-pointer shadow-[0_0_12px_rgba(99,102,241,0.45)] transition-[background,transform,box-shadow] duration-100 hover:bg-accent-hover hover:shadow-[0_0_18px_rgba(99,102,241,0.65)] active:translate-y-px"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_FOLDER" />
      </svg>
      {{ t('fileBrowser.pickRoot') }}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" class="opacity-70" aria-hidden="true">
        <path :d="ICON_CHEVRON_DOWN" />
      </svg>
    </button>
    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1 min-w-[230px] max-h-[320px] overflow-y-auto bg-surface-4 xp-bd rounded-lg py-1 shadow-xl backdrop-blur-xl"
      role="menu"
      data-test="pickroot-menu"
    >
      <button
        v-if="canSetRootHere"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-light transition-colors text-text-secondary"
        role="menuitem"
        data-test="pickroot-set-here"
        @click="onSetRootHere"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path :d="ICON_PIN" />
        </svg>
        {{ t('fileBrowser.setRootHere') }}
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-light transition-colors text-text-secondary"
        role="menuitem"
        data-test="pickroot-local"
        @click="onPickLocal"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path :d="ICON_FOLDER" />
        </svg>
        {{ t('fileBrowser.pickRootLocal') }}
      </button>
      <div class="xp-bdt-subtle my-1" />
      <p class="px-3 py-1 m-0 text-[11px] text-text-muted select-none">
        {{ t('fileBrowser.pickRootAccounts') }}
      </p>
      <button
        v-for="acct in accounts"
        :key="acct.id"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-light transition-colors text-text-secondary"
        role="menuitem"
        :data-test="`pickroot-acct-${acct.id}`"
        @click="onOpenAccount(acct)"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path :d="ICON_SERVER" />
        </svg>
        <span class="truncate">{{ acct.name }}</span>
        <span class="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-text-muted">{{ acct.type }}</span>
      </button>
      <p
        v-if="!loadingAccounts && accounts.length === 0"
        class="px-3 py-1.5 m-0 text-xs text-text-muted"
        data-test="pickroot-no-accounts"
      >
        {{ t('fileBrowser.pickRootNoAccounts') }}
      </p>
    </div>
  </div>
</template>
