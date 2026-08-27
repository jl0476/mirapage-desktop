# 瀑布流混排图标占位卡片（方案 B）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 瀑布流视图中非图片条目（Thumbs.db / 子目录 / 归档）渲染为图标占位卡片（FileIcon + 文件名），消灭「布局占位但渲染缺席」的左上角空洞；占位卡双击可打开（进目录 / 进压缩包视图，复用现有 open 链路）。

**架构：** 布局与渲染统一数据源——统一谓词 `isMasonryImage(entry)`（类型标记优先于扩展名）贯穿全部判定点；`useMasonryLayout.inputs` 给非图片条目固定 16:9 高（不查 measuredMap）；`MasonryRow` 按 `isDirectory/isArchive/isImage` 分派：图片走 MasonryThumbnail（现状），非图片渲染 `.masonry-placeholder`（FileIcon + 名称）。窗口卫生三条线分离：`dimensionPrefetchPaths` 与缩略图请求 batch 只喂图片；`thumbnailWindows` 原样保留（`useArchiveWindowPrefetch` 靠它拿 is_archive 条目，一刀切过滤会断 M3 归档预载）。

**技术栈：** Vue 3 + Vitest（happy-dom）。零 Rust 零 migration 零 i18n（文件名是业务值不翻译）。

**背景（2026-08-27 实机诊断）：** 混排目录（如壁纸目录里的 `Thumbs.db`）中，`layoutMasonry` 给**全部 entries** 排位（Thumbs.db 自然排序最前占 (0,0)），`visibleItems` 却 `filter(isImage)` 不渲染它——布局占位 + 渲染缺席 = 141px 空洞。3.0.6 spec「不为文件夹目录呈现瀑布流」的纯图假设与现实不符。

**已核对的事实：**
- `useMasonryBrowsePosition:55` 已过滤 `!isDirectory && isImage(name)`（不受影响）；`FileList.onRowDblclick → emit('open', entry)` 链路对目录/归档/图片通用（零新增接线）；`FileIcon.vue` 组件现成（四型 lucide 线条 SVG + currentColor + `.icon-*` 色 token）。
- `useArchiveWindowPrefetch.test.ts` 已有 7 用例，其中第一个（`:57` webdav 源 + `.cbz` 进窗口 → 100ms 防抖后 `notifyArchiveWindow(descriptor, ['sub/a.cbz'], 'content')`）正中「归档预载窗口联动」——本计划不改该 composable，既有测试即回归证据。
- 现有图片判定模式 4 处均为 `!isDirectory && isImage(name)`（browsePosition / FileBrowser:801 / useReaderActions:93 / RowContextMenu×3）——**类型标记优先于扩展名**是既定语义；本计划谓词补 `!isArchive` 防御。

**用户拍板：**
- 方案 B（图标占位卡片，非图片在瀑布流中可见可点）。
- 占位卡固定 16:9 高（壁纸目录主流比例，与图片卡节奏整齐；不参与估算/测量）。
- 双击行为复用现有 open 链路（点目录=进目录，点归档=进压缩包视图）。

**审查修订（2026-08-27 用户审查两轮）：**
- 一轮 [P1] 新增统一谓词 `isMasonryImage(entry)`（`!isDirectory && !isArchive && isImage(name)`）替换所有仅按文件名的判断——目录可合法命名为 `cover.jpg`，仅按扩展名会把它送进尺寸/缩略图队列并渲染 spinner，违背「目录优先」。新增 `cover.jpg` 目录与 `isArchive: true` 图片扩展名条目测试贯穿各任务。
- 一轮 [P2] 归档预载验证不由双击替代：任务 2 显式跑既有 `useArchiveWindowPrefetch.test.ts`（7 用例，窗口→notifyArchiveWindow 链路已锁）；实机项相应降级为日志观察。
- 一轮 [P2] push 前预检：`git status --short`（工作区只含本计划改动）+ `git log github/main..HEAD --oneline`（待推范围确认）先行。
- 二轮 [必须] 任务 2 混排测试自建 `mkMix` factory（现有 `mkEntry` 是其他 describe 局部函数且固定 `isDirectory: false`——原稿引用会编译失败且构造不出目录）；`cover.jpg` 显式 `{ isDirectory: true }`。
- 二轮 [必须] 缩略图队列测试按既有 `setup`/`requestSpy` 基建落成完整用例（四组窗口全含非图片 → items 严格 `['a.jpg']`），不再是骨架。
- 二轮 [建议] 任务 1 测试预期修正为 4 passed。

---

## 工程师须知

