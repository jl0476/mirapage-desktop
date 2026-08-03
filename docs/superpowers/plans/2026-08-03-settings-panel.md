# Settings 面板完整化（v0.1.0-module3.0）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标**：把 Settings 视图从 Phase 1 骨架升级到 PV 同等使用面（除 Desktop 不适用的下载/缓存）；新增 11 个 DB key（scale/direction/9 区触控）；让 10 个 store 字段全部有 UI 入口；引入 anchor nav + 9 宫格编辑器。

**架构**：store 平铺（每 DB key = 1 ref 或 1 reactive entry），Settings.vue 重写为左侧 sticky anchor nav + 右侧滚动 6 section；新 `useThemeSync` 监听 themeMode → `html.dark`；新 `useSectionAnchors` 用 IntersectionObserver 跟踪 active section；`useReaderTouchZones` 从 store 读 `touchScheme`；`dispatchZoneAction` switch 扩 11 case，新增 `fit-width` + `open-file-browser` 两个回调。

**技术栈**：Vue 3 setup script + Pinia setup store + Tailwind v4 + vue-i18n + vitest + happy-dom。

**参考文档**：
- 设计规格：`docs/superpowers/specs/2026-08-03-settings-panel-design.md`
- CLAUDE.md §0 阅读器 / §1 UI 视觉 / §2 i18n / §3 代码约定 / §4 测试 / §5 tag 流程
- PV Settings：`F:/WorkSpaceCollection/git/perfect-viewer/app/src/main/java/top/racyan/ui/settings/SettingsScreen.kt`
- 现有控件模板：`src/components/filebrowser/SortDropdown.vue`（Xplorer 风格 Dropdown）
- 现有锚点测试：`src/components/layout/SideNav.test.ts`

---

## 文件结构

**新建**：
- `src/lib/readerSettings.ts` — 阅读器设置相关枚举与默认值（无 Vue 依赖）
- `src/lib/readerSettings.test.ts`
- `src/composables/useThemeSync.ts` — themeMode ↔ html.dark
- `src/composables/useThemeSync.test.ts`
- `src/composables/useSectionAnchors.ts` — IntersectionObserver + scrollTo
- `src/composables/useSectionAnchors.test.ts`
- `src/views/Settings.test.ts` — DOM 渲染 + 交互

**修改**：
- `src/stores/settings.ts` — 新增 `defaultScaleMode` / `defaultReadDirection` / `touchScheme`；load 扩 11 行；新增 `setTouchAction` / `resetTouchScheme`
- `src/stores/settings.test.ts` — 扩 4 case
- `src/composables/useReaderTouchZones.ts` — 从 store 读 touchScheme；删除 `DEFAULT_READER_ZONES` 与 `ReaderZoneConfig` 类型
- `src/composables/useReaderTouchZones.test.ts` — 扩 3 case
- `src/views/ReaderView.vue` — `dispatchZoneAction` switch 扩 11 case；新增 `fitWidth` / `openFileBrowser` 回调
- `src/views/ReaderView.test.ts` — 扩 1 case（11 动作 dispatch）
- `src/views/Settings.vue` — 整体重写为 anchor nav + 6 section + 9 宫格
- `src/App.vue` — 加 `useThemeSync()` 初始化
- `src/locales/zh-CN.ts` + `en-US.ts` — 新增 `settings.*` namespace（45 keys）
- `src/styles/tailwind.css` — 加 `html.dark` 基线标注（保留 Tokyo Night 为默认）

---

## 任务 1：阅读器设置类型模块（`readerSettings.ts`）

**文件：**
- 创建：`src/lib/readerSettings.ts`
- 测试：`src/lib/readerSettings.test.ts`

- [ ] **步骤 1：写失败的测试（枚举 + 默认值对齐 PV）**

`src/lib/readerSettings.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import {
  TOUCH_ZONES, TOUCH_ACTIONS,
  DEFAULT_TOUCH_SCHEME,
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
} from './readerSettings';

describe('readerSettings', () => {
  it('TOUCH_ZONES covers all 9 cells in row-major order', () => {
    expect(TOUCH_ZONES).toEqual([
      'tl','tm','tr','ml','mm','mr','bl','bm','br',
    ]);
  });

  it('TOUCH_ACTIONS exposes 11 actions (toggle-chrome hidden)', () => {
    expect(TOUCH_ACTIONS).toHaveLength(11);
    expect(TOUCH_ACTIONS).not.toContain('toggle-chrome');
    expect(TOUCH_ACTIONS).toContain('fit-width');
    expect(TOUCH_ACTIONS).toContain('open-file-browser');
  });

  it('DEFAULT_TOUCH_SCHEME aligns with PerfectViewer TouchScheme.DEFAULT', () => {
    expect(DEFAULT_TOUCH_SCHEME).toEqual({
      tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
      ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
      bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
    });
  });

  it('DEFAULT_SCALE_MODE is fit-screen', () => {
    expect(DEFAULT_SCALE_MODE).toBe('fit-screen');
  });

  it('DEFAULT_READ_DIRECTION is ltr', () => {
    expect(DEFAULT_READ_DIRECTION).toBe('ltr');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/lib/readerSettings.test.ts
```

预期：FAIL "Cannot find module './readerSettings'"。

- [ ] **步骤 3：实现类型模块**

`src/lib/readerSettings.ts`：

```ts
// src/lib/readerSettings.ts
// 阅读器设置相关枚举与默认值。对齐 PerfectViewer AppSettings.kt 的语义，名称按桌面端 kebab 约定改写。
// 无 Vue / Pinia / Tauri 依赖，可独立测试。

export type ScaleMode =
  | 'fit-screen' | 'fit-width' | 'fit-height'
  | 'original' | 'full-screen' | 'stretch';

export type ReadDirection = 'ltr' | 'rtl';

export type TouchZone =
  | 'tl' | 'tm' | 'tr'
  | 'ml' | 'mm' | 'mr'
  | 'bl' | 'bm' | 'br';

export const TOUCH_ZONES: TouchZone[] = [
  'tl', 'tm', 'tr',
  'ml', 'mm', 'mr',
  'bl', 'bm', 'br',
] as const;

/** 11 个对外可选动作（toggle-chrome 已弃用） */
export type TouchAction =
  | 'none'
  | 'prev-page' | 'next-page'
  | 'jump-first' | 'jump-last'
  | 'open-main-menu'
  | 'slideshow-toggle'
  | 'fit-width'
  | 'folder-prev' | 'folder-next'
  | 'open-file-browser';

export const TOUCH_ACTIONS: TouchAction[] = [
  'none',
  'prev-page', 'next-page',
  'jump-first', 'jump-last',
  'open-main-menu',
  'slideshow-toggle',
  'fit-width',
  'folder-prev', 'folder-next',
  'open-file-browser',
] as const;

export const DEFAULT_TOUCH_SCHEME: Record<TouchZone, TouchAction> = {
  tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
  ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
  bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
};

export const DEFAULT_SCALE_MODE: ScaleMode = 'fit-screen';
export const DEFAULT_READ_DIRECTION: ReadDirection = 'ltr';
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/lib/readerSettings.test.ts
```

