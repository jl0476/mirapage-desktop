/**
 * ArchivePasswordDialog 测试 — 受控密码弹窗（任务 13）
 * Enter 提交 / Esc 取消 / busy 禁用 / 不回显错误密码 / 重开清空
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ArchivePasswordDialog from './ArchivePasswordDialog.vue';

function testI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });
}

function mountDialog(props: Partial<{
  show: boolean;
  archiveName: string;
  busy: boolean;
  errorKind: 'wrongPassword' | null;
}> = {}) {
  return mount(ArchivePasswordDialog, {
    props: { show: true, archiveName: 'book.cbr', busy: false, errorKind: null, ...props },
    // Teleport 内容渲染进 wrapper（可 find）——BookmarkJumpDialog.test 同款
    global: { plugins: [testI18n()], stubs: { teleport: true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('ArchivePasswordDialog', () => {
  it('Enter 提交、Esc 取消、提交中禁用且不回显错误密码', async () => {
    const wrapper = mount(ArchivePasswordDialog, {
      props: { show: true, archiveName: 'book.cbr', busy: false, errorKind: null },
      // 偏差（测试基建）：Teleport 内容需 stub 才可被 wrapper.get 查找（BookmarkJumpDialog.test 同款）
      global: { plugins: [testI18n()], stubs: { teleport: true } },
    });
    const input = wrapper.get('[data-test="archive-password-input"]');
    await input.setValue('secret');
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('submit')).toEqual([['secret']]);
    // 偏差（测试基建）：Teleport stub 下 wrapper 根是 <teleport-stub>，keydown 不会下传到
    // 遮罩层——改为在弹窗元素上派发（语义一致：Esc 在弹窗内取消）
    await wrapper.get('[data-test="archive-password-dialog"]').trigger('keydown.esc');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    await wrapper.setProps({ busy: true, errorKind: 'wrongPassword' });
    expect(wrapper.get('[data-test="archive-password-submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('secret');
  });

  it('show false→true 清空上次输入；busy 时遮罩点击与 Esc 不取消', async () => {
    const wrapper = mountDialog();
    await wrapper.get('[data-test="archive-password-input"]').setValue('old');
    await wrapper.setProps({ show: false });
    await wrapper.setProps({ show: true });
    expect((wrapper.get('[data-test="archive-password-input"]').element as HTMLInputElement).value).toBe('');

    await wrapper.setProps({ busy: true });
    await wrapper.get('[data-test="archive-password-dialog"]').trigger('click');
    await wrapper.get('[data-test="archive-password-dialog"]').trigger('keydown.esc');
    expect(wrapper.emitted('cancel')).toBeUndefined();
    wrapper.unmount();
  });

  it('wrongPassword 显示错误文案且清空已输入密码', async () => {
    const wrapper = mountDialog();
    await wrapper.get('[data-test="archive-password-input"]').setValue('bad');
    await wrapper.setProps({ errorKind: 'wrongPassword' });
    expect(wrapper.text()).toContain('密码不正确');
    expect((wrapper.get('[data-test="archive-password-input"]').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });
});
