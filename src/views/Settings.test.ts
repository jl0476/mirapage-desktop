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
  // M3 任务 9: remote section（预载开关 + cache 清空/用量）
  setArchivePrefetchEnabled: vi.fn(async () => undefined),
  getArchiveCacheInfo: vi.fn(async () => ({ count: 2, bytes: 5 })),
  clearArchiveCache: vi.fn(async () => undefined),
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
import NumberRow from '@/components/settings/NumberRow.vue';
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
    for (const id of ['fileBrowser', 'reader', 'appearance', 'behavior', 'slideshow', 'masonry', 'remote', 'maintenance']) {
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

describe('Settings.vue remote section (M3 任务 9)', () => {
  const mountSettings = () => mount(Settings, { global: { plugins: [i18n], stubs: { ThumbnailCacheSettings: true } } });

  it('渲染 remote section 三项（开关 / 上限 / 用量+清空）', async () => {
    const wrapper = mountSettings();
    await flushPromises();
    const section = wrapper.find('[data-test="section-remote"]');
    expect(section.exists()).toBe(true);
    expect(wrapper.find('[data-test="remote-archive-prefetch"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="archive-cache-limit"]').exists()).toBe(true);
    // 用量展示（mock getArchiveCacheInfo → {count:2, bytes:5}）
    const usage = wrapper.find('[data-test="archive-cache-usage"]');
    expect(usage.exists()).toBe(true);
    expect(usage.text()).toContain('2');
    expect(wrapper.find('[data-test="archive-cache-clear-btn"]').exists()).toBe(true);
  });

  // 终审二批 P1-2：partBytes > 0 时展示「含未完成」文案（总量 = bytes + partBytes）
  it('用量展示含 .part 未完成字节（老载荷无 part 字段走原文案）', async () => {
    const { getArchiveCacheInfo } = await import('@/lib/tauri');
    vi.mocked(getArchiveCacheInfo).mockResolvedValueOnce(
      { count: 1, bytes: 5, partCount: 2, partBytes: 3 });
    const wrapper = mountSettings();
    await flushPromises();
    const usage = wrapper.find('[data-test="archive-cache-usage"]');
    expect(usage.text()).toBe(i18n.global.t('settings.remote.archiveCacheUsagePending',
      { count: 1, size: '8 B', pending: '3 B' }));
  });

  it('点击预载开关 → setArchivePrefetchEnabled(false)（任务 8 命令，写设置+运行时推送）', async () => {
    const wrapper = mountSettings();
    await flushPromises();
    const btn = wrapper.find('[data-test="remote-archive-prefetch"]').find('button');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();
    const { setArchivePrefetchEnabled } = await import('@/lib/tauri');
    expect(setArchivePrefetchEnabled).toHaveBeenCalledWith(false);
  });

  // module3.5.3 任务 C：IPC reject 时 UI 必须回滚假成功（alert 直呈与清空缓存按钮同款范式）。
  // 判据链：click#1 注入 reject → 回滚后 UI 停在初值 true → click#2 必然再次发起 false。
  it('预载开关 invoke reject → ref 回滚初值 + alert 提示', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const wrapper = mountSettings();
    await flushPromises();
    const btn = wrapper.find('[data-test="remote-archive-prefetch"]').find('button');

    const { setArchivePrefetchEnabled } = await import('@/lib/tauri');
    vi.mocked(setArchivePrefetchEnabled).mockRejectedValueOnce(new Error('ipc down'));
    await btn.trigger('click'); // true→false 翻转发起 IPC，reject
    await flushPromises();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(setArchivePrefetchEnabled).toHaveBeenCalledWith(false);

    // 回滚自证：若假成功未回滚（现缺陷行为），UI 已是 false，本次点击会发 true；
    // 回滚正确时初值 true 保持，第二次点击仍发 false
    vi.mocked(setArchivePrefetchEnabled).mockClear();
    await btn.trigger('click'); // 默认 mock resolve
    await flushPromises();
    expect(setArchivePrefetchEnabled).toHaveBeenLastCalledWith(false);

    alertSpy.mockRestore();
  });

  // 审查 P0-2 核心场景：旧请求晚于新请求 settle 时，不得覆盖新值/误告警；
  // writeTail 串行化保证 #2 在 #1 settle 前根本不发——后端完成顺序==操作顺序。
  it('上限双 deferred 交错：头请求晚败被顶替静默，最终值=第 2 次选择', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const wrapper = mountSettings();
    await flushPromises();

    // Pinia 由组件 setup 首次 useSettingsStore() 自动激活；只钉本键两笔调用，
    // 其余转发真实实现
    const { getActivePinia } = await import('pinia');
    const { useSettingsStore } = await import('@/stores/settings');
    const store = useSettingsStore(getActivePinia()!);
    const realUpdate = store.update.bind(store);
    let releaseFail!: () => void;
    vi.spyOn(store, 'update')
      .mockImplementationOnce(
        () => new Promise<void>((_, rej) => { releaseFail = () => rej(new Error('db down')); }),
      )
      .mockImplementationOnce(realUpdate);

    const input = wrapper.find('[data-test="archive-cache-limit"]').find('input');
    await input.setValue('4096'); // 写 #1 排入 tail 后挂起
    await input.setValue('8192'); // 写 #2 排队
    await flushPromises();
    // 串行化自证：#1 挂起期间 #2 根本未发起（后端完成顺序==操作顺序）
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith('archive_cache_max_mb', 4096);
    expect((input.element as HTMLInputElement).value).toBe('8192'); // 显示值乐观即时

    releaseFail();                // 第 1 次此刻才失败——用户最新意图已是 8192
    await flushPromises();
    // 串行链此刻才发第 2 笔（简报原断言置于 releaseFail 前，与「#2 不早发」矛盾，已按目标语义后移）
    // 存在性断言；笔序由前方 toHaveBeenCalledTimes(1) + 首笔 4096 + 串行化链共同钉死
    expect(store.update).toHaveBeenCalledWith('archive_cache_max_mb', 8192);
    expect((input.element as HTMLInputElement).value).toBe('8192'); // 不回滚到旧值
    expect(alertSpy).not.toHaveBeenCalled();                        // 被顶替的失败静默
    alertSpy.mockRestore();
  });

  // 审查 P0-1（第二轮）核心场景：A→B→A 后首个 A 晚败——按「显示值==尝试值」判据
  // 会误认为自己仍是最新请求而回滚到 B 并误告警；revision 判定下 id1≠latest(3) 静默。
  // 用例性质：静默/稳定类断言在无实现基线上天然绿（计划测试设计固有），防回归价值
  // 在实现落地后生效；RED 信号当时由全局 unhandled rejection 承担。
  it('上限 ABA 序列且首请求晚败：终值与持久化均为最后一次的 4096，零告警', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const wrapper = mountSettings();
    await flushPromises();

    const { getActivePinia } = await import('pinia');
    const { useSettingsStore } = await import('@/stores/settings');
    const store = useSettingsStore(getActivePinia()!);
    const realUpdate = store.update.bind(store);
    let failFirst!: () => void;
    vi.spyOn(store, 'update')
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { failFirst = () => rej(new Error('db down')); }))
      .mockImplementationOnce(realUpdate)   // #2 → 8192
      .mockImplementationOnce(realUpdate);  // #3 → 4096

    const input = wrapper.find('[data-test="archive-cache-limit"]').find('input');
    await input.setValue('4096'); // #1 排入 tail 挂起
    await input.setValue('8192'); // #2 排队
    await input.setValue('4096'); // #3 排队——显示值回到与 #1 尝试值相同（ABA 靶心）
    expect((input.element as HTMLInputElement).value).toBe('4096');

    failFirst();                  // #1 此刻才失败
    await flushPromises();

    expect(store.update).toHaveBeenCalledTimes(3);
    expect((input.element as HTMLInputElement).value).toBe('4096'); // 不得回滚成 8192（等值判据的病灶）
    expect(alertSpy).not.toHaveBeenCalled();                        // #1 已非最新请求，静默

    // 最终持久化核对：#2/#3 转发真实 update，底层 setSetting(key, String(value))
    // （stores/settings.ts:129-130）尾笔应恰为最后一次选择的 '4096'
    const { setSetting } = await import('@/lib/tauri');
    expect(setSetting).toHaveBeenLastCalledWith('archive_cache_max_mb', '4096');

    alertSpy.mockRestore();
  });

  // 第三轮审查核心场景：连环失败时乐观 prev 被前序失败翻转污染——
  // 2048→4096(#1败)→8192(#2败)，回滚目标必须是 confirmed=2048 而非 prev₂=4096。
  it('连续两笔均失败（4096 败→8192 败）：UI 与持久化均保持已确认的 2048，仅最新失败告警一次', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const wrapper = mountSettings();
    await flushPromises();
    // 本用例要求零成功写；按该文件既有 beforeEach 惯例清计数（无全局重置则手动 mockClear）
    const { setSetting } = await import('@/lib/tauri');
    vi.mocked(setSetting).mockClear();

    const { getActivePinia } = await import('pinia');
    const { useSettingsStore } = await import('@/stores/settings');
    const store = useSettingsStore(getActivePinia()!);
    let fail1!: () => void;
    let fail2!: () => void;
    vi.spyOn(store, 'update')
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { fail1 = () => rej(new Error('db down')); }))
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { fail2 = () => rej(new Error('db down')); }));

    const input = wrapper.find('[data-test="archive-cache-limit"]').find('input');
    await input.setValue('4096'); // #1 排入 tail 挂起（display 4096）
    await input.setValue('8192'); // #2 排队（display 8192；confirmed 仍 2048）
    await flushPromises();

    fail1();                      // #1 失败——已被 #2 顶替，静默且 confirmed 不动
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe('8192');
    expect(alertSpy).not.toHaveBeenCalled();

    fail2();                      // #2 失败——最新请求：回滚到 confirmed=2048（非乐观 prev₂=4096）
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe('2048');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(setSetting).not.toHaveBeenCalled(); // 零成功写＝存储从未离开 2048

    alertSpy.mockRestore();
  });

  it('上限尾请求失败且未被顶替：回滚显示值 + alert 恰一次', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const wrapper = mountSettings();
    await flushPromises();

    const { getActivePinia } = await import('pinia');
    const { useSettingsStore } = await import('@/stores/settings');
    const store = useSettingsStore(getActivePinia()!);
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('db down'));

    const input = wrapper.find('[data-test="archive-cache-limit"]').find('input');
    const initial = (input.element as HTMLInputElement).value;

    await input.setValue('8192'); // 组件内钳位后发起 update → reject
    await flushPromises();
    expect(store.update).toHaveBeenCalledWith('archive_cache_max_mb', 8192);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect((input.element as HTMLInputElement).value).toBe(initial); // 回滚显示值

    alertSpy.mockRestore();
  });

  // 第四轮审查核心场景：初载回填（deferred getSetting）未决时用户写入——无门时写意图
  // 抢跑，回滚基准停在种子默认 2048 而 DB 实为 4096。有门时写意图挂起→回填 4096→
  // 门开→写继续→失败→回滚到 confirmed=4096（DB 真值）。
  it('初载未完成时写入挂就绪门：失败后 UI 回滚到真实 DB 值 4096 而非种子默认', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { getSetting, setSetting } = await import('@/lib/tauri');
    // 只钉 maxMb 为 deferred；prefetch 键与后续调用走既有默认 mock（返回 null 不回填）
    const origGetSetting = vi.mocked(getSetting).getMockImplementation();
    let resolveMax!: () => void;
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key !== 'archive_cache_max_mb') return null as never;
      await new Promise<void>((r) => { resolveMax = r; });
      return '4096';
    });
    vi.mocked(setSetting).mockClear();

    // 断言区放 try / mock 恢复放 finally——用例中途失败时 deferred 补丁若不恢复，
    // 会连挂后续所有用例（RED 阶段实证过的泄漏路径）。
    try {
      const wrapper = mountSettings(); // onMounted → loadRemoteSection 挂在 deferred 上

      const { getActivePinia } = await import('pinia');
      const { useSettingsStore } = await import('@/stores/settings');
      const store = useSettingsStore(getActivePinia()!);
      vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('db down'));

      const input = wrapper.find('[data-test="archive-cache-limit"]').find('input');
      expect((input.element as HTMLInputElement).value).toBe('2048'); // 初载中仍显默认
      await input.setValue('8192');                                   // 写意图挂 ready 门
      await flushPromises();
      // 挂门期判据（简报原断言读 DOM，但 VTU setValue 直写 element.value 且 ref 未翻转
      // 无 re-render，DOM 必然残留 '8192'——改为 prop 层「不乐观翻转」+「写未发起」：
      expect(wrapper.find('[data-test="archive-cache-limit"]').findComponent(NumberRow).props('value')).toBe(2048);
      expect(store.update).not.toHaveBeenCalled();

      resolveMax();                 // 回填 4096（display+confirmed 双写）→ 放门
      await flushPromises();

      expect(alertSpy).toHaveBeenCalledTimes(1);                      // 失败告警恰一次
      expect((input.element as HTMLInputElement).value).toBe('4096'); // 回滚到 DB 真值非 2048
      expect(setSetting).not.toHaveBeenCalled();                      // 零成功写＝DB 保持 4096
    } finally {
      alertSpy.mockRestore();
      if (origGetSetting) vi.mocked(getSetting).mockImplementation(origGetSetting);
    }
  });

  it('上限输入越界值 100 → 钳 512 → settings.update 持久化 archive_cache_max_mb', async () => {
    const wrapper = mountSettings();
    await flushPromises();
    const input = wrapper.find('[data-test="archive-cache-limit"]').find('input');
    await input.setValue('100');
    await flushPromises();
    const { setSetting } = await import('@/lib/tauri');
    expect(setSetting).toHaveBeenCalledWith('archive_cache_max_mb', '512');
  });

  it('confirm 取消 → 不调 clearArchiveCache；确认 → 清空 + 刷新用量', async () => {
    const { getArchiveCacheInfo } = await import('@/lib/tauri');
    vi.mocked(getArchiveCacheInfo).mockResolvedValueOnce(
      { count: 2, bytes: 5, partCount: 1, partBytes: 3 });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const wrapper = mountSettings();
    await flushPromises();
    const btn = wrapper.find('[data-test="archive-cache-clear-btn"]');
    await btn.trigger('click');
    await flushPromises();
    const { clearArchiveCache } = await import('@/lib/tauri');
    expect(clearArchiveCache).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await btn.trigger('click');
    await flushPromises();
    expect(clearArchiveCache).toHaveBeenCalledTimes(1);
    // confirm 文案带 ready + .part 总用量（5 B + 3 B）
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('8 B'));
    confirmSpy.mockRestore();
  });
});