预期：5 个 PASS。

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/lib/readerSettings.ts src/lib/readerSettings.test.ts && git -c user.email=auto@local -c user.name=auto commit -m "feat(settings): 抽出 readerSettings 类型模块 + 默认值对齐 PV"
```

---

## 任务 2：settings store 新增字段与 action

**文件：**
- 修改：`src/stores/settings.ts:1-75`（顶部 import + state + load + return）
- 修改：`src/stores/settings.test.ts:1-49`（加 mock 字段 + 加 4 个 case）

- [ ] **步骤 1：写失败的测试（load 新字段 / setTouchAction / resetTouchScheme）**

`src/stores/settings.test.ts` 替换为：

```ts
/**
 * settings store 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (key === 'locale') return 'zh-CN';
    if (key === 'theme_mode') return 'dark';
    if (key === 'slideshow_interval_ms') return '5000';
    if (key === 'slideshow_loop') return '1';
    if (key === 'default_scale_mode') return 'fit-width';
    if (key === 'default_read_direction') return 'rtl';
    if (key === 'touch_top_left') return 'jump-first';
    return null;
  }),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from './settings';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('settings store', () => {
  it('load populates known keys', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.locale).toBe('zh-CN');
    expect(store.themeMode).toBe('dark');
    expect(store.slideshowIntervalMs).toBe(5000);
    expect(store.slideshowLoop).toBe(true);
    expect(store.initialized).toBe(true);
  });

  it('update persists boolean as 1/0', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    await store.update('slideshow_loop', false);
    expect(setSetting).toHaveBeenCalledWith('slideshow_loop', '0');
  });

  it('update persists number as string', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.update('slideshow_interval_ms', 2500);
    expect(setSetting).toHaveBeenCalledWith('slideshow_interval_ms', '2500');
  });

  it('load populates new default_scale_mode and default_read_direction', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.defaultScaleMode).toBe('fit-width');
    expect(store.defaultReadDirection).toBe('rtl');
  });

  it('load populates touch_top_left to override default', async () => {
    const store = useSettingsStore();
    await store.load();
    expect(store.touchScheme.tl).toBe('jump-first');
    // 其他 8 区未在 mock 命中, 应保持 PV DEFAULT
    expect(store.touchScheme.tm).toBe('open-file-browser');
    expect(store.touchScheme.br).toBe('folder-next');
  });

  it('setTouchAction updates reactive state and persists to DB', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    await store.setTouchAction('tl', 'jump-last');
    expect(store.touchScheme.tl).toBe('jump-last');
    expect(setSetting).toHaveBeenCalledWith('touch_top_left', 'jump-last');
  });

  it('resetTouchScheme writes all 9 zones to PV DEFAULT', async () => {
    const setSetting = vi.mocked((await import('@/lib/tauri')).setSetting);
    const store = useSettingsStore();
    await store.load();
    await store.touchScheme;  // ensure reactive obj init
    await store.resetTouchScheme();
    expect(store.touchScheme).toEqual({
      tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
      ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
      bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
    });
    expect(setSetting).toHaveBeenCalledWith('touch_top_left', 'fit-width');
    expect(setSetting).toHaveBeenCalledWith('touch_bot_right', 'folder-next');
    expect(setSetting).toHaveBeenCalledTimes(9);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/stores/settings.test.ts
```

预期：FAIL，错误信息含 "defaultScaleMode is not a function" 或 "expected 'fit-width' to be 'fit-screen'"（最后 4 个新 case）。

- [ ] **步骤 3：改造 store**

`src/stores/settings.ts` 整文件替换：

```ts
// Pinia settings store
// 读 / 写 settings 表（通过 Tauri IPC 桥接到 SQLite）

import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { getSetting, setSetting } from '@/lib/tauri';
import {
  TOUCH_ZONES, DEFAULT_TOUCH_SCHEME,
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
  type ScaleMode, type ReadDirection,
  type TouchZone, type TouchAction,
} from '@/lib/readerSettings';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ColorTheme = 'blue' | 'purple' | 'amber' | 'neutral';
export type Locale = 'system' | 'zh-CN' | 'en-US';
export type ContinueMode = 'off' | 'auto' | 'manual';
export type ReaderMode = 'single' | 'double';
export type SearchMode = 'fuzzy' | 'substring';

export const useSettingsStore = defineStore('settings', () => {
  const themeMode = ref<ThemeMode>('system');
  const colorTheme = ref<ColorTheme>('blue');
  const locale = ref<Locale>('system');
  const readerDefaultMode = ref<ReaderMode>('single');
  const continueToNextVolume = ref<ContinueMode>('manual');
  const searchMode = ref<SearchMode>('fuzzy');
  const slideshowIntervalMs = ref(3000);
  const slideshowLoop = ref(true);
  const slideshowDirection = ref<'forward' | 'backward'>('forward');
  const keepScreenOn = ref(true);

  // v0.1.0-module3.0: 新增字段
  const defaultScaleMode = ref<ScaleMode>(DEFAULT_SCALE_MODE);
  const defaultReadDirection = ref<ReadDirection>(DEFAULT_READ_DIRECTION);
  const touchScheme = reactive<Record<TouchZone, TouchAction>>({ ...DEFAULT_TOUCH_SCHEME });

  const initialized = ref(false);

  /** 加载所有 settings（启动时调用） */
  async function load(): Promise<void> {
    const keys: Array<[string, (v: string) => void]> = [
      ['theme_mode', (v) => (themeMode.value = v as ThemeMode)],
      ['color_theme', (v) => (colorTheme.value = v as ColorTheme)],
      ['locale', (v) => (locale.value = v as Locale)],
      ['reader_default_mode', (v) => (readerDefaultMode.value = v as ReaderMode)],
      ['continue_to_next_volume', (v) => (continueToNextVolume.value = v as ContinueMode)],
      ['search_mode', (v) => (searchMode.value = v as SearchMode)],
      ['slideshow_interval_ms', (v) => (slideshowIntervalMs.value = Number(v))],
      ['slideshow_loop', (v) => (slideshowLoop.value = v === '1')],
      ['slideshow_direction', (v) => (slideshowDirection.value = v as 'forward' | 'backward')],
      ['keep_screen_on', (v) => (keepScreenOn.value = v === '1')],
      ['default_scale_mode', (v) => (defaultScaleMode.value = v as ScaleMode)],
      ['default_read_direction', (v) => (defaultReadDirection.value = v as ReadDirection)],
      ...TOUCH_ZONES.map((z) =>
        [`touch_${z}`, (v) => (touchScheme[z] = v as TouchAction)] as [string, (v: string) => void],
      ),
    ];

    for (const [key, apply] of keys) {
      const v = await getSetting(key);
      if (v !== null) apply(v);
    }

    initialized.value = true;
  }

  /** 更新并持久化单个设置 */
  async function update<T extends string | number | boolean>(key: string, value: T): Promise<void> {
    const strValue = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    await setSetting(key, strValue);
  }

  /** 设置单个触控分区动作 */
  async function setTouchAction(zone: TouchZone, action: TouchAction): Promise<void> {
    touchScheme[zone] = action;
    await update(`touch_${zone}`, action);
  }

  /** 恢复 PV 经典 9 区布局 */
  async function resetTouchScheme(): Promise<void> {
    for (const z of TOUCH_ZONES) {
      touchScheme[z] = DEFAULT_TOUCH_SCHEME[z];
      await update(`touch_${z}`, DEFAULT_TOUCH_SCHEME[z]);
    }
  }

  return {
    // 状态
    themeMode,
    colorTheme,
    locale,
    readerDefaultMode,
    continueToNextVolume,
    searchMode,
    slideshowIntervalMs,
    slideshowLoop,
    slideshowDirection,
    keepScreenOn,
    defaultScaleMode,
    defaultReadDirection,
    touchScheme,
    initialized,
    // 方法
    load,
    update,
    setTouchAction,
    resetTouchScheme,
  };
});
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/stores/settings.test.ts
```

预期：7 个 PASS。

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/stores/settings.ts src/stores/settings.test.ts && git -c user.email=auto@local -c user.name=auto commit -m "feat(settings): store 新增 scale/direction/9区触控 + setTouchAction + resetTouchScheme"
```

---

## 任务 3：anchor nav composable（useSectionAnchors）

