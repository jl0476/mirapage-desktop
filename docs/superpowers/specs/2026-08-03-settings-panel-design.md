# 设置面板完整化 — MiraPage Desktop

- **日期**: 2026-08-03
- **状态**: 设计稿（待规格审查）
- **范围**: B —— 阅读器设置 + 触控方案（不含下载 / 缓存 / 备份）
- **相关**: [`DESIGN.md`](../../DESIGN.md) §11 主题 / §15 输入 / §5 阶段；CLAUDE.md §0 阅读器规约 / §1.1 视觉 / §2 i18n

## 1. 背景与目标

MiraPage Desktop 当前 Settings 视图是 Phase 1 骨架：

- 10 个 settings store 字段中**只有 2 个**（`locale` / `continueToNextVolume`）在 Settings 页暴露
- 8 个字段（`themeMode` / `colorTheme` / `readerDefaultMode` / `searchMode` / `slideshowIntervalMs` / `slideshowLoop` / `slideshowDirection` / `keepScreenOn`）被业务组件（ReaderView / Search.vue）直接读写，Settings 完全看不到
- 没有 9 区触控方案编辑（写死在 `useReaderTouchZones.ts` 的 `DEFAULT_READER_ZONES`）
- 没有 dark/light 切换入口（Tokyo Night 写死）
- 视图用 scoped CSS 写死 hex 色（违反 CLAUDE.md §1.1）
- `<h3>{{ t('reader.continue.off') }}</h3>` 把选项值当标题用，明显的 i18n key 错用