- 所有命令仓库根跑（前端零 Rust 改动）。测试：`npx vitest run <file>`；全量：`npm test -- --run`；类型：`npm run type-check`。
- 当前基线：前端 1224 passed、type-check 0 err。
- `src/lib/mime.ts` 的 `isImage(name)` 是扩展名判定单一真值源；本计划在其旁新增 `isMasonryImage(entry)` 结构化参数（不引 MediaEntry 依赖，保持 lib 无依赖）。
- `FileIcon.vue`（`src/components/filebrowser/FileIcon.vue`）type prop：`'folder' | 'image' | 'archive' | 'file'`；svg width/height 硬编码 16（任务 3 加可选 size prop）。
- MasonryView.test.ts 已有 `layoutParams`（mock 工厂捕获 useMasonryLayout 入参）与 `fakeLayoutMap` 基建，新测试直接复用。
- **勿动** `useMasonryBrowsePosition.ts:55` 与 `useReaderActions.ts:93` 的既有判定（行为等价，本计划只收敛 masonry 链路内的 6 处新判定；扩散清理留后续，避免 diff 膨胀）。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/lib/mime.ts` | 修改 | `isMasonryImage(entry)` 统一谓词（任务 1） |
| `src/lib/mime.test.ts` | 创建 | 谓词三态测试（任务 1） |
| `src/composables/useMasonryLayout.ts` | 修改 | `PLACEHOLDER_ASPECT_RATIO`；inputs 非图片固定高；dimensionPrefetchPaths 滤非图片（任务 2） |
| `src/composables/useMasonryLayout.test.ts` | 修改 | 混排布局 + 窗口过滤测试（任务 2） |
| `src/composables/useMasonryThumbnails.ts` | 修改 | batch 构建滤非图片（任务 2） |
| `src/composables/useMasonryThumbnails.test.ts` | 修改 | 非图片不进请求 batch（任务 2） |
| `src/components/filebrowser/FileIcon.vue` | 修改 | 可选 `size` prop（任务 3） |
| `src/components/filebrowser/MasonryRow.vue` | 修改 | 非图片渲染 `.masonry-placeholder`（任务 3） |
| `src/components/filebrowser/MasonryRow.test.ts` | 修改 | 占位卡三型 + cover.jpg 目录渲染（任务 3） |
| `src/components/filebrowser/MasonryView.vue` | 修改 | visibleItems 放开过滤；loading 只判 masonry 图片（任务 4） |
| `src/components/filebrowser/MasonryView.test.ts` | 修改 | 混排渲染 + loading 不永挂（任务 4） |
| `AGENTS.md` | 修改 | 3.0.6 行补记（任务 5） |

---

### 任务 1：`isMasonryImage` 统一谓词

**文件：**
- 修改：`src/lib/mime.ts`（`isArchive` 后）
- 创建：`src/lib/mime.test.ts`

- [ ] **步骤 1.1：编写失败的测试**

创建 `src/lib/mime.test.ts`：

```ts
// isMasonryImage——masonry 图片卡统一判定（2026-08-27 混排占位，审查 P1）。
// 类型标记优先于扩展名：目录可合法命名为 cover.jpg；归档即使扩展名像图片也不是图片卡。
import { describe, it, expect } from 'vitest';
import { isMasonryImage } from './mime';

describe('isMasonryImage', () => {
  const e = (over: Partial<{ name: string; isDirectory: boolean; isArchive: boolean }>) => ({
    name: 'a.jpg', isDirectory: false, isArchive: false, ...over,
  });

  it('普通图片文件 → true', () => {
    expect(isMasonryImage(e({}))).toBe(true);
    expect(isMasonryImage(e({ name: 'page_01.PNG' }))).toBe(true);
  });

  it('目录命名 cover.jpg → false（类型标记优先，防送尺寸/缩略图队列）', () => {
    expect(isMasonryImage(e({ name: 'cover.jpg', isDirectory: true }))).toBe(false);
  });

  it('归档条目 → false（isArchive 防御；cbz 扩展名本就非图片）', () => {
    expect(isMasonryImage(e({ name: 'book.cbz', isArchive: true }))).toBe(false);
    expect(isMasonryImage(e({ name: 'weird.jpg', isArchive: true }))).toBe(false);
  });

  it('非图片普通文件 → false', () => {
    expect(isMasonryImage(e({ name: 'Thumbs.db' }))).toBe(false);
    expect(isMasonryImage(e({ name: 'notes.txt' }))).toBe(false);
  });
});
```

- [ ] **步骤 1.2：运行测试验证失败**

运行：`npx vitest run src/lib/mime.test.ts`
预期：编译失败 `isMasonryImage is not exported`。

- [ ] **步骤 1.3：实现**

`src/lib/mime.ts` 的 `isArchive` 函数后追加：

```ts
/** masonry 图片卡统一判定（2026-08-27 混排占位，审查 P1）：类型标记优先于扩展名。
 *  目录可合法命名为 cover.jpg——仅按扩展名会把它送进尺寸/缩略图队列并渲染 spinner。
 *  对齐 useMasonryBrowsePosition/useReaderActions 的 !isDirectory && isImage 既有语义，
 *  补 !isArchive 防御（结构上可能存在图片扩展名 + isArchive 的条目）。 */
