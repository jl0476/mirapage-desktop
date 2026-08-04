/**
 * ReaderMainMenu.vue 测试 — v0.1.0-module3.0.2 + 需求4-C PV 全套菜单
 * 覆盖:
 *  - 老的 4 emit 事件 (back / jump-page / cycle-mode / cycle-direction / update:show)
 *  - 新增 PV 全套: 导航组(navigate) / 缩放下拉(scale-change) / 幻灯片(toggle-slideshow,
 *    toggle-slideshow-direction) / 书库工具组(add-to-library, toggle-like, add-bookmark,
 *    打开书签走 navigate(/bookmarks))
 *  + props + i18n + Teleport + 不自动 fade
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import ReaderMainMenu from './ReaderMainMenu.vue';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

const baseProps = {
  show: true,
  title: '漫画 A',
  currentSpreadIndex: 2,
  totalSpreads: 10,
  scaleMode: 'fit-screen' as const,
  mode: 'single' as const,
  direction: 'ltr' as const,
  isSlideshowPlaying: false,
  slideshowDirection: 'forward' as const,
  isLiked: false,
};

function mountMenu(propsOverride: Record<string, unknown> = {}) {
  // 不 attachTo: Teleport 已把菜单渲染到 document.body
  return mount(ReaderMainMenu, {
    props: { ...baseProps, ...propsOverride },
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
  function findAllInBody(testid: string): Element[] {
    return Array.from(document.body.querySelectorAll(`[data-test="${testid}"]`));
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

  // ─── 需求4-C PV 全套菜单 ───────────────────────────────────────────

  it('渲染导航组 5 项 (fileBrowser/library/history/accounts/settings)', () => {
    mountMenu();
    const nav = findAllInBody('menu-nav');
    expect(nav.length).toBe(5);
    expect(nav[0].textContent).toContain('文件浏览器');
    expect(nav[1].textContent).toContain('书库');
    expect(nav[2].textContent).toContain('阅览记录');
    expect(nav[3].textContent).toContain('网络账户');
    expect(nav[4].textContent).toContain('设置');
  });

  it('点导航项 → emit navigate(path) + 关闭', async () => {
    const w = mountMenu();
    (findAllInBody('menu-nav')[1] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('navigate')?.[0]).toEqual(['/library']);
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('/settings 导航也触发 navigate', async () => {
    const w = mountMenu();
    (findAllInBody('menu-nav')[4] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('navigate')?.[0]).toEqual(['/settings']);
  });

  it('渲染书库工具组 5 项', () => {
    mountMenu();
    expect(findAllInBody('menu-lib').length).toBe(5);
  });

  it('点加入书库 → emit add-to-library + 关闭', async () => {
    const w = mountMenu();
    (findAllInBody('menu-lib')[0] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('add-to-library')).toBeTruthy();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('点喜欢 → emit toggle-like + 关闭', async () => {
    const w = mountMenu({ isLiked: false });
    (findAllInBody('menu-lib')[1] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('toggle-like')).toBeTruthy();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('isLiked=true 时喜欢按钮文案为 unlike', () => {
    mountMenu({ isLiked: true });
    const lib = findAllInBody('menu-lib');
    // 第二项是 toggle-like; isLiked=true 应显示取消喜欢文案
    expect(lib[1].textContent).toContain('取消喜欢');
  });

  it('点加书签 → emit add-bookmark + 关闭', async () => {
    const w = mountMenu();
    (findAllInBody('menu-lib')[2] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('add-bookmark')).toBeTruthy();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('点打开书签 → emit navigate(/bookmarks) + 关闭', async () => {
    const w = mountMenu();
    (findAllInBody('menu-lib')[3] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('navigate')?.[0]).toEqual(['/bookmarks']);
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('缩放下拉展开显示全部 ScaleMode', async () => {
    const w = mountMenu();
    // 初始未展开 → 无 option 渲染
    expect(findAllInBody('menu-scale-option').length).toBe(0);
    (findInBody('menu-scale') as HTMLElement).querySelector('button')!.click();
    await w.vm.$nextTick();
    const opts = findAllInBody('menu-scale-option');
    // fit-screen / fit-width / fit-height / original / full-screen / stretch = 6
    expect(opts.length).toBe(6);
  });

  it('点缩放选项 → emit scale-change(mode) + 折叠下拉', async () => {
    const w = mountMenu();
    // 展开
    (findInBody('menu-scale') as HTMLElement).querySelector('button')!.click();
    await w.vm.$nextTick();
    // 选第二项 fit-width
    (findAllInBody('menu-scale-option')[1] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('scale-change')?.[0]).toEqual(['fit-width']);
    // 折叠后无 option 可见
    expect(findAllInBody('menu-scale-option').length).toBe(0);
  });

  it('点击幻灯片播放按钮 → emit toggle-slideshow', async () => {
    const w = mountMenu({ isSlideshowPlaying: false });
    // 阅读组里第4个按钮 (mode/direction/scale/slideshow); 通过 trigger click 找 slideshow
    // 简化策略: 直接 query teleported DOM 找含"播放"文本的按钮并点击
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const playBtn = buttons.find((b) => b.textContent?.includes('播放'));
    expect(playBtn).toBeTruthy();
    playBtn!.click();
    await w.vm.$nextTick();
    expect(w.emitted('toggle-slideshow')).toBeTruthy();
  });

  it('点击幻灯片方向按钮 → emit toggle-slideshow-direction', async () => {
    const w = mountMenu();
    const buttons = Array.from(document.body.querySelectorAll('button'));
    // 方向按钮文案包含"幻灯片方向"
    const dirBtn = buttons.find((b) => b.textContent?.includes('幻灯片方向'));
    expect(dirBtn).toBeTruthy();
    dirBtn!.click();
    await w.vm.$nextTick();
    expect(w.emitted('toggle-slideshow-direction')).toBeTruthy();
  });
});
