/**
 * MasonryRow.vue 测试 (v0.1.0-module3.0.6)
 *
 * 验证:
 * - img 属性 (src + loading=lazy + decoding=async) -- decoding 回归问题 4
 * - absolute 定位 (top/left/width/height)
 * - 选中态 / 阅读状态 badge
 * - click -> emit row-click
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import MasonryRow from './MasonryRow.vue';
import type { MediaEntry } from '@/lib/sourceDescriptor';

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
});

function entry(name: string): MediaEntry {
  return { name, path: name, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
}

describe('MasonryRow.vue', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const mkProps = (overrides: Record<string, unknown> = {}): any => ({
    entry: entry('page-001.jpg'),
    thumbState: undefined,
    width: 200,
    height: 280,
    top: 0,
    left: 0,
    mark: 'none',
    selected: false,
    ...overrides,
  });

  it('cached 状态渲染 MasonryThumbnail 的 img (src + loading=lazy + decoding=async)', () => {
    const w = mount(MasonryRow, {
      props: mkProps({
        thumbState: { kind: 'cached', cacheKey: 'k', path: 'asset://001.webp', width: 200, height: 280 },
      }),
      global: { plugins: [createPinia(), i18n] },
    });
    const img = w.find('.thumbnail-image');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('asset://001.webp');
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
  });

  it('placeholder（无 thumbState）不渲染 img', () => {
    const w = mount(MasonryRow, {
      props: mkProps(),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.find('.thumbnail-image').exists()).toBe(false);
  });

  it('absolute 定位 (top/left/width/height 写入 style)', () => {
    const w = mount(MasonryRow, {
      props: mkProps({ top: 100, left: 200, width: 240, height: 320 }),
      global: { plugins: [createPinia(), i18n] },
    });
    const style = w.find('.masonry-row').attributes('style') || '';
    expect(style).toContain('top: 100px');
    expect(style).toContain('left: 200px');
    expect(style).toContain('width: 240px');
    expect(style).toContain('height: 320px');
  });

  it('selected -> is-selected class', () => {
    const w = mount(MasonryRow, {
      props: mkProps({ selected: true }),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.find('.masonry-row').classes()).toContain('is-selected');
  });

  it('mark=none -> 无 badge (edge case)', () => {
    const w = mount(MasonryRow, {
      props: mkProps({ mark: 'none' }),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.find('.masonry-badge').exists()).toBe(false);
  });

  it('mark=reading -> 渲染 reading badge', () => {
    const w = mount(MasonryRow, {
      props: mkProps({ mark: 'reading' }),
      global: { plugins: [createPinia(), i18n] },
    });
    const badge = w.find('.masonry-badge');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain('reading');
  });

  it('点击 -> emit row-click (entry, event)', async () => {
    const w = mount(MasonryRow, {
      props: mkProps(),
      global: { plugins: [createPinia(), i18n] },
    });
    await w.find('.masonry-row').trigger('click');
    const ev = w.emitted('row-click');
    expect(ev).toBeTruthy();
    expect(ev![0][0]).toEqual(entry('page-001.jpg'));
  });

  // module3.0.11：show-progress 转发（entry + 角标元素，round-1 P2）
  it('show-progress 转发到父级（entry + 角标元素）', async () => {
    const w = mount(MasonryRow, {
      props: mkProps({ thumbState: { kind: 'generating', cacheKey: 'k', phase: 'decoding', startedAt: Date.now(), timings: {} } }),
      global: { plugins: [createPinia(), i18n] },
    });
    const badge = w.find('.phase-badge');
    await badge.trigger('click');
    const emitted = w.emitted('show-progress');
    expect(emitted).toBeTruthy();
    // 转发链携带 entry + 角标 DOM 元素（MasonryView 不走 querySelector）
    expect(emitted![0]![0]).toEqual(entry('page-001.jpg'));
    expect(emitted![0]![1]).toBeInstanceOf(HTMLElement);
  });
});

describe('选中描边环源码守卫（module3.0.14）', () => {
  it('::after 置顶环替代 outline，pointer-events none 不挡点击', () => {
    const src = readFileSync('src/components/filebrowser/MasonryRow.vue', 'utf-8');
    expect(src).toContain('.masonry-row::after');
    expect(src).toContain('pointer-events: none');
    expect(src).toContain('z-index: 3');
    expect(src).not.toContain('outline-offset'); // outline 方案已废弃
  });
});