export function isMasonryImage(e: { name: string; isDirectory: boolean; isArchive: boolean }): boolean {
  return !e.isDirectory && !e.isArchive && isImage(e.name);
}
```

- [ ] **步骤 1.4：运行测试验证通过**

运行：`npx vitest run src/lib/mime.test.ts`
预期：4 passed（4 个 `it`，其中前两个 `it` 各含两条断言）。

- [ ] **步骤 1.5：Commit**

```bash
git add src/lib/mime.ts src/lib/mime.test.ts
git commit -m "feat(mime): isMasonryImage 统一谓词（类型标记优先于扩展名）"
```

---

### 任务 2：useMasonryLayout 混排布局 + 窗口卫生

**文件：**
- 修改：`src/composables/useMasonryLayout.ts`（inputs computed ~:339、dimensionPrefetchPaths ~:425）
- 修改：`src/composables/useMasonryThumbnails.ts`（batch 构建 ~:198）
- 测试：`src/composables/useMasonryLayout.test.ts`、`src/composables/useMasonryThumbnails.test.ts`

- [ ] **步骤 2.1：编写失败的测试**

`useMasonryLayout.test.ts` 尾部追加。**注意：现有 `mkEntry` 是其他 describe 的局部函数且固定 `isDirectory: false`（复审确认），本 describe 自建 factory 支持类型覆盖：**

```ts
// ─── 混排占位（2026-08-27 方案 B）：非图片条目固定 16:9 高占位 ──────────────
// 布局含全部 entries（占位卡参与瀑布流），非图片不查 measuredMap（固定高），
// dimensionPrefetchPaths 只喂 masonry 图片（isMasonryImage——cover.jpg 目录不算）。
// 自建 factory（现有 mkEntry 是其他 describe 局部函数且固定 isDirectory:false）。
describe('useMasonryLayout 混排占位', () => {
  function mkMix(
    path: string,
    over: Partial<{ isDirectory: boolean; isArchive: boolean }> = {},
  ): MediaEntry {
    return { name: path, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0, ...over };
  }

  const MIX = (): Ref<readonly MediaEntry[]> => ref([
    mkMix('Thumbs.db'),               // 非图片文件（自然排序最前——实机空洞元凶）
    mkMix('cover.jpg', { isDirectory: true }),  // 目录命名像图片（审查 P1：类型标记优先）
    mkMix('sub', { isDirectory: true }),        // 子目录
    mkMix('book.cbz', { isArchive: true }),     // 归档
    mkMix('a.jpg'),                   // 真图片
  ]);

  function mountLayout(entries: Ref<readonly MediaEntry[]>, measured: Map<string, { width: number; height: number }>) {
    return useMasonryLayout({
      entries,
      containerWidth: ref(1000),
      containerHeight: ref(800),
      colCount: ref(4),
      hGap: ref(0),
      vGap: ref(0),
      scrollTop: ref(0),
      measuredMap: ref(measured),
    });
  }

  it('布局 map 含全部 entries（非图片占位卡参与瀑布流，无空洞）', () => {
    const { layout } = mountLayout(MIX(), new Map([['a.jpg', { width: 3840, height: 2160 }]]));
    expect(layout.value.map.size).toBe(5);
    expect(layout.value.map.get('Thumbs.db')).toBeTruthy();
    expect(layout.value.map.get('cover.jpg')).toBeTruthy();
    expect(layout.value.map.get('sub')).toBeTruthy();
    expect(layout.value.map.get('book.cbz')).toBeTruthy();
  });

  it('非图片固定 16:9 高（colWidth×9/16），不查 measuredMap；图片用测量高', () => {
    const measured = new Map([['a.jpg', { width: 3840, height: 2160 }]]);
    const { layout, colWidth } = mountLayout(MIX(), measured);
    const cw = colWidth.value; // (1000 - 0) / 4 = 250
    const ph = Math.round((cw * 9) / 16); // ≈141
    expect(layout.value.map.get('Thumbs.db')!.height).toBe(ph);
    expect(layout.value.map.get('cover.jpg')!.height).toBe(ph, 'cover.jpg 目录走占位高不走估算');
    expect(layout.value.map.get('sub')!.height).toBe(ph);
    expect(layout.value.map.get('book.cbz')!.height).toBe(ph);
    // 图片：250 × 2160/3840 = 140.625 → round 141
    expect(layout.value.map.get('a.jpg')!.height).toBe(Math.round((cw * 2160) / 3840));
  });

  it('dimensionPrefetchPaths 不含非图片（cover.jpg 目录也不含——isMasonryImage）', () => {
    const { dimensionPrefetchPaths } = mountLayout(MIX(), new Map());
    const paths = dimensionPrefetchPaths.value;
    expect(paths).toContain('a.jpg');
    expect(paths).not.toContain('Thumbs.db');
    expect(paths).not.toContain('cover.jpg');
    expect(paths).not.toContain('sub');
    expect(paths).not.toContain('book.cbz');
  });

  it('thumbnailWindows 保持含非图片（useArchiveWindowPrefetch 靠它拿 is_archive 条目）', () => {
    const { thumbnailWindows } = mountLayout(MIX(), new Map());
    const all = [...thumbnailWindows.value.visible, ...thumbnailWindows.value.ahead, ...thumbnailWindows.value.behind, ...thumbnailWindows.value.idle];
    expect(all).toContain('book.cbz');
  });
});
```

`useMasonryThumbnails.test.ts` 尾部追加。**该文件基建（复审已核实）**：`mkEntry` 是模块级函数但固定 `isDirectory: false`——用内联对象构造目录/归档条目；`setup({ windows, measured })` 返回 `{ entries, windowsRef, unmount, ... }`；`requestSpy` mock `requestThumbnails`，items 在 `requestSpy.mock.calls[0][1]`；debounce 80ms 用 `vi.advanceTimersByTimeAsync`（`beforeEach` 已 `useFakeTimers`）：

```ts
// ─── 混排（2026-08-27 方案 B）：非图片不进缩略图请求 batch ──────────────────
// cover.jpg 目录也不进（isMasonryImage 类型标记优先）；归档/杂文件无缩略图语义。
describe('useMasonryThumbnails 混排过滤', () => {
  it('窗口含目录/归档/杂文件时只请求图片（items 严格等于图片集）', async () => {
    const { entries, windowsRef, unmount } = setup({
      windows: { visible: [], ahead: [], behind: [], idle: [] },
    });
    entries.value = [
      mkEntry('a.jpg'),
      { name: 'cover.jpg', path: 'cover.jpg', isDirectory: true, isArchive: false, size: 0, modifiedAt: 100 },
      { name: 'book.cbz', path: 'book.cbz', isDirectory: false, isArchive: true, size: 0, modifiedAt: 100 },
      { name: 'Thumbs.db', path: 'Thumbs.db', isDirectory: false, isArchive: false, size: 0, modifiedAt: 100 },
    ];
    // 四组窗口均含全部 path（最严苛：非图片混进每一组都要被滤掉）
    windowsRef.value = {
      visible: ['a.jpg', 'cover.jpg'],
      ahead: ['book.cbz'],
      behind: ['Thumbs.db'],
      idle: ['cover.jpg'],
    };
    requestSpy.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(90);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const items = requestSpy.mock.calls[0][1] as Array<{ path: string }>;
    expect(items.map((i) => i.path)).toEqual(['a.jpg']);
    unmount();
  });
});
```

- [ ] **步骤 2.2：运行测试验证失败**

运行：`npx vitest run src/composables/useMasonryLayout.test.ts src/composables/useMasonryThumbnails.test.ts`
预期：「固定 16:9 高」红（Thumbs.db/cover.jpg 走 avgRatio 估算 3:4）；「dimensionPrefetchPaths 不含非图片」红（含 Thumbs.db/cover.jpg）；缩略图过滤用例红。「布局含全部」「thumbnailWindows 保留」可能已绿（现本就全量）——以实际红为准。

- [ ] **步骤 2.3：实现**

`useMasonryLayout.ts`：

① import 区补：

```ts
import { isMasonryImage } from '@/lib/mime';
```

② `DEFAULT_ASPECT_RATIO` 常量旁（~:107）新增：

```ts
/** 非图片条目（目录/归档/杂文件）占位卡固定宽高比（宽/高，2026-08-27 方案 B）。
 *  16:9 与壁纸类目录主流比例一致，占位卡与图片卡节奏整齐；不参与测量/估算。 */
