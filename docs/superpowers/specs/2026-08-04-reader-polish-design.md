# 阅读器打磨 + 立即阅读入口语义 — MiraPage Desktop

- **日期**: 2026-08-04
- **状态**: 设计稿（待规格审查）
- **范围**: 9 个 bug / 优化项（1 个 defer 到后续），3 个 cluster
- **相关**: [`DESIGN.md`](../../DESIGN.md) §11 设置 / §12 阅读器状态机 / §14 输入；CLAUDE.md §0 阅读器规约 / §1 UI / §3 代码约定

## 1. 背景与目标

### 1.1 用户反馈（9 条）

| # | 类型 | 描述 |
|---|---|---|
| 1 | bug | 文件浏览器：双击图片文件未触发阅读（当前 no-op） |
| 2 | bug | 文件浏览器：立即阅读进度偶尔不恢复（疑似依赖是否加书库）—— **本次 defer** |
| 3 | 优化 | 文件浏览器：选中图片时"立即阅读"按钮可点 |
| 4 | 优化 | 文件浏览器：选中图片文件夹时按钮可用 + 读历史（当前已 work，验证即可） |
| 5 | bug | 阅读器：顶/底栏按钮全部无响应 |
| 6 | 优化 | 阅读器：支持多种缩放（fit-screen / fit-width / fit-height / original / full-screen / stretch） |
| 7 | bug | 阅读器：ESC 跳到 OSD 默认控件页（X 图标）+ 应返回文件浏览器 |
| 8 | 优化 | 阅读器：幻灯片播放时 chrome 自动隐藏，hover 时显示 |
| 9 | 优化 | 窗口默认最小宽度太大 |

### 1.2 目标

- **Cluster A（#1 #3 #4）**：统一"立即阅读"入口语义，所有入口（双击 / 选中后按钮 / 右键菜单）行为一致：选中目录 → 读该目录；选中图片 → 从该图开始。自动读历史进度。
- **Cluster B（#5 #7 #8 #9）**：修复阅读器 UI 可交互性 + 简化交互（PV 风格"tap center → menu"）。
- **Cluster C（#6）**：完整化 6 种缩放模式，OSD 实例暴露，9 宫格 `fit-width` 实际生效。

### 1.3 范围

| 模块 | 包含 | 不包含 |
|---|---|---|
| 立即阅读入口 | 双击图片、选中图片/文件夹、详情面板 CTA、右键菜单 read-now 全部统一；新增 `useReaderActions.readFromImage` | 编辑类功能（新建/重命名/删除） |
| 阅读器 UI 修复 | OSD nav control 禁用、pointer-events 修复、chrome 显隐逻辑、ESC 行为、窗口最小尺寸 | OSD 重构、双指手势改动 |
| 缩放 | 6 种模式 + OSD API 暴露 + useReaderScale composable + Settings UI 暴露 + 9 宫格 fit-width 实际生效 | 触控屏手势（macOS trackpad pinch → 已 OSD 内置） |
| 进度恢复诊断 | — | #2 的真正修复需用户复现步骤（见 §6 已知问题） |

### 1.4 非目标

- WebView2 内 OSD icon 资源加载失败的根因调查（CSP / asset path）—— 直接用 `showNavigationControl: false` 绕过
- `progress` 表 FK CASCADE 行为审计 —— 与 #2 同源，待用户复现
- macOS / Linux 平台的窗口最小尺寸调整 —— 改 `tauri.conf.json` 同步生效

## 2. 核心决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| **Cluster 数量** | 3 cluster 单 spec | 全部 reader 域，单一 v0.1.0-module3.0.2-reader-polish |
| **双击图片方案** | query param `?at=imageName` | 不污染 path，可选参数，与 #4 复用同一路由 |
| **readFromImage 实现** | 合成父目录 MediaEntry + 复用 ensureBookId | 最小改动，复用 Rust `create_book` upsert 语义 |
| **进度恢复优先级** | 显式 ?at > saved progress > 0 | 双击图片是用户当下意图，优先 saved progress；末页钳位仍生效 |
| **OSD 默认控件** | `showNavigationControl: false`（不是 navigator） | 单行修复；保留 `showNavigator: false`（小地图） |
| **ESC 行为** | `router.back()`（Vue Router history） | 有 history 时返上一个路由，无 history 返首页（Home.vue） |
| **chrome 自动隐藏触发** | `autoHide = slideshow.isPlaying` | 与 #8 描述"播放幻灯片时"精确对应；hover 解除 |
| **缩放 6 模式全接** | fit-screen / fit-width / fit-height / original / full-screen / stretch | 用户明确选 6 模式 |
| **OSD viewer 暴露** | `defineExpose({ viewer })` + `ref` 冒泡 | 无 provide/inject 间接层；测试时 mock `applyScale` 简单 |
| **缩放运行时态 vs 默认值** | `currentScaleMode`（runtime）+ `defaultScaleMode`（新书初始值） | 双字段各司其职，避免 conflict |
| **窗口最小尺寸** | `minWidth: 480, minHeight: 360` | 接近典型 4:3 漫画页比例；不破坏 sidebar/toolbar |

