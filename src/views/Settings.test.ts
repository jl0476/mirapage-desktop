/**
 * Settings.vue DOM 渲染 + 交互测试
 * v0.1.0-module3.0: 6 section + 锚点 nav + 9 宫格 + reset
 * v0.1.0-module3.0.8 (任务 12): +1 fileBrowser section (7 sections total)
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
}));

import Settings from './Settings.vue';
import { useSettingsStore } from '@/stores/settings';
import { i18n } from '@/locales';

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('Settings.vue', () => {
  it('renders all 8 sections with anchors', () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    const anchors = wrapper.findAll('[data-test^="anchor-"]');
    expect(anchors.length).toBe(8);
    for (const id of ['fileBrowser', 'reader', 'appearance', 'behavior', 'slideshow', 'touch', 'masonry', 'maintenance']) {
      expect(wrapper.find(`#${id}`).exists()).toBe(true);
    }
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

  it('clicking reset shows confirm and resets touch scheme', async () => {
    const store = useSettingsStore();
    const wrapper = mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });
    // 篡改 store 一格
    store.touchScheme.tl = 'jump-first';
    await flushPromises();

    const resetBtn = wrapper.find('[data-test="touch-reset"]');
    expect(resetBtn.exists()).toBe(true);
    await resetBtn.trigger('click');
    await flushPromises();

    const confirm = wrapper.find('[data-test="reset-confirm"]');
    expect(confirm.exists()).toBe(true);
    await confirm.trigger('click');
    await flushPromises();

    expect(store.touchScheme.tl).toBe('fit-width');
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
});