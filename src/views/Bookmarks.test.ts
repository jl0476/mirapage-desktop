/**
 * Bookmarks.vue 测试 — 双模式：跨书聚合（无 bookId）/ 单书（?bookId=）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import zhCN from '@/locales/zh-CN';
import Bookmarks from './Bookmarks.vue';
import { addBookmark, listAllBookmarks, listBookmarks } from '@/lib/tauri';
import type { BookmarkItem, BookmarkRow } from '@/lib/tauri';

const sample: BookmarkItem[] = [
  { id: 1, bookId: 7, page: 0, positionKind: 'image', label: null, createdAt: 100 },
  { id: 2, bookId: 7, page: 4, positionKind: 'spread', label: '旧书签', createdAt: 200 },
];
const allSample: BookmarkRow[] = [
  { id: 5, bookId: 9, page: 2, positionKind: 'image', label: null, createdAt: 300, bookTitle: '书B', bookPath: 'D:\\manga\\b' },
  { id: 1, bookId: 7, page: 0, positionKind: 'image', label: null, createdAt: 100, bookTitle: '书A', bookPath: 'C:\\comics\\a' },
];

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    listBookmarks: vi.fn(async () => [...sample]),
    listAllBookmarks: vi.fn(async () => [...allSample]),
    addBookmark: vi.fn(async (_bookId: number, _page: number, _label: string | null) => sample[0]!),
    removeBookmark: vi.fn(async () => undefined),
  };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div/>' } },
      { path: '/bookmarks', component: Bookmarks },
      { path: '/reader/:bookId', component: { template: '<div/>' } },
    ],
  });
}

async function mountAt(path: string) {
  const router = makeRouter();
  router.push(path);
  await router.isReady();
  const wrapper = mount(Bookmarks, { global: { plugins: [i18n, router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.mocked(listBookmarks).mockResolvedValue([...sample]);
  vi.mocked(listAllBookmarks).mockResolvedValue([...allSample]);
});

describe('Bookmarks.vue 单书模式（?bookId=）', () => {
  it('加载列表；image kind 页码显示 +1，legacy spread 原样', async () => {
    const { wrapper } = await mountAt('/bookmarks?bookId=7');
    expect(listBookmarks).toHaveBeenCalledWith(7);
    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain('页码 1'); // image page=0 → 显示 1（1-based）
    expect(rows[1]!.text()).toContain('页码 4'); // legacy spread 原样（当时语义即 spread 序号）
  });

  it('表单输入 1 表示第 1 张图：addBookmark 收到 0-based page', async () => {
    const { wrapper } = await mountAt('/bookmarks?bookId=7');
    const input = wrapper.get('[data-test="add-form"] input[type="number"]');
    await input.setValue('3');
    await wrapper.get('[data-test="add"]').trigger('click');
    await flushPromises();
    expect(addBookmark).toHaveBeenCalledWith(7, 2, null);
  });

  it('点"打开"跳 /reader/:bookId?bookmarkPage&bookmarkKind', async () => {
    const { wrapper, router } = await mountAt('/bookmarks?bookId=7');
    await wrapper.findAll('[data-test="jump"]')[0]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/reader/7');
    expect(router.currentRoute.value.query.bookmarkPage).toBe('0');
    expect(router.currentRoute.value.query.bookmarkKind).toBe('image');
  });
});

describe('Bookmarks.vue 聚合模式（无 bookId，侧栏入口）', () => {
  it('显示全部书签（跨书），每行带书名，表单隐藏', async () => {
    const { wrapper } = await mountAt('/bookmarks');
    expect(listAllBookmarks).toHaveBeenCalled();
    expect(listBookmarks).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="add-form"]').exists()).toBe(false);
    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain('书B'); // created_at DESC 最新在前
    expect(rows[0]!.text()).toContain('页码 3'); // image page=2 → +1
    expect(rows[1]!.text()).toContain('书A');
    expect(wrapper.text()).not.toContain('请先打开一本书');
  });

  it('空聚合显示「暂无书签」', async () => {
    vi.mocked(listAllBookmarks).mockResolvedValue([]);
    const { wrapper } = await mountAt('/bookmarks');
    expect(wrapper.text()).toContain('暂无书签');
  });

  it('聚合行点"打开"跳对应书', async () => {
    const { wrapper, router } = await mountAt('/bookmarks');
    await wrapper.findAll('[data-test="jump"]')[0]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/reader/9');
    expect(router.currentRoute.value.query.bookmarkPage).toBe('2');
  });

  it('聚合模式搜索：按书名过滤，无结果显示「没有匹配项」', async () => {
    const { wrapper } = await mountAt('/bookmarks');
    const input = wrapper.get('[data-test="list-search-input"]');
    await input.setValue('书A');
    const rows = wrapper.findAll('[data-test="row"]');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('书A');
    await input.setValue('zzz不存在');
    expect(wrapper.text()).toContain('没有匹配项');
    expect(wrapper.text()).not.toContain('暂无书签'); // 搜索空态 ≠ 真空态
  });

  it('聚合行：副标题=路径，行尾列显示页码·标签', async () => {
    const { wrapper } = await mountAt('/bookmarks');
    const row = wrapper.get('[data-test="row"]');
    expect(row.find('.font-mono.truncate').text()).toContain('D:\\manga\\b'); // 副标题路径
    expect(row.get('[data-test="meta"]').text()).toContain('页码 3');       // 行尾个性化列
  });
});
