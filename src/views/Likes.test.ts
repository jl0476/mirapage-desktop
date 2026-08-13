/**
 * Likes.test.ts — v0.1.0-module3.0.7
 *
 * 覆盖:
 *  - 空 favorites 显示 empty state + 文案
 *  - favorites 渲染 list + 行内 ❤️ toggle + 打开按钮(用 name:'reader' + params,不用 query)
 *  - 行内 btn-fav 点击调 toggleFavorite(行消失)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import Likes from './Likes.vue';

vi.mock('@/lib/tauri', () => ({
  listLibrary: vi.fn(async () => []),
  setFavorite: vi.fn(),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: {
    'zh-CN': {
      likes: { title: '喜欢', empty: '还没有喜欢的书', toggleOn: '喜欢', toggleOff: '取消喜欢' },
      common: { back: '返回', open: '打开' },
      fileBrowser: { pickRoot: '选择根目录' },
    },
  },
});

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/likes', name: 'likes', component: Likes },
      { path: '/reader/:bookId', name: 'reader', component: { template: '<div />' } },
    ],
  });
}

async function mountLikes() {
  setActivePinia(createPinia());
  const router = makeRouter();
  router.push('/likes');
  await router.isReady();
  const wrapper = mount(Likes, { global: { plugins: [router, i18n] } });
  await flushPromises();
  return { wrapper, router };
}

const FAV_BOOK = {
  id: 7,
  title: 'TestBook',
  isFavorite: true,
  sourceDescriptor: { type: 'local', rootPath: '/x' },
  sourceType: 'Local',
  absolutePath: '/x',
  coverEntryPath: null,
  coverEntryName: null,
  pageCount: 10,
  lastReadAt: null,
  addedAt: 0,
};

describe('Likes.vue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空 favorites 显示 empty state + 文案', async () => {
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="list"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('还没有喜欢的书');
  });

  it('favorites 渲染 list + 打开按钮用 name:reader + params(不是 query)', async () => {
    const tauri = await import('@/lib/tauri');
    (tauri.listLibrary as any).mockResolvedValueOnce([FAV_BOOK]);
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="list"]').exists()).toBe(true);
    const row = wrapper.find('[data-test="row"]');
    expect(row.text()).toContain('TestBook');

    // 关键(代码审查 P2):打开按钮 href 是 /reader/7(params),不是 /reader?bookId=7(query)
    const openLink = wrapper.find('[data-test="btn-open"]');
    expect(openLink.exists()).toBe(true);
    expect(openLink.attributes('href')).toBe('/reader/7');
  });

  it('行内 btn-fav 点击调 setFavorite(7, false),book.isFavorite=false 后行消失', async () => {
    const tauri = await import('@/lib/tauri');
    (tauri.listLibrary as any).mockResolvedValueOnce([FAV_BOOK]);
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="row"]').exists()).toBe(true);

    await wrapper.find('[data-test="btn-fav"]').trigger('click');
    await flushPromises();

    // library.toggleFavorite 内部调 setFavorite(id, nextFav=!isFavorite=false)
    expect(tauri.setFavorite).toHaveBeenCalledWith(7, false);
    // favorites 是 computed filter isFavorite,false 后该行从 favorites 移除
    expect(wrapper.find('[data-test="row"]').exists()).toBe(false);
    // empty state 应出现
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
  });
});