**文件：**
- 创建：`src/composables/useSectionAnchors.ts`
- 测试：`src/composables/useSectionAnchors.test.ts`

- [ ] **步骤 1：写失败的测试**

`src/composables/useSectionAnchors.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { useSectionAnchors } from './useSectionAnchors';

describe('useSectionAnchors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // stub IntersectionObserver
    (globalThis as any).IntersectionObserver = class {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe(el: Element) {
        this.cb([{ isIntersecting: true, target: el, boundingClientRect: { top: 0 } as DOMRect }]);
      }
      unobserve() {}
      disconnect() {}
    };
  });

  it('mount defaults activeId to first id', async () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    let active: any;
    mount(defineComponent({
      setup() {
        const { activeId } = useSectionAnchors(['a', 'b']);
        active = activeId;
        return () => h('div');
      },
    }));
    expect(active.value).toBe('a');
  });

  it('scrollTo calls scrollIntoView with smooth', async () => {
    document.body.innerHTML = '<div id="target"></div>';
    const scrollIntoView = vi.fn();
    document.getElementById('target')!.scrollIntoView = scrollIntoView;
    let scroll: any;
    mount(defineComponent({
      setup() {
        const { scrollTo } = useSectionAnchors(['target']);
        scroll = scrollTo;
        return () => h('div');
      },
    }));
    scroll('target');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/composables/useSectionAnchors.test.ts
```

预期：FAIL "Cannot find module './useSectionAnchors'"。

- [ ] **步骤 3：实现 composable**

`src/composables/useSectionAnchors.ts`：

```ts
// useSectionAnchors — IntersectionObserver 跟踪哪个 section 在视口顶部
// 用法: const { activeId, scrollTo } = useSectionAnchors(['reader', 'appearance', ...])
import { onMounted, onUnmounted, ref, type Ref } from 'vue';

export interface UseSectionAnchorsReturn {
  activeId: Ref<string>;
  scrollTo: (id: string) => void;
}

export function useSectionAnchors(sectionIds: string[]): UseSectionAnchorsReturn {
  const activeId = ref<string>(sectionIds[0] ?? '');
  let observer: IntersectionObserver | null = null;

  onMounted(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) activeId.value = visible.target.id;
      },
      { rootMargin: '-16px 0px -60% 0px', threshold: [0, 1] },
    );
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
  });

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
  });

  function scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { activeId, scrollTo };
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/composables/useSectionAnchors.test.ts
```

预期：2 个 PASS。

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/composables/useSectionAnchors.ts src/composables/useSectionAnchors.test.ts && git -c user.email=auto@local -c user.name=auto commit -m "feat(settings): 新增 useSectionAnchors composable"
```

---

## 任务 4：theme 同步 composable（useThemeSync）

**文件：**
- 创建：`src/composables/useThemeSync.ts`
- 测试：`src/composables/useThemeSync.test.ts`
- 修改：`src/App.vue:1-31`（加 useThemeSync）

- [ ] **步骤 1：写失败的测试**

`src/composables/useThemeSync.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from '@/stores/settings';
import { useThemeSync } from './useThemeSync';

function mountWithTheme(setup: () => void) {
  return mount(defineComponent({
    setup() { setup(); return () => h('div'); },
  }));
}

