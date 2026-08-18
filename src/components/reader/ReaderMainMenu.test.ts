/**
 * ReaderMainMenu.vue 测试 — v0.1.0-module3.0.2 + 需求4-C PV 全套菜单
 * 覆盖:
 *  - 老的 emit 事件 (back / cycle-mode / cycle-direction / update:show)
 *  - 跳页改为 emit('open-jump-input') (父级打开 dialog)
 *  - 新增 PV 全套: 导航组(navigate) / 缩放下拉(scale-change) / 幻灯片(toggle-slideshow,
 *    toggle-slideshow-direction) / 书签工具组(toggle-like, add-bookmark,
 *    打开书签走 navigate(/bookmarks))
 *  + props + i18n + Teleport + 不自动 fade
 *
 * v0.1.0-reader-review:
 *  - jump 事件改为 open-jump-input (修复: 之前 emit('jump-page', 0) 总跳到封面)
 *  - lib 按钮用独立 data-test id (menu-lib-like/bookmark/bookmarks)
 *    测试按 id 取, 不再靠 positional index (reorder 安全)
 *  - aria-modal="true" 验证
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

  it('role=dialog + aria-modal=true', () => {
    mountMenu();
    const menu = findInBody('reader-main-menu');
    expect(menu?.getAttribute('role')).toBe('dialog');
    expect(menu?.getAttribute('aria-modal')).toBe('true');
  });

  it('点击 back → emit back + 关闭', async () => {
    const w = mountMenu();
    (findInBody('menu-back') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('back')).toBeTruthy();
    // v0.1.0-module3.0.2: back 应同时关闭菜单
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  // v0.1.0-reader-review: jump 改为 emit('open-jump-input') 让父级打开 dialog.
  // 之前 emit('jump-page', 0) 硬编码 index=0 导致点击永远跳到封面.
  it('点击 jump → emit open-jump-input + 关闭 (不再硬编码 jump-page(0))', async () => {
    const w = mountMenu();
    (findInBody('menu-jump') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('open-jump-input')).toBeTruthy();
    // 必须不带任何 payload (旧版是 [0])
    expect(w.emitted('open-jump-input')?.[0]).toEqual([]);
    expect(w.emitted('jump-page')).toBeFalsy(); // 旧事件已废弃
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

  it('mode=single 时 cycle-mode 按钮文案走 reader.mode.single', () => {
    mountMenu({ mode: 'single' });
    const btn = findInBody('menu-mode');
    expect(btn?.textContent).toContain('单页');
  });

  it('mode=double 时 cycle-mode 按钮文案走 reader.mode.double', () => {
    mountMenu({ mode: 'double' });
    const btn = findInBody('menu-mode');
    expect(btn?.textContent).toContain('双页');
  });

  it('点击 cycle-direction → emit cycle-direction (不关闭菜单)', async () => {
    const w = mountMenu();
    (findInBody('menu-direction') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('cycle-direction')).toBeTruthy();
    expect(w.emitted('update:show')).toBeFalsy();
  });

  it('direction=ltr 时 cycle-direction 按钮文案走 reader.direction.ltr', () => {
    mountMenu({ direction: 'ltr' });
    const btn = findInBody('menu-direction');
    expect(btn?.textContent).toContain('从左到右');
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

  it('渲染导航组 5 项 (fileBrowser/likes/history/accounts/settings)', () => {
    mountMenu();
    const nav = findAllInBody('menu-nav');
    expect(nav.length).toBe(5);
    expect(nav[0].textContent).toContain('文件浏览器');
    expect(nav[1].textContent).toContain('喜欢');
    expect(nav[2].textContent).toContain('阅览记录');
    expect(nav[3].textContent).toContain('网络账户');
    expect(nav[4].textContent).toContain('设置');
  });

  it('点导航项 → emit navigate(path) + 关闭', async () => {
    const w = mountMenu();
    (findAllInBody('menu-nav')[1] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('navigate')?.[0]).toEqual(['/likes']);
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('/settings 导航也触发 navigate', async () => {
    const w = mountMenu();
    (findAllInBody('menu-nav')[4] as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('navigate')?.[0]).toEqual(['/settings']);
  });

  // v0.1.0-module3.0.7: 删"加入书库"按钮(menu-lib-add)
  // v0.1.0-module3.0.12: 删"显示触控区"按钮(menu-lib-regions, 9 宫格整体移除)
  // 书签修复: 加"跳转至书签"(menu-lib-bookmark-jump), 剩 4 个 lib 按钮
  it('渲染书签工具组 4 项 (like/bookmark/bookmark-jump/bookmarks)', () => {
    mountMenu();
    expect(findInBody('menu-lib-add')).toBeFalsy();
    expect(findInBody('menu-lib-like')).toBeTruthy();
    expect(findInBody('menu-lib-bookmark')).toBeTruthy();
    expect(findInBody('menu-lib-bookmark-jump')).toBeTruthy();
    expect(findInBody('menu-lib-bookmarks')).toBeTruthy();
    expect(findInBody('menu-lib-regions')).toBeFalsy();
  });

  it('点喜欢 → emit toggle-like + 关闭', async () => {
    const w = mountMenu({ isLiked: false });
    (findInBody('menu-lib-like') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('toggle-like')).toBeTruthy();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('isLiked=true 时喜欢按钮文案为 unlike', () => {
    mountMenu({ isLiked: true });
    const btn = findInBody('menu-lib-like');
    expect(btn?.textContent).toContain('取消喜欢');
  });

  it('点加书签 → emit add-bookmark + 关闭', async () => {
    const w = mountMenu();
    (findInBody('menu-lib-bookmark') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('add-bookmark')).toBeTruthy();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('点跳转至书签 → emit open-bookmark-jump + 关闭', async () => {
    const w = mountMenu();
    (findInBody('menu-lib-bookmark-jump') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('open-bookmark-jump')).toBeTruthy();
    expect(w.emitted('update:show')?.[0]).toEqual([false]);
  });

  it('点打开书签 → emit navigate(/bookmarks)（全局聚合视图,不带 bookId）', async () => {
    const w = mountMenu();
    (findInBody('menu-lib-bookmarks') as HTMLElement).click();
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
    // fit-screen / fit-width / fit-height / original / full-screen = 5 (stretch 已移除)
    expect(opts.length).toBe(5);
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

  // v0.1.0-reader-review: scale 按钮文案走 t('reader.scale.*') 而非 raw enum
  it('scale 按钮文案显示中文翻译 (适应屏幕), 非 raw enum "fit-screen"', () => {
    mountMenu({ scaleMode: 'fit-screen' });
    const btn = findInBody('menu-scale')?.querySelector('button');
    expect(btn?.textContent).toContain('适应屏幕');
    expect(btn?.textContent).not.toContain('fit-screen');
  });

  it('点击幻灯片播放按钮 → emit toggle-slideshow', async () => {
    const w = mountMenu({ isSlideshowPlaying: false });
    (findInBody('menu-slideshow') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('toggle-slideshow')).toBeTruthy();
  });

  it('点击幻灯片方向按钮 → emit toggle-slideshow-direction', async () => {
    const w = mountMenu();
    (findInBody('menu-slideshow-direction') as HTMLElement).click();
    await w.vm.$nextTick();
    expect(w.emitted('toggle-slideshow-direction')).toBeTruthy();
  });

  it('页码 override（十轮 P2）：webtoon 下显示 currentPageOverride / totalPagesOverride', async () => {
    const w = mountMenu({ mode: 'webtoon', currentPageOverride: 5, totalPagesOverride: 120 });
    await w.vm.$nextTick();
    const header = document.body.querySelector('[data-test="menu-jump"]')?.parentElement;
    expect(header?.textContent).toContain('5 / 120');
  });

});