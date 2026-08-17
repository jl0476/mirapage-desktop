import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { readFileSync } from 'node:fs';
import WebtoonViewer from './WebtoonViewer.vue';
import { listImageDimensions } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, listImageDimensions: vi.fn(async () => []) };
});

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': {} } });
const URLS = ['asset://a.jpg', 'asset://b.jpg', 'asset://c.jpg'];
const NAMES = ['a.jpg', 'b.jpg', 'c.jpg'];

function mountViewer(extra: Record<string, unknown> = {}) {
  return mount(WebtoonViewer, {
    props: { urls: URLS, names: NAMES, descriptor: { type: 'local', rootPath: 'R:\\c' }, relPath: '' },
    global: { plugins: [i18n] },
    ...extra,
  });
}

describe('WebtoonViewer（module3.1.0）', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('挂载滚动容器 + strip + 窗口内 img（decoding=async）', async () => {
    const w = mountViewer(); await flushPromises();
    expect(w.find('.webtoon-scroll').exists()).toBe(true);
    const imgs = w.findAll('.webtoon-item img');
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].attributes('decoding')).toBe('async');
    expect(imgs[0].attributes('src')).toBe('asset://a.jpg');
  });

  it('getTopVisibleImage：scrollTop=0 → 首图', async () => {
    const w = mountViewer(); await flushPromises();
    expect(w.vm.getTopVisibleImage()).toBe('a.jpg');
  });

  it('setZoom clamp 1-4 + getZoom 可读', async () => {
    const w = mountViewer(); await flushPromises();
    w.vm.setZoom(9); expect(w.vm.getZoom()).toBe(4);
    w.vm.setZoom(0.2); expect(w.vm.getZoom()).toBe(1);
  });

  it('isAtBottom() 是 getter 且初始未到底', async () => {
    const w = mountViewer(); await flushPromises();
    expect(typeof w.vm.isAtBottom).toBe('function');
    expect(w.vm.isAtBottom()).toBe(false);
  });

  it('连续缩放共用锚点并按最终 zoom 恢复', async () => {
    const w = mountViewer(); await flushPromises();
    const el = w.find('.webtoon-scroll').element as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 1000, writable: true });
    Object.defineProperty(el, 'scrollLeft', { value: 0, writable: true });
    w.vm.setZoom(1.1, 10, 20); w.vm.setZoom(1.2, 10, 20); w.vm.setZoom(1.3, 10, 20);
    const events = w.emitted('zoom-change') as number[][];
    expect(events.map((e) => e[0])).toEqual([1, 1.1, 1.2, 1.3]);
    await flushPromises();
    expect(el.scrollTop).toBe(1306);
  });

  it('挂载即 emit zoom-change=1', async () => {
    const w = mountViewer(); await flushPromises();
    expect((w.emitted('zoom-change') as number[][])[0]).toEqual([1]);
  });

  it('autoScrollStep 增加 scrollTop', async () => {
    const w = mountViewer(); await flushPromises();
    const el = w.find('.webtoon-scroll').element as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 10000 });
    w.vm.autoScrollStep(1000, 60, 1); expect(el.scrollTop).toBe(60);
  });

  it('autoScrollStep 负向位移 clamp 到 0（不出现负 scrollTop）', async () => {
    const w = mountViewer(); await flushPromises();
    const el = w.find('.webtoon-scroll').element as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { value: 50, writable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 10000 });
    w.vm.autoScrollStep(1000, 60, -1); expect(el.scrollTop).toBe(0);
  });

  it('wheel 底部向下滚动 emit scroll-past-bottom', async () => {
    const w = mountViewer(); await flushPromises();
    const el = w.find('.webtoon-scroll');
    Object.defineProperty(el.element, 'scrollTop', { value: 999999, writable: true });
    Object.defineProperty(el.element, 'clientHeight', { value: 100 });
    Object.defineProperty(el.element, 'scrollHeight', { value: 1000 });
    await el.trigger('scroll'); await el.trigger('wheel', { deltaY: 120 });
    expect(w.emitted('scroll-past-bottom')).toBeTruthy();
  });

  it('源码守卫：窗口外卸载且普通滚轮不 preventDefault', () => {
    const src = readFileSync('src/components/reader/WebtoonViewer.vue', 'utf-8');
    expect(src).toContain('v-for="it in windowItems"');
    expect(src).not.toContain('v-show'); expect(src).not.toContain('loading="lazy"');
    expect(src).toContain('@wheel="onWheel"'); expect(src).not.toMatch(/wheel\.prevent/);
    // 滚动条隐藏（2026-08-17 用户拍板：条漫不显示滚动条，位置感知靠页码指示器）
    expect(src).toContain('scrollbar-width:none');
    expect(src).toContain('::-webkit-scrollbar{display:none}');
  });

  it('调用尺寸预读并传递 descriptor 相对路径', async () => {
    mountViewer({ props: { urls: URLS, names: NAMES, descriptor: { type: 'local', rootPath: 'R:\\c' }, relPath: 'sub' } });
    await flushPromises();
    expect(vi.mocked(listImageDimensions)).toHaveBeenCalled();
  });
});