## 3. 方案选择

### 3.1 双击图片进入阅读（已选 A）

**A. query param `?at=imageName`**（选）
- 路由：`/reader/:bookId?at=imageName`
- ReaderView `route.query.at` 解析 → 找 index → 覆盖 initialSpreadIndex
- 优点：不污染 path；可缺省；测试容易（mock route）
- 缺点：URL 较长（特殊字符需 encodeURIComponent）

**B. path param `/reader/:bookId/:imageName`**
- 优点：URL 语义清晰
- 缺点：route schema 改；router.push 用 object vs string 都要改

**C. router state（push 后 query 立即清）**
- 缺点：刷新页面 state 丢失

→ 选 A，与现有 `?at=` 模式无冲突（无既有 query param）。

### 3.2 #5 按钮不可点 修复（已选 B）

**A. 重构 OSD 容器结构，让 overlay 在视觉上层**（选）
- 移除 OSD 默认 nav controls（`showNavigationControl: false`）
- ReaderOverlay 外层 `pointer-events-none`，内层按钮 `pointer-events-auto`
- 不需要 z-index 改动（DOM 顺序已确保 overlay 在 viewer 之后）

**B. 改 OSD 内部 pointer-events 处理**
- 复杂，需要 patch OSD
- 副作用大

→ 选 A，最小侵入。

### 3.3 chrome 自动隐藏逻辑（已选 A）

**A. `autoHide = slideshow.isPlaying`，hover 临时显示**
- 顶栏 / 底栏 / 控制条 都遵循 `v-if="... && !autoHide"`
- hover 时清除 autoHide，setTimeout 2s 重新隐藏
- 简单一致

**B. 分层：chrome 跟 isPlaying 走，控制条始终独立**
- 与现有"控制条独立显示"逻辑共存但更复杂
- 不符合"播放时控制条也要隐藏"的诉求

→ 选 A。

### 3.4 OSD 缩放实现（已选 B）

**A. `viewport.fitBounds(imageBounds, false)`（fit-screen / fit-width / fit-height / full-screen）**
- OSD 原生 API，语义清晰
- 需要 OSD 暴露 imageBounds（`viewer.world.getItemAt(0).getBounds()`）

**B. 自实现 `zoomTo(widthRatio, null, true)` + 居中**（stretch）
- A 不支持 stretch（变形填满）
- B 用于 stretch 与 original（`zoomTo(1)` 100%）

→ 都用：`fit-*` 系列用 A，original / stretch 用 B。

## 4. 设计

### 4.1 Cluster A：立即阅读入口

#### 4.1.1 `src/composables/useReaderActions.ts`

新增方法：

```ts
async function readFromImage(imageEntry: MediaEntry): Promise<void> {
  // 1. 父目录 = 当前 fb.lastFetchedPath
  const parentPath = opts.getLastFetchedPath();
  if (!parentPath) return;  // 容错:无列表上下文,放弃

  const parentName = parentPath.split(/[\\/]/).filter(Boolean).pop() ?? imageEntry.name;

  // 2. 合成父目录 MediaEntry (走 ensureBookId 目录分支)
  const parentDir: MediaEntry = {
    name: parentName,
    path: parentPath,
    isDirectory: true,
    isArchive: false,
    size: 0,
  };

  const bookId = await ensureBookId(parentDir, /*favorite=*/false);
  if (bookId === null) return;

  // 3. recordHistory + router.push 带 ?at=imageName
  try {
    const rootPath = opts.resolveRootPath();
    const descriptor = opts.buildSourceDescriptor(rootPath);
    await recordHistory(descriptor, parentPath, parentName, bookId);
  } catch (e) { /* 容错 */ }

  if (opts.onLibraryChanged) await opts.onLibraryChanged();
  if (router) {
    await router.push({
      path: `/reader/${bookId}`,
      query: { at: encodeURIComponent(imageEntry.name) },
    });
  }
}
```

