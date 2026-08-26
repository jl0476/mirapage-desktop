/**
 * PickRootMenu 组件测试 — module3.5.0 后续（选根目录支持网络账户）
 * 三入口：将当前目录设为根（条件渲染）/ 本地文件夹 / 网络账户列表。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import PickRootMenu from './PickRootMenu.vue';
import { listAccounts } from '@/lib/tauri';
import zhCN from '@/locales/zh-CN';

vi.mock('@/lib/tauri', () => ({
  listAccounts: vi.fn(async () => []),
}));

const mockedAccounts = vi.mocked(listAccounts);
const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function mountMenu(props: { canSetRootHere?: boolean; variant?: 'toolbar' | 'cta' } = {}) {
  return mount(PickRootMenu, { props, global: { plugins: [i18n] } });
}

async function openMenu(wrapper: ReturnType<typeof mountMenu>) {
  await wrapper.find('[data-test="btn-pick"]').trigger('click');
  await flushPromises();
}

describe('PickRootMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAccounts.mockResolvedValue([]);
  });

  it('默认关闭；点击 trigger 打开菜单并拉取账户列表', async () => {
    mockedAccounts.mockResolvedValue([
      { id: 7, name: 'NAS', type: 'smb', host: '192.168.50.168', port: 445, share: 'Other1' },
    ]);
    const wrapper = mountMenu();
    expect(wrapper.find('[data-test="pickroot-menu"]').exists()).toBe(false);
    await openMenu(wrapper);
    expect(wrapper.find('[data-test="pickroot-menu"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="pickroot-acct-7"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="pickroot-local"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('NAS');
  });

  it('canSetRootHere=false 时不渲染「将当前目录设为根目录」；true 时渲染', async () => {
    const hidden = mountMenu({ canSetRootHere: false });
    await openMenu(hidden);
    expect(hidden.find('[data-test="pickroot-set-here"]').exists()).toBe(false);

    const shown = mountMenu({ canSetRootHere: true });
    await openMenu(shown);
    expect(shown.find('[data-test="pickroot-set-here"]').exists()).toBe(true);
  });

  it('点击本地项 → emit pickLocal 且菜单关闭', async () => {
    const wrapper = mountMenu();
    await openMenu(wrapper);
    await wrapper.find('[data-test="pickroot-local"]').trigger('click');
    expect(wrapper.emitted('pickLocal')).toHaveLength(1);
    expect(wrapper.find('[data-test="pickroot-menu"]').exists()).toBe(false);
  });

  it('点击「设为根目录」项 → emit setRootHere', async () => {
    const wrapper = mountMenu({ canSetRootHere: true });
    await openMenu(wrapper);
    await wrapper.find('[data-test="pickroot-set-here"]').trigger('click');
    expect(wrapper.emitted('setRootHere')).toHaveLength(1);
  });

  it('点击 SMB 账户 → emit openAccount 携带 share 根 descriptor（空 initialPath + port）', async () => {
    mockedAccounts.mockResolvedValue([
      { id: 7, name: 'NAS', type: 'smb', host: '192.168.50.168', port: 445, share: 'Other1' },
    ]);
    const wrapper = mountMenu();
    await openMenu(wrapper);
    await wrapper.find('[data-test="pickroot-acct-7"]').trigger('click');
    const ev = wrapper.emitted('openAccount');
    expect(ev).toHaveLength(1);
    expect(ev![0]![0]).toEqual({ type: 'smb', accountId: 7, initialPath: '', path: '', port: 445 });
  });

  it('点击 WebDAV 账户 → emit openAccount 携带 baseUrl 根 descriptor', async () => {
    mockedAccounts.mockResolvedValue([
      { id: 3, name: 'Cloud', type: 'webdav', host: 'https://dav.example' },
    ]);
    const wrapper = mountMenu();
    await openMenu(wrapper);
    await wrapper.find('[data-test="pickroot-acct-3"]').trigger('click');
    const ev = wrapper.emitted('openAccount');
    expect(ev![0]![0]).toEqual({ type: 'webdav', accountId: 3, baseUrl: 'https://dav.example', path: '' });
  });

  it('无账户 → 显示占位提示', async () => {
    const wrapper = mountMenu();
    await openMenu(wrapper);
    expect(wrapper.find('[data-test="pickroot-no-accounts"]').exists()).toBe(true);
  });

  it('菜单外 mousedown 关闭菜单', async () => {
    const wrapper = mountMenu();
    await openMenu(wrapper);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[data-test="pickroot-menu"]').exists()).toBe(false);
  });
});
