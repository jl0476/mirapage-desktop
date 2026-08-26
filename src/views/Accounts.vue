<script setup lang="ts">
/**
 * AccountsView.vue — 网络账户(SMB / WebDAV)管理
 *
 * Phase 7-8 实装:
 * - 列表 show accounts (id, name, type, host, port, share, username)
 * - 添加/编辑 SMB / WebDAV 账户(name + host + port + cred)
 * - 测试连接(backend returns boolean)
 * - 删除账户
 *
 * M2 task 7 修订:
 * - test() catch 存错误信息，testResult 值由 boolean 扩展为 { ok: boolean; message?: string }
 * - 按错误字符串关键字路由三态：含「权限/认证/Auth/credential」→ testFailAuth、
 *   含「share/契约/配置」→ testFailConfig、其余 → testFailNetwork
 * - 删除按钮的 res.warning 走顶部 5s toast（保留已有 warning 行为）
 *
 * v0.1.0-module3.5.0 后续：视觉对齐 3.1.1 列表页统一范式（Likes/Bookmarks 同款
 * header/行/按钮/空态 + 密码弹窗同款 modal token），删除旧 scoped 硬编码 hex。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import { accountRootDescriptor } from '@/lib/sourceDescriptor';
import {
  listAccounts,
  upsertAccount,
  deleteAccount,
  testConnection,
  type AccountItem,
} from '@/lib/tauri';

const { t } = useI18n();
const router = useRouter();
const fb = useFileBrowserStore();

const accounts = ref<AccountItem[]>([]);
const showAdd = ref(false);
const editing = ref<AccountItem | null>(null);
const draft = ref({
  name: '',
  kind: 'smb' as 'smb' | 'webdav',
  host: '',
  port: 445,
  share: '',
  username: '',
  password: '',
});

/** M2 task 7：testResult 由 boolean 扩为 { ok, message } 对象，支持三态失败分类。 */
interface TestResult {
  ok: boolean;
  message?: string;
}
const testResult = ref<Record<number, TestResult>>({});

/** M2 task 7：测试连接失败原因 5s 顶部 toast（与删除凭据残留 warning 共享同一 banner）。 */
const testFailMessage = ref<string | null>(null);
let testFailTimer: ReturnType<typeof setTimeout> | null = null;

function showTestFail(msg: string): void {
  testFailMessage.value = msg;
  if (testFailTimer) clearTimeout(testFailTimer);
  testFailTimer = setTimeout(() => { testFailMessage.value = null; }, 5000);
}

/** M2 task 7：按后端错误消息关键字路由三态。前端兜底，后端文案已人话；后端没有强制错误码。
 *  实机（2026-08-26，SMB NAS）修正：SMB 认证失败报「Logon Failure (0xc000006d)」——
 *  不含原 auth 关键字会被兜到 network 档误导排查方向，补 SMB/NT 状态词。 */
function classifyTestFail(msg: string): 'auth' | 'config' | 'network' {
  const m = msg.toLowerCase();
  if (m.includes('权限') || m.includes('认证') || m.includes('auth')
      || m.includes('credential') || m.includes('password')
      || m.includes('logon') || m.includes('0xc000006d')
      || m.includes('access_denied') || m.includes('denied')) {
    return 'auth';
  }
  if (m.includes('share') || m.includes('契约') || m.includes('配置')
      || m.includes('share_root') || m.includes('initial_path')
      || m.includes('路径')) {
    return 'config';
  }
  return 'network';
}

function testFailI18nKey(kind: 'auth' | 'config' | 'network'): string {
  return kind === 'auth' ? 'accounts.testFailAuth'
       : kind === 'config' ? 'accounts.testFailConfig'
       : 'accounts.testFailNetwork';
}

/** module3.2.0：删除账户的凭据残留警告（keyring 删除失败时后端返回） */
const warning = ref<string | null>(null);
let warningTimer: ReturnType<typeof setTimeout> | null = null;

function showWarning(msg: string): void {
  warning.value = msg;
  if (warningTimer) clearTimeout(warningTimer);
  warningTimer = setTimeout(() => { warning.value = null; }, 5000);
}

async function refresh() {
  accounts.value = await listAccounts();
}

onMounted(refresh);

function startAdd() {
  editing.value = null;
  draft.value = {
    name: '',
    kind: 'smb',
    host: '',
    port: 445,
    share: '',
    username: '',
    password: '',
  };
  showAdd.value = true;
}

function startEdit(acct: AccountItem) {
  editing.value = acct;
  draft.value = {
    name: acct.name,
    kind: acct.type as 'smb' | 'webdav',
    host: acct.host ?? '',
    port: acct.port ?? 445,
    share: acct.share ?? '',
    username: acct.username ?? '',
    password: '',
  };
  showAdd.value = true;
}

