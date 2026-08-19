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
 */
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  listAccounts,
  upsertAccount,
  deleteAccount,
  testConnection,
  type AccountItem,
} from '@/lib/tauri';

const { t } = useI18n();

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

/** M2 task 7：按后端错误消息关键字路由三态。前端兜底，后端文案已人话；后端没有强制错误码。 */
function classifyTestFail(msg: string): 'auth' | 'config' | 'network' {
  const m = msg.toLowerCase();
  if (m.includes('权限') || m.includes('认证') || m.includes('auth')
      || m.includes('credential') || m.includes('password')) {
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
</script>

<template>
  <main class="accounts-view">
    <header>
      <h2>{{ t('accounts.title') }}</h2>
      <div class="actions">
        <button data-test="add-btn" @click="startAdd">+ {{ t('accounts.add') }}</button>
        <RouterLink to="/">← {{ t('common.back') }}</RouterLink>
      </div>
    </header>

    <p v-if="accounts.length === 0" class="hint">
      {{ t('accounts.empty') }}
    </p>

    <!-- module3.2.0：凭据残留警告（keyring 删除失败，DB 已删） -->
    <p v-if="warning" data-test="credential-warning" class="hint warning">
      {{ warning }}
    </p>

    <!-- M2 task 7：测试连接失败三态原因 toast（顶部 5s 提示） -->
    <p v-else-if="testFailMessage" data-test="test-fail" class="hint warning">
      {{ testFailMessage }}
    </p>

    <ul v-if="accounts.length > 0" data-test="list" class="accounts-list">
      <li v-for="acct in accounts" :key="acct.id" data-test="row">
        <span class="name">{{ acct.name }}</span>
        <span class="kind" :class="acct.type">{{ t(`accounts.${acct.type}`) }}</span>
        <span class="host">{{ acct.host ?? '' }}:{{ acct.port ?? '' }}</span>
        <button data-test="test-btn" @click="test(acct.id)">{{ t('accounts.test') }}</button>
        <span
          v-if="testResult[acct.id] !== undefined"
          class="test-result"
          :class="{ ok: testResult[acct.id].ok, fail: !testResult[acct.id].ok }"
          :data-test-fail-kind="testResult[acct.id].message
            ? classifyTestFail(testResult[acct.id].message!) : null"
        >
          {{ testResult[acct.id].ok ? t('accounts.testedOk') : t('accounts.testedFail') }}
        </span>
        <button data-test="edit-btn" @click="startEdit(acct)">{{ t('accounts.edit') }}</button>
        <button data-test="delete-btn" @click="remove(acct.id)">{{ t('accounts.delete') }}</button>
      </li>
    </ul>

    <div v-if="showAdd" class="modal-backdrop" @click.self="showAdd = false">
      <div class="modal" role="dialog">
        <h3>{{ editing ? t('accounts.edit') : t('accounts.add') }}</h3>
        <label>
          {{ t('accounts.name') }}
          <input v-model="draft.name" data-test="name" />
        </label>
        <label>
          {{ t('accounts.type') }}
          <!-- module3.2.0：type 不可变（spec §3.4——杜绝改类型后旧 keyring 条目遗留） -->
          <select v-model="draft.kind" :disabled="!!editing" data-test="kind-select">
            <option value="smb">{{ t('accounts.smb') }}</option>
            <option value="webdav">{{ t('accounts.webdav') }}</option>
          </select>
        </label>
        <label>
          {{ t('accounts.host') }}
          <input v-model="draft.host" data-test="host" />
        </label>
        <label>
          {{ t('accounts.port') }}
          <input v-model.number="draft.port" type="number" />
        </label>
        <label v-if="draft.kind === 'smb'">
          {{ t('accounts.share') }}
          <input v-model="draft.share" />
        </label>
        <label>
          {{ t('accounts.username') }}
          <input v-model="draft.username" />
        </label>
        <label>
          {{ t('accounts.password') }}
          <input
            v-model="draft.password"
            type="password"
            data-test="password"
            :placeholder="editing ? t('accounts.passwordKeep') : t('accounts.passwordPlaceholder')"
          />
        </label>
        <div class="modal-actions">
          <button @click="showAdd = false">{{ t('common.cancel') }}</button>
          <button data-test="save-btn" @click="save">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.accounts-view { padding: 24px; height: 100%; overflow-y: auto; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.actions { display: flex; gap: 12px; align-items: center; }
h2 { margin: 0; }
.accounts-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.accounts-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #444;
  border-radius: 8px;
  flex-wrap: wrap;
}
.accounts-list .name { font-weight: 600; min-width: 120px; }
.accounts-list .kind {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
}
.accounts-list .kind.smb { background: #5a9e3c; }
.accounts-list .kind.webdav { background: #4060c0; }
.accounts-list .host { opacity: 0.7; }
.accounts-list .test-result.ok { color: #5dff5d; }
.accounts-list .test-result.fail { color: #ff6b6b; }
button {
  padding: 4px 10px;
  border: 1px solid #555;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #1f1f1f;
  padding: 24px;
  border-radius: 8px;
  min-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal h3 { margin: 0; }
.modal label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.modal input, .modal select {
  padding: 6px 8px;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 4px;
  color: inherit;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.hint { color: #888; text-align: center; margin-top: 24px; }
.hint.warning { color: #ff6b6b; }
</style>