export const PLACEHOLDER_ASPECT_RATIO = 16 / 9;
```

③ `inputs` computed（~:323-337）map 回调分支：

```ts
    return params.entries.value.map((e) => {
      // 非图片（目录/归档/杂文件，isMasonryImage 类型标记优先）固定 16:9 占位高——
      // 不查 measuredMap（无测量语义）
      if (!isMasonryImage(e)) {
        return { path: e.path, width: cw, height: estimateHeight(cw, PLACEHOLDER_ASPECT_RATIO) };
      }
      const m = measured.get(e.path);
      // 已测量: 按 colWidth 等比缩放真实高度 (m.height/m.width 是原始像素, 须缩到卡片宽度)。
      // 不能直接用 m.height -- 否则卡片 180px 宽 × 1280px 高 (极长), cover 裁左右。
      const height = m ? (cw * m.height) / m.width : estimateHeight(cw, avgRatio);
      return { path: e.path, width: cw, height };
    });
```

④ `dimensionPrefetchPaths` computed（~:409-423）：

```ts
  const dimensionPrefetchPaths = computed<string[]>(() => {
    const w = thumbnailWindows.value;
    // listImageDimensions 只对 masonry 图片有意义（isMasonryImage——cover.jpg 目录不算）；
    // 目录/归档/杂文件固定占位高无需测量
    const imagePaths = new Set(params.entries.value.filter((e) => isMasonryImage(e)).map((e) => e.path));
    const candidates = [...w.visible, ...w.ahead, ...w.behind].filter((p) => imagePaths.has(p));
    const measured = params.measuredMap.value;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of candidates) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (measured.has(p)) continue;
      out.push(p);
      if (out.length >= DIMENSION_BATCH_SIZE) break;
    }
    return out;
  });
