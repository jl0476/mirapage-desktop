# 大文件夹性能优化设计

> spec for `v0.1.0-module3.0.4-virtuallist` tag（tag 名用户审批时可调整；约定见 CLAUDE.md §5.1）

## 背景

### 现象

14949 个文件的目录打开后：
- **内存占用 2-3 GB**（任务管理器可见 `msedgewebview2.exe` PID 34544 占 1.5 GB）
- **hover 行卡、click 选卡、load 列表卡**；鼠标不在文件列表时不卡

### 实测根因（debug 实例 + `mcp__tauri-devtools__evaluate_script`）

| 测量 | 结果 | 含义 |
|---|---|---|
| 主动触发 200 次 mousemove 跨行 | avg 0.003 ms / max 0.1 ms / **0 longtask** | **JS 完全不卡** |
| 主动触发 60 帧滚动 | DOM 不变、frame 时间正常 | **滚动 JS 不卡** |
| DOM 节点数 | **194,485** | 14,949 `<li>` × 平均 13 嵌套元素 |
| `<ul>` scrollHeight | **427,114 px** | 14,949 行 × 29 px |
| 每行 innerHTML 字节 | 1808 × 14,949 ≈ **27 MB** | 静态 HTML 就占这么多 |
| JS heap | 167 MB | 还行 |
| FileList hover 链 | 纯 CSS `:hover`，**不进 JS**，**只 patch 当前 1 个 li** | Vue 重渲染范围极小 |
| FileList `markFor()` 行内调用 | 每行 **4-6 次**，每次 O(m) | 但这是渲染期成本 |

**结论**：JS hot path 不是瓶颈。**GPU 进程 rasterization 才是真凶**——Chromium 在 paint tree 里维护 194k DOM × 14949 SVG icon × 427k px scroll container。

### 影响范围

项目定位（CLAUDE.md）是漫画阅读器，**10k-30k 单目录文件**是典型场景（漫画文件夹/图库）。当前架构在 1k 文件以内可用，超过 5k 明显卡顿。

## 目标

| 目标 | 度量 |
|---|---|
| 10k-30k 单目录：内存 | ≤ 500 MB（当前 2-3 GB） |
| 10k-30k 单目录：hover/click | 无感（< 16 ms / frame） |
| 10k-30k 单目录：首屏渲染 | < 100 ms（当前 ~500 ms） |
| 1k 以内单目录 | 行为/性能不退化 |
| 现有功能 | 不破坏（搜索/排序/hideFinished/3 视图/键盘导航/选中状态） |

## 非目标（YAGNI）

- ❌ 全局/递归搜索（独立 feature，hotfix17 已删除旧全局搜索）
- ❌ 100k+ 文件场景（虚拟列表能扩展，本次不验证）
- ❌ 引入 `vue-virtual-scroller` 等运行时依赖（手写 ~80 行 composable）
- ❌ 动态行高 grid view 的精确滚动条 thumb（先固定 132 px）
- ❌ 编辑类功能（用户明确不做）

## 范围

### In-scope（本次实现）

1. `useVirtualList` composable（手写）
2. FileList 三视图统一虚拟化（list/grid/details）
3. viewMode 切换改为 CSS class 显隐（**DOM 复用**）
4. 算法层顺手修：markFor / iconType / selectRange / toggleSelection / readStatus / displayedEntries
5. 搜索兼容：scrollTop clamp + empty state + aria-rowcount
6. 键盘导航：方向键 / Home / End / PageUp / PageDown
7. a11y：aria-rowcount、aria-rowindex、role="grid"、focused row tabindex

### Out-of-scope（独立 feature / 模块）

- 全局搜索（涉及 library index、IPC、新 search 算法）
- 后端分页/流式（虚拟列表已能上 30k，分页留 100k+ 阶段）
- 编辑类功能
- 虚拟列表外的性能（如 reader 内部 OSD）

## 架构

### 抽 `useVirtualList` composable

```
src/composables/useVirtualList.ts
├─ useVirtualList(entries: Ref<readonly MediaEntry[]>, options: {
│     rowHeight: number | ((entry: MediaEntry) => number),
│     bufferSize?: number,  // 默认 5
│   })
├─ 返回:
│   ├─ containerRef: Ref<HTMLElement>          ← 滚动容器
│   ├─ contentRef:   Ref<HTMLElement>          ← 撑出 scrollHeight 的内层
│   ├─ visibleRange: { start, end }            ← 当前窗口 index 范围
│   ├─ visibleEntries: ComputedRef<Entry[]>    ← entries.slice(start, end + buffer)
│   ├─ totalHeight: ComputedRef<number>        ← 虚拟 scrollHeight
│   ├─ scrollToIndex(i, opts?: { align })       ← 滚动到指定 entry
│   └─ scrollToPath(path, opts?)               ← pathIndex → index → scrollToIndex
└─ 内部:
    ├─ ResizeObserver → viewportHeight
    ├─ scroll 事件 passive + rAF 节流 → scrollTop
    └─ watch(entries) → scrollTop clamp
```

**核心策略**（参考 `vue-virtual-scroller` 的 `RecycleScroller` 实现）：
- row 用 `position: absolute; transform: translateY(${rowIndex * rowHeight}px)`——只触发 composite，不触发 layout
- `scroll` 事件 passive + rAF 节流——避免每像素触发 Vue computed
- buffer（默认 5）——快速滚动不出空白

### FileList 改造（三视图统一收口）

```
FileList.vue
├─ props 不变: entries, marks, selectedPaths, viewMode, loading
├─ 用 useVirtualList(entries, { rowHeight: getRowHeight(viewMode) })
├─ 模板:
│   <div ref="containerRef" class="virt-container" :class="viewClass(viewMode)">
│     <div v-if="entries.length === 0" class="virt-empty">
│       <IconX /><span>{{ t('fileBrowser.empty') }}</span>
│     </div>
│     <div v-else ref="contentRef" class="virt-content"
│          :style="{ height: totalHeight + 'px' }">
│       <component
│         :is="VirtualRow"
│         v-for="(entry, i) in visibleEntries"
│         :key="entry.path"
│         :entry="entry"
│         :rowIndex="visibleRange.start + i"
│         :absoluteTop="(visibleRange.start + i) * resolvedRowHeight"
│         :marks="marks"
│         :selected="isSelected(entry)"
│         :viewMode="viewMode"
│         @click @dblclick @keydown @contextmenu ...
│       />
│     </div>
│   </div>
└─ VirtualRow 子组件（单组件 + 内部 v-if/viewMode 切模板; 或 3 子组件）
```

**关键变更**：
- 三 row 模板**同时挂载**（不再 v-if/v-else-if 切换销毁树）
- viewMode 通过 `:class="row-view-*"` + CSS `display:none/flex` 控制显隐
- 切换 viewMode 时**DOM 不重建**（保留滚动位置 + DOM 复用）

### store 侧变更（`fileBrowser.ts`）

```ts
// 新增 pathIndex computed
const pathIndex = computed<Map<string, number>>(() => {
  const m = new Map<string, number>();
  sortedEntries.value.forEach((e, i) => m.set(e.path, i));
  return m;
});

// selectRange 用 pathIndex 替代 indexOf ×2
function selectRange(from: string, to: string): void {
  const i = pathIndex.value.get(from);
  const j = pathIndex.value.get(to);
  if (i === undefined || j === undefined) return;
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  const next = new Set<string>();
  for (let k = lo; k <= hi; k++) next.add(sortedEntries.value[k].path);
  selectedPaths.value = next;
}

// scrollToPath action
function scrollToPath(path: string, opts?: { align?: 'start'|'center'|'end' }) {
  const i = pathIndex.value.get(path);
  if (i !== undefined) {
    // 通过事件或 callback 通知 FileList 滚动
    scrollToIndexCallback?.(i, opts);
  }
}
```

## 关键算法

### `useVirtualList` 内部