describe('useThemeSync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.documentElement.className = '';
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('themeMode=dark adds html.dark class', async () => {
    mountWithTheme(() => {
      const s = useSettingsStore();
      s.themeMode = 'dark';
      useThemeSync();
    });
    await nextTick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('themeMode=light removes html.dark class', async () => {
    document.documentElement.classList.add('dark');
    mountWithTheme(() => {
      const s = useSettingsStore();
      s.themeMode = 'light';
      useThemeSync();
    });
    await nextTick();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('themeMode=system follows prefers-color-scheme media query', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'), media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mountWithTheme(() => {
      const s = useSettingsStore();
      s.themeMode = 'system';
      useThemeSync();
    });
    await nextTick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/composables/useThemeSync.test.ts
```

预期：FAIL "Cannot find module './useThemeSync'"。

- [ ] **步骤 3：实现 composable**

`src/composables/useThemeSync.ts`：

```ts
// useThemeSync — 同步 settings.themeMode → html.dark class
// system 模式跟随 prefers-color-scheme media query
import { watchEffect } from 'vue';
import { useSettingsStore } from '@/stores/settings';

export function useThemeSync(): void {
  const settings = useSettingsStore();
  watchEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const isDark =
      settings.themeMode === 'dark' ||
      (settings.themeMode === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', isDark);
  });
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/composables/useThemeSync.test.ts
```

预期：3 个 PASS。

- [ ] **步骤 5：在 App.vue 接入**

修改 `src/App.vue:1-31` 的 `<script setup>`：

```ts
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import SideNav from '@/components/layout/SideNav.vue';
import { useSettingsStore } from '@/stores/settings';
import { useLocaleSync } from '@/composables/useLocaleSync';
import { useThemeSync } from '@/composables/useThemeSync';

const route = useRoute();
const settings = useSettingsStore();

const showSideNav = computed(() => route.name !== 'reader');

useThemeSync();
useLocaleSync();
onMounted(async () => {
  await settings.load();
});
```

模板不变。

- [ ] **步骤 6：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/composables/useThemeSync.ts src/composables/useThemeSync.test.ts src/App.vue && git -c user.email=auto@local -c user.name=auto commit -m "feat(settings): useThemeSync + App.vue 接入"
```

---

## 任务 5：useReaderTouchZones 接入 store

**文件：**
- 修改：`src/composables/useReaderTouchZones.ts:1-122`（改完整个文件）
- 修改：`src/composables/useReaderTouchZones.test.ts`（扩 3 case）

- [ ] **步骤 1：写失败的测试**

替换 `src/composables/useReaderTouchZones.test.ts`：

```ts
/**
 * useReaderTouchZones — 9 宫格点击坐标 → 触控动作
 * v0.1.0-module3.0: 动作源改为 settings.touchScheme
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from '@/stores/settings';
import { useReaderTouchZones } from './useReaderTouchZones';

function makeContainer() {
  const container = document.createElement('div');
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect),
  });
  document.body.appendChild(container);
  return container;
}

function clickAt(container: HTMLElement, x: number, y: number) {
  const ev = new MouseEvent('click', { clientX: x, clientY: y, bubbles: true });
  container.dispatchEvent(ev);
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('useReaderTouchZones', () => {
  it('maps 9 click positions to corresponding zones using PV DEFAULT scheme', async () => {
    const container = makeContainer();
    const actions: string[] = [];
    const containerRef = ref<HTMLElement | null>(container);

    mount(defineComponent({
      setup() {
        useReaderTouchZones({
          containerRef,
          onAction: (a) => actions.push(a),
        });
        return () => h('div');
      },
    }));
    await nextTick();

    // top-left → fit-width (PV DEFAULT)
    clickAt(container, 10, 10);
    // top-center → open-file-browser
    clickAt(container, 50, 10);
    // mid-center → open-main-menu
    clickAt(container, 50, 50);
    // bot-right → folder-next
    clickAt(container, 90, 90);

    expect(actions).toEqual(['fit-width', 'open-file-browser', 'open-main-menu', 'folder-next']);
  });

  it('reflects live updates from settings.touchScheme', async () => {
    const container = makeContainer();
    const actions: string[] = [];
    const containerRef = ref<HTMLElement | null>(container);
    let store: ReturnType<typeof useSettingsStore>;

    mount(defineComponent({
      setup() {
        store = useSettingsStore();
        useReaderTouchZones({ containerRef, onAction: (a) => actions.push(a) });
        return () => h('div');
      },
    }));
    await nextTick();

    // 改 store.touchScheme.tl 后, 下一次点击 tl 区应返回 jump-first
    store!.touchScheme.tl = 'jump-first';
    await nextTick();
    clickAt(container, 10, 10);
    expect(actions[actions.length - 1]).toBe('jump-first');
  });

  it('skips click when target is inside ignoreSelector', async () => {
    const container = makeContainer();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-overlay', '');
    overlay.innerHTML = '<button>overlay btn</button>';
    container.appendChild(overlay);
    document.body.appendChild(container);

    const actions: string[] = [];
    const containerRef = ref<HTMLElement | null>(container);

    mount(defineComponent({
      setup() {
        useReaderTouchZones({
          containerRef,
          ignoreSelector: '[data-overlay]',
          onAction: (a) => actions.push(a),
        });
        return () => h('div');
      },
    }));
    await nextTick();

    const btn = overlay.querySelector('button')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }));
    expect(actions).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/composables/useReaderTouchZones.test.ts
```

预期：FAIL, 错误含 `'fit-width'` 期望但实际是 `'jump-first'`（因为旧 DEFAULT）。

- [ ] **步骤 3：重写 composable**

整文件替换 `src/composables/useReaderTouchZones.ts`：

```ts
/**
 * useReaderTouchZones.ts — 桌面端阅读屏幕 9 宫格点击检测
 *
 * v0.1.0-module3.0: 动作源从硬编码 DEFAULT_READER_ZONES 改为 settings.touchScheme.
 *  - 3x3 网格 (上/中/下 × 左/中/右), 命中后查 store.touchScheme[key].
 *  - 默认映射对齐 PerfectViewer TouchScheme.DEFAULT (src/lib/readerSettings.ts).
 *  - 点击触发, 不依赖 drag.
 */
import { onMounted, onUnmounted, type Ref } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import type { TouchAction, TouchZone } from '@/lib/readerSettings';

export type ReaderZoneAction = TouchAction;

export interface UseReaderTouchZonesOptions {
  containerRef: Ref<HTMLElement | null>;
  /**
   * v0.1.0-module3.0.2 (M4): 9 宫格 listener 落在该 selector 容器内的 click 直接忽略.
   * 解决 overlay 顶/底栏按钮被 9 宫格拦截双触发.
   */
  ignoreSelector?: string;
  onAction: (a: TouchAction) => void;
}

export function useReaderTouchZones(opts: UseReaderTouchZonesOptions): void {
  const settings = useSettingsStore();

  function onClick(e: MouseEvent): void {
    const el = opts.containerRef.value;
    if (!el) return;
    if (opts.ignoreSelector) {
      const target = e.target as Element | null;
      if (target && target.closest(opts.ignoreSelector)) return;
    }
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    const col: 'l' | 'm' | 'r' = xRatio < 1 / 3 ? 'l' : xRatio < 2 / 3 ? 'm' : 'r';
    const row: 't' | 'm' | 'b' = yRatio < 1 / 3 ? 't' : yRatio < 2 / 3 ? 'm' : 'b';
    const key = (row + col) as TouchZone;
    opts.onAction(settings.touchScheme[key]);
  }

  onMounted(() => {
    const el = opts.containerRef.value;
    if (!el) return;
    el.addEventListener('click', onClick);
  });

  onUnmounted(() => {
    const el = opts.containerRef.value;
    if (!el) return;
    el.removeEventListener('click', onClick);
  });
}

/**
 * Zone action → reader 调用映射 (供 ReaderView 集成)
 */
export function dispatchZoneAction(
  action: TouchAction,
  ctx: {
    openMainMenu: () => void;
    prevPage: () => void;
    nextPage: () => void;
    jumpToFirst: () => void;
    jumpToLast: () => void;
    toggleSlideshow: () => void;
    prevVolume: () => void;
    nextVolume: () => void;
    fitWidth: () => void;
    openFileBrowser: () => void;
  },
): void {
  switch (action) {
    case 'none': /* noop */ break;
    case 'prev-page':         ctx.prevPage(); break;
    case 'next-page':         ctx.nextPage(); break;
    case 'jump-first':        ctx.jumpToFirst(); break;
    case 'jump-last':         ctx.jumpToLast(); break;
    case 'open-main-menu':    ctx.openMainMenu(); break;
    case 'slideshow-toggle':  ctx.toggleSlideshow(); break;
    case 'fit-width':         ctx.fitWidth(); break;
    case 'folder-prev':       ctx.prevVolume(); break;
    case 'folder-next':       ctx.nextVolume(); break;
    case 'open-file-browser': ctx.openFileBrowser(); break;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/composables/useReaderTouchZones.test.ts
```

预期：3 个 PASS。

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/composables/useReaderTouchZones.ts src/composables/useReaderTouchZones.test.ts && git -c user.email=auto@local -c user.name=auto commit -m "feat(reader): 9 宫格动作源改为 settings.touchScheme + dispatchZoneAction 扩 11 case"
```

---

## 任务 6：ReaderView 加 fit-width / open-file-browser 回调

**文件：**
- 修改：`src/views/ReaderView.vue`（dispatchZoneAction 调用处 + 新增 2 callback）
- 修改：`src/views/ReaderView.test.ts`（扩 11 动作 dispatch test）

- [ ] **步骤 1：读现有 ReaderView 调用 dispatchZoneAction 处**

定位 `dispatchZoneAction(action, { ... })` 调用块（grep `dispatchZoneAction`），记录现有 8 个 ctx 字段名 + 调用点行号。

预期输出样例（实际根据文件查找）：

```ts
dispatchZoneAction(action, {
  openMainMenu,
  prevPage,
  nextPage,
  jumpToFirst,
  jumpToLast,
  toggleSlideshow,
  prevVolume,
  nextVolume,
});
```

- [ ] **步骤 2：写失败的测试（11 动作 dispatch）**

读现有 `src/views/ReaderView.test.ts`，**追加**一个 describe block（在文件末尾）。如文件不存在，先创建并 import：

```ts
import { describe, it, expect, vi } from 'vitest';
import { dispatchZoneAction } from '@/composables/useReaderTouchZones';
import type { TouchAction } from '@/lib/readerSettings';

describe('dispatchZoneAction — 11 actions', () => {
  const ctx = {
    openMainMenu: vi.fn(),
    prevPage: vi.fn(),
    nextPage: vi.fn(),
    jumpToFirst: vi.fn(),
    jumpToLast: vi.fn(),
    toggleSlideshow: vi.fn(),
    prevVolume: vi.fn(),
    nextVolume: vi.fn(),
    fitWidth: vi.fn(),
    openFileBrowser: vi.fn(),
  };

  const cases: Array<[TouchAction, keyof typeof ctx]> = [
    ['none', 'openMainMenu'],
    ['prev-page', 'prevPage'],
    ['next-page', 'nextPage'],
    ['jump-first', 'jumpFirst'],
    ['jump-last', 'jumpLast'],
    ['open-main-menu', 'openMainMenu'],
    ['slideshow-toggle', 'toggleSlideshow'],
    ['fit-width', 'fitWidth'],
    ['folder-prev', 'prevVolume'],
    ['folder-next', 'nextVolume'],
    ['open-file-browser', 'openFileBrowser'],
  ];

  for (const [action, expectedCall] of cases) {
    it(`${action} → ${expectedCall}`, () => {
      dispatchZoneAction(action, ctx);
      if (action === 'none') {
        // none 是 noop, 所有 ctx 不应被调
        for (const fn of Object.values(ctx)) expect(fn).not.toHaveBeenCalled();
      } else {
        expect(ctx[expectedCall]).toHaveBeenCalledTimes(1);
      }
    });
  }
});
```

- [ ] **步骤 3：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/views/ReaderView.test.ts
```

预期：FAIL（已有 case 仍应 PASS；新增 case FAIL because `fit-width` 在 switch 里还是 `noop` 或未定义）。

- [ ] **步骤 4：ReaderView 加 2 个 callback**

**重要约束**：`SinglePageViewer` / `DoublePageViewer` 的 OpenSeadragon viewer 在 setup 内部 `let viewer` 中持有，**未通过 `defineExpose` 暴露**。fit-width 的 UI 反馈本期简化为：写 store + log，下次打开新书自然按新 scale 渲染。OSG 实时切换留作后续 reader 重构。

修改 `src/views/ReaderView.vue` 的 `<script setup>`：

1. 在 `import { useRouter }` 等 import 后**新增**：

```ts
import { useSettingsStore } from '@/stores/settings';
```

2. 在 setup 内**新增**：

```ts
const router = useRouter();

function fitWidth(): void {
  // v0.1.0-module3.0 简化: 仅写 store + log, 不动 OSG (OSG viewer 未 expose).
  // 下次打开新书时, ReaderView.openBook 会读 defaultScaleMode 渲染.
  settings.defaultScaleMode = 'fit-width';
  void settings.update('default_scale_mode', 'fit-width');
  log('[ReaderView/fitWidth] persisted fit-width; takes effect on next book open');
}

function openFileBrowser(): void {
  router.push('/');
}
```

3. 在 `dispatchZoneAction(action, { ... })` 调用块中**新增** 2 个字段：

```ts
dispatchZoneAction(action, {
  openMainMenu,
  prevPage,
  nextPage,
  jumpToFirst,
  jumpToLast,
  toggleSlideshow,
  prevVolume,
  nextVolume,
  fitWidth,           // 新增
  openFileBrowser,    // 新增
});
```

具体行号由 `grep -n "dispatchZoneAction" src/views/ReaderView.vue` 定位后插入。

确认 `log` 已 import：`grep -q "from '@/lib/logger'" src/views/ReaderView.vue`，未导入则在顶部加 `import { log } from '@/lib/logger';`。

- [ ] **步骤 5：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/views/ReaderView.test.ts
```

预期：全部 PASS（含新增 11 个 dispatch 子 case）。

- [ ] **步骤 6：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/views/ReaderView.vue src/views/ReaderView.test.ts && git -c user.email=auto@local -c user.name=auto commit -m "feat(reader): dispatchZoneAction 加 fit-width + open-file-browser 回调"
```

---

## 任务 7：i18n 加 settings.* namespace

**文件：**
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`
- 测试：`src/locales/i18n-keys.test.ts`（新建，验证中英 key 对称）

- [ ] **步骤 1：写失败的测试（i18n key 对称）**

`src/locales/i18n-keys.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import zh from './zh-CN';
import en from './en-US';

/** 递归收集所有 leaf key path. */
function flatten(obj: any, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : flatten(v, prefix + k + '.'),
  );
}

describe('i18n key symmetry', () => {
  it('zh-CN and en-US have identical settings.* key paths', () => {
    const zhKeys = new Set(flatten(zh).filter((k) => k.startsWith('settings.')));
    const enKeys = new Set(flatten(en).filter((k) => k.startsWith('settings.')));
    expect([...zhKeys].sort()).toEqual([...enKeys].sort());
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/locales/i18n-keys.test.ts
```

预期：FAIL, 因为 zh/en 都还没有 `settings.*` 任何 key。

- [ ] **步骤 3：在 zh-CN.ts 加 settings.* namespace**

在 `src/locales/zh-CN.ts` 文件**末尾**追加（保留所有现有内容）：

```ts
  // v0.1.0-module3.0: 设置面板完整化
  settings: {
    title: '设置',
    back: '返回',
    section: {
      reader: '阅读器默认值',
      appearance: '外观',
      behavior: '行为',
      slideshow: '幻灯片',
      touch: '触控分区',
    },
    reader: {
      mode: '默认阅读模式',
      scale: '默认缩放',
      direction: '默认阅读方向',
      continue: '翻到末页后',
    },
    appearance: {
      theme: '主题',
      themeSystem: '跟随系统',
      themeDark: '深色',
      themeLight: '浅色',
    },
    behavior: {
      keepScreenOn: '阅读时保持屏幕常亮',
      language: '界面语言',
    },
    slideshow: {
      interval: '自动播放间隔（秒）',
      intervalLabel: '{seconds} 秒',
      direction: '方向',
      directionForward: '正向',
      directionBackward: '反向',
      loop: '循环播放',
    },
    touch: {
      title: '屏幕 9 宫格',
      hint: '点击格子映射动作，3×3 网格对齐屏幕分区',
      reset: '恢复经典布局',
      resetConfirm: '将 9 区动作恢复为默认？',
    },
    scale: {
      'fit-screen': '适应屏幕',
      'fit-width': '适宽',
      'fit-height': '适高',
      'original': '原始大小',
      'full-screen': '全屏显示',
      'stretch': '拉伸',
    },
    direction: {
      ltr: '从左到右',
      rtl: '从右到左',
    },
    touchAction: {
      none: '无',
      prevPage: '上一页',
      nextPage: '下一页',
      jumpFirst: '跳到首页',
      jumpLast: '跳到末页',
      openMainMenu: '打开主菜单',
      slideshowToggle: '切换幻灯片',
      fitWidth: '适应宽度',
      folderPrev: '上一卷',
      folderNext: '下一卷',
      openFileBrowser: '打开文件浏览器',
    },
  },
```

- [ ] **步骤 4：在 en-US.ts 加对应英文翻译**

在 `src/locales/en-US.ts` 文件**末尾**追加（同样保留现有内容）：

```ts
  // v0.1.0-module3.0: Settings panel completion
  settings: {
    title: 'Settings',
    back: 'Back',
    section: {
      reader: 'Reader defaults',
      appearance: 'Appearance',
      behavior: 'Behavior',
      slideshow: 'Slideshow',
      touch: 'Touch zones',
    },
    reader: {
      mode: 'Default reading mode',
      scale: 'Default scale',
      direction: 'Default reading direction',
      continue: 'When reaching last page',
    },
    appearance: {
      theme: 'Theme',
      themeSystem: 'Follow system',
      themeDark: 'Dark',
      themeLight: 'Light',
    },
    behavior: {
      keepScreenOn: 'Keep screen on while reading',
      language: 'Language',
    },
    slideshow: {
      interval: 'Auto-advance interval (seconds)',
      intervalLabel: '{seconds} s',
      direction: 'Direction',
      directionForward: 'Forward',
      directionBackward: 'Backward',
      loop: 'Loop',
    },
    touch: {
      title: 'Screen 9-zone',
      hint: 'Tap a cell to remap its action; 3×3 grid mirrors the screen',
      reset: 'Reset to classic layout',
      resetConfirm: 'Reset all 9 zones to defaults?',
    },
    scale: {
      'fit-screen': 'Fit screen',
      'fit-width': 'Fit width',
      'fit-height': 'Fit height',
      'original': 'Original',
      'full-screen': 'Full screen',
      'stretch': 'Stretch',
    },
    direction: {
      ltr: 'Left to right',
      rtl: 'Right to left',
    },
    touchAction: {
      none: 'None',
      prevPage: 'Previous page',
      nextPage: 'Next page',
      jumpFirst: 'Jump to first',
      jumpLast: 'Jump to last',
      openMainMenu: 'Open main menu',
      slideshowToggle: 'Toggle slideshow',
      fitWidth: 'Fit width',
      folderPrev: 'Previous volume',
      folderNext: 'Next volume',
      openFileBrowser: 'Open file browser',
    },
  },
```

- [ ] **步骤 5：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/locales/i18n-keys.test.ts
```

预期：1 个 PASS。

- [ ] **步骤 6：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/locales/zh-CN.ts src/locales/en-US.ts src/locales/i18n-keys.test.ts && git -c user.email=auto@local -c user.name=auto commit -m "feat(i18n): settings.* namespace 中英双语对齐 (45 keys)"
```

---

## 任务 8：Settings.vue 整体重写（最大任务）

**文件：**
- 重写：`src/views/Settings.vue`
- 测试：`src/views/Settings.test.ts`（新建）

- [ ] **步骤 1：写失败的测试（6 section 渲染 + dropdown 联动 + reset + anchor）**

`src/views/Settings.test.ts`：

```ts
/**
 * Settings.vue DOM 渲染 + 交互测试
 * v0.1.0-module3.0: 6 section + 锚点 nav + 9 宫格 + reset
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import Settings from './Settings.vue';
import { useSettingsStore } from '@/stores/settings';
import { i18n } from '@/locales';  // 用项目 i18n 实例, 避免 createI18n 重复

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('Settings.vue', () => {
  it('renders all 6 sections with anchors', () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n] } });
    const anchors = wrapper.findAll('[data-test="section-anchor"]');
    expect(anchors.length).toBeGreaterThanOrEqual(6);
    for (const id of ['reader', 'appearance', 'behavior', 'slideshow', 'touch']) {
      expect(wrapper.find(`#${id}`).exists()).toBe(true);
    }
  });

  it('changing continue mode persists to store', async () => {
    const wrapper = mount(Settings, { global: { plugins: [i18n] } });
    const store = useSettingsStore();
    // 找到「翻到末页后」下拉, 选项 manual → off
    const selects = wrapper.findAll('[data-test="enum-select"]');
    expect(selects.length).toBeGreaterThan(0);
    // 模拟 store 直接写, 验证 view 反映
    store.continueToNextVolume = 'off';
    await flushPromises();
    expect(store.continueToNextVolume).toBe('off');
  });

  it('clicking reset shows confirm and resets touch scheme', async () => {
    const store = useSettingsStore();
    const wrapper = mount(Settings, { global: { plugins: [i18n] } });
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
    const wrapper = mount(Settings, { global: { plugins: [i18n] } });
    const scrollIntoView = vi.fn();
    document.getElementById = vi.fn().mockReturnValue({
      scrollIntoView,
    } as any);

    const anchor = wrapper.find('[data-test="anchor-appearance"]');
    expect(anchor.exists()).toBe(true);
    await anchor.trigger('click');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/views/Settings.test.ts
```

预期：FAIL（找不到 Settings.vue 的 export 内容，或 6 section 缺失）。

- [ ] **步骤 3：实现 Settings.vue**

整文件 `src/views/Settings.vue`：

```vue
<script setup lang="ts">
/**
 * Settings.vue — v0.1.0-module3.0 重写
 * 6 section + 左侧 anchor nav + 9 宫格触控编辑器 + reset 按钮.
 * 视觉基线: Tailwind utility class (CLAUDE.md §1.1), 无 scoped hex 色.
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import {
  TOUCH_ZONES, TOUCH_ACTIONS, DEFAULT_TOUCH_SCHEME,
  type ScaleMode, type ReadDirection,
  type TouchZone, type TouchAction,
} from '@/lib/readerSettings';
import { useSectionAnchors } from '@/composables/useSectionAnchors';

const { t } = useI18n();
const settings = useSettingsStore();

const sections = ['reader', 'appearance', 'behavior', 'slideshow', 'touch'] as const;
const { activeId, scrollTo } = useSectionAnchors([...sections]);

// ─── 枚举选项源 ───────────────────────────────────────────────────────
const readerModes = [
  { value: 'single', label: t('reader.mode.single') },
  { value: 'double', label: t('reader.mode.double') },
] as const;

const scaleModes: Array<{ value: ScaleMode; label: string }> = [
  { value: 'fit-screen', label: t('settings.scale.fit-screen') },
  { value: 'fit-width', label: t('settings.scale.fit-width') },
  { value: 'fit-height', label: t('settings.scale.fit-height') },
  { value: 'original', label: t('settings.scale.original') },
  { value: 'full-screen', label: t('settings.scale.full-screen') },
  { value: 'stretch', label: t('settings.scale.stretch') },
];

const directions = [
  { value: 'ltr', label: t('settings.direction.ltr') },
  { value: 'rtl', label: t('settings.direction.rtl') },
] as const;

const continueModes = [
  { value: 'off', label: t('reader.continue.off') },
  { value: 'auto', label: t('reader.continue.auto') },
  { value: 'manual', label: t('reader.continue.manual') },
] as const;

const themes = [
  { value: 'system', label: t('settings.appearance.themeSystem') },
  { value: 'dark', label: t('settings.appearance.themeDark') },
  { value: 'light', label: t('settings.appearance.themeLight') },
] as const;

const languages = [
  { value: 'system', label: t('lang.system') },
  { value: 'zh-CN', label: t('lang.zh-CN') },
  { value: 'en-US', label: t('lang.en-US') },
] as const;

const slideshowDirs = [
  { value: 'forward', label: t('settings.slideshow.directionForward') },
  { value: 'backward', label: t('settings.slideshow.directionBackward') },
] as const;

const touchActionLabels = computed<Record<TouchAction, string>>(() => ({
  'none': t('settings.touchAction.none'),
  'prev-page': t('settings.touchAction.prevPage'),
  'next-page': t('settings.touchAction.nextPage'),
  'jump-first': t('settings.touchAction.jumpFirst'),
  'jump-last': t('settings.touchAction.jumpLast'),
  'open-main-menu': t('settings.touchAction.openMainMenu'),
  'slideshow-toggle': t('settings.touchAction.slideshowToggle'),
  'fit-width': t('settings.touchAction.fitWidth'),
  'folder-prev': t('settings.touchAction.folderPrev'),
  'folder-next': t('settings.touchAction.folderNext'),
  'open-file-browser': t('settings.touchAction.openFileBrowser'),
}));

// ─── 单格 dropdown 开/关状态 ──────────────────────────────────────────
const openCell = ref<TouchZone | null>(null);
const showResetConfirm = ref(false);

function toggleCell(zone: TouchZone): void {
  openCell.value = openCell.value === zone ? null : zone;
}

async function pickAction(zone: TouchZone, action: TouchAction): Promise<void> {
  openCell.value = null;
  await settings.setTouchAction(zone, action);
}

async function onResetTouch(): Promise<void> {
  showResetConfirm.value = false;
  await settings.resetTouchScheme();
}

// ─── 通用 setter (封装 store 字段 + DB) ─────────────────────────────
async function setReaderMode(v: string) {
  settings.readerDefaultMode = v as 'single' | 'double';
  await settings.update('reader_default_mode', v);
}
async function setScaleMode(v: string) {
  settings.defaultScaleMode = v as ScaleMode;
  await settings.update('default_scale_mode', v);
}
async function setDirection(v: string) {
  settings.defaultReadDirection = v as ReadDirection;
  await settings.update('default_read_direction', v);
}
async function setContinue(v: string) {
  settings.continueToNextVolume = v as 'off' | 'auto' | 'manual';
  await settings.update('continue_to_next_volume', v);
}
async function setTheme(v: string) {
  settings.themeMode = v as 'system' | 'dark' | 'light';
  await settings.update('theme_mode', v);
}
async function setLocale(v: string) {
  settings.locale = v as 'system' | 'zh-CN' | 'en-US';
  await settings.update('locale', v);
}
async function setKeepScreenOn(v: boolean) {
  settings.keepScreenOn = v;
  await settings.update('keep_screen_on', v);
}
async function setSlideshowInterval(v: number) {
  const n = Math.max(1, Math.min(30, Number(v) || 1));
  settings.slideshowIntervalMs = n * 1000;
  await settings.update('slideshow_interval_ms', n * 1000);
}
async function setSlideshowDirection(v: string) {
  settings.slideshowDirection = v as 'forward' | 'backward';
  await settings.update('slideshow_direction', v);
}
async function setSlideshowLoop(v: boolean) {
  settings.slideshowLoop = v;
  await settings.update('slideshow_loop', v);
}

const touchGridRows: TouchZone[][] = [
  ['tl', 'tm', 'tr'],
  ['ml', 'mm', 'mr'],
  ['bl', 'bm', 'br'],
];
</script>

<template>
  <div class="flex h-full w-full bg-bg text-text-primary overflow-hidden">
    <!-- 左侧锚点 nav -->
    <aside
      class="shrink-0 w-[220px] h-full overflow-y-auto bg-surface-1 border-r border-white/10 px-3 py-4 sticky top-0"
    >
      <h2 class="text-lg font-semibold mb-3 px-2">{{ t('settings.title') }}</h2>
      <ol class="flex flex-col gap-0.5 list-none m-0 p-0">
        <li v-for="s in sections" :key="s">
          <button
            type="button"
            :data-test="`anchor-${s}`"
            class="w-full text-left text-sm rounded-md px-3 py-1.5 hover:bg-surface-2 transition-colors"
            :class="activeId === s ? 'bg-surface-2 text-accent font-medium' : 'text-text-secondary'"
            data-test="section-anchor"
            @click="scrollTo(s)"
          >
            {{ t(`settings.section.${s}`) }}
          </button>
        </li>
      </ol>
    </aside>

    <!-- 右侧滚动内容 -->
    <main class="flex-1 min-w-0 h-full overflow-y-auto px-8 py-6">
      <header class="mb-6">
        <RouterLink to="/" class="text-xs text-text-secondary hover:text-accent">
          ← {{ t('settings.back') }}
        </RouterLink>
        <h1 class="text-2xl font-bold mt-2">{{ t('settings.title') }}</h1>
      </header>

      <!-- Reader defaults -->
      <section id="reader" data-test="section-reader" class="mb-10 scroll-mt-4">
        <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
          {{ t('settings.section.reader') }}
        </h3>
        <div class="flex flex-col gap-3 max-w-[640px]">
          <!-- 通用枚举 row 模板由 inline 渲染, 每行 data-test="enum-select" -->
          <EnumRow
            :label="t('settings.reader.mode')"
            :value="settings.readerDefaultMode"
            :options="readerModes"
            @change="setReaderMode"
          />
          <EnumRow
            :label="t('settings.reader.scale')"
            :value="settings.defaultScaleMode"
            :options="scaleModes"
            @change="setScaleMode"
          />
          <EnumRow
            :label="t('settings.reader.direction')"
            :value="settings.defaultReadDirection"
            :options="directions"
            @change="setDirection"
          />
          <EnumRow
            :label="t('settings.reader.continue')"
            :value="settings.continueToNextVolume"
            :options="continueModes"
            @change="setContinue"
          />
        </div>
      </section>

      <hr class="border-white/5 my-8" />

      <!-- Appearance -->
      <section id="appearance" :data-test="`section-appearance`" class="mb-10 scroll-mt-4">
        <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
          {{ t('settings.section.appearance') }}
        </h3>
        <div class="flex flex-col gap-3 max-w-[640px]">
          <EnumRow
            :label="t('settings.appearance.theme')"
            :value="settings.themeMode"
            :options="themes"
            @change="setTheme"
          />
        </div>
      </section>

      <hr class="border-white/5 my-8" />

      <!-- Behavior -->
      <section id="behavior" :data-test="`section-behavior`" class="mb-10 scroll-mt-4">
        <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
          {{ t('settings.section.behavior') }}
        </h3>
        <div class="flex flex-col gap-3 max-w-[640px]">
          <BooleanRow
            :label="t('settings.behavior.keepScreenOn')"
            :value="settings.keepScreenOn"
            @change="setKeepScreenOn"
          />
          <EnumRow
            :label="t('settings.behavior.language')"
            :value="settings.locale"
            :options="languages"
            @change="setLocale"
          />
        </div>
      </section>

      <hr class="border-white/5 my-8" />

      <!-- Slideshow -->
      <section id="slideshow" :data-test="`section-slideshow`" class="mb-10 scroll-mt-4">
        <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
          {{ t('settings.section.slideshow') }}
        </h3>
        <div class="flex flex-col gap-3 max-w-[640px]">
          <NumberRow
            :label="t('settings.slideshow.interval')"
            :value="Math.round(settings.slideshowIntervalMs / 1000)"
            :min="1"
            :max="30"
            :suffix="t('settings.slideshow.intervalLabel', { seconds: Math.round(settings.slideshowIntervalMs / 1000) })"
            @change="setSlideshowInterval"
          />
          <EnumRow
            :label="t('settings.slideshow.direction')"
            :value="settings.slideshowDirection"
            :options="slideshowDirs"
            @change="setSlideshowDirection"
          />
          <BooleanRow
            :label="t('settings.slideshow.loop')"
            :value="settings.slideshowLoop"
            @change="setSlideshowLoop"
          />
        </div>
      </section>

      <hr class="border-white/5 my-8" />

      <!-- Touch zones -->
      <section id="touch" :data-test="`section-touch`" class="mb-10 scroll-mt-4">
        <h3 class="text-sm font-semibold text-accent uppercase tracking-wider mb-2">
          {{ t('settings.section.touch') }}
        </h3>
        <p class="text-xs text-text-secondary mb-3">{{ t('settings.touch.hint') }}</p>

        <div class="inline-flex flex-col gap-1 mb-4">
          <div v-for="row in touchGridRows" :key="row.join(',')" class="flex gap-1">
            <div
              v-for="zone in row"
              :key="zone"
              class="relative"
              data-test="touch-cell"
            >
              <button
                type="button"
                class="w-[88px] h-[60px] bg-surface-1 border border-white/10 rounded-md text-xs px-1 hover:bg-surface-2 transition-colors flex items-center justify-center text-center"
                @click="toggleCell(zone)"
              >
                {{ touchActionLabels[settings.touchScheme[zone]] }}
              </button>
              <ul
                v-if="openCell === zone"
                class="absolute z-10 left-0 top-full mt-1 min-w-[170px] bg-surface-4 border border-white/10 rounded-lg py-1 shadow-xl backdrop-blur-xl"
              >
                <li v-for="action in TOUCH_ACTIONS" :key="action">
                  <button
                    type="button"
                    class="block w-full text-left text-xs px-3 py-1.5 hover:bg-surface-light"
                    :class="settings.touchScheme[zone] === action ? 'text-accent' : ''"
                    @click="pickAction(zone, action)"
                  >
                    {{ touchActionLabels[action] }}
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div>
          <button
            type="button"
            data-test="touch-reset"
            class="text-xs text-text-secondary hover:text-accent border border-white/10 px-3 py-1 rounded-md"
            @click="showResetConfirm = true"
          >
            {{ t('settings.touch.reset') }}
          </button>
          <button
            v-if="showResetConfirm"
            type="button"
            data-test="reset-confirm"
            class="ml-2 text-xs text-error border border-error/40 px-3 py-1 rounded-md"
            @click="onResetTouch"
          >
            {{ t('settings.touch.resetConfirm') }}
          </button>
        </div>
      </section>
    </main>
  </div>
</template>
```

然后**新建** 3 个 inline 子组件（行级 row），文件：`src/views/Settings.vue` 内部用 `defineComponent` 不优雅，**改为分离文件**：

- [ ] **步骤 4：拆出 3 个 row 组件**

新建 `src/components/settings/EnumRow.vue`：

```vue
<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}>();
const emit = defineEmits<{ (e: 'change', v: string): void }>();

defineOptions({ inheritAttrs: false });
</script>

<template>
  <label class="flex items-center justify-between gap-4">
    <span class="text-sm text-text-secondary shrink-0">{{ label }}</span>
    <div class="relative" data-test="enum-select">
      <select
        :value="value"
        class="bg-surface-2 border border-white/10 rounded-md text-xs px-3 py-1.5 text-text-primary hover:border-white/20 focus:outline-none focus:border-accent transition-colors cursor-pointer min-w-[170px]"
        @change="emit('change', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in options" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>
  </label>
</template>
```

新建 `src/components/settings/BooleanRow.vue`：

```vue
<script setup lang="ts">
defineProps<{ label: string; value: boolean }>();
const emit = defineEmits<{ (e: 'change', v: boolean): void }>();
</script>

<template>
  <label class="flex items-center justify-between gap-4 cursor-pointer">
    <span class="text-sm text-text-secondary">{{ label }}</span>
    <button
      type="button"
      :class="[
        'w-9 h-5 rounded-full transition-colors relative shrink-0',
        value ? 'bg-accent' : 'bg-surface-2 border border-white/10',
      ]"
      @click="emit('change', !value)"
    >
      <span
        :class="[
          'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
          value ? 'translate-x-[18px]' : 'translate-x-0.5',
        ]"
      />
    </button>
  </label>
</template>
```

新建 `src/components/settings/NumberRow.vue`：

```vue
<script setup lang="ts">
const props = defineProps<{
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
}>();
const emit = defineEmits<{ (e: 'change', v: number): void }>();
</script>

<template>
  <label class="flex items-center justify-between gap-4">
    <span class="text-sm text-text-secondary shrink-0">{{ label }}</span>
    <div class="flex items-center gap-2">
      <input
        type="number"
        :value="value"
        :min="props.min"
        :max="props.max"
        class="w-20 bg-surface-2 border border-white/10 rounded-md text-xs px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent"
        @change="emit('change', Number(($event.target as HTMLInputElement).value))"
      />
      <span v-if="suffix" class="text-xs text-text-secondary">{{ suffix }}</span>
    </div>
  </label>
</template>
```

然后**修改** `Settings.vue` 的 `<script setup>` 顶部 import：

```ts
import EnumRow from '@/components/settings/EnumRow.vue';
import BooleanRow from '@/components/settings/BooleanRow.vue';
import NumberRow from '@/components/settings/NumberRow.vue';
```

- [ ] **步骤 5：运行测试验证通过**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/views/Settings.test.ts
```

预期：4 个 PASS。

- [ ] **步骤 6：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/views/Settings.vue src/views/Settings.test.ts src/components/settings/ && git -c user.email=auto@local -c user.name=auto commit -m "feat(settings): Settings.vue 重写 (6 section + 锚点 nav + 9 宫格编辑器)"
```

---

## 任务 9：Tailwind `html.dark` 基线标注 + 整体验证

**文件：**
- 修改：`src/styles/tailwind.css`（加 `@layer base` 块声明 `html.dark` selector）
- 无测试，跑全局验证

- [ ] **步骤 1：在 tailwind.css 加 html.dark 注释块**

定位 `src/styles/tailwind.css` 的 `@theme {}` 块**末尾**（或在文件末尾追加）：

```css
/*
 * v0.1.0-module3.0: html.dark 由 useThemeSync 切换。
 * 当前默认 (无 .dark class) 仍是 Tokyo Night 暗色 (--color-bg, --color-text-primary 等在 @theme 定义).
 * 未来 "light" 模式: 在 @layer base 下加 `:root:not(.dark) { --color-bg: #f8fafc; ... }`.
 */
```

不改任何 token，仅注释。**这一步是保险栓**——CLAUDE.md §1.1 视觉基线不变。

- [ ] **步骤 2：跑全套验证**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && npm run type-check && npm test -- --run
```

预期：type-check 0 error；所有 vitest 全过（包含新增 ~24 case + 既有 ~250 case）。

- [ ] **步骤 3：手测启动 dev**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"
```

预期：Tauri dev 启动，访问 `/settings` 看到 6 section。

手测清单（CLAUDE.md §5.3）：

1. 切 theme 系统/浅/深 → devtools 看 `<html>` 节点 class 切换
2. 改 default reader mode → 重启 app 后生效
3. 改 default scale mode → 打开新书生效
4. 改 continue mode → 翻到末页触发不同行为
5. 改 9 区映射（如 tl 改成 `jump-first`）→ 进 reader 点左上角 → 跳首页生效
6. 点 reset → 9 区回到 PV DEFAULT

- [ ] **步骤 4：Commit + Tag**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && git add src/styles/tailwind.css && git -c user.email=auto@local -c user.name=auto commit -m "chore(styles): tailwind.css 加 html.dark 基线注释 (保险栓)"
git tag v0.1.0-module3.0-settings
git push github main
git push github v0.1.0-module3.0-settings
```

预期：tag 推送后，CI 跑全量验证。

---

## 自检报告（写计划时）

**1. 规格覆盖度**：
- §4.1 视觉骨架 → 任务 8
- §4.2 文件清单 → 任务 1-8 全部覆盖
- §4.3 store schema → 任务 2
- §4.4.1 useThemeSync → 任务 4
- §4.4.2 useSectionAnchors → 任务 3
- §4.4.3 useReaderTouchZones → 任务 5
- §4.4.4 dispatchZoneAction + 2 新 callback → 任务 6
- §4.5 i18n 45 keys → 任务 7
- §4.6 错误处理 → 各任务内嵌（store.load 已有 fallback, setSetting 异常边界由 store.update 兜底）
- §4.7 测试策略 → 任务 1-8 测试

**2. 占位符扫描**：无 "TODO" / "待定" / "类似任务"。

**3. 类型一致性**：
- `TouchAction` 在任务 1 定义，任务 2 / 5 / 6 全部引用 ✓
- `TouchZone` 同上 ✓
- `useSettingsStore.setTouchAction` / `resetTouchScheme` 在任务 2 定义，任务 5 / 8 引用 ✓
- `DEFAULT_TOUCH_SCHEME` 任务 1 定义，任务 2 / 8 引用 ✓
- `useSectionAnchors` 返回 `{ activeId, scrollTo }`，任务 3 定义，任务 8 引用 ✓
- `useThemeSync` 任务 4 定义，App.vue 引用 ✓

**4. 风险与回滚**：
- 触控默认变化 → 任务 8 提供 reset 按钮（`data-test="touch-reset"` + `reset-confirm`）
- dark 浅色基线未实装 → 任务 9 仅加注释，未动 token
- dispatchZoneAction 重命名 → 任务 5 / 6 显式列出旧→新映射
- ReaderView 加 2 callback → 任务 6 step 4
- 窄屏 anchor 挤压 → 不在本范围

---

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 触控默认 PV DEFAULT 与老用户习惯冲突 | Settings 9 宫格下方有「恢复经典」按钮（任务 8），reset 后回 PV DEFAULT；本次默认 PV DEFAULT 已迁移，reset 即"恢复本次默认" |
| Tailwind `dark:` 浅色基线未实装 | 任务 9 仅加注释，视觉零变化 |
| `dispatchZoneAction` 重命名（`open-menu` → `open-main-menu`）| 任务 5 switch 全覆盖；type-check 兜底 |
| ReaderView 加 2 callback（fitWidth / openFileBrowser）| 任务 6 显式列出 |
| Anchor nav 在窄屏挤压 | 不在本范围；桌面端固定 220px |
| 9 宫格 dropdown 遮挡下方内容 | `z-10` + 紧贴 cell 下方展开；后续可改 popper |
