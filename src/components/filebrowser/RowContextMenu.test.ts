/**
 * RowContextMenu.vue 测试（计划任务10）—— 图片"重新生成缩略图"项。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia, getActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import zhCN from '@/locales/zh-CN';
import RowContextMenu from './RowContextMenu.vue';
import { resetProgressByLocation } from '@/lib/tauri';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import type { MediaEntry } from '@/lib/sourceDescriptor';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, resetProgressByLocation: vi.fn(async () => true) };
});

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
});

function imgEntry(name = 'page-001.jpg'): MediaEntry {
  return { name, path: name, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 };
}
function dirEntry(name = 'vol01'): MediaEntry {
  return { name, path: name, isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 };
}

async function mountCtx(entry: MediaEntry) {
  // 组件 visible 由 watch(entry) 驱动（无 immediate）；mount 时 entry=null 再 setProps 触发。
  const w = mount(RowContextMenu, {
    props: { entry: null, x: 10, y: 10 },
    global: { plugins: [createPinia(), i18n] },
  });
  await w.setProps({ entry });
  await w.vm.$nextTick();
  return w;
}

describe('RowContextMenu 重新生成缩略图', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('图片：显示 regenerate-thumbnail 项', async () => {
    const w = await mountCtx(imgEntry());
    expect(w.find('[data-test="regenerate-thumbnail"]').exists()).toBe(true);
  });

  it('目录：不显示 regenerate-thumbnail 项', async () => {
    const w = await mountCtx(dirEntry());
    expect(w.find('[data-test="regenerate-thumbnail"]').exists()).toBe(false);
  });

  it('点击 regenerate -> emit regenerate-thumbnail (entries 数组) + close', async () => {
    const e = imgEntry('x.jpg');
    const w = await mountCtx(e);
    await w.find('[data-test="regenerate-thumbnail"]').trigger('click');
    expect(w.emitted('regenerate-thumbnail')).toBeTruthy();
    expect(w.emitted('regenerate-thumbnail')![0][0]).toEqual([e]);
    expect(w.emitted('close')).toBeTruthy();
  });

  it('多选 (entries) -> regenerate 文案带 N 张 + emit 整个 entries', async () => {
    const entries = [imgEntry('a.jpg'), imgEntry('b.jpg'), imgEntry('c.jpg')];
    const w = mount(RowContextMenu, {
      props: { entry: null, entries, x: 10, y: 10 },
      global: { plugins: [i18n] },
    });
    await w.vm.$nextTick();
    const btn = w.find('[data-test="regenerate-thumbnail"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('3');
    // 目录专属项多选时隐藏
    expect(w.find('[data-test="ctx-read-now"]').exists()).toBe(false);
    expect(w.find('[data-test="ctx-add-to-library"]').exists()).toBe(false);
    await btn.trigger('click');
    expect(w.emitted('regenerate-thumbnail')![0][0]).toEqual(entries);
  });

  it('目录 (单选 isDirectory=true) -> 显示 read-now / add-to-library', async () => {
    const w = await mountCtx(dirEntry('vol01'));
    expect(w.find('[data-test="ctx-read-now"]').exists()).toBe(true);
    expect(w.find('[data-test="ctx-add-to-library"]').exists()).toBe(true);
  });

  it('目录 + 多选 -> 目录项隐藏 (isBatch)', async () => {
    const entries = [dirEntry('vol01'), dirEntry('vol02')];
    const w = mount(RowContextMenu, {
      props: { entry: null, entries, x: 10, y: 10 },
      global: { plugins: [i18n] },
    });
    await w.vm.$nextTick();
    expect(w.find('[data-test="ctx-read-now"]').exists()).toBe(false);
    expect(w.find('[data-test="ctx-add-to-library"]').exists()).toBe(false);
  });
});

describe('RowContextMenu 重置阅读进度（module3.0.14）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(resetProgressByLocation).mockClear();
  });

  // 组件与测试共享同一 active pinia（mountCtx 自建 pinia 拿不到 store 状态）
  async function mountCtxShared(entry: MediaEntry) {
    const w = mount(RowContextMenu, {
      props: { entry: null, x: 10, y: 10 },
      global: { plugins: [getActivePinia()!, i18n] },
    });
    await w.setProps({ entry });
    await w.vm.$nextTick();
    return w;
  }

  async function setupStore(base: string) {
    const fb = useFileBrowserStore();
    fb.rootPath = 'R:\comics';
    fb.lastFetchedPath = base;
    return fb;
  }

  async function flushTick(w: { vm: { $nextTick: () => Promise<void> } }) {
    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();
  }

  it('目录项：absPath = join(lastFetchedPath, entry.path)', async () => {
    await setupStore('');
    const w = await mountCtxShared(dirEntry('vol01'));
    await w.find('[data-test="reset-progress"]').trigger('click');
    await flushTick(w);
    expect(resetProgressByLocation).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'R:\comics' },
      'vol01',
    );
  });

  it('子目录内右键图片：absPath = lastFetchedPath 本身（书=所在目录）', async () => {
    await setupStore('output');
    const w = await mountCtxShared(imgEntry('page-001.jpg'));
    await w.find('[data-test="reset-progress"]').trigger('click');
    await flushTick(w);
    expect(resetProgressByLocation).toHaveBeenCalledWith(
      { type: 'local', rootPath: 'R:\comics' },
      'output',
    );
  });

  it('返回 false 不抛错且关闭菜单（no-op 场景）', async () => {
    await setupStore('');
    vi.mocked(resetProgressByLocation).mockResolvedValueOnce(false);
    const w = await mountCtxShared(dirEntry('vol01'));
    await w.find('[data-test="reset-progress"]').trigger('click');
    await flushTick(w);
    expect(w.emitted('close')).toBeTruthy();
  });
});

describe('RowContextMenu 缩略图菜单二合一（module3.0.14）', () => {
  it('图片右键不再渲染 retry-thumbnail 项（regenerate 功能完全覆盖 retry）', async () => {
    const w = await mountCtx(imgEntry());
    expect(w.find('[data-test="retry-thumbnail"]').exists()).toBe(false);
    expect(w.find('[data-test="regenerate-thumbnail"]').exists()).toBe(true);
  });
});

describe('RowContextMenu 重置进度多选隐藏（module3.0.14 hotfix）', () => {
  it('多选 (entries) -> reset-progress 隐藏（多选时 firstItem 是排序首位而非右键对象，重置会错书）', async () => {
    const entries = [dirEntry('vol01'), dirEntry('vol02')];
    const w = mount(RowContextMenu, {
      props: { entry: null, entries, x: 10, y: 10 },
      global: { plugins: [i18n] },
    });
    await w.vm.$nextTick();
    expect(w.find('[data-test="reset-progress"]').exists()).toBe(false);
  });
});
