/**
 * DoublePageViewer.vue 测试
 * 双页阅读器：当前 spread 渲染 1-2 张图（cover 或末页只有 1 张）
 *
 * - props.pageUrls: 当前书全部图片 URL
 * - props.spreads: SpreadPlanner.plan() 结果
 * - props.currentSpreadIndex: 当前 spread 索引
 * 计算每个 spread 包含的页 URL，过滤掉空字符串（单页时不显示右侧）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import DoublePageViewer from './DoublePageViewer.vue';

vi.mock('./SinglePageViewer.vue', () => ({
  default: {
    name: 'SinglePageViewer',
    props: ['imageUrl'],
    template: '<div data-test="single-viewer" :data-url="imageUrl" />',
  },
}));

function makeWrapper() {
  return mount(DoublePageViewer, {
    props: {
      pageUrls: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
      ],
      currentSpreadIndex: 0,
    },
  });
}

describe('DoublePageViewer.vue', () => {
  beforeEach(() => {});

  it('renders one SinglePageViewer for single-page spread (cover)', () => {
    const w = makeWrapper();
    const viewers = w.findAll('[data-test="single-viewer"]');
    expect(viewers).toHaveLength(1);
    expect(viewers[0].attributes('data-url')).toBe('a.jpg');
  });

  it('renders two SinglePageViewers for two-page spread', async () => {
    const w = makeWrapper();
    await w.setProps({ currentSpreadIndex: 1 });
    const viewers = w.findAll('[data-test="single-viewer"]');
    expect(viewers).toHaveLength(2);
    expect(viewers[0].attributes('data-url')).toBe('b.jpg');
    expect(viewers[1].attributes('data-url')).toBe('c.jpg');
  });

  it('renders single page for last odd spread', async () => {
    const w = makeWrapper();
    await w.setProps({ currentSpreadIndex: 2 });
    const viewers = w.findAll('[data-test="single-viewer"]');
    expect(viewers).toHaveLength(1);
    expect(viewers[0].attributes('data-url')).toBe('d.jpg');
  });

  it('exposes current spread pages for parent to compute page indicator', async () => {
    const w = makeWrapper();
    await w.setProps({ currentSpreadIndex: 1 });
    // 子组件应暴露 currentPages via data attribute 或 computed
    const pages = w.find('[data-test="current-pages"]').attributes('data-pages');
    expect(pages).toBe('b.jpg,c.jpg');
  });
});