```

⑤ `useMasonryThumbnails.ts` batch 构建（~:198 `const entry = entriesByPath.get(path); if (!entry) continue;` 后）加：

```ts
      // 非图片不进缩略图请求（isMasonryImage：目录/归档/杂文件无缩略图语义，占位卡由
      // MasonryRow 直接渲染；cover.jpg 目录不得因扩展名混入）
      if (!isMasonryImage(entry)) continue;
```

（`isMasonryImage` 补 `import { isMasonryImage } from '@/lib/mime';`——该文件原无 mime import，grep 确认。）

- [ ] **步骤 2.4：运行测试验证通过 + 归档预载回归**

```bash
npx vitest run src/composables/useMasonryLayout.test.ts src/composables/useMasonryThumbnails.test.ts src/composables/useArchiveWindowPrefetch.test.ts
```

预期：全 passed。**归档预载 7 用例是本任务「thumbnailWindows 保留」决策的回归证据**（窗口→notifyArchiveWindow 链路既有测试锁定，本任务不改该 composable）。

- [ ] **步骤 2.5：Commit**

```bash
git add src/composables/useMasonryLayout.ts src/composables/useMasonryLayout.test.ts src/composables/useMasonryThumbnails.ts src/composables/useMasonryThumbnails.test.ts
git commit -m "feat(masonry): 混排布局——非图片固定 16:9 占位高 + 测量/缩略图窗口只喂图片（isMasonryImage）"
```

---

### 任务 3：MasonryRow 占位卡渲染 + FileIcon size prop

**文件：**
- 修改：`src/components/filebrowser/FileIcon.vue`（props）
- 修改：`src/components/filebrowser/MasonryRow.vue`
- 测试：`src/components/filebrowser/MasonryRow.test.ts`

- [ ] **步骤 3.1：编写失败的测试**

`MasonryRow.test.ts` 尾部追加（`entry`/`MediaEntry` 该文件已 import）：

```ts
// ─── 混排占位卡（2026-08-27 方案 B）：非图片渲染 FileIcon + 名称 ─────────────
describe('MasonryRow 混排占位卡', () => {
  function phProps(e: MediaEntry) {
    return {
      entry: e,
      width: 251, height: 141, top: 0, left: 0, mark: 'none' as const, selected: false,
    } as never;
  }

  it('目录条目：placeholder + folder 图标 + 名称，无 img 无 spinner', () => {
    const w = mount(MasonryRow, {
      props: phProps({ name: 'sub', path: 'sub', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.find('.masonry-placeholder').exists()).toBe(true);
    expect(w.find('.masonry-placeholder .placeholder-name').text()).toBe('sub');
    expect(w.findComponent({ name: 'FileIcon' }).props('type')).toBe('folder');
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('.thumb-spinner').exists()).toBe(false);
  });

  it('目录命名为 cover.jpg：仍是 folder 占位（isMasonryImage 类型标记优先，审查 P1）', () => {
    const w = mount(MasonryRow, {
      props: phProps({ name: 'cover.jpg', path: 'cover.jpg', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.find('.masonry-placeholder').exists()).toBe(true);
    expect(w.findComponent({ name: 'FileIcon' }).props('type')).toBe('folder');
    expect(w.find('.thumb-spinner').exists()).toBe(false, '不得送进缩略图状态机渲染 spinner');
  });

  it('归档条目：archive 图标', () => {
    const w = mount(MasonryRow, {
      props: phProps({ name: 'book.cbz', path: 'book.cbz', isDirectory: false, isArchive: true, size: 0, modifiedAt: 0 }),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.findComponent({ name: 'FileIcon' }).props('type')).toBe('archive');
  });

  it('杂文件（Thumbs.db）：file 图标', () => {
    const w = mount(MasonryRow, {
      props: phProps({ name: 'Thumbs.db', path: 'Thumbs.db', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 }),
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.findComponent({ name: 'FileIcon' }).props('type')).toBe('file');
  });

  it('图片条目仍走 MasonryThumbnail（无 placeholder）', () => {
    const w = mount(MasonryRow, {
      props: {
        entry: entry('page-001.jpg'),
        thumbState: { kind: 'cached', cacheKey: 'k', path: 'asset://c.webp', width: 512, height: 288 },
        width: 251, height: 141, top: 0, left: 0, mark: 'none', selected: false,
      } as never,
      global: { plugins: [createPinia(), i18n] },
    });
    expect(w.find('.masonry-placeholder').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(true);
  });

  it('占位卡双击仍 emit row-dblclick（复用 open 链路）', async () => {
    const w = mount(MasonryRow, {
      props: phProps({ name: 'sub', path: 'sub', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 }),
      global: { plugins: [createPinia(), i18n] },
    });
    await w.find('.masonry-row').trigger('dblclick');
    expect(w.emitted('row-dblclick')).toBeTruthy();
  });
});
```

- [ ] **步骤 3.2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/MasonryRow.test.ts`
预期：占位三型 + cover.jpg 目录红（现渲染 MasonryThumbnail spinner）；「图片仍走 Thumbnail」「双击 emit」可能已绿。核心红 = placeholder 四条。

- [ ] **步骤 3.3：实现**

① `FileIcon.vue` props 加可选 size（向后兼容）：

```ts
const props = withDefaults(defineProps<{ type: FileIconType; size?: number }>(), { size: 16 });
```

svg 标签：`width="16" height="16"` → `:width="props.size" :height="props.size"`。

② `MasonryRow.vue` script 补：

```ts
import { isMasonryImage } from '@/lib/mime';
import FileIcon from './FileIcon.vue';
```

```ts
type PlaceholderType = 'folder' | 'archive' | 'file';
/** 非图片占位类型（isMasonryImage 先行排除图片卡；目录 > 归档 > 杂文件，
 *  对齐 VirtualRow.iconType 判定顺序——cover.jpg 目录归 folder 不归 spinner）。 */
const placeholderType = computed<PlaceholderType | null>(() => {
  if (isMasonryImage(props.entry)) return null;
  if (props.entry.isDirectory) return 'folder';
  if (props.entry.isArchive) return 'archive';
  return 'file';
});
const placeholderClass = computed(() =>
  placeholderType.value ? `ph-${placeholderType.value}` : '',
);
```

模板——MasonryThumbnail 分支化 + 占位卡：

```vue
    <MasonryThumbnail
      v-if="placeholderType === null"
      :state="thumbState"
      :alt="entry.name"
      :badge-interactive="badgeInteractive"
      @retry="$emit('row-retry', entry)"
      @show-progress="(el) => $emit('show-progress', entry, el)"
      @measured="(w, h) => $emit('row-measured', entry, w, h)"
    />
    <div v-else class="masonry-placeholder" :class="placeholderClass">
      <FileIcon :type="placeholderType" :size="28" />
      <span class="placeholder-name">{{ entry.name }}</span>
    </div>
```

style 追加：

```css
/* 混排占位卡（2026-08-27 方案 B）：非图片条目 FileIcon + 名称居中 */
.masonry-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--color-surface-1);
}
.masonry-placeholder.ph-folder { color: var(--color-file-folder); }
.masonry-placeholder.ph-archive { color: var(--color-file-archive); }
.masonry-placeholder.ph-file { color: var(--color-file-default); }
.placeholder-name {
  max-width: 90%;
  font-size: 11px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

（色 token 与 VirtualRow 同源；写实现时 grep `tailwind.css` 确认 `--color-file-folder/--color-file-archive/--color-file-default` 存在，缺则用 `--color-text-muted` 兜底。）

- [ ] **步骤 3.4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/MasonryRow.test.ts`
预期：全 passed（既有 row-measured 转发等用例零回归）。

- [ ] **步骤 3.5：Commit**

```bash
git add src/components/filebrowser/FileIcon.vue src/components/filebrowser/MasonryRow.vue src/components/filebrowser/MasonryRow.test.ts
git commit -m "feat(masonry): 非图片条目渲染图标占位卡（FileIcon + 名称，cover.jpg 目录不误判）"
```

---

### 任务 4：MasonryView 放开过滤 + loading 只判图片

**文件：**
- 修改：`src/components/filebrowser/MasonryView.vue`（visibleItems ~:486、loading ~:512）
- 测试：`src/components/filebrowser/MasonryView.test.ts`

- [ ] **步骤 4.1：编写失败的测试**

`MasonryView.test.ts` 尾部追加：

```ts
// ─── 混排占位（2026-08-27 方案 B）：非图片条目渲染占位卡 ─────────────────────
describe('MasonryView 混排占位', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeLayoutMap.current = new Map<string, MasonryItem>();
    browsePositionParams.current = null;
    layoutParams.current = null;
  });

  const mixedProps = {
    ...baseProps,
    entries: [
      { name: 'Thumbs.db', path: 'Thumbs.db', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'cover.jpg', path: 'cover.jpg', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'a.jpg', path: 'a.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ],
    canonicalImageNames: ['a.jpg'],
  };

  it('非图片条目渲染占位卡（布局含全部 entries，无空洞；cover.jpg 目录是 folder 占位）', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['Thumbs.db', { path: 'Thumbs.db', width: 200, height: 112, top: 0, left: 0, col: 0 }],
      ['cover.jpg', { path: 'cover.jpg', width: 200, height: 112, top: 0, left: 200, col: 1 }],
      ['a.jpg', { path: 'a.jpg', width: 200, height: 112, top: 0, left: 400, col: 2 }],
    ]);
    const w = mount(MasonryView, {
      props: mixedProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(w.findAll('.masonry-row').length).toBe(3);
    expect(w.find('.masonry-row[data-path="Thumbs.db"] .masonry-placeholder').exists()).toBe(true);
    const cover = w.find('.masonry-row[data-path="cover.jpg"]');
    expect(cover.find('.masonry-placeholder').exists()).toBe(true);
    expect(cover.find('.thumb-spinner').exists()).toBe(false, 'cover.jpg 目录不渲染 spinner');
    w.unmount();
  });

  it('布局输入含全部 entries（不因 isImage 截断——占位参与瀑布流）', async () => {
    mount(MasonryView, {
      props: mixedProps,
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(layoutParams.current).not.toBeNull();
    expect(layoutParams.current!.entries.value.length).toBe(3);
  });

  it('窗口全为非图片时 loading 不永挂（占位卡即内容，无需测量）', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['Thumbs.db', { path: 'Thumbs.db', width: 200, height: 112, top: 0, left: 0, col: 0 }],
    ]);
    const w = mount(MasonryView, {
      props: { ...mixedProps, entries: [mixedProps.entries[0]], canonicalImageNames: [] },
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    // entries 非空 + 可见区渲染出占位卡 → loading=false（旧实现：可见区无 measured → 永挂 spinner）
    expect(w.find('[data-test="masonry-loading"]').exists()).toBe(false);
    expect(w.find('.masonry-placeholder').exists()).toBe(true);
    w.unmount();
  });

  it('窗口全为 cover.jpg 目录时 loading 同样不永挂（isMasonryImage 判定）', async () => {
    fakeLayoutMap.current = new Map<string, MasonryItem>([
      ['cover.jpg', { path: 'cover.jpg', width: 200, height: 112, top: 0, left: 0, col: 0 }],
    ]);
    const w = mount(MasonryView, {
      props: { ...mixedProps, entries: [mixedProps.entries[1]], canonicalImageNames: [] },
      global: { plugins: [createPinia(), i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await nextTick();
    expect(w.find('[data-test="masonry-loading"]').exists()).toBe(false);
    expect(w.find('.masonry-placeholder').exists()).toBe(true);
    w.unmount();
  });
});
```

- [ ] **步骤 4.2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：全部红——非图片被 `filter(isImage)` 剔除（行数 1/placeholder 不存在；Thumbs.db/cover.jpg 现状不渲染）；loading 用例永挂 true。

- [ ] **步骤 4.3：实现**

`MasonryView.vue`：

① import 区（:24 `isImage` 处）改为同时引入谓词：

```ts
import { isMasonryImage } from '@/lib/mime';
```

（若该文件其他位置仍用裸 `isImage`——grep 确认：本次改造后 masonry 链路不应再有裸调用；若有保留 import 两者。）

② `visibleItems` computed（~:486-505）——删 `.filter((e) => isImage(e.name))`，thumbState 判定换谓词：

```ts
const visibleItems = computed(() => {
  const { start, end } = visibleRange.value;
  const map = layout.value.map;
  const tmap = thumbStateMap.value;
  return props.entries
    .slice(start, end)
    .map((e) => {
      const item = map.get(e.path);
      if (!item) return null;
      return {
        entry: e,
        item,
        mark: getMark(e),
        selected: props.selectedPaths.has(e.path),
        // 非图片占位卡不消费缩略图状态（MasonryRow 占位分支不渲染 MasonryThumbnail）
        thumbState: isMasonryImage(e) ? tmap.get(e.path) : undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
});
```

③ `loading` computed（~:512-523）：

```ts
const loading = computed(() => {
  if (props.entries.length === 0) return true;
  const r = visibleRange.value;
  if (r.end === 0) return true;
  const mm = measuredMap.value;
  if (!(mm instanceof Map)) return true;
  // 混排占位（2026-08-27）：可见区全是非图片（含 cover.jpg 目录，isMasonryImage 判定）
  // 时占位卡即内容（无需测量），不得永挂 spinner——只对图片条目判测量就绪
  let hasImageInRange = false;
  for (let i = r.start; i < r.end; i++) {
    const e = props.entries[i];
    if (!e) continue;
    if (!isMasonryImage(e)) continue;
    hasImageInRange = true;
    if (mm.has(e.path)) return false; // 有任意 measured 即加载完成
  }
  return hasImageInRange; // 窗口有图片且全未测量 → loading；窗口无图片 → false
});
```

- [ ] **步骤 4.4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：全 passed（含既有 atBottom/scrollToEntry/row-measured/frame 结构用例）。

- [ ] **步骤 4.5：Commit**

```bash
git add src/components/filebrowser/MasonryView.vue src/components/filebrowser/MasonryView.test.ts
git commit -m "feat(masonry): visibleItems 放开混排 + loading 只判图片条目（占位卡不永挂 spinner）"
```

---

### 任务 5：全量回归 + 实机验证 + 文档补记 + 预检推送

- [ ] **步骤 5.1：全量前端回归**

```bash
npm run type-check && npm test -- --run
```

预期：type-check 0 error；1224+N passed 0 fail（N = 新增用例数：任务 1 约 4 条 + 任务 2 约 5 条 + 任务 3 约 6 条 + 任务 4 约 4 条）。

- [ ] **步骤 5.2：实机 CDP 验证（dev 实例 9222）**

导航到含 Thumbs.db 的混排目录（如 WebDAV `Drive/wallpapers/normal`），断言：
1. 左上角 (0,0) 处是 Thumbs.db 占位卡（`.masonry-placeholder` + file 图标 + 名称），无空洞。
2. 图片卡正常渲染（row-measured 链不回归——已加载图即时进 measuredMap）。
3. loading spinner 不永挂（进目录后消失）。
4. 双击子目录占位卡 → 进目录；双击归档占位卡 → 进压缩包条目视图（复用 open 链路）。
5. 归档预载日志观察（自动化证据见步骤 5.1 的 useArchiveWindowPrefetch 7 用例；此项仅为运行时旁证）：远程目录滚动时 `main.log` 无 `[useArchiveWindowPrefetch] notifyArchiveWindow failed` 错误行。

- [ ] **步骤 5.3：AGENTS.md 补记（CRLF 文件单行锚点）**

3.0.6 行「**待打磨**（留后续）：像素级 scrollTop 锚定补偿、resolve in-flight cancel、hasImages 搜索态副作用、var(--ease-out) 残留」句尾追加：

```markdown
；混排占位已实现（2026-08-27 方案 B：isMasonryImage 统一谓词（类型标记优先于扩展名）+ 非图片 FileIcon 占位卡固定 16:9 高参与布局 + 双击复用 open 链路 + dimensionPrefetchPaths/缩略图 batch 滤非图片 + thumbnailWindows 保留归档供 useArchiveWindowPrefetch）
```

- [ ] **步骤 5.4：推送前预检（审查 P2）**

```bash
# 工作区干净（只含已提交状态，无本计划外的遗留改动）
git status --short
# 当前分支 = main
git branch --show-current
# 待推范围 = 本计划 5 个 commit（逐条目检，无他人/无关提交混入）
git log github/main..HEAD --oneline
```

预期：`git status --short` 无输出；分支 main；`github/main..HEAD` 恰为任务 1-5 的 commit。**任一不符 → 停下向用户报告，不推送。**

- [ ] **步骤 5.5：Commit + push**

```bash
git add AGENTS.md
git commit -m "docs: 补记瀑布流混排占位交付"
# 复查一次待推范围（现含文档 commit），确认后推送
git log github/main..HEAD --oneline
git push github main
```

---

## 自检记录

1. **规格覆盖度**：方案 B 占位卡（任务 3/4）、固定 16:9 高（任务 2）、双击复用 open 链路（任务 3 测试 + 任务 5 实机）、统一谓词六消费点（inputs/dimensionPrefetchPaths/缩略图 batch/placeholderType/thumbState/loading——任务 1 定义，任务 2/3/4 替换）、cover.jpg 目录测试贯穿四任务（mime 三态 / 布局固定高+窗口过滤 / folder 占位不渲染 spinner / loading 不永挂）、归档预载回归（任务 2 步骤 2.4 跑既有 7 用例 + 任务 5 日志旁证）、push 预检（任务 5 步骤 5.4）。browsePosition/useReaderActions 既有判定不动（工程师须知「勿动」条目）。
2. **占位符扫描**：全部步骤带完整可执行代码（二轮复审确认缩略图过滤测试已按 `setup`/`requestSpy` 既有基建落成真实用例，无骨架）；无 TODO/待定。
3. **类型一致性**：`isMasonryImage(e)`（任务 1 定义 `{name,isDirectory,isArchive}` 结构参数；MediaEntry 结构兼容，全部消费点传整 entry）；`PLACEHOLDER_ASPECT_RATIO`（任务 2 定义即消费）；`placeholderType/placeholderClass`（任务 3）；`layoutParams`（MasonryView.test 既有）；FileIcon `size` 默认 16 向后兼容（VirtualRow 零改动）。
