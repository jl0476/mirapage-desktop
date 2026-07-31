/**
 * SideNav 模块 #0 单测
 * 覆盖 SideNav 导航、settings 读写与折叠切换
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, type Router, RouterLink } from 'vue-router';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import SideNav from './SideNav.vue';
import { getSetting, setSetting } from '@/lib/tauri';

/**
 * i18n 注入策略说明：
 * 与项目 `useLocaleSync.test.ts` 的 `vi.mock('vue-i18n')` 全局替换不同，
 * 本测试**创建一个真实 `vue-i18n` 实例**并通过 `global.plugins` 挂入。
 * 原因：组件模板用 `$t(item.labelKey)` 渲染 7 个中文文案，断言需命中真实翻译，
 * 而 `vi.mock('vue-i18n')` 会把 `useI18n()`/`$t` 整体替换成桩，导致 `expect(html).toContain('文件浏览')` 失败。
 * vitest 测试文件间的 mock 默认隔离，useLocaleSync 的全局 mock 不会污染此处。
 */
vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
});

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/',          name: 'home',       component: { template: '<div />' } },
      { path: '/library',   name: 'library',    component: { template: '<div />' } },
      { path: '/bookmarks', name: 'bookmarks',  component: { template: '<div />' } },
      { path: '/likes',     name: 'likes',      component: { template: '<div />' } },
      { path: '/history',   name: 'history',    component: { template: '<div />' } },
      { path: '/accounts',  name: 'accounts',   component: { template: '<div />' } },
      { path: '/settings',  name: 'settings',   component: { template: '<div />' } },
    ],
  });
}

async function mountSideNav(initialRoute = '/'): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = makeRouter();
  router.push(initialRoute);
  await router.isReady();
  const wrapper = mount(SideNav, {
    global: { plugins: [router, i18n] },
  });
  return { wrapper, router };
}

describe('SideNav — 7 项导航', () => {
  it('mount 渲染 8 个 RouterLink 指向 8 条路由', async () => {
    const { wrapper } = await mountSideNav();
    const links = wrapper.findAllComponents(RouterLink);
    expect(links.length).toBe(8);

    const hrefs = links.map((l) => l.props('to'));
    expect(hrefs).toEqual([
      '/',
      '/shortcuts',
      '/library',
      '/bookmarks',
      '/likes',
      '/history',
      '/accounts',
      '/settings',
    ]);
  });

  it('8 个项目的 label 通过 i18n key 渲染', async () => {
    const { wrapper } = await mountSideNav();
    const html = wrapper.html();
    // zh-CN 默认 locale 应包含中文文案
    expect(html).toContain('文件浏览');
    expect(html).toContain('快捷方式');
    expect(html).toContain('书架');
    expect(html).toContain('书签');
    expect(html).toContain('喜欢');
    expect(html).toContain('阅览记录');
    expect(html).toContain('网络账户');
    expect(html).toContain('设置');
  });
});

describe('SideNav — mount settings 同步读', () => {
  it('mount 时同步读 sidenav_collapsed="1" → .sidenav 含 w-[60px] class (collapsed)', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('1');
    const { wrapper } = await mountSideNav();
    // 等 onMounted 的 promise resolve
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).toContain('w-[60px]');
    // label 视觉隐藏依赖 .label 元素 v-if!collapsed，CSS 不用验
  });

  it('mount 时 getSetting 抛错 → 默认展开（容错回退）', async () => {
    vi.mocked(getSetting).mockRejectedValueOnce(new Error('ipc fail'));
    const { wrapper } = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).toContain('w-[220px]');
  });
});

describe('SideNav — 折叠切换', () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockResolvedValue(undefined);
  });

  it('点击 toggle 按钮 → collapsed 翻转并调用 setSetting("sidenav_collapsed", "1")', async () => {
    const { wrapper } = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const toggleBtn = wrapper.find('[data-test="sidenav-toggle"]');
    await toggleBtn.trigger('click');

    // 等异步 setSetting 完成
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).toContain('w-[60px]');
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenNthCalledWith(1, 'sidenav_collapsed', '1');
  });

  it('从展开状态连续切换折叠再展开 → 按顺序写入 "1" 和 "0"', async () => {
    const { wrapper } = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const toggleBtn = wrapper.find('[data-test="sidenav-toggle"]');
    await toggleBtn.trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    await toggleBtn.trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(setSetting).toHaveBeenCalledTimes(2);
    expect(setSetting).toHaveBeenNthCalledWith(1, 'sidenav_collapsed', '1');
    expect(setSetting).toHaveBeenNthCalledWith(2, 'sidenav_collapsed', '0');
  });

  it('mount 读取折叠状态不回写，点击展开后只写入 "0"', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('1');
    const { wrapper } = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).toContain('w-[60px]');
    expect(setSetting).not.toHaveBeenCalled();

    await wrapper.find('[data-test="sidenav-toggle"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(nav.classes()).toContain('w-[220px]');
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenNthCalledWith(1, 'sidenav_collapsed', '0');
  });
});

describe('SideNav — 选中态高亮 + 路由跳转触达', () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockResolvedValue(undefined);
  });

  it('当前路由 /library 时，/library 链接含 active + router-link-exact-active class', async () => {
    const { wrapper } = await mountSideNav('/library');
    await new Promise((r) => setTimeout(r, 0));

    const links = wrapper.findAllComponents(RouterLink);
    const libraryLink = links.find((l) => l.props('to') === '/library');
    expect(libraryLink).toBeTruthy();
    // vue-router 4 exact match → 'active' (template active-class) + 'router-link-exact-active'
    expect(libraryLink!.classes()).toContain('active');
    expect(libraryLink!.classes()).toContain('router-link-exact-active');
  });

  it('当前路由 /accounts 时仅 /accounts 高亮，其它无 active class', async () => {
    const { wrapper } = await mountSideNav('/accounts');
    await new Promise((r) => setTimeout(r, 0));

    const links = wrapper.findAllComponents(RouterLink);
    const activeCount = links.filter((l) => l.classes().includes('active')).length;
    expect(activeCount).toBe(1);
    expect(links.find((l) => l.props('to') === '/accounts')!.classes())
      .toContain('active');
  });

  it('8 个 RouterLink 逐个点击 → router.push 按顺序被调 8 次', async () => {
    const targets = ['/', '/shortcuts', '/library', '/bookmarks', '/likes', '/history', '/accounts', '/settings'];
    const { wrapper, router } = await mountSideNav('/');
    await new Promise((r) => setTimeout(r, 0));

    const pushSpy = vi.spyOn(router, 'push');

    const links = wrapper.findAllComponents(RouterLink);
    expect(links.length).toBe(targets.length);

    for (const target of targets) {
      const link = links.find((l) => l.props('to') === target)!;
      // 优先点击渲染后的 <a> 元素 — vue-router 4 在 happy-dom 下 a.click 触发 push
      const a = link.find('a');
      if (a.exists()) {
        await a.trigger('click');
      } else {
        await link.trigger('click');
      }
      // 给 router 当前 tick 让 push resolve
      await router.isReady();
    }

    expect(pushSpy).toHaveBeenCalledTimes(targets.length);
    targets.forEach((t, i) => {
      expect(pushSpy).toHaveBeenNthCalledWith(i + 1, t);
    });
  });
});