```ts
const visibleRange = computed(() => {
  const rh = resolvedRowHeight.value;  // 函数场景取首项估算
  const start = Math.max(0, Math.floor(scrollTop.value / rh) - bufferSize);
  const end = Math.min(
    entries.value.length,
    Math.ceil((scrollTop.value + viewportHeight.value) / rh) + bufferSize,
  );
  return { start, end };
});

const visibleEntries = computed(() =>
  entries.value.slice(visibleRange.value.start, visibleRange.value.end),
);

function scrollToIndex(i: number, opts?: { align?: 'start'|'center'|'end' }) {
  if (!containerRef.value) return;
  const rh = resolvedRowHeight.value;
  const vh = viewportHeight.value;
  let target = i * rh;
  if (opts?.align === 'center') target = i * rh - (vh - rh) / 2;
  if (opts?.align === 'end') target = i * rh - (vh - rh);
  containerRef.value.scrollTop = Math.max(0, Math.min(target, totalHeight.value - vh));
}

onMounted(() => {
  if (!containerRef.value) return;
  const ro = new ResizeObserver(() => {
    viewportHeight.value = containerRef.value!.clientHeight;
  });
  ro.observe(containerRef.value);
  // scroll + rAF 节流
  let rafId: number | null = null;
  containerRef.value.addEventListener('scroll', () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      scrollTop.value = containerRef.value!.scrollTop;
      rafId = null;
    });
  }, { passive: true });
  onUnmounted(() => {
    ro.disconnect();
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
});

// entries 变化 → clamp scrollTop
watch(entries, () => {
  nextTick(() => {
    if (!containerRef.value) return;
    const max = Math.max(0, totalHeight.value - viewportHeight.value);
    if (containerRef.value.scrollTop > max) {
      containerRef.value.scrollTop = max;
    }
    scrollTop.value = containerRef.value.scrollTop;
  });
}, { flush: 'post' });
```

### viewMode 切换（DOM 复用）

```vue
<!-- 三 row 同时挂载, CSS class 控制显隐 -->
<template>
  <div class="row-host" :class="['row-host-' + viewMode]" :style="positionStyle">
    <div v-if="viewMode === 'list'" class="row-view-list">...</div>
    <div v-else-if="viewMode === 'grid'" class="row-view-grid">...</div>
    <div v-else class="row-view-details">...</div>
  </div>
</template>

<style scoped>
.row-host {
  position: absolute;
  left: 0; right: 0;
  height: v-bind('rowHeight') + 'px';
  transform: translateY(v-bind('absoluteTop') + 'px');
  contain: layout style;  /* 减少 paint 影响 */
}
/* viewMode 切换: 隐藏其他视图, 显示当前 */
.row-host:not(.row-host-list) .row-view-list { display: none; }
.row-host:not(.row-host-grid) .row-view-grid { display: none; }
.row-host:not(.row-host-details) .row-view-details { display: none; }
</style>
```

### 边界 case

| 场景 | 处理 |
|---|---|
| `entries.length === 0` | totalHeight=0, visibleEntries=[], 渲染 empty state |
| `rowHeight` 函数返回 NaN/负数 | clamp 到最小 20 px |
| 容器 resize（窗口拉大/小） | ResizeObserver 触发 `viewportHeight` 重算 |
| 快速滚动 | scroll event passive + rAF 节流；bufferSize=5 |
| 切 viewMode | `rowHeight` 变 → totalHeight 重算；**DOM 不重建** |
| 切 viewMode scrollTop 超出新 totalHeight | watch(entries) 同款 clamp |
| 搜索结果空 | totalHeight=0 + empty state 内联 |
| 选中 path 不在新 entries（搜索过滤） | `scrollToPath` no-op；Set 保留 |
| ResizeObserver 不支持（极老 WebView） | feature detect + 兜底 `window.resize` |
| scroll container `display:none` | viewportHeight=0, visibleEntries=[]；重新可见时 ResizeObserver 触发 |

### a11y

```vue
<div ref="containerRef"
     role="grid"
     :aria-rowcount="entries.length"
     aria-label="文件列表">
  <div ref="contentRef" :style="{ height: totalHeight + 'px' }" role="presentation">
    <div role="row"
         :aria-rowindex="rowIndex + 1"
         :aria-selected="isSelected"
         :data-path="entry.path"
         tabindex="-1">
      <!-- 三视图模板同挂, CSS 显隐 -->
    </div>
  </div>
</div>
```

- 屏幕阅读器按 `aria-rowindex` 报告位置
- 虚拟化对 SR 透明（SR 只看到可见 row，按 DOM 顺序遍历）
- 键盘焦点管理：方向键移动焦点 row，`scrollToIndex(focusedIndex)`
- focused row 设 `tabindex=0`，其他 `-1`

## 顺手修的算法层问题

不增加改动面，**不引入虚拟列表也能受益**：

| 问题 | 位置 | 修复 | 行数 |
|---|---|---|---|
| `markFor` ×6 行内调用 | `FileList.vue` 多处 | 行子组件接收 `:mark="marks[path]"`（父预算好），模板里 `:class="mark"` | ~10 行 |
| `iconType`/`iconClass` 双计算 | `FileList.vue:96-111` | WeakMap 缓存 `entry._kind` | ~5 行 |
| `selectRange` 用 indexOf ×2 | `fileBrowser.ts:253-262` | pathIndex O(1) | ~5 行 |
| `toggleSelection` 拷贝整个 Set | `fileBrowser.ts:242-247` | in-place + `triggerRef` | ~5 行 |
| `readStatus.isFinished` O(m) | `readStatus.ts:76-84` | 内部维护 `finishedSet: Set<string>`，refresh 时一次性构建 | ~15 行 |
| `displayedEntries` 串联 3 O(n) | `FileBrowser.vue:78-84` | 合并到单次循环 | ~10 行 |

**总计**：虚拟列表 ~80 行 + 算法层 ~50 行 = **~130 行 net 代码**

## 搜索兼容（v0.1.0-module3.0.3-search）

### 关键确认

**虚拟列表与单目录搜索完全兼容**：
- `useVirtualList` 对 entries 输入域透明
- `searchFilter.filterByQuery` 仍在 `FileBrowser.displayedEntries` computed 里跑（**不动**）
- `useVirtualList` 只 slice 渲染

### 需加的边界处理

| 风险 | 缓解 |
|---|---|
| 14949 → 10 时 scrollTop 超限 → 空白 | `watch(entries) → scrollTop clamp`（已在 §`useVirtualList` 内部） |
| `aria-rowcount` 不同步 | 响应式绑 `entries.length` |
| empty state 位置 | FileList 容器内渲染（不在 FileBrowser 外） |
| 选中路径不在搜索结果 | `scrollToPath` no-op；Set 保留（用户清空搜索后恢复） |
| 搜索高频变化 | 已有 150ms debounce（hotfix17） |

### 不做什么

- ❌ 不改 `searchFilter.ts`
- ❌ 不改 `SearchInput.vue`
- ❌ 不改 `fileBrowser.searchQuery` 状态
- ❌ 不动 `displayedEntries` 搜索叠加逻辑

## 数据流

```
┌─ fileBrowser store ────────────────────────────────────────────┐
│ entries (Ref<MediaEntry[]>)            ← listDirectory IPC     │
│ sortField / sortAscending (Ref)         ← settings + dirSort   │
│ searchQuery (Ref)                       ← SearchInput debounce │
│ hideFinished (Ref)                      ← settings             │
│ pathIndex (computed: Map<path,index>)   ← 从 sortedEntries      │
│                                                                │
│ displayedEntries (computed):                                │
│   sortEntries(entries, effectiveSort)                            │
│   .filter(hideFinished ? not isFinished : true)                 │
│   .filter(filterByQuery(_, searchQuery))                        │
└────────────────────────────────────────────────────────────┬──┘
                                                              ↓
                  FileList.entries prop (响应式)
                                                              ↓
┌─ FileList.vue + useVirtualList composable ──────────────────┐
│ containerRef: <div class="virt-container"> ← 滚动容器    │
│ contentRef:   <div :style="{ height: totalHeight }">       │
│                                                               │
│ scrollTop (Ref)         ← scroll 事件 + rAF 节流            │
│ viewportHeight (Ref)    ← ResizeObserver                    │
│ visibleRange (computed)                                      │
│ visibleEntries (computed) ← entries.slice(start, end)        │
│                                                               │
│ <Row> × visibleEntries.length (~30-50)                      │
│   :style="{ transform: translateY(${absoluteTop}px) }"     │
│   :mark="marks[entry.path]"  ← 父预算 markFor, 模板里 1 次 │
│                                                               │
│ 三视图 row 同挂, CSS .row-view-list/grid/details 显隐       │
└─────────────────────────────────────────────────────────────┘
```

## 错误处理

| 场景 | 行为 | 兜底 |
|---|---|---|
| `containerRef` 未挂载调 `scrollToIndex` | no-op | early return |
| `entries.length === 0` | totalHeight=0, empty state 内联 | container 内 empty UI |
| `rowHeight` 函数 NaN/负数 | clamp 到 20 px | `Math.max(20, fn(entry))` |
| ResizeObserver 不支持 | 兜底 `window.resize` | feature detect |
| scroll container `display:none` | viewportHeight=0；重新可见时 ResizeObserver 触发 | |
| 极快速滚动出现空白 | bufferSize 默认 5 → 可调到 10 | trade 内存换体验 |
| `pathIndex` 找不到 path | `scrollToPath` no-op | 不报错 |
| 选中路径不在 viewport | `scrollToPath` 滚动到 | 自动 |
| grid 视图拖拽选中多行 | shift+click 走 pathIndex | 与 list/details 一致 |
| 切 viewMode scrollTop 超 new totalHeight | clamp | `watch(entries)` 同款 |
| 搜索中（debounce 150ms）切换目录 | abort：setRoot 清空 searchQuery | store 已有逻辑 |
| `displayedEntries` 抛错 | 沿用现有 try/catch | 不变 |

## 性能预算

| 操作 | 目标 | 实测基线（14949 entry） |
|---|---|---|
| 首次 mount 渲染 | < 100 ms（DOM 节点 < 5k） | 当前 ~500 ms |
| `scrollToIndex(i)` | < 5 ms | N/A |
| 单击切换选中（无 Ctrl） | < 16 ms（1 frame） | 0.003 ms（mousemove 类似路径） |
| Shift+Click 选 1000 行 | < 16 ms | pathIndex 后 ~5 ms |
| 搜索过滤（14949 → 10） | < 50 ms（含 clamp） | filterByQuery 自身 ~5 ms |
| 切 viewMode | < 50 ms（DOM 不重建） | 当前 ~200 ms |
| 键盘 PageDown 翻页 | < 16 ms | N/A |
| 内存占用（renderer 进程） | < 250 MB（14949 entry） | 当前 1.5 GB |
| 总内存（多进程） | < 500 MB | 当前 2-3 GB |

## 测试

### 单元（Vitest）

```
useVirtualList.test.ts
├─ visibleRange 边界 (start=0, end=N, mid)
├─ scrollToIndex 边界 (align=center/end/start, clamp)
├─ ResizeObserver 触发 viewportHeight 重算
├─ entries 引用变化 → scrollTop clamp
├─ 0 entries → empty state, totalHeight=0
├─ rowHeight 函数返回 NaN → 兜底 20 px
├─ aria-rowcount 同步 entries.length
└─ 三视图 row 同时挂载（DOM 复用）

fileBrowser.test.ts 增
├─ pathIndex 同步 sortedEntries
├─ selectRange 用 pathIndex 后顺序不变
└─ toggleSelection in-place（不拷贝 Set）

readStatus.test.ts 增
└─ finishedSet 缓存命中 vs 穿透

searchFilter.test.ts（已有）→ 不变
```

### 集成（Vitest + happy-dom）

```
FileList.test.ts 增
├─ 14949 mock entries → DOM <li> 数 < 100
├─ scrollTop=200000 → 切 10 entries → scrollTop=0
├─ viewMode 切换 → DOM 不重建（同一 row element 复用）
├─ 键盘 ArrowDown → focusedIndex=1 + scroll if needed
└─ 三视图 row 同时挂载 → DOM 节点数共享

FileBrowser.test.ts 增
└─ 搜索 + 选中 + 切视图组合
```

### E2E（debug 实例 + `mcp__tauri-devtools__evaluate_script`）

```
1. 打开 14949 文件目录 → DOM 节点数从 194k 降到 < 5k
2. 鼠标滑过 → GPU 进程 < 500 MB（之前 1.5 GB）
3. 搜索 → 14949 → 3 → scrollTop clamp 验证
4. 选中 1000 行 → UI 不卡
5. 键盘 PageDown 翻页 → focused row 正确
6. viewMode 切 grid → DOM 不重建
```

### 视觉回归

```
debug 实例截图:
├─ list 视图 选中态
├─ grid 视图 hover 态
├─ details 视图 多列宽
├─ 搜索过滤态（14949 → 3）
└─ empty 态（搜索无结果）

对比基线：v0.1.0-module3.0.3 当前 main
```

## 实施步骤（writing-plans 输入）

按依赖顺序拆分 6 个 PR，便于 review + 出问题回滚：

### Phase 1：算法层优化（独立 PR，可单独发布）
- `markFor` ×6 行内调用预算化（FileList 子组件接收 `:mark`）
- `iconType` WeakMap 缓存
- `selectRange` 用 `pathIndex`
- `toggleSelection` in-place + `triggerRef`
- `readStatus` `finishedSet` 缓存
- `displayedEntries` 单次循环合并
- **零虚拟列表变更，纯算法层**
- 预期收益：单次重渲 ~30%↓

### Phase 2：`useVirtualList` composable
- 新文件 `src/composables/useVirtualList.ts`
- 单元测试 `useVirtualList.test.ts`（7-8 case）
- 不集成到 FileList，纯 composable 独立可用

### Phase 3：FileList 集成虚拟列表
- FileList.vue 改造为虚拟容器
- 新增 `VirtualRow` 子组件（3 视图模板同挂）
- store 加 `pathIndex`
- FileBrowser 接入 `scrollToPath`
- FileList 测试（DOM 节点数 < 100）

### Phase 4：viewMode 切换 DOM 复用
- 三视图 row 同时挂载
- CSS class 显隐
- 测试：viewMode 切换 DOM 不重建

### Phase 5：键盘导航 + a11y
- FileList 容器 `@keydown` 拦截
- focused row tabindex 管理
- aria-rowcount / aria-rowindex / role="grid"
- 集成测试：键盘 ArrowDown 翻页

### Phase 6：搜索兼容 + 性能验证
- `useVirtualList` 内 `watch(entries)` clamp scrollTop
- FileList 容器内 empty state
- aria-rowcount 响应式
- E2E：debug 实例打开 14949 文件目录实测

### Phase 7：tag + release
- `v0.1.0-module3.0.4-virtuallist` tag
- GitHub Actions CI 通过
- 文档更新（CLAUDE.md 状态表 + BUILD.md §5.3）

## 关键文件路径

| 用途 | 路径 |
|---|---|
| 新 composable | `src/composables/useVirtualList.ts` |
| 新 composable 测试 | `src/composables/useVirtualList.test.ts` |
| 新 row 子组件 | `src/components/filebrowser/VirtualRow.vue` |
| FileList 改造 | `src/components/filebrowser/FileList.vue` |
| FileList 测试 | `src/components/filebrowser/FileList.test.ts` |
| store 改造 | `src/stores/fileBrowser.ts` |
| store 测试 | `src/stores/fileBrowser.test.ts` |
| readStatus 改造 | `src/stores/readStatus.ts` |
| readStatus 测试 | `src/stores/readStatus.test.ts` |
| i18n（empty state） | `src/locales/zh-CN.ts` / `src/locales/en-US.ts` |

## 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| rowHeight 函数对 grid 不准 | grid 先固定 132 px；后续可优化 |
| 切换 viewMode 滚动位置丢失 | 切前记录 scrollTop + currentPath，切后用 `scrollToPath` 恢复 |
| sticky header 与绝对定位 row 冲突 | `position: sticky` 挂在 `contentRef` 内（在 row 容器外） |
| Teleport tooltip 跨虚拟边界 | tooltip 是 fixed 位置，独立于 row 位置，不受影响 |
| 行选中状态跨虚拟边界丢失 | Vue 用 `:key="entry.path"` 复用 VNode，状态保留 |
| 14949 行实测不达预期 | Phase 6 验收门槛：DOM < 5k + 内存 < 500 MB |
| 后续 100k+ 场景 | 虚拟列表 composable 抽象稳定，可换 DynamicScroller 算法 |

## 关键决策记录

- **手写 vs 库**：选**手写** + 参考 `vue-virtual-scroller` 思路。100% 库引入不依赖、但 viewMode 切换问题它不解决。CLAUDE.md §1 偏向少依赖。
- **单目录搜索确认**：虚拟列表只 slice 渲染，对 `displayedEntries` 输入域透明。搜索范围维持**单目录、非递归**（hotfix17 设计）。
- **viewMode 切换 = DOM 复用**：v-if/v-else-if 销毁树 → 改三 row 同挂 + CSS 显隐。**这是用户"卡"的次要源头**。
- **不动 IPC 全量**：虚拟列表已能上 30k，分页/流式留 100k+ 阶段。
- **算法层顺手修**：用户报告"卡"，算法层 N² 也背一部分；不增加改动面一并修。

## 待用户审批

- [ ] 设计通过
- [ ] Phase 1 算法层优化是否独立成第一个 PR？（便于 review + 出问题回滚）
- [ ] tag 名 `v0.1.0-module3.0.4-virtuallist` 是否合适
- [ ] 是否接受"虚拟列表无完美适配 grid 动态行高，先固定 132 px"的折中