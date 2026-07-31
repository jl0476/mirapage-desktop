/**
 * Breadcrumb.vue 测试
 * 路径切段 + 渲染 + 点击 emit 跳转
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Breadcrumb from './Breadcrumb.vue';

describe('Breadcrumb.vue', () => {
  beforeEach(() => {
    // noop
  });

  it('renders root label when path is empty', () => {
    const w = mount(Breadcrumb, {
      props: { rootLabel: 'Home', path: '' },
    });
    // root 用 data-test="crumb-root", 子段 data-test="crumb" — 二者都视为 segment
    const segs = w.findAll('[data-test="crumb"], [data-test="crumb-root"]');
    expect(segs).toHaveLength(1);
    expect(segs[0].text()).toBe('Home');
  });

  it('renders each segment with accumulated path', () => {
    const w = mount(Breadcrumb, {
      props: { rootLabel: 'Root', path: 'docs/comics' },
    });
    const segs = w.findAll('[data-test="crumb"], [data-test="crumb-root"]');
    // root + docs + comics = 3
    expect(segs).toHaveLength(3);
    expect(segs[0].text()).toBe('Root');
    expect(segs[1].text()).toBe('docs');
    expect(segs[2].text()).toBe('comics');
  });

  it('emits navigate with accumulated path when segment clicked', async () => {
    const w = mount(Breadcrumb, {
      props: { rootLabel: 'Root', path: 'docs/comics/x' },
    });
    const segs = w.findAll('[data-test="crumb"], [data-test="crumb-root"]');
    await segs[2].trigger('click'); // comics
    expect(w.emitted('navigate')).toBeTruthy();
    expect(w.emitted('navigate')![0]).toEqual(['docs/comics']);
  });

  it('emits navigate with empty path when root clicked', async () => {
    const w = mount(Breadcrumb, {
      props: { rootLabel: 'Home', path: 'docs/comics' },
    });
    await w.find('[data-test="crumb-root"]').trigger('click');
    expect(w.emitted('navigate')![0]).toEqual(['']);
  });

  it('marks current path as active (last crumb) and middle as navigable', () => {
    const w = mount(Breadcrumb, {
      props: { rootLabel: 'Root', path: 'docs/comics' },
    });
    const segs = w.findAll('[data-test="crumb"]');
    // 最后一段(当前路径) aria-current='location' 且 disabled
    expect(segs[segs.length - 1].attributes('aria-current')).toBe('location');
    expect(segs[segs.length - 1].attributes('disabled')).toBeDefined();
    // 中间段可点击 (无 aria-current, 无 disabled)
    expect(segs[segs.length - 2].attributes('aria-current')).toBeUndefined();
    expect(segs[segs.length - 2].attributes('disabled')).toBeUndefined();
  });
});