`ReaderActionsOptions` 增字段：

```ts
interface ReaderActionsOptions {
  resolveRootPath: () => string;
  buildSourceDescriptor: (rootPath: string) => SourceDescriptor;
  getLastFetchedPath: () => string;   // 新增, FileBrowser 注入 fb.lastFetchedPath
  router?: Router;
  onLibraryChanged?: () => void | Promise<void>;
}
```

#### 4.1.2 `src/components/filebrowser/FileBrowser.vue`

```ts
import { isImage } from '@/lib/mime';

const canReadNow = computed(() => {
  const e = selectedEntry.value;
  if (!e) return false;
  return e.isDirectory === true || isImage(e.name);
});

function onReadNowClick() {
  if (!selectedEntry.value) return;
  if (selectedEntry.value.isDirectory) {
    void readerActions.readNow(selectedEntry.value);
  } else {
    void readerActions.readFromImage(selectedEntry.value);
  }
}

async function onEntryOpen(entry: MediaEntry) {
  if (entry.isDirectory) {
    await fb.navigate(`${fb.lastFetchedPath}/${entry.path}`.replace(/\/+/g, '/'));
    return;
  }
  if (isImage(entry.name)) {
    await readerActions.readFromImage(entry);
    return;
  }
  // 其他文件 no-op
}
```

`useReaderActions` 注入 `getLastFetchedPath: () => fb.lastFetchedPath ?? ''`。

#### 4.1.3 `src/views/ReaderView.vue`

```ts
const initialImageName = computed(() => {
  const v = route.query.at;
  return typeof v === 'string' ? decodeURIComponent(v) : null;
});

async function resolveInitialSpreadIndex(
  bookId: number,
  pageCount: number,
  singlePage: boolean,
  imageNames: string[],   // 新增
): Promise<number> {
  // 优先: 双击 / 选中图片入口
  if (initialImageName.value && imageNames.includes(initialImageName.value)) {
    const idx = imageNames.indexOf(initialImageName.value);
    const spreads = SpreadPlanner.plan(pageCount, true, singlePage);
    const target = SpreadPlanner.spreadIndexForPage(idx, spreads);
    const last = spreads.length - 1;
    return target >= last ? Math.max(0, last - 1) : target;
  }
  // 缺省: 读 saved progress
  try {
    const progress = await getProgress(bookId);
    if (!progress) return 0;
    const spreads = SpreadPlanner.plan(pageCount, true, singlePage);
    const last = spreads.length - 1;
    if (last < 0) return 0;
    const idx = SpreadPlanner.spreadIndexForPage(progress.page, spreads);
    const clamped = Math.max(0, Math.min(idx, last));
    return clamped >= last ? Math.max(0, last - 1) : clamped;
  } catch (e) {
    log('[ReaderView] resolveInitialSpreadIndex fallback 0:', e);
    return 0;
  }
}
```

调用方多传 `sortedNames`：

```ts
const initialSpreadIndex = await resolveInitialSpreadIndex(
  id, sortedNames.length, isSinglePage, sortedNames,
);
```

### 4.2 Cluster B：阅读器 UI 修复

#### 4.2.1 #5 按钮不可点

**改动 1：`src/components/reader/SinglePageViewer.vue`**

OSD init 加 `showNavigationControl: false`：

```ts
viewer = OpenSeadragon({
  element: containerRef.value,
  tileSources: { type: 'image', url: props.imageUrl },
  showNavigator: false,
  showNavigationControl: false,    // 新增
  gestureSettingsMouse: { scrollToZoom: false },
  animationTime: 0.3,
});
```

**改动 2：`src/components/reader/DoublePageViewer.vue`** 同上。

**改动 3：`src/components/reader/ReaderOverlay.vue`**

外层 div 加 `pointer-events-none`，所有 button / input / form 加 `pointer-events-auto`：

```vue
<div
  class="absolute inset-0 pointer-events-none flex flex-col justify-between ..."
  data-test="overlay"
  data-test-ignore-touch-zones
>
  <header class="bg-black/60 ..."
          :class="chromeVisible && !autoHide ? '' : 'hidden'">
    <button ... class="pointer-events-auto" />
    ...
  </header>

  <div v-if="showSlideshowControl && !autoHide"
       class="... pointer-events-auto" data-test="slideshow-control">
    ...
  </div>

  <footer ...>
    <button ... class="pointer-events-auto" />
    <form ... class="pointer-events-auto" @submit="submitJump">
      <input ... />
      <button type="submit">Go</button>
    </form>
  </footer>
</div>
```

#### 4.2.2 #7 OSD 默认控件 + ESC

**改动 1：OSD nav control 禁用**（同 4.2.1 改动 1/2）

**改动 2：`src/lib/inputBindings.ts`**

```ts
export type ReaderCommand =
  | ... existing ...
  | 'closeReader';   // 新增

export interface KeyBindings {
  ... existing ...
  closeReader: string[];
}

export const defaultKeyBindings: KeyBindings = {
  ... existing ...
  openMainMenu: ['m'],   // 移除 'Escape'
  closeReader: ['Escape'],
};
```

**改动 3：`src/composables/useReaderHotkeys.ts`**

```ts
import { useRouter } from 'vue-router';

function dispatch(store, cmd: ReaderCommand): void {
  const slideshow = useSlideshowStore();
  const router = useRouter();
  switch (cmd) {
    ... existing ...
    case 'closeReader':
      router.back();
      break;
  }
}
```

#### 4.2.3 #8 chrome 自动隐藏

**改动 1：`src/components/reader/ReaderOverlay.vue`**

```ts
import { useSlideshowStore } from '@/stores/slideshow';
const slideshow = useSlideshowStore();

const autoHide = computed(() => slideshow.isPlaying);

const hoveredVisible = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function flashOnHover() {
  hoveredVisible.value = true;
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoveredVisible.value = false; }, 2000);
}

onUnmounted(() => { if (hoverTimer !== null) clearTimeout(hoverTimer); });

const chromeShow = computed(() => chromeVisible.value && !autoHide.value);
const slideshowControlShow = computed(() =>
  (slideshow.isPlaying || hoveredVisible.value) && !autoHide.value
);
```

模板：

```vue
<header v-if="chromeShow" ...>
  ...
</header>

<div v-if="slideshowControlShow" ...>
  ...
</div>

<footer v-if="chromeShow" ...>
  ...
</footer>
```

**改动 2：`src/components/reader/ReaderScreen.vue`** 不必传 props —— ReaderOverlay 直接从 store 读 `slideshow`。

**ReaderOverlay 父级容器** `mouseenter` / `mouseleave`：

```vue
<div ... @mouseenter="flashOnHover" @mouseleave="onLeave">
```

或者保留现有 `hovered` prop 来自 ReaderScreen，统一通过 `flashOnHover` 处理。

#### 4.2.4 #9 窗口最小尺寸

**改动：`src-tauri/tauri.conf.json`**

```json
"windows": [
  {
    "title": "MiraPage",
    "width": 1280,
    "height": 800,
    "minWidth": 480,
    "minHeight": 360,
    "resizable": true,
    "fullscreen": false
  }
]
```

视觉破坏性验证：在 480×360 下：
- SideNav 收起 / 抽屉化（不在本次 scope，超小尺寸已知 trade-off）
- FileBrowser toolbar 不溢出
- Reader 仅显示图片 + 隐藏 chrome（符合预期）

### 4.3 Cluster C：缩放

#### 4.3.1 `src/composables/useReaderScale.ts`（新增）

