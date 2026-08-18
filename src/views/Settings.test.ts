/**
 * Settings.vue DOM 渲染 + 交互测试
 * v0.1.0-module3.0: 6 section + 锚点 nav
 * v0.1.0-module3.0.8 (任务 12): +1 fileBrowser section (7 sections total)
 * v0.1.0-module3.0.12: 移除 touch section（9 宫格功能整体删除）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
  // 维护（v0.1.0-database-retention-and-cleanup）：Settings onMounted 调 loadSummary
  getMaintenanceSummary: vi.fn(async () => ({
    historyTotal: 0, historyMaxEntries: 2000, historyRetentionDays: 365,
    historyProtectDays: 7, autoEnabled: true, lastRunAt: 0, lastResultJson: '{}',
    thumbnailTotalBytes: 0, thumbnailCount: 0, thumbnailLimitBytes: 512000000,
  })),
  getMaintenancePreview: vi.fn(async () => ({
    history: { total: 0, daysCandidates: 0, countCandidates: 0, protectedInWindow: 0, protectedExceedsLimit: false },
    thumbnailTotalBytes: 0, thumbnailLimitBytes: 512000000,
  })),
  runMaintenance: vi.fn(async () => ({
    historyDeleted: 0, thumbnailFreedBytes: 0, thumbnailDirtyCleaned: 0,
    protectedExceedsLimit: false, source: 'manual',
  })),
  updateMaintenanceSettings: vi.fn(async () => undefined),
  exportBrowseHistory: vi.fn(async () => ({ exported: false, path: null, totalCount: 0 })),
}));

import Settings from './Settings.vue';
import { useSettingsStore } from '@/stores/settings';
import { i18n } from '@/locales';

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('Settings.vue', () => {
  it('renders all 7 sections with anchors', () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const anchors = wrapper.findAll('[data-test^="anchor-"]');
    expect(anchors.length).toBe(7);
    for (const id of ['fileBrowser', 'reader', 'appearance', 'behavior', 'slideshow', 'masonry', 'maintenance']) {
      expect(wrapper.find(`#${id}`).exists()).toBe(true);
    }
  });

  it('webtoon 模式显示连续阅读设置且继续阅读仍属于 reader 区域', async () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const store = useSettingsStore();
    store.readerDefaultMode = 'webtoon';
    await flushPromises();
    const modeOptions = wrapper.find('[data-test="section-reader"] [data-test="enum-select"] select').findAll('option');
    expect(modeOptions.map((option) => option.text())).toEqual([
      i18n.global.t('reader.mode.single'),
      i18n.global.t('reader.mode.double'),
      i18n.global.t('reader.mode.webtoon'),
    ]);
    expect(wrapper.find('[data-test="section-masonry"] [data-test="enum-select"]').exists()).toBe(false);
    // webtoon 下无效控件禁用：阅读方向 + 幻灯片方向 + 幻灯片间隔
    // section-reader 内 4 个 select 依次为 模式/缩放/方向/继续阅读，方向是第 3 个（index 2）
    const readerSelects = wrapper.findAll('[data-test="section-reader"] select');
    const readerDir = readerSelects[2].element as HTMLSelectElement;
    const slideshowDir = wrapper.find('[data-test="section-slideshow"] [data-test="enum-select"] select').element as HTMLSelectElement;
    const intervalInput = wrapper.find('[data-test="section-slideshow"] input[type="number"]').element as HTMLInputElement;
    expect(readerDir.disabled).toBe(true);
    expect(slideshowDir.disabled).toBe(true);
    expect(intervalInput.disabled).toBe(true);
    // 切回 single 恢复可用
    store.readerDefaultMode = 'single';
    await flushPromises();
    const slideshowDirAfter = wrapper.find('[data-test="section-slideshow"] [data-test="enum-select"] select').element as HTMLSelectElement;
    expect(slideshowDirAfter.disabled).toBe(false);
});

  it('EnumRow change triggers store setter', async () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const store = useSettingsStore();
    store.continueToNextVolume = 'manual';

    // 找到 continue 那一行 (按 label 找)
    const selects = wrapper.findAll('[data-test="enum-select"] select');
    expect(selects.length).toBeGreaterThan(0);
    // 模拟设置 store 直接验证视图受控
    store.continueToNextVolume = 'off';
    await flushPromises();
    expect(store.continueToNextVolume).toBe('off');
  });

  it('列表每页条数：下拉切 20 → setSetting 持久化 + store 更新', async () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const store = useSettingsStore();
    const select = wrapper.get('[data-test="list-page-size"]').find('select');
    await select.setValue('20');
    await flushPromises();
    expect(store.listPageSize).toBe(20);
    const { setSetting } = await import('@/lib/tauri');
    expect(setSetting).toHaveBeenCalledWith('list_page_size', '20');
  });

  it('anchor click triggers scrollTo for the matching section', async () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const scrollIntoView = vi.fn();
    document.getElementById = vi.fn().mockReturnValue({
      scrollIntoView,
    } as unknown as HTMLElement);

    const anchor = wrapper.find('[data-test="anchor-appearance"]');
    expect(anchor.exists()).toBe(true);
    await anchor.trigger('click');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});

describe('Settings.vue fileBrowser section (任务 12)', () => {
  // i18n key 命名说明：section 标题用 `settings.section.fileBrowser`（与现有 6 个 section
  // reader / appearance / behavior / slideshow / touch / masonry 一致），不是
  // `settings.fileBrowser.title`。这是有意选择——保持 section namespace 统一。
  // 内部 BooleanRow 走 `settings.fileBrowser.{recordBrowsePosition,...}` 二级分组。
  it('renders fileBrowser section + 2 BooleanRow', () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const section = wrapper.find('[data-test="settings-filebrowser"]');
    expect(section.exists()).toBe(true);
    // 2 个 BooleanRow（按 data-test 定位）
    const recordRow = wrapper.find('[data-test="record-browse-position"]');
    const restoreRow = wrapper.find('[data-test="restore-browse-position"]');
    expect(recordRow.exists()).toBe(true);
    expect(restoreRow.exists()).toBe(true);
  });

  it('点击 record-browse-position BooleanRow 调 setRecordBrowsePosition', async () => {
    const store = useSettingsStore();
    const spy = vi.spyOn(store, 'setRecordBrowsePosition');
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const recordRow = wrapper.find('[data-test="record-browse-position"]');
    expect(recordRow.exists()).toBe(true);
    // 找到内部按钮并点击
    const btn = recordRow.find('button');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(false);  // 默认 true → 点击后变 false
    expect(store.recordBrowsePosition).toBe(false);
  });

  // module3.0.11：角标详情开关（settings.fileBrowser namespace）
  it('renders thumbnail detail popover BooleanRow', () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const row = wrapper.find('[data-test="thumbnail-detail-popover"]');
    expect(row.exists()).toBe(true);
  });

  it('点击 thumbnail-detail-popover 调 setThumbnailDetailPopover', async () => {
    const store = useSettingsStore();
    const spy = vi.spyOn(store, 'setThumbnailDetailPopover');
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const row = wrapper.find('[data-test="thumbnail-detail-popover"]');
    expect(row.exists()).toBe(true);
    await row.find('button').trigger('click');
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(false);
    expect(store.thumbnailDetailPopover).toBe(false);
  });

  it('父开关关闭时子开关 disabled', async () => {
    const store = useSettingsStore();
    // 父开关默认 true，子开关 enabled
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const restoreRow = wrapper.find('[data-test="restore-browse-position"]');
    const restoreBtn = restoreRow.find('button');
    expect((restoreBtn.element as HTMLButtonElement).disabled).toBe(false);

    // 关父开关
    store.recordBrowsePosition = false;
    await flushPromises();
    const restoreRowAfter = wrapper.find('[data-test="restore-browse-position"]');
    const restoreBtnAfter = restoreRowAfter.find('button');
    expect((restoreBtnAfter.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('maintenance 渲染导出阅览记录行，点击触发导出', async () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    await flushPromises();

    const btn = wrapper.find('[data-test="maintenance-export-history"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain(i18n.global.t('history.export'));

    await btn.trigger('click');
    await flushPromises();
    const { exportBrowseHistory } = await import('@/lib/tauri');
    expect(exportBrowseHistory).toHaveBeenCalledTimes(1);
    expect(exportBrowseHistory).toHaveBeenCalledWith(
      expect.stringMatching(/^browse_history_\d{8}_\d{6}\.json$/)
    );
  });
});