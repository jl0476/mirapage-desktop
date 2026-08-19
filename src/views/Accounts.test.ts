/**
 * Accounts.vue 测试 — module3.2.0（media-display M1 任务 16）
 * type 编辑锁定 / password 传参 / 删除凭据残留 warning
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import Accounts from './Accounts.vue';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  upsertAccount: vi.fn(),
  deleteAccount: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listAccounts: mocks.listAccounts,
    upsertAccount: mocks.upsertAccount,
    deleteAccount: mocks.deleteAccount,
    testConnection: mocks.testConnection,
  };
});

import zhCN from '@/locales/zh-CN';
const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

const WEBDAV_ACCT = {
  id: 3, name: 'dav', type: 'webdav', host: 'https://d/x', port: null,
  share: null, username: 'u',
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.listAccounts.mockResolvedValue([WEBDAV_ACCT]);
  mocks.upsertAccount.mockResolvedValue(3);
  mocks.deleteAccount.mockResolvedValue({ warning: null });
  mocks.testConnection.mockResolvedValue(true);
});

describe('Accounts.vue', () => {
  it('编辑态 type 下拉禁用（type 不可变）', async () => {
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="edit-btn"]').trigger('click');
    const select = wrapper.find('[data-test="kind-select"]');
    expect((select.element as HTMLSelectElement).disabled).toBe(true);
  });

  it('新建态 type 可选 + 保存传 password 字段', async () => {
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="add-btn"]').trigger('click');
    const select = wrapper.find('[data-test="kind-select"]');
    expect((select.element as HTMLSelectElement).disabled).toBe(false);
    await wrapper.find('[data-test="name"]').setValue('n');
    await wrapper.find('[data-test="host"]').setValue('https://d/y');
    await wrapper.find('[data-test="password"]').setValue('secret');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();
    expect(mocks.upsertAccount).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'secret', type: 'smb', name: 'n' }));
  });

  it('删除返回 warning 时展示提示', async () => {
    mocks.deleteAccount.mockResolvedValue({ warning: '凭据可能残留在系统凭据管理器（webdav-3），请手动清理' });
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="delete-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="credential-warning"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="credential-warning"]').text()).toContain('凭据可能残留');
  });

  it('删除无 warning 时不展示提示', async () => {
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="delete-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="credential-warning"]').exists()).toBe(false);
  });
});
