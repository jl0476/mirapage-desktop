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

  // ---- M2 task 7: test_connection 三态失败分类 ----

  it('test 成功时展示 ok 状态（testResult.ok=true）', async () => {
    mocks.testConnection.mockResolvedValue(true);
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="test-btn"]').trigger('click');
    await flushPromises();
    const result = wrapper.find('.test-result');
    expect(result.exists()).toBe(true);
    expect(result.classes()).toContain('ok');
    expect(wrapper.find('[data-test="test-fail"]').exists()).toBe(false);
  });

  it('test 抛异常时按错误关键字分类为认证失败', async () => {
    mocks.testConnection.mockRejectedValue(new Error('MissingPermissions: 用户认证失败'));
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="test-btn"]').trigger('click');
    await flushPromises();
    await flushPromises();
    const result = wrapper.find('.test-result');
    expect(result.exists()).toBe(true);
    expect(result.classes()).toContain('fail');
    const dataKind = result.attributes('data-test-fail-kind');
    expect(dataKind).toBe('auth');
    // toast 展示 i18n 文案
    const failBanner = wrapper.find('[data-test="test-fail"]');
    expect(failBanner.exists()).toBe(true);
    expect(failBanner.text()).toContain('认证失败');
  });

  it('test 抛异常时按错误关键字分类为配置错误（share/契约）', async () => {
    mocks.testConnection.mockRejectedValue(new Error('smb 账户缺少 share（固定共享根必填）'));
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="test-btn"]').trigger('click');
    await flushPromises();
    await flushPromises();
    const result = wrapper.find('.test-result');
    expect(result.exists()).toBe(true);
    expect(result.classes()).toContain('fail');
    expect(result.attributes('data-test-fail-kind')).toBe('config');
    const failBanner = wrapper.find('[data-test="test-fail"]');
    expect(failBanner.exists()).toBe(true);
    expect(failBanner.text()).toContain('配置错误');
  });

  it('test 抛异常时按错误关键字分类为网络错误（兜底）', async () => {
    mocks.testConnection.mockRejectedValue(new Error('connect timeout after 5s'));
    const wrapper = mount(Accounts, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.find('[data-test="test-btn"]').trigger('click');
    await flushPromises();
    await flushPromises();
    const result = wrapper.find('.test-result');
    expect(result.exists()).toBe(true);
    expect(result.classes()).toContain('fail');
    expect(result.attributes('data-test-fail-kind')).toBe('network');
    const failBanner = wrapper.find('[data-test="test-fail"]');
    expect(failBanner.exists()).toBe(true);
    expect(failBanner.text()).toContain('网络错误');
  });
});
