/**
 * SideNav 模块 #0 单测
 * 覆盖规格 §4.7 5 项测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, type Router } from 'vue-router';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import SideNav from './SideNav.vue';

// mock @/lib/tauri 三个 IPC，本任务只用 getSetting 返回 null
vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { getSetting } from '@/lib/tauri';

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

async function mountSideNav(initialRoute = '/') {
  const router = makeRouter();
  router.push(initialRoute);
  await router.isReady();
  return mount(SideNav, {
    global: { plugins: [router, i18n] },
  });
}

describe('SideNav — 7 项导航', () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it('mount 渲染 7 个 RouterLink 指向 7 条路由', async () => {
    const wrapper = await mountSideNav();
    const links = wrapper.findAllComponents({ name: 'RouterLink' });
    expect(links.length).toBe(7);

    const hrefs = links.map((l) => l.props('to'));
    expect(hrefs).toEqual([
      '/',
      '/library',
      '/bookmarks',
      '/likes',
      '/history',
      '/accounts',
      '/settings',
    ]);
  });

  it('7 个项目的 label 通过 i18n key 渲染', async () => {
    const wrapper = await mountSideNav();
    const html = wrapper.html();
    // zh-CN 默认 locale 应包含中文文案
    expect(html).toContain('文件浏览');
    expect(html).toContain('书架');
    expect(html).toContain('书签');
    expect(html).toContain('喜欢');
    expect(html).toContain('阅览记录');
    expect(html).toContain('网络账户');
    expect(html).toContain('设置');
  });
});