参考对象：[`F:\WorkSpaceCollection\git\perfect-viewer\app\src\main\java\top\racyan\ui\settings\SettingsScreen.kt`](file:///F:/WorkSpaceCollection/git/perfect-viewer/app/src/main/java/top/racyan/ui/settings/SettingsScreen.kt) 及其 [`SettingsRepository.kt`](file:///F:/WorkSpaceCollection/git/perfect-viewer/app/src/main/java/top/racyan/data/local/prefs/SettingsRepository.kt)。Android 版 ~30 字段，分 6 区。

**目标**：把 Settings 视图升级到 PV 同等使用面（除 Desktop 不适用的下载 / 缓存概念），让所有 10 个 store 字段都有 UI 入口，新增 11 个 DB key（scale / direction / 9 区触控）。

**范围（明确）**：

| 模块 | 包含 | 不包含 |
|---|---|---|
| 主题 | themeMode UI（system / light / dark）+ html.dark class + Tailwind `dark:` variant（首期仅 toggle，无 light token） | colorTheme UI、Tokyo Night 重做 |
| 阅读器默认值 | readerDefaultMode / defaultScaleMode / defaultReadDirection / continueToNextVolume UI | volume key paging（无硬件键） |
| 行为 | keepScreenOn UI、locale UI | startupScreen（暂未加） |
| 幻灯片 | interval / direction / loop UI | — |
| 9 区触控方案 | 3×3 编辑器 + 11 动作下拉 + Reset 按钮 | toggle-chrome（PV 已弃用） |

**非目标**：

- Backup / Restore（AES 加密 + SAF URI）—— Desktop 无 SAF
- Volume key paging —— Desktop 无物理音量键
- Download 段（directoryUri / autoDeleteAfterFinished / downloadConcurrency）—— Desktop 无下载管理器
- Disk cache 段（pageCacheSizeMb / archiveCacheSizeMb / prefetchBudgetMb）—— Desktop archive 是 mmap，按需 seek；page cache 不存在
- SMB / WebDAV archive strategy —— SMB 仍 stub，WebDAV 策略不暴露
- colorTheme 落地（仅 store 存值，**不接** Tailwind）—— 后续主题模块
- 启动屏（startupScreen）—— 暂未加，与本次无强关联

## 2. 核心决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| **范围** | B：读者设置 + 9 区触控方案 | PV 招牌功能，零跨 subsystem 副作用 |
| **布局** | 左侧锚点 nav + 右侧滚动内容 | 6 section 共 16+ 控件，单页太长 |
| **store 形态** | 平铺（每 DB key = 1 ref）| 与现有 10 字段一致；DB 无 schema 改动 |
| **TouchScheme 持久化** | 9 行 KV，reactive 嵌套对象 hold 内存态 | 避免 9 个 ref 散落；`dispatchZoneAction` 读嵌套对象更清晰 |
| **默认触控映射** | 改用 PV `TouchScheme.DEFAULT` | 与 PV 行业标杆对齐；与 Desktop 旧默认仅 tl/tm 2 区不同 |
| **主题切换** | 仅 themeMode（system/light/dark），`html.dark` class + Tailwind `dark:` variant | colorTheme 用户选"先不接"，最小侵入 |
| **9 宫格 UI** | 9 按钮方块 + Xplorer 风格 dropdown 弹出 11 个动作 | 与 filebrowser/SortDropdown.vue 复用同模式 |
| **i18n namespace** | `settings.*` 全新 namespace | 现有零散键合并到该树 |
| **DB migration** | 不加（settings 表 KV 本就无 schema 约束）| 与 SideNav 模块一致 |

## 3. 方案选择

### 3.1 store 形态（已选 A）

| 方案 | 结构 | 取舍 |
|---|---|---|
| **A. 平铺 9 个 ref**（选定） | `touchAction_tl / touchAction_tm / ...` 9 个独立 ref | 与现有 store 风格一致；DB key 显式 |
| B. 嵌套 `touchScheme` 对象 | 1 个 `reactive<Record<TouchZone, TouchAction>>` | 更语义化；需 serialize helper；与 store 现有模式不一致 |
| C. 拆 store | `useTouchSchemeStore()` 独立 | 跨 store 协调复杂，无收益 |

**选 A**（注：本设计最终是 hybrid —— store 内 reactive 嵌套对象 + DB 用 9 行 KV 持久化，介于 A 与 B 之间。下表简称 "A-hybrid"。）

### 3.2 主题切换（已选 C）

| 方案 | 工作量 | 取舍 |
|---|---|---|
| A. 仅 store 存值 | 最小 | 仅占位，无视觉变化 |
| B. 多 colorTheme 重做整个 `@theme` | 大 | 与 Xplorer Tokyo Night 设计冲突 |
| **C. themeMode + `html.dark` class**（选定） | 中 | Tailwind v4 `dark:` 原生支持；不动现有 token；未来可加 |

### 3.3 默认触控映射（已选 PV DEFAULT）

PV DEFAULT 与 Desktop 旧 DEFAULT 差异仅 `tl`（fit-width vs jump-first）+ `tm`（open-file-browser vs open-main-menu）。用户选 PV DEFAULT——理由：

- 用户选 "PV 12 动作对齐" 后，按 PV 行为基准更自然
- 影响面仅 2 区，老用户第一次升级会注意到，下次启动即持久化

### 3.4 布局（已选 anchor nav）

| 方案 | 取舍 |
|---|---|
| 单页长滚动 | 16+ 控件滚太长；阅读体验差 |
| **左侧锚点 + 右侧**（选定） | 行业标准（VSCode Settings / GitHub Settings） |
| 子路由拆分 | 6 条路由 + SideNav 子项爆炸 |

## 4. 详细设计

### 4.1 视觉骨架

```
┌─────────────┬─────────────────────────────────────────────┐
│ 锚点 nav    │  ← Settings                                  │
│ (sticky     │                                              │
│  220px)     │  ▼ Reader defaults                            │
│             │    Default reading mode      [Single Page ▾] │
│ • Reader    │    Default scale mode        [Fit Width   ▾] │
│ • Appearance│    Default read direction    [LTR         ▾] │
│ • Behavior  │    Continue to next volume   [Manual      ▾] │
│ • Slideshow │                                              │
│ • Touch     │  ▼ Appearance                                 │
│             │    Theme                      [System      ▾] │
│             │                                              │
│             │  ▼ Behavior                                   │
│             │    Keep screen on            [✓]              │
│             │    Language                  [简体中文    ▾] │
│             │                                              │
│             │  ▼ Slideshow                                  │
│             │    Auto-advance interval     [ 5  ] seconds    │
│             │    Direction                 [Forward     ▾] │
│             │    Loop                      [✓]              │
│             │                                              │
│             │  ▼ Touch zones                                │
│             │    ┌─────┬─────┬─────┐                        │
│             │    │ Fit │File │Last │                        │
│             │    │ W   │Brwsr│ Pg  │                        │
│             │    ├─────┼─────┼─────┤                        │
│             │    │ Prev │Menu │Next│                        │
│             │    │ Pg  │     │ Pg  │                        │
│             │    ├─────┼─────┼─────┤                        │
│             │    │Prev │Slide│Next │                        │
│             │    │ Vol │show │ Vol │                        │
│             │    └─────┴─────┴─────┘                        │
│             │    Reset to classic layout                   │
└─────────────┴─────────────────────────────────────────────┘
```

- 锚点 nav 容器 `sticky top-0 h-screen overflow-y-auto`，**不替换 SideNav**（Settings 仍有 SideNav 在外层）
- IntersectionObserver 监测 active section；锚点点击调 `scrollIntoView({ behavior: 'smooth' })`
- Section 用 `<section :id="anchorId">` + `scroll-margin-top: 16px`
- 控件统一 Xplorer 风格：枚举用 `Dropdown` 模板（SortDropdown.vue 同款），数值用 `<input type="number">`，布尔用 toggle button

### 4.2 文件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `src/lib/readerSettings.ts` | 新建 | `ScaleMode / ReadDirection / TouchZone / TouchAction` 枚举 + `DEFAULT_TOUCH_SCHEME` + `TOUCH_ACTIONS` 列表 |
| `src/lib/readerSettings.test.ts` | 新建 | 3 个 case（对齐 + 11 动作 + 9 区） |
| `src/stores/settings.ts` | 改造 | 加 2 ref + 1 reactive + load 11 行 + `setTouchAction` + `resetTouchScheme` |
| `src/stores/settings.test.ts` | 扩 4 case | 新字段 load；新 action DB 写入；reset 9 行 |
| `src/composables/useThemeSync.ts` | 新建 | watchEffect 同步 `html.dark` class |
| `src/composables/useThemeSync.test.ts` | 新建 | 3 case |
| `src/composables/useSectionAnchors.ts` | 新建 | IntersectionObserver + scrollIntoView |
| `src/composables/useSectionAnchors.test.ts` | 新建 | 2 case |
| `src/composables/useReaderTouchZones.ts` | 改造 | 从 store 读 `touchScheme`；删除冗余 `ReaderZoneConfig` |
| `src/composables/useReaderTouchZones.test.ts` | 扩 3 case | 9 区坐标 + store 集成 |
| `src/views/ReaderView.vue` | 改造 | `dispatchZoneAction` switch 扩 11 case；新增 `fitWidth` / `openFileBrowser` 回调 |
| `src/views/ReaderView.test.ts` | 扩 1 case | 11 动作 dispatch |
| `src/views/Settings.vue` | 重写 | 6 section + 左侧 anchor nav + 9 宫格 |
| `src/views/Settings.test.ts` | 新建 | 4 case |
| `src/locales/zh-CN.ts` + `en-US.ts` | 同步扩 | `settings.*` 新 namespace |
| `src/App.vue` | 微改 | 加 `useThemeSync()` |
| `src/styles/tailwind.css` | 微改 | 加 `dark:` variant 适配（保留 Tokyo Night 暗色为 `dark` 模式基线） |

### 4.3 store schema 增改

#### 4.3.1 新增字段

| 字段 | 类型 | 默认 | UI 入口 | DB key |
|---|---|---|---|---|
| `defaultScaleMode` | `ScaleMode` | `'fit-screen'` | Settings § Reader | `default_scale_mode` |
| `defaultReadDirection` | `ReadDirection` | `'ltr'` | Settings § Reader | `default_read_direction` |
| `touchScheme` (reactive) | `Record<TouchZone, TouchAction>` | PV DEFAULT | Settings § Touch | 9 行 `touch_tl / touch_tm / ...` |

#### 4.3.2 PV DEFAULT `TouchScheme`（替代 Desktop 旧 DEFAULT）

```ts
// src/lib/readerSettings.ts
export const DEFAULT_TOUCH_SCHEME: Record<TouchZone, TouchAction> = {
  tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
  ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
  bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
};
```

#### 4.3.3 store 伪代码

```ts
// src/stores/settings.ts
import {
  TOUCH_ZONES, DEFAULT_TOUCH_SCHEME,
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
  type ScaleMode, type ReadDirection,
  type TouchZone, type TouchAction,
} from '@/lib/readerSettings';

const defaultScaleMode = ref<ScaleMode>(DEFAULT_SCALE_MODE);
const defaultReadDirection = ref<ReadDirection>(DEFAULT_READ_DIRECTION);
const touchScheme = reactive<Record<TouchZone, TouchAction>>({ ...DEFAULT_TOUCH_SCHEME });

// load() 扩
['default_scale_mode', (v) => (defaultScaleMode.value = v as ScaleMode)],
['default_read_direction', (v) => (defaultReadDirection.value = v as ReadDirection)],
...TOUCH_ZONES.map((z) =>
  [`touch_${z}`, (v) => (touchScheme[z] = v as TouchAction)] as [string, (v: string) => void]
),

async function setTouchAction(zone: TouchZone, action: TouchAction): Promise<void> {
  touchScheme[zone] = action;
  await update(`touch_${zone}`, action);
}

async function resetTouchScheme(): Promise<void> {
  for (const z of TOUCH_ZONES) {
    touchScheme[z] = DEFAULT_TOUCH_SCHEME[z];
    await update(`touch_${z}`, DEFAULT_TOUCH_SCHEME[z]);
  }
}
```

#### 4.3.4 类型文件骨架

```ts
// src/lib/readerSettings.ts
export type ScaleMode =
  | 'fit-screen' | 'fit-width' | 'fit-height'
  | 'original' | 'full-screen' | 'stretch';

export type ReadDirection = 'ltr' | 'rtl';

export type TouchZone =
  | 'tl' | 'tm' | 'tr'
  | 'ml' | 'mm' | 'mr'
  | 'bl' | 'bm' | 'br';

export const TOUCH_ZONES: TouchZone[] = [
  'tl','tm','tr','ml','mm','mr','bl','bm','br',
] as const;

/** 11 个对外可选动作（PV 的 toggle-chrome 已弃用） */
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
```

### 4.4 composable 改造

#### 4.4.1 `useThemeSync.ts`（新建）

```ts
// 监听 settings.themeMode, 同步 html.dark class + 跟随系统
import { watchEffect } from 'vue';
import { useSettingsStore } from '@/stores/settings';

export function useThemeSync(): void {
  const settings = useSettingsStore();
  watchEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const isDark = settings.themeMode === 'dark'
      || (settings.themeMode === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', isDark);
  });
}
```

`App.vue` 在 `onMounted` 内调用 `useThemeSync()`。`tailwind.css` 保留 Tokyo Night 作为 `dark` 模式基线（不动现有 token）；首期 `light` 模式**不写**新 token —— 用户切到 light 会得到"无 dark class"的状态，相当于仍是 Tokyo Night（与范围一致："仅 store 存值，无视觉变化"——本次实现后会有 class toggle，但视觉基线暂不变）。

#### 4.4.2 `useSectionAnchors.ts`（新建）

```ts
import { ref, onMounted, onUnmounted } from 'vue';

export function useSectionAnchors(sectionIds: string[]) {
  const activeId = ref(sectionIds[0]);
  let observer: IntersectionObserver | null = null;

  onMounted(() => {
    observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) activeId.value = visible.target.id;
    }, { rootMargin: '-16px 0px -60% 0px', threshold: [0, 1] });
    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer!.observe(el);
    });
  });

  onUnmounted(() => observer?.disconnect());

  function scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { activeId, scrollTo };
}
```

#### 4.4.3 `useReaderTouchZones.ts` 改造

```ts
import { useSettingsStore } from '@/stores/settings';
import type { TouchAction, TouchZone } from '@/lib/readerSettings';

// ReaderZoneAction 类型别名删除, 直接用 TouchAction
export type ReaderZoneAction = TouchAction;

export interface UseReaderTouchZonesOptions {
  containerRef: Ref<HTMLElement | null>;
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
      if (target?.closest(opts.ignoreSelector)) return;
    }
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    const col = xRatio < 1/3 ? 'l' : xRatio < 2/3 ? 'm' : 'r';
    const row = yRatio < 1/3 ? 't' : yRatio < 2/3 ? 'm' : 'b';
    const key = (row + col) as TouchZone;
    opts.onAction(settings.touchScheme[key]);
  }

  onMounted(() => {
    const el = opts.containerRef.value;
    if (!el) el.addEventListener('click', onClick);
  });
  onUnmounted(() => {
    const el = opts.containerRef.value;
    if (el) el.removeEventListener('click', onClick);
  });
}
```

#### 4.4.4 `dispatchZoneAction` 重写

**旧 → 新动作映射表**（避免读老代码误判）：

| 旧 ReaderZoneAction | 新 TouchAction | 函数体 |
|---|---|---|
| `open-menu` | `open-main-menu` | 改名不变体 |
| `first` | `jump-first` | 改名不变体 |
| `last` | `jump-last` | 改名不变体 |
| `prev` | `prev-page` | 改名不变体 |
| `next` | `next-page` | 改名不变体 |
| `prev-volume` | `folder-prev` | 改名不变体 |
| `next-volume` | `folder-next` | 改名不变体 |
| `toggle-slideshow` | `slideshow-toggle` | 改名不变体 |
| —（无） | `none` | 新增，noop |
| —（无） | `fit-width` | 新增，调 `ctx.fitWidth()` |
| —（无） | `open-file-browser` | 新增，调 `ctx.openFileBrowser()` |

```ts
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
    fitWidth: () => void;             // 新增
    openFileBrowser: () => void;      // 新增
  },
): void {
  switch (action) {
    case 'none':              /* noop */ break;
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

`ReaderView.vue` 接入 2 个新回调：

```ts
function fitWidth(): void {
  // 调 reader store, 写 defaultScaleMode='fit-width', 推 OSG viewport.goHome()
  settings.defaultScaleMode = 'fit-width';
  await settings.update('default_scale_mode', 'fit-width');
  osgViewer.value?.viewport.goHome();
}

function openFileBrowser(): void {
  router.push('/');
}
```

### 4.5 i18n 新增

namespace `settings.*` 全新（不在 `nav.*` / `reader.*` 等子树），全部键 z 中英双语对照见 § 4.5.1。

#### 4.5.1 key 清单

| Key | zh-CN | en-US |
|---|---|---|
| `settings.title` | "设置" | "Settings" |
| `settings.back` | "返回" | "Back" |
| `settings.section.reader` | "阅读器默认值" | "Reader defaults" |
| `settings.section.appearance` | "外观" | "Appearance" |
| `settings.section.behavior` | "行为" | "Behavior" |
| `settings.section.slideshow` | "幻灯片" | "Slideshow" |
| `settings.section.touch` | "触控分区" | "Touch zones" |
| `settings.reader.mode` | "默认阅读模式" | "Default reading mode" |
| `settings.reader.scale` | "默认缩放" | "Default scale" |
| `settings.reader.direction` | "默认阅读方向" | "Default reading direction" |
| `settings.reader.continue` | "翻到末页后" | "When reaching last page" |
| `settings.appearance.theme` | "主题" | "Theme" |
| `settings.appearance.theme.system` | "跟随系统" | "System" |
| `settings.appearance.theme.dark` | "深色" | "Dark" |
| `settings.appearance.theme.light` | "浅色" | "Light" |
| `settings.behavior.keepScreenOn` | "阅读时保持屏幕常亮" | "Keep screen on while reading" |
| `settings.behavior.language` | "界面语言" | "Language" |
| `settings.slideshow.interval` | "自动播放间隔（秒）" | "Auto-advance interval (seconds)" |
| `settings.slideshow.interval.label` | "{seconds} 秒" | "{seconds} s" |
| `settings.slideshow.direction` | "方向" | "Direction" |
| `settings.slideshow.direction.forward` | "正向" | "Forward" |
| `settings.slideshow.direction.backward` | "反向" | "Backward" |
| `settings.slideshow.loop` | "循环播放" | "Loop" |
| `settings.touch.title` | "屏幕 9 宫格" | "Screen 9-zone" |
| `settings.touch.hint` | "点击格子映射动作，3×3 网格对齐屏幕分区" | "Tap a cell to remap its action; 3×3 grid mirrors the screen" |
| `settings.touch.reset` | "恢复经典布局" | "Reset to classic layout" |
| `settings.touch.resetConfirm` | "将 9 区动作恢复为默认？" | "Reset all 9 zones to defaults?" |
| `settings.scale.fit-screen` | "适应屏幕" | "Fit screen" |
| `settings.scale.fit-width` | "适宽" | "Fit width" |
| `settings.scale.fit-height` | "适高" | "Fit height" |
| `settings.scale.original` | "原始大小" | "Original" |
| `settings.scale.full-screen` | "全屏显示" | "Full screen" |
| `settings.scale.stretch` | "拉伸" | "Stretch" |
| `settings.direction.ltr` | "从左到右" | "Left to right" |
| `settings.direction.rtl` | "从右到左" | "Right to left" |
| `settings.touchAction.none` | "无" | "None" |
| `settings.touchAction.prevPage` | "上一页" | "Previous page" |
| `settings.touchAction.nextPage` | "下一页" | "Next page" |
| `settings.touchAction.jumpFirst` | "跳到首页" | "Jump to first" |
| `settings.touchAction.jumpLast` | "跳到末页" | "Jump to last" |
| `settings.touchAction.openMainMenu` | "打开主菜单" | "Open main menu" |
| `settings.touchAction.slideshowToggle` | "切换幻灯片" | "Toggle slideshow" |
| `settings.touchAction.fitWidth` | "适应宽度" | "Fit width" |
| `settings.touchAction.folderPrev` | "上一卷" | "Previous volume" |
| `settings.touchAction.folderNext` | "下一卷" | "Next volume" |
| `settings.touchAction.openFileBrowser` | "打开文件浏览器" | "Open file browser" |

`reader.continue.{off,auto,manual}` 保留复用，不复制到 `settings.*`。

### 4.6 错误处理

- `getSetting` 抛错 → catch 后用 ref 默认（已有模式）
- `setSetting` 抛错 → catch 后 ref 已变但 DB 未持久化，UI 显示 "保存失败" toast（**新增**——CLAUDE.md §1.8 error toast 模板）
- IntersectionObserver 在 happy-dom 不支持 → `useSectionAnchors.test.ts` mock；生产环境正常
- `prefers-color-scheme` media query → Safari 旧版需 fallback（14+ 不需要）

### 4.7 测试策略

#### 4.7.1 单元测试（vitest）

| 文件 | 新增 case | 数量 |
|---|---|---|
| `src/lib/readerSettings.test.ts` | DEFAULT_TOUCH_SCHEME 对齐 PV；TOUCH_ACTIONS = 11 个不含 toggle-chrome；TOUCH_ZONES = 9 个 | 3 |
| `src/stores/settings.test.ts` | load 命中 scale/direction/9 zones；update 序列化；setTouchAction；resetTouchScheme 写 9 行 | 4 |
| `src/composables/useReaderTouchZones.test.ts` | 9 区坐标映射；与 store 集成；ignoreSelector 跳过 | 3 |
| `src/composables/useThemeSync.test.ts` | themeMode=dark 添 class；system 跟随；light 移除 | 3 |
| `src/composables/useSectionAnchors.test.ts` | mount activeId 默认；scrollTo 调用 | 2 |
| `src/views/Settings.test.ts` | 6 section 渲染；改 dropdown → store 改；reset → confirm；切 anchor | 4 |
| `src/views/ReaderView.test.ts` | 11 动作 dispatch 全覆盖 | 1 |

合计 **~20 个新测试**。

#### 4.7.2 验证清单（CLAUDE.md §5.3）

| # | 命令 | 期望 |
|---|---|---|
| V1 | `npm run type-check` | 0 error |
| V2 | `npm test -- --run` | 全部通过（含既有） |
| V3 | `npm run tauri:dev` + 手动 5 步骤 | 见 §4.7.3 |

#### 4.7.3 手测用例

1. 切 theme 系统/浅/深 → html class 切换（用 devtools 看 `<html>` 节点）
2. 改 default reader mode → 重启 app 后生效
3. 改 default scale mode → 打开新书生效
4. 改 continue mode → 翻到末页触发不同行为
5. 改 9 区映射（如 tl 改成 `jump-first`）→ 进 reader 点左上角 → 跳首页生效
6. 点 reset → 9 区回到 PV DEFAULT

#### 4.7.4 不测的（YAGNI）

- colorTheme UI —— 用户选"仅 store 存值"，无 UI
- TouchAction persistence 边界（脏写 / 并发）
- Anchor nav scroll 性能 —— 6 section 不会卡
- Backup / Restore —— 不在范围

### 4.8 TDD 顺序（CLAUDE.md §3 + §4）

1. `src/lib/readerSettings.ts` + `readerSettings.test.ts` —— 先测后码，3 case
2. `src/stores/settings.ts` 改造 + 扩 `settings.test.ts` —— 4 case
3. `src/composables/useSectionAnchors.ts` + test —— 2 case
4. `src/composables/useThemeSync.ts` + test —— 3 case
5. `useReaderTouchZones.ts` 接入 store + test —— 3 case
6. `ReaderView.vue` 扩 dispatchZoneAction + test —— 1 case
7. `Settings.vue` 重写 + test —— 4 case（最大组件，最后做）
8. i18n `zh-CN.ts` + `en-US.ts` 同步加 key —— 1 case 验两文件 key 一致
9. `App.vue` 接入 `useThemeSync()` —— 无单测（集成度低）

## 5. 验证清单（合并到 §4.7.2）

## 6. 风险与回滚

| 风险 | 严重 | 缓解 |
|---|---|---|
| 触控默认 PV DEFAULT 与老用户习惯冲突 | 中 | reset 按钮 1 键回滚；首次启动提示（**不做**，用户已知会变） |
| Tailwind `dark:` 浅色基线未实装 | 低 | 本次仅 class toggle，视觉无变化；后续主题模块再做 |
| `dispatchZoneAction` 重命名（`open-menu` → `open-main-menu`）| 低 | 全部替换，type-check 兜底；表 §4.4.4 显式列出 |
| ReaderView 加 2 个 callback | 低 | store 已有 `defaultScaleMode`；OSG `viewport.goHome` 是公开 API |
| Anchor nav 在窄屏（< 1024px）挤压 | 低 | 桌面端固定 220px，不处理 |

## 7. 不在本模块范围

| 项目 | 后续 |
|---|---|
| ColorTheme UI + Tailwind 多主题 | 主题模块 |
| Backup / Restore + AES | 备份模块 |
| Volume key paging | 输入模块（CLAUDE.md §0.4） |
| Startup screen | App boot 模块 |
| 启动屏 / 关于 / 版本号 | 关于模块 |
| Disk cache 段（pageCache / archiveCache）| 不适用 |
| Download 段 | 不适用 |
| SMB / WebDAV archive strategy 暴露 | 协议层模块 |
