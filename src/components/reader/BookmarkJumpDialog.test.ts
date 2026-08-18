/**
 * BookmarkJumpDialog 测试 — 受控选框：列表渲染 / jump / close（取消、ESC、遮罩）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import BookmarkJumpDialog from './BookmarkJumpDialog.vue';
import type { BookmarkItem } from '@/lib/tauri';

const bookmarks: BookmarkItem[] = [
  { id: 11, bookId: 7, page: 2, positionKind: 'image', label: '中段', createdAt: 300 },
  { id: 12, bookId: 7, page: 1, positionKind: 'spread', label: null, createdAt: 100 },
];

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });

function mountDialog(props: Partial<{ show: boolean; bookmarks: BookmarkItem[] }> = {}) {
  return mount(BookmarkJumpDialog, {
    props: { show: true, bookmarks, ...props },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('BookmarkJumpDialog', () => {
  it('show=true 渲染列表：image kind 页码 +1，legacy spread 原样', () => {
    const w = mountDialog();
    const items = w.findAll('li button');
    expect(items.length).toBe(2);
    expect(items[0]!.text()).toContain('3');   // page=2 image → 3
    expect(items[0]!.text()).toContain('中段');
    expect(items[1]!.text()).toContain('1');   // page=1 spread → 1
  });

  it('show=false 不渲染', () => {
    const w = mountDialog({ show: false });
    expect(w.find('[data-test="bookmark-jump-dialog"]').exists()).toBe(false);
  });

  it('空列表显示「暂无书签」', () => {
    const w = mountDialog({ bookmarks: [] });
    expect(w.text()).toContain('暂无书签');
  });

  it('点书签行 → emit jump(bm)', async () => {
    const w = mountDialog();
    await w.get('[data-test="bookmark-jump-item-11"]').trigger('click');
    expect(w.emitted('jump')?.[0]).toEqual([bookmarks[0]]);
  });

  it('点取消 → emit close', async () => {
    const w = mountDialog();
    await w.get('[data-test="bookmark-jump-cancel"]').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('ESC → emit close', async () => {
    const w = mountDialog();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.emitted('close')).toBeTruthy();
    w.unmount();
  });

  it('点遮罩空白 → emit close', async () => {
    const w = mountDialog();
    await w.get('[data-test="bookmark-jump-dialog"]').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
    w.unmount();
  });
});