```ts
/**
 * useReaderScale.ts — OSD 缩放控制（Cluster C）
 *
 * - 接收 OSD Viewer 实例 ref
 * - watch settings.currentScaleMode → 立即 applyScale
 * - watch imageUrl 变化 → 重 apply currentScaleMode
 * - 6 种 scale mode 映射到 OSD viewport API
 */
import { onUnmounted, watch, type Ref } from 'vue';
import { useSettingsStore } from '@/stores/settings';

export type OSDViewer = {
  viewport: {
    goHome: (immediately?: boolean) => void;
    fitBounds: (bounds: unknown, immediately?: boolean) => void;
    zoomTo: (zoom: number, refPoint?: unknown, immediately?: boolean) => void;
    panTo: (point: unknown, immediately?: boolean) => void;
    getContainerSize: () => { x: number; y: number };
  };
  world: {
    getItemAt: (idx: number) => { getBounds: () => unknown } | null;
  };
};

export function useReaderScale(viewerRef: Ref<OSDViewer | null>): void {
  const settings = useSettingsStore();

  function applyScale(mode: typeof settings.currentScaleMode): void {
    const viewer = viewerRef.value;
    if (!viewer) return;
    const item = viewer.world.getItemAt(0);
    if (!item) return;
    const bounds = item.getBounds() as { x: number; y: number; width: number; height: number };

    switch (mode) {
      case 'fit-screen':
        viewer.viewport.goHome();
        break;
      case 'fit-width':
        viewer.viewport.fitBoundsWithAlignment(
          bounds,
          { x: 0.5, y: 0 },  // 顶部对齐, 水平居中
          false,
        );
        break;
      case 'fit-height':
        viewer.viewport.fitBoundsWithAlignment(bounds, { x: 0.5, y: 0.5 }, false);
        break;
      case 'full-screen':
        viewer.viewport.fitBounds(bounds, true);
        break;
      case 'original': {
        const container = viewer.viewport.getContainerSize();
        const imageViewport = bounds;
        const zoomX = container.x / imageViewport.width;
        const zoomY = container.y / imageViewport.height;
        viewer.viewport.zoomTo(Math.min(zoomX, zoomY), null, false);
        viewer.viewport.panTo({ x: imageViewport.x + imageViewport.width / 2, y: imageViewport.y + imageViewport.height / 2 });
        break;
      }
      case 'stretch': {
        const container = viewer.viewport.getContainerSize();
        const zoomX = container.x / bounds.width;
        const zoomY = container.y / bounds.height;
        viewer.viewport.zoomTo(Math.max(zoomX, zoomY), null, true);   // 取大值, 双方向覆盖
        break;
      }
    }
  }

  watch(
    () => settings.currentScaleMode,
    (mode) => applyScale(mode),
    { immediate: true },
  );
}
```

#### 4.3.2 OSD viewer 暴露

`src/components/reader/SinglePageViewer.vue`：

```ts
import OpenSeadragon from 'openseadragon';
// ... existing ...
let viewer: OpenSeadragon.Viewer | null = null;

defineExpose({
  getViewer: () => viewer,
  onImageLoad: (cb: () => void) => {
    if (!viewer) return () => undefined;
    viewer.addOnceHandler('open', cb);
    return () => viewer?.removeHandler('open', cb);
  },
});

onMounted(() => {
  // ... OSD init ...
  viewer.addHandler('open', () => {
    log('[SinglePageViewer] OSD open ok');
  });
});
```

`src/components/reader/DoublePageViewer.vue`：内部 2 个 SinglePageViewer，需要 ref 转发 / `defineExpose` 把每个 viewer 暴露出去（或合并为"取第一个 viewer"用于缩放）。

#### 4.3.3 `src/stores/settings.ts`

```ts
// 新增字段
const currentScaleMode = ref<ScaleMode>(DEFAULT_SCALE_MODE);

async function setScaleMode(mode: ScaleMode): Promise<void> {
  currentScaleMode.value = mode;
  await update('scale_mode', mode);   // 新 DB key
}
```

`load()` 增加：

```ts
['scale_mode', (v) => (currentScaleMode.value = v as ScaleMode)],
```

**与 `defaultScaleMode` 区分**：
- `defaultScaleMode`：新书打开时初始化的缩放（持久化为 `default_scale_mode`，已存在）
- `currentScaleMode`：阅读中当前缩放（持久化为 `scale_mode`，新增）

ReaderView 在 `openBook` 时：
```ts
settings.setScaleMode(settings.defaultScaleMode);
```

#### 4.3.4 `src/composables/useReaderTouchZones.ts` `fitWidth`

当前 `fitWidth` 回调：

```ts
fitWidth: () => {
  settings.defaultScaleMode = 'fit-width';
  void settings.update('default_scale_mode', 'fit-width');
  log('[ReaderView/zoneActions/fitWidth] persisted fit-width; takes effect on next book open');
},
```

改为：

```ts
fitWidth: () => {
  void settings.setScaleMode('fit-width');   // 立即 apply + 持久化
},
```

#### 4.3.5 Settings UI

`src/views/Settings.vue`（已存在 `reader.scale.*` dropdown）：调用 `setScaleMode(mode)` action，立即反映到 reader（store → useReaderScale watch → OSD apply）。

#### 4.3.6 ReaderOverlay 缩放下拉（PV 参考）

在幻灯片控制条旁加缩放模式按钮组（参考 PV `ReaderMainMenu.kt`），调 `settings.setScaleMode`。

## 5. 测试策略

