/**
 * ReaderMainMenu.vue 测试 — v0.1.0-module3.0.2
 * 覆盖 4 emit 事件 (back / jump-page / cycle-mode / cycle-direction / update:show)
 * + props + i18n + Teleport + 不自动 fade
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ReaderMainMenu from './ReaderMainMenu.vue';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function mountMenu(propsOverride: Record<string, unknown> = {}) {
  // 不 attachTo: Teleport 已把菜单渲染到 document.body
  return mount(ReaderMainMenu, {
    props: {
      show: true,
      title: '漫画 A',
      currentSpreadIndex: 2,
      totalSpreads: 10,
      ...propsOverride,
    },
    global: { plugins: [i18n] },
  });
}

describe('ReaderMainMenu.vue', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 工具: Teleport 把菜单渲染到 document.body, w.find() 查 wrapper DOM 找不到
  function findInBody(testid: string): Element | null {
    return document.body.querySelector(`[data-test="${testid}"]`);
  }

  it('show=false 时不渲染', () => {
    mountMenu({ show: false });
    expect(findInBody('reader-main-menu')).toBeFalsy();
  });

  it('show=true 时渲染 title + 进度 + 菜单项', () => {
    mountMenu();
    const menu = findInBody('reader-main-menu');
    expect(menu).toBeTruthy();
    expect(menu?.textContent).toContain('漫画 A');
    expect(menu?.textContent).toMatch(/3.*\/.*10/); // currentSpreadIndex + 1 / totalSpreads
  });

  it('点击 back → emit back', async () => {
    const w = mountMenu();
    (findInBody('menu-back') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('back')).toBeTruthy();
    // v0.1.0-module3.0.2: back 应同时关闭菜单
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('点击 jump → emit jump-page(0) + 关闭', async () => {
    const w = mountMenu();
    (findInBody('menu-jump') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('jump-page')?.[0]).toEqual([0]);
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('点击 cycle-mode → emit cycle-mode (不关闭菜单)', async () => {
    const w = mountMenu();
    (findInBody('menu-mode') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('cycle-mode')).toBeTruthy();
    // 重要: cycle-mode 不应关闭菜单 (设计: 切换模式保持打开)
    expect(w.emitted('update:show')).toBeFalsy();
  });

  it('点击 cycle-direction → emit cycle-direction (不关闭菜单)', async () => {
    const w = mountMenu();
    (findInBody('menu-direction') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('cycle-direction')).toBeTruthy();
    expect(w.emitted('update:show')).toBeFalsy();
  });

  it('点击 close → emit update:show(false)', async () => {
    const w = mountMenu();
    (findInBody('menu-close') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('v-model:show 双向绑定: 父组件更新 prop → emit update:show', async () => {
    const w = mountMenu({ show: true });
    await w.setProps({ show: false });
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('Teleport 到 body (不在父组件 DOM 里)', () => {
    mountMenu();
    expect(findInBody('reader-main-menu')).toBeTruthy();
  });
});