async function save() {
  await upsertAccount({
    id: editing.value?.id,
    name: draft.value.name,
    type: draft.value.kind,
    host: draft.value.host,
    port: draft.value.port,
    share: draft.value.share,
    username: draft.value.username,
    password: draft.value.password || null,
  });
  showAdd.value = false;
  await refresh();
}

async function remove(id: number) {
  const res = await deleteAccount(id);
  if (res.warning) showWarning(res.warning); // 凭据残留提示（spec §3.4）
  await refresh();
}

async function test(id: number) {
  try {
    const ok = await testConnection(id);
    testResult.value = { ...testResult.value, [id]: { ok } };
    if (!ok) {
      // 后端返回 Ok(false) 但不带 message（极少见——工厂层仅在 true/Err 二态）——
      // 给个兜底网络文案，避免 toast 空串。
      showTestFail(t('accounts.testFailNetwork'));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    testResult.value = { ...testResult.value, [id]: { ok: false, message } };
    const kind = classifyTestFail(message);
    showTestFail(t(testFailI18nKey(kind)));
  }
}

/** 副标题：host:port（SMB 追加 share）——mono 路径行（对齐 Likes/快捷方式双行制） */
function hostLine(acct: AccountItem): string {
  const host = `${acct.host ?? ''}:${acct.port ?? ''}`;
  return acct.type === 'smb' && acct.share ? `${host}/${acct.share}` : host;
}

/** 浏览入口（实机补全 2026-08-26：账户配置好后此前无任何 UI 入口可达其目录——
 *  FileBrowser 选根只有本地对话框，Shortcuts/Likes 的 openDescriptorAt 路径需要
 *  先有记录，鸡生蛋）。descriptor 构造经 lib/sourceDescriptor.accountRootDescriptor
 *  （与 FileBrowser 选根菜单共用；module3.5.0 后续提取）。一次性意图经
 *  requestOpenLocation，FileBrowser 消费。 */
function openInBrowser(acct: AccountItem): void {
  fb.requestOpenLocation(accountRootDescriptor(acct), '');
  void router.push('/');
}

const ICON_SERVER = 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12';
const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_GRID = 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z';
const ICON_PULSE = 'M22 12h-4l-3 9L9 3l-3 9H2';
</script>

<template>
  <main class="accounts-view p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">
        {{ t('accounts.title') }}
      </h2>
      <div class="flex items-center gap-3">
        <button
          data-test="add-btn"
          class="flex items-center gap-1 px-3 py-1.5 rounded text-xs xp-bd bg-transparent
                 text-accent hover:bg-surface-2 transition-colors cursor-pointer"
          @click="startAdd"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_PLUS" />
          </svg>
          {{ t('accounts.add') }}
        </button>
        <RouterLink
          to="/"
          class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors"
        >
          ← {{ t('common.back') }}
        </RouterLink>
      </div>
    </header>

    <!-- module3.2.0：凭据残留警告（keyring 删除失败，DB 已删）；
         M2 task 7：测试连接失败三态原因 toast（顶部 5s，与上方共享同一 banner 位） -->
    <p
      v-if="warning"
      data-test="credential-warning"
      class="m-0 mb-4 px-3 py-2 rounded text-xs bg-error/8 border border-error text-error
             shadow-[0_0_10px_rgba(248,113,113,0.3)]"
    >
      {{ warning }}
    </p>
    <p
      v-else-if="testFailMessage"
      data-test="test-fail"
      class="m-0 mb-4 px-3 py-2 rounded text-xs bg-error/8 border border-error text-error
             shadow-[0_0_10px_rgba(248,113,113,0.3)]"
    >
      {{ testFailMessage }}
    </p>

    <!-- 列表（Likes/快捷方式同款双行制：主标题 + 徽章 + mono 副标题 host） -->
    <ul
      v-if="accounts.length > 0"
      data-test="list"
      class="list-none p-0 m-0 flex flex-col gap-2"
    >
      <li
        v-for="acct in accounts"
        :key="acct.id"
        data-test="row"
        class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]"
      >
        <svg
          width="18" height="18" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
          :class="['shrink-0', acct.type === 'smb' ? 'text-success' : 'text-accent']"
        >
          <path :d="ICON_SERVER" />
        </svg>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <span class="font-semibold text-sm text-text-primary truncate">{{ acct.name }}</span>
            <span
              class="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium"
              :class="acct.type === 'smb'
                ? 'bg-success/15 text-success'
                : 'bg-accent/15 text-accent'"
            >{{ t(`accounts.${acct.type}`) }}</span>
            <span
              v-if="testResult[acct.id] !== undefined"
              class="test-result shrink-0 flex items-center gap-1 text-xs"
              :class="testResult[acct.id].ok ? 'ok text-success' : 'fail text-error'"
              :data-test-fail-kind="testResult[acct.id].message
                ? classifyTestFail(testResult[acct.id].message!) : null"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="ICON_PULSE" />
              </svg>
              {{ testResult[acct.id].ok ? t('accounts.testedOk') : t('accounts.testedFail') }}
            </span>
          </div>
          <span class="font-mono text-xs text-text-tertiary truncate" :title="hostLine(acct)">
            {{ hostLine(acct) }}
          </span>
        </div>
        <button
          v-if="acct.type === 'smb' || acct.host"
          data-test="browse-btn"
          :title="t('accounts.browseTitle')"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors cursor-pointer"
          @click="openInBrowser(acct)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_GRID" />
          </svg>
          {{ t('accounts.browse') }}
        </button>
        <button
          data-test="test-btn"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors cursor-pointer"
          @click="test(acct.id)"
        >{{ t('accounts.test') }}</button>
        <button
          data-test="edit-btn"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors cursor-pointer"
          @click="startEdit(acct)"
        >{{ t('accounts.edit') }}</button>
        <button
          data-test="delete-btn"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-error/10 hover:text-error transition-colors cursor-pointer"
          @click="remove(acct.id)"
        >{{ t('accounts.delete') }}</button>
      </li>
    </ul>

    <!-- 空状态（Likes 同款：图标盒 + hint + CTA） -->
    <div
      v-if="accounts.length === 0"
      class="flex flex-col items-center justify-center gap-4 mt-12"
      data-test="empty-state"
    >
      <div class="w-16 h-16 rounded-2xl bg-surface-1 xp-bd flex items-center justify-center backdrop-blur-md">
        <svg
          width="32" height="32" viewBox="0 0 24 24" fill="none"
          stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path :d="ICON_SERVER" />
        </svg>
      </div>
      <p class="text-text-tertiary text-sm m-0">
        {{ t('accounts.empty') }}
      </p>
      <button
        data-test="add-btn-empty"
        class="text-accent text-sm hover:text-accent-hover hover:underline transition-colors bg-transparent border-none cursor-pointer"
        @click="startAdd"
      >
        + {{ t('accounts.add') }} →
      </button>
    </div>

    <!-- 添加/编辑 modal（密码弹窗同款 token 卡片 + input 范式） -->
    <div
      v-if="showAdd"
      class="fixed inset-0 z-[1200] bg-black/60 backdrop-blur-sm flex items-center justify-center"
      @click.self="showAdd = false"
    >
      <div
        role="dialog"
        class="w-[420px] max-w-[90vw] bg-surface-1 xp-bd rounded-lg p-6 flex flex-col gap-3 text-text-primary shadow-xl"
      >
        <h3 class="m-0 text-base font-semibold">
          {{ editing ? t('accounts.edit') : t('accounts.add') }}
        </h3>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.name') }}
          <input
            v-model="draft.name"
            data-test="name"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.type') }}
          <!-- module3.2.0：type 不可变（spec §3.4——杜绝改类型后旧 keyring 条目遗留） -->
          <select
            v-model="draft.kind"
            :disabled="!!editing"
            data-test="kind-select"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-40"
          >
            <option value="smb">{{ t('accounts.smb') }}</option>
            <option value="webdav">{{ t('accounts.webdav') }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.host') }}
          <input
            v-model="draft.host"
            data-test="host"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.port') }}
          <input
            v-model.number="draft.port"
            type="number"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
        <label v-if="draft.kind === 'smb'" class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.share') }}
          <input
            v-model="draft.share"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.username') }}
          <input
            v-model="draft.username"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {{ t('accounts.password') }}
          <input
            v-model="draft.password"
            type="password"
            data-test="password"
            :placeholder="editing ? t('accounts.passwordKeep') : t('accounts.passwordPlaceholder')"
            class="px-3 py-2 bg-surface-inset xp-bd text-text-primary text-sm rounded outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
        <div class="flex justify-end gap-2 mt-2">
          <button
            class="px-3 py-1.5 xp-bd bg-transparent text-text-secondary rounded cursor-pointer text-xs transition-[background,color] duration-100 hover:bg-surface-2 hover:text-text-primary"
            @click="showAdd = false"
          >{{ t('common.cancel') }}</button>
          <button
            data-test="save-btn"
            class="px-3 py-1.5 rounded text-xs bg-accent text-white border-none cursor-pointer hover:bg-accent-hover transition-colors"
            @click="save"
          >{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </main>
</template>