| 层 | 测试 |
|---|---|
| Unit | `useReaderActions.test.ts`: readFromImage 用合成 parent dir entry |
| Unit | `inputBindings.test.ts`: Escape → `closeReader`, `m` → `openMainMenu` |
| Unit | `useReaderScale.test.ts`: 6 种 mode → OSD viewer 调用对应 API |
| Unit | `useReaderTouchZones.test.ts`: `fitWidth` 调 setScaleMode 而非 update |
| Component | `FileBrowser.test.ts`: 双击 .jpg → onEntryOpen → readFromImage; canReadNow 对 image=true |
| Component | `ReaderView.test.ts`: route query `at=img.jpg` → initialSpreadIndex 指向该图 |
| Component | `ReaderOverlay.test.ts`: `slideshow.isPlaying=true` → 三层 v-if 全 false |
| E2E | 手动测试：双击图片 / 选中立即阅读 / ESC 返 FB / 缩放切换 |

## 6. 已知问题 / Future Work

### #2 进度偶尔恢复偶尔不（DEFER）

**症状**：用户报告"进度偶尔恢复偶尔不(依赖是否加书库)"。

**已知事实**：
- Rust `create_book` 已确认按 `(source_descriptor, absolute_path)` upsert 复用 book_id（`src-tauri/src/commands/library.rs:133-151`）
- 因此 favorite=true/false 调用同一 (sd, path) 应返回相同 book_id，progress 关联保留

**可能根因（待诊断）**：
- `recordHistory` 在 favorite=false 调用时 bookId 传 0/null，旧 history row 的 bookId 被覆盖
- 不同 `absolutePath`（`/A/B` vs `/A/B/c`）创建不同 book_id，每次"立即阅读"都新建 row
- `progress` 表 FK CASCADE 删除（待 schema 验证）

**诊断需要**：
- 用户提供复现步骤：
  - 入口（双击 / 立即阅读 / 加书库）
  - 当前路径（rootPath / absolutePath）
  - 是否加书库（is_favorite=1/0）
  - progress.bookId 与 library.id 是否匹配（log）

**本次不动**。spec commit 后请用户复现 → Rust + TS 调用链 trace → 单独 fix 发版。

### 其他已知问题

- 480×360 极小尺寸下 SideNav 抽屉化未实现（不在 scope）
- OSD 双指 pinch → zoom（macOS 触控板）默认行为不变，scale 切换不影响

## 7. 发版 & 文件清单

**Tag**: `v0.1.0-module3.0.2-reader-polish`

**改动文件**（estimate ~14）：
- 新增：`src/composables/useReaderScale.ts`、`src/composables/useReaderScale.test.ts`
- 修改：
  - `src/composables/useReaderActions.ts` (+ readFromImage)
  - `src/composables/useReaderActions.test.ts`
  - `src/composables/useReaderHotkeys.ts` (+ closeReader dispatch)
  - `src/composables/useReaderTouchZones.ts` (fitWidth 改 setScaleMode)
  - `src/composables/useReaderTouchZones.test.ts`
  - `src/components/filebrowser/FileBrowser.vue` (canReadNow + onEntryOpen)
  - `src/components/filebrowser/FileBrowser.test.ts`
  - `src/views/ReaderView.vue` (route.query.at + resolveInitialSpreadIndex)
  - `src/views/ReaderView.test.ts`
  - `src/components/reader/SinglePageViewer.vue` (showNavigationControl: false + defineExpose)
  - `src/components/reader/SinglePageViewer.test.ts`
  - `src/components/reader/DoublePageViewer.vue` (同上)
  - `src/components/reader/ReaderOverlay.vue` (pointer-events + autoHide)
  - `src/components/reader/ReaderOverlay.test.ts`
  - `src/stores/settings.ts` (currentScaleMode + setScaleMode)
  - `src/stores/settings.test.ts`
  - `src/lib/inputBindings.ts` (closeReader ReaderCommand)
  - `src/lib/inputBindings.test.ts`
  - `src/views/Settings.vue` (缩放下拉连 setScaleMode)
  - `src-tauri/tauri.conf.json` (minWidth/minHeight)
- i18n：`src/locales/zh-CN.ts` + `en-US.ts` 增 ~3-5 keys（`reader.scale.*` 已存在；`reader.menu.closeReader`、`reader.menu.escapeHint` 等）

**风险**：
- OSD `defineExpose` + `onImageLoad` callback 钩子时序未覆盖（待实现验证）
- pointer-events 改动可能影响 OSD 双指 / 鼠标 drag —— 验证 zoom & pan 仍可用
- 缩放算法可能与 coverStandalone / singlePage 模式有 corner case
- 窗口最小尺寸 480×360 下 file browser 可能布局破坏 —— 视觉测试

**回退**：每个 cluster 独立 commit，可单独 revert。tag 在所有 cluster 测试通过后打。