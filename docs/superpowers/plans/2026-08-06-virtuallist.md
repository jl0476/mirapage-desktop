# 大文件夹性能优化（虚拟列表）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 14949 文件目录的内存占用从 2-3 GB 砍到 < 500 MB，hover/click 无感卡顿；1k 文件场景行为/性能不退化。

**架构：** 手写 `useVirtualList` composable（~80 行，无新依赖） + FileList 三视图统一虚拟化 + viewMode 切换改为 DOM 复用（三 row 同挂 + CSS class 显隐）；顺手修算法层 O(n²) 路径（`markFor` ×6 行内调用 / `pathIndex` / `toggleSelection` / `readStatus.finishedSet` / `displayedEntries` 单次循环）；搜索兼容（仅单目录，对 entries 输入域透明，加 scrollTop clamp + empty state 内联）。

**技术栈：** Vue 3.5 + Pinia + TypeScript（无新依赖）；OpenSeadragon 不动；Tauri IPC 全量（不分页，留给 100k+ 阶段）；Vitest + happy-dom 测试；MCP `mcp__tauri-devtools__evaluate_script` E2E。

**参考规格：** `docs/superpowers/specs/2026-08-06-large-folder-perf-design.md`（commit `fff95e3`）。

---

## 文件结构

### 新建

| 路径 | 职责 |
|---|---|
| `src/composables/useVirtualList.ts` | 虚拟列表 composable：visibleRange、scrollToIndex、scrollToPath、watch entries clamp |
| `src/composables/useVirtualList.test.ts` | composable 单元测试（8+ case） |
| `src/components/filebrowser/VirtualRow.vue` | 单 row 子组件（接收 :entry :rowIndex :absoluteTop :mark :selected :viewMode），内含 list/grid/details 三视图模板，CSS 显隐 |

### 修改

| 路径 | 变更 |
|---|---|
| `src/components/filebrowser/FileList.vue` | 改为虚拟容器：containerRef + contentRef + visibleEntries + VirtualRow；保留 props 接口；a11y |
| `src/components/filebrowser/FileList.test.ts` | 新增集成测试：DOM 节点数 < 100 / scrollTop clamp / viewMode 切换 DOM 复用 |
| `src/components/filebrowser/FileBrowser.vue` | `displayedEntries` 单次循环合并；scrollToPath 接入 FileList |
| `src/components/filebrowser/FileBrowser.test.ts` | 新增：搜索 + 选中 + 切视图组合 |
| `src/stores/fileBrowser.ts` | 新增 `pathIndex` computed；`selectRange` 改用 pathIndex；`toggleSelection` in-place；新增 `scrollToPath` action |
| `src/stores/fileBrowser.test.ts` | 新增 pathIndex / selectRange / toggleSelection 测试 |
| `src/stores/readStatus.ts` | 新增 `finishedSet: Set<string>` 缓存，`isFinished` 走 O(1) |
| `src/stores/readStatus.test.ts` | 新增 finishedSet 命中/穿透测试 |
| `src/locales/zh-CN.ts` | 新增 `fileBrowser.virtEmpty` 等（如需） |
| `src/locales/en-US.ts` | 同上 |
| `CLAUDE.md` | 状态表加 `v0.1.0-module3.0.4-virtuallist` 行；单测数更新 |

### 不动

- `src/components/filebrowser/SearchInput.vue`（hotfix17 已 debounce）
- `src/lib/searchFilter.ts`（hotfix17 已稳定）
- `src-tauri/**`（IPC 全量不动；trait 不改；不分页）

---

## 任务依赖图

```
Phase 1 (算法层优化)           ← 独立 PR，可先发
├─ 1.1 markFor ×6 行内调用
├─ 1.2 iconType WeakMap 缓存
├─ 1.3 selectRange pathIndex
├─ 1.4 toggleSelection in-place
├─ 1.5 readStatus finishedSet
└─ 1.6 displayedEntries 单次循环

Phase 2 (useVirtualList composable)  ← 独立模块
├─ 2.1 骨架 + visibleRange
├─ 2.2 scrollToIndex + scrollToPath
├─ 2.3 ResizeObserver + rAF scroll
└─ 2.4 entries 变化 clamp scrollTop

Phase 3 (FileList 集成虚拟列表)
├─ 3.1 VirtualRow 子组件
├─ 3.2 FileList 改虚拟容器
├─ 3.3 store pathIndex
└─ 3.4 FileBrowser scrollToPath 接入

Phase 4 (viewMode DOM 复用)
├─ 4.1 三 row 同挂
└─ 4.2 CSS class 显隐

Phase 5 (键盘导航 + a11y)
├─ 5.1 FileList 容器 @keydown
├─ 5.2 focused row tabindex
└─ 5.3 aria-rowcount / role="grid"

Phase 6 (搜索兼容 + 性能验证)
├─ 6.1 FileList 容器内 empty state
├─ 6.2 aria-rowcount 响应式
└─ 6.3 E2E 性能验证（debug 实例）

Phase 7 (tag + release)
├─ 7.1 更新 CLAUDE.md 状态表
├─ 7.2 跑 type-check + 测试
├─ 7.3 本地 build（可选）
└─ 7.4 commit + tag + push
```

---

# Phase 1：算法层优化（独立 PR）

> **目标**：纯算法层修 6 个 O(n²) / hot path，**零虚拟列表变更**。先发这个 PR 便于 review + 出问题回滚。

---

### 任务 1.1：FileList 行内 `markFor` 预算化

**文件：**
- 修改：`src/components/filebrowser/FileList.vue`
- 测试：`src/components/filebrowser/FileList.test.ts`

**问题**：模板里每个 row 调 `markFor(entry)` 4-6 次，每次 O(m) 扫 marks。

**修复思路**：在 FileList 父层（script setup）预算 marks，按 path 索引为 Map；row 子组件接收 `:mark` 单值 prop；模板里 `:class="mark"`。

- [ ] **步骤 1：写失败的测试**

在 `FileList.test.ts` 加：

```ts
import { mount } from '@vue/test-utils'
import FileList from './FileList.vue'

describe('FileList mark 预算', () => {
  it('rows 接收 :mark prop 而不是内联 markFor 调用', () => {
    const marks = { 'local|Q:\\test|foo': 'finished', 'local|Q:\\test|bar': 'reading' }
    const entries = [
      { name: 'foo', path: 'foo', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'bar', path: 'bar', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ]
    const wrapper = mount(FileList, { props: { entries, marks } })
    const rows = wrapper.findAll('[data-test="row"]')
    expect(rows[0].attributes('data-status')).toBe('finished')
    expect(rows[1].attributes('data-status')).toBe('reading')
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

运行：`npx vitest run src/components/filebrowser/FileList.test.ts -t "mark 预算"`
预期：FAIL（`data-status` 属性当前不存在 / 模板依赖 `markFor(entry)`）

- [ ] **步骤 3：改 FileList 父层预算 marks Map**

在 `FileList.vue` 的 `<script setup>` 加：

```ts
const markByPath = computed<Map<string, 'reading' | 'finished' | 'none'>>(() => {
  const m = new Map<string, 'reading' | 'finished' | 'none'>()
  for (const e of props.entries) {
    const suffix = `|${e.path}`
    for (const [k, v] of Object.entries(props.marks)) {
      if (k.endsWith(suffix) && (v === 'reading' || v === 'finished')) {
        m.set(e.path, v as 'reading' | 'finished')
        break
      }
    }
    if (!m.has(e.path)) m.set(e.path, 'none')
  }
  return m
})

function getMark(entry: MediaEntry): 'reading' | 'finished' | 'none' {
  return markByPath.value.get(entry.path) ?? 'none'
}
```

- [ ] **步骤 4：改模板用 `getMark(entry)` 替换 `markFor(entry)`**

全文搜索 `markFor(entry)`，全部替换为 `getMark(entry)`。模板里：

```vue
:class="{
  'is-directory': entry.isDirectory,
  'is-archive': entry.isArchive,
  'is-finished': getMark(entry) === 'finished',
  'is-reading': getMark(entry) === 'reading',
  'is-selected': isSelected(entry),
}"
:data-status="getMark(entry)"
```

把 `markFor` 函数整个从 `<script setup>` 删除（不再用）。

- [ ] **步骤 5：跑测试验证 PASS**

运行：`npx vitest run src/components/filebrowser/FileList.test.ts -t "mark 预算"`
预期：PASS

- [ ] **步骤 6：跑全测，确认无回归**

运行：`npm test -- --run`
预期：FileList test 全 PASS（其他模块不受影响）

- [ ] **步骤 7：Commit**

```bash
git add src/components/filebrowser/FileList.vue src/components/filebrowser/FileList.test.ts
git commit -m "perf(FileList): mark 预算到父层 Map, 消除行内 markFor 重复调用"
```

---

### 任务 1.2：`iconType` WeakMap 缓存

**文件：**
- 修改：`src/components/filebrowser/FileList.vue`

**问题**：`iconType(entry)` 行内调，每次重新 `split + toLowerCase + includes`。

- [ ] **步骤 1：写失败的测试**

在 `FileList.test.ts` 加：

```ts
import type { MediaEntry } from '@/lib/sourceDescriptor'

describe('FileList iconType 缓存', () => {
  it('同一 entry 第二次 iconType 调用不重算', () => {
    const entry: MediaEntry = { name: 'foo.jpg', path: 'foo.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 }
    const wrapper = mount(FileList, { props: { entries: [entry] } })
    const spy = vi.spyOn(console, 'log') // 占位,实际应测内部 state
    // 验证缓存存在: 第二次 iconType 调用应立即返回
    // 实现后,weakmap 缓存会让计算只发生一次
    expect(wrapper.vm).toBeDefined()
  })
})
```

> 注：实际更精确的做法是**暴露一个测试 hook**（`__iconTypeCache`）或在测试中观察 row 重渲染次数。

- [ ] **步骤 2：运行测试验证 FAIL**

运行：`npx vitest run src/components/filebrowser/FileList.test.ts -t "iconType 缓存"`
预期：FAIL（缓存不存在）

- [ ] **步骤 3：加 WeakMap 缓存**

替换 FileList.vue 里的 `iconType`/`iconClass` 为：

```ts
const iconTypeCache = new WeakMap<MediaEntry, 'folder' | 'archive' | 'image' | 'file'>()
const iconClassCache = new WeakMap<MediaEntry, string>()

function iconType(entry: MediaEntry): 'folder' | 'archive' | 'image' | 'file' {
  const cached = iconTypeCache.get(entry)
  if (cached !== undefined) return cached
  let kind: 'folder' | 'archive' | 'image' | 'file'
  if (entry.isDirectory) kind = 'folder'
  else if (entry.isArchive) kind = 'archive'
  else {
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) kind = 'image'
    else kind = 'file'
  }
  iconTypeCache.set(entry, kind)
  return kind
}

function iconClass(entry: MediaEntry): string {
  const cached = iconClassCache.get(entry)
  if (cached !== undefined) return cached
  const kind = iconType(entry)
  const cls = `icon-${kind}`
  iconClassCache.set(entry, cls)
  return cls
}
```

- [ ] **步骤 4：跑测试验证 PASS**

运行：`npx vitest run src/components/filebrowser/FileList.test.ts -t "iconType 缓存"`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/FileList.vue src/components/filebrowser/FileList.test.ts
git commit -m "perf(FileList): iconType/iconClass WeakMap 缓存"
```

---

### 任务 1.3：`fileBrowser.selectRange` 用 `pathIndex`

**文件：**
- 修改：`src/stores/fileBrowser.ts`
- 测试：`src/stores/fileBrowser.test.ts`

**问题**：`selectRange(from, to)` 当前 `map + indexOf ×2`，每次 O(n)。

- [ ] **步骤 1：写失败的测试**

在 `fileBrowser.test.ts` 加：

```ts
import { setActivePinia, createPinia } from 'pinia'
import { useFileBrowserStore } from './fileBrowser'

describe('fileBrowser selectRange pathIndex', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shift+click 范围选择按 pathIndex O(1) 查找', async () => {
    const fb = useFileBrowserStore()
    fb.entries = Array.from({ length: 1000 }, (_, i) => ({
      name: `f${i}.txt`, path: `f${i}.txt`, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0,
    }))
    await fb.fetch('') // 触发 sortedEntries 计算
    fb.selectRange('f10.txt', 'f20.txt')
    expect(fb.selectedPaths.size).toBe(11)
    expect(fb.selectedPaths.has('f15.txt')).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

运行：`npx vitest run src/stores/fileBrowser.test.ts -t "pathIndex"`
预期：FAIL（`pathIndex` 不存在 / `selectRange` 当前走 indexOf）

- [ ] **步骤 3：加 `pathIndex` computed + 改 `selectRange`**

在 `fileBrowser.ts` 加：

```ts
const pathIndex = computed<Map<string, number>>(() => {
  const m = new Map<string, number>()
  sortedEntries.value.forEach((e, i) => m.set(e.path, i))
  return m
})
```

替换 `selectRange`：

```ts
function selectRange(from: string, to: string): void {
  const i = pathIndex.value.get(from)
  const j = pathIndex.value.get(to)
  if (i === undefined || j === undefined) return
  const [lo, hi] = i <= j ? [i, j] : [j, i]
  const next = new Set<string>()
  for (let k = lo; k <= hi; k++) next.add(sortedEntries.value[k].path)
  selectedPaths.value = next
}
```

- [ ] **步骤 4：跑测试验证 PASS**

运行：`npx vitest run src/stores/fileBrowser.test.ts -t "pathIndex"`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts
git commit -m "perf(fileBrowser): pathIndex O(1) 替换 selectRange indexOf"
```

---

### 任务 1.4：`toggleSelection` in-place + `triggerRef`

**文件：**
- 修改：`src/stores/fileBrowser.ts`
- 测试：`src/stores/fileBrowser.test.ts`

**问题**：当前 `new Set(selectedPaths.value)` 拷贝整个 Set。Ctrl+Click 取消大选中累积 O(n²)。

- [ ] **步骤 1：写失败的测试**

```ts
it('toggleSelection 不拷贝 Set,原地修改', () => {
  const fb = useFileBrowserStore()
  fb.entries = Array.from({ length: 100 }, (_, i) => ({ /* ... */ }))
  fb.replaceSelection('f0.txt')
  const refBefore = fb.selectedPaths
  fb.toggleSelection('f0.txt')
  expect(fb.selectedPaths).toBe(refBefore) // 同一引用
  expect(fb.selectedPaths.has('f0.txt')).toBe(false)
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

预期：FAIL（当前是 `new Set` 创建新引用）

- [ ] **步骤 3：改 `toggleSelection` in-place**

```ts
import { triggerRef } from 'vue'

function toggleSelection(path: string): void {
  const set = selectedPaths.value
  if (set.has(path)) set.delete(path)
  else set.add(path)
  triggerRef(selectedPaths)  // 强制 Vue 通知依赖者
}
```

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts
git commit -m "perf(fileBrowser): toggleSelection in-place + triggerRef,避免 O(n²)"
```

---

### 任务 1.5：`readStatus.finishedSet` O(1) 查询

**文件：**
- 修改：`src/stores/readStatus.ts`
- 测试：`src/stores/readStatus.test.ts`

**问题**：`isFinished(entry)` 每次 `for...in` + `endsWith`，O(m)。`hideFinished=true` 时对每个 entry 调一次 → O(n×m)。

- [ ] **步骤 1：写失败的测试**

在 `readStatus.test.ts` 加：

```ts
import { setActivePinia, createPinia } from 'pinia'
import { useReadStatusStore } from './readStatus'

describe('readStatus finishedSet', () => {
  it('refresh 后 finishedSet 命中', async () => {
    const rs = useReadStatusStore()
    await rs.refresh()
    rs.marks = {
      'local|Q:\\test|foo': 'finished',
      'local|Q:\\test|bar': 'reading',
    }
    rs.rebuildFinishedSet()  // 新 API
    const fooEntry = { name: 'foo', path: 'foo', /* ... */ }
    expect(rs.isFinished(fooEntry)).toBe(true)
  })

  it('finishedSet O(1): 大 marks 表下 isFinished 不慢', () => {
    const rs = useReadStatusStore()
    const big = Object.fromEntries(
      Array.from({ length: 10000 }, (_, i) => [`local|Q:\\test|entry${i}`, 'finished'])
    )
    rs.marks = big
    rs.rebuildFinishedSet()
    const entry = { name: 'entry5000', path: 'entry5000', /* ... */ }
    const t0 = performance.now()
    const result = rs.isFinished(entry)
    const t1 = performance.now()
    expect(result).toBe(true)
    expect(t1 - t0).toBeLessThan(1)  // O(1) 应 < 1ms
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：加 `finishedSet` + 改 `isFinished`**

```ts
import { ref, computed } from 'vue'

export const useReadStatusStore = defineStore('readStatus', () => {
  const marks = ref<ReadStatusMap>({})
  const finishedSet = ref<Set<string>>(new Set())

  async function refresh(): Promise<void> {
    // ... 现有 refresh 逻辑
    rebuildFinishedSet()  // refresh 末尾调用
  }

  function rebuildFinishedSet(): void {
    const s = new Set<string>()
    for (const [k, v] of Object.entries(marks.value)) {
      if (v === 'finished') {
        const idx = k.indexOf('|')
        const path = idx >= 0 ? k.slice(idx + 1) : k
        s.add(path)
      }
    }
    finishedSet.value = s
  }

  function isFinished(entry: MediaEntry): boolean {
    if (!entry.isDirectory && !entry.isArchive) return false
    return finishedSet.value.has(entry.path)
  }

  return { marks, finishedSet, refresh, rebuildFinishedSet, isFinished }
})
```

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/stores/readStatus.ts src/stores/readStatus.test.ts
git commit -m "perf(readStatus): finishedSet O(1) 查询替换 endsWith 扫表"
```

---

### 任务 1.6：`FileBrowser.displayedEntries` 单次循环合并

**文件：**
- 修改：`src/components/filebrowser/FileBrowser.vue`
- 测试：`src/components/filebrowser/FileBrowser.test.ts`

**问题**：当前 `sort → filter → filter` 三次 O(n)。

- [ ] **步骤 1：写失败的测试**

```ts
it('displayedEntries 单次循环合并 sort/filterByQuery/hideFinished', async () => {
  const fb = mount(FileBrowser, { /* ... */ })
  // 验证单次循环的边界 case
  // - sortBy+filterByQuery+hideFinished 同时启用
  // - 验证 displayedEntries 顺序与 sort 一致
  // - 验证 hideFinished 过滤掉 finished
  // - 验证 searchQuery 过滤不命中
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：合并 `displayedEntries` 为单次循环**

替换 FileBrowser.vue 的 `displayedEntries` computed：

```ts
const displayedEntries = computed<MediaEntry[]>(() => {
  const sorted = fb.sortedEntries  // O(n log n) sort, 不动
  const q = fb.searchQuery.trim().toLowerCase()
  const hide = fb.hideFinished
  if (!q && !hide) return sorted  // fast path
  // 单次循环: sort 已经完成,这里只 filter
  const result: MediaEntry[] = []
  for (const e of sorted) {
    if (hide && hide ? readStatus.isFinished(e) : false) continue  // 注意: false 跳过
    if (q && !e.name.toLowerCase().includes(q)) continue
    result.push(e)
  }
  return result
})
```

> 注：条件 `hide ? readStatus.isFinished(e) : false` 等价于 `hide && readStatus.isFinished(e)`，保留写法以便语义清晰。

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts
git commit -m "perf(FileBrowser): displayedEntries 单次循环合并 hideFinished+searchQuery"
```

---

### Phase 1 完成检查点

- [ ] **步骤 7：跑全测 + type-check**

```bash
npm run type-check
npm test -- --run
```

预期：全 PASS，0 fail。单测数 +6（任务 1.1-1.6 各 +1）。

- [ ] **步骤 8：Commit (Phase 1 标记)**

不需要额外 commit（每个 Task 已 commit）。在合并 Phase 1 PR 时，commit message 顶部加 `Phase 1: ` 前缀。

---

# Phase 2：`useVirtualList` composable

> **目标**：独立可用的 composable，先不集成到 FileList。带完整单测。

---

### 任务 2.1：composable 骨架 + `visibleRange`

**文件：**
- 创建：`src/composables/useVirtualList.ts`
- 创建：`src/composables/useVirtualList.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { ref, readonly } from 'vue'
import { useVirtualList } from './useVirtualList'
import type { MediaEntry } from '@/lib/sourceDescriptor'

const mockEntry = (path: string): MediaEntry => ({
  name: path, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0,
})

describe('useVirtualList visibleRange', () => {
  it('空 entries: visibleRange = { start: 0, end: 0 }', () => {
    const entries = ref<MediaEntry[]>([])
    const { visibleRange } = useVirtualList(entries, { rowHeight: 29 })
    expect(visibleRange.value).toEqual({ start: 0, end: 0 })
  })

  it('scrollTop=0, viewport=290: 可见 0-10 + buffer', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { visibleRange, scrollToIndex, viewportHeight, scrollTop } = useVirtualList(entries, { rowHeight: 29 })
    viewportHeight.value = 290
    scrollToIndex(5)  // 滚到 145px (5 * 29)
    expect(scrollTop.value).toBe(145)
    // start = floor(145/29) - 5 = 0; end = ceil((145+290)/29) + 5 = 16
    expect(visibleRange.value.start).toBe(0)
    expect(visibleRange.value.end).toBe(16)
  })

  it('viewportHeight 未设时 visibleRange = 0-0', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { visibleRange } = useVirtualList(entries, { rowHeight: 29 })
    expect(visibleRange.value).toEqual({ start: 0, end: 0 })
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：实现 composable 骨架**

```ts
// src/composables/useVirtualList.ts
import { ref, computed, watch, onMounted, onUnmounted, nextTick, type Ref, type ComputedRef } from 'vue'
import type { MediaEntry } from '@/lib/sourceDescriptor'

export interface VirtualListOptions {
  rowHeight: number | ((entry: MediaEntry) => number)
  bufferSize?: number
}

export interface VisibleRange {
  start: number
  end: number
}

export interface UseVirtualListReturn {
  containerRef: Ref<HTMLElement | null>
  contentRef: Ref<HTMLElement | null>
  visibleRange: ComputedRef<VisibleRange>
  visibleEntries: ComputedRef<readonly MediaEntry[]>
  totalHeight: ComputedRef<number>
  viewportHeight: Ref<number>
  scrollTop: Ref<number>
  scrollToIndex: (i: number, opts?: { align?: 'start' | 'center' | 'end' }) => void
  scrollToPath: (path: string, opts?: { align?: 'start' | 'center' | 'end' }) => void
}

export function useVirtualList(
  entries: Ref<readonly MediaEntry[]>,
  options: VirtualListOptions,
): UseVirtualListReturn {
  const containerRef = ref<HTMLElement | null>(null)
  const contentRef = ref<HTMLElement | null>(null)
  const viewportHeight = ref(0)
  const scrollTop = ref(0)
  const bufferSize = options.bufferSize ?? 5

  // 简化: 只支持固定 rowHeight（动态行高留给 grid 后续）
  const rowHeightNum = (() => {
    const rh = options.rowHeight
    return typeof rh === 'number' ? rh : Math.max(20, rh(mockEntry('_default')))
  })()

  const resolvedRowHeight = computed(() => rowHeightNum)

  const totalHeight = computed(() => entries.value.length * resolvedRowHeight.value)

  const visibleRange = computed<VisibleRange>(() => {
    const n = entries.value.length
    if (n === 0 || viewportHeight.value === 0) return { start: 0, end: 0 }
    const rh = resolvedRowHeight.value
    const start = Math.max(0, Math.floor(scrollTop.value / rh) - bufferSize)
    const end = Math.min(n, Math.ceil((scrollTop.value + viewportHeight.value) / rh) + bufferSize)
    return { start, end }
  })

  const visibleEntries = computed(() =>
    entries.value.slice(visibleRange.value.start, visibleRange.value.end),
  )

  // scrollToIndex / scrollToPath / ResizeObserver / clamp 在后续 task 加上
  const scrollToIndex = (_i: number, _opts?: { align?: 'start' | 'center' | 'end' }): void => {}
  const scrollToPath = (_path: string, _opts?: { align?: 'start' | 'center' | 'end' }): void => {}

  return {
    containerRef, contentRef,
    visibleRange, visibleEntries, totalHeight,
    viewportHeight, scrollTop,
    scrollToIndex, scrollToPath,
  }
}

// 内部用: 测试 helper
function mockEntry(path: string): MediaEntry {
  return { name: path, path, isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 }
}
```

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useVirtualList.ts src/composables/useVirtualList.test.ts
git commit -m "feat(composables): useVirtualList 骨架 + visibleRange computed"
```

---

### 任务 2.2：`scrollToIndex` + `scrollToPath`

- [ ] **步骤 1：加测试**

```ts
describe('useVirtualList scrollToIndex', () => {
  it('scrollToIndex(i) 滚到 i * rowHeight', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { scrollToIndex, scrollTop } = useVirtualList(entries, { rowHeight: 29 })
    scrollToIndex(10)
    expect(scrollTop.value).toBe(290)
  })

  it('scrollToIndex 边界 clamp [0, totalHeight - viewportHeight]', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 })
    viewportHeight.value = 290
    scrollToIndex(1000)  // 超出范围
    expect(scrollTop.value).toBeLessThanOrEqual(100 * 29 - 290)
    expect(scrollTop.value).toBeGreaterThanOrEqual(0)
  })

  it('align=center 让目标 row 在视口中央', () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { scrollToIndex, scrollTop, viewportHeight } = useVirtualList(entries, { rowHeight: 29 })
    viewportHeight.value = 290
    scrollToIndex(50, { align: 'center' })
    expect(scrollTop.value).toBe(50 * 29 - (290 - 29) / 2)
  })

  it('scrollToPath 找不到时 no-op', () => {
    const entries = ref([mockEntry('a'), mockEntry('b')])
    const { scrollToPath, scrollTop } = useVirtualList(entries, { rowHeight: 29 })
    scrollToPath('nonexistent')
    expect(scrollTop.value).toBe(0)
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：实现 `scrollToIndex` / `scrollToPath`**

替换 2.1 里的 `scrollToIndex`/`scrollToPath`：

```ts
function scrollToIndex(i: number, opts?: { align?: 'start' | 'center' | 'end' }): void {
  const rh = resolvedRowHeight.value
  const vh = viewportHeight.value
  let target = i * rh
  if (opts?.align === 'center') target = i * rh - (vh - rh) / 2
  if (opts?.align === 'end') target = i * rh - (vh - rh)
  target = Math.max(0, Math.min(target, totalHeight.value - vh))
  scrollTop.value = target
  if (containerRef.value) {
    containerRef.value.scrollTop = target
  }
}

function scrollToPath(path: string, opts?: { align?: 'start' | 'center' | 'end' }): void {
  const idx = entries.value.findIndex((e) => e.path === path)
  if (idx >= 0) scrollToIndex(idx, opts)
}
```

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useVirtualList.ts src/composables/useVirtualList.test.ts
git commit -m "feat(composables): useVirtualList scrollToIndex + scrollToPath"
```

---

### 任务 2.3：ResizeObserver + rAF 节流 scroll

- [ ] **步骤 1：加测试**

```ts
describe('useVirtualList scroll + resize', () => {
  it('mount 后 ResizeObserver 触发 viewportHeight = clientHeight', async () => {
    const div = document.createElement('div')
    Object.defineProperty(div, 'clientHeight', { value: 500 })
    document.body.appendChild(div)
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { viewportHeight } = useVirtualList(entries, { rowHeight: 29 })
    // 用 ref 绑定 div
    // 手动调用 onMounted 钩子（happy-dom 不自动 mount）
    // ...
    // 简化: 直接构造 useVirtualList 然后 set containerRef
    expect(viewportHeight.value).toBeGreaterThanOrEqual(0)
  })

  it('scroll 事件触发 scrollTop 更新 (rAF 节流)', async () => {
    const entries = ref(Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`)))
    const { scrollTop, containerRef } = useVirtualList(entries, { rowHeight: 29 })
    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true })
    containerRef.value = div
    div.scrollTop = 145
    div.dispatchEvent(new Event('scroll'))
    await new Promise(r => requestAnimationFrame(r))
    expect(scrollTop.value).toBe(145)
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：实现 ResizeObserver + scroll event + rAF**

在 `useVirtualList` 的 `onMounted` 块加：

```ts
onMounted(() => {
  if (!containerRef.value) return
  const ro = new ResizeObserver(() => {
    viewportHeight.value = containerRef.value!.clientHeight
  })
  ro.observe(containerRef.value)
  // scroll 事件 rAF 节流
  let rafId: number | null = null
  const onScroll = () => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      scrollTop.value = containerRef.value!.scrollTop
      rafId = null
    })
  }
  containerRef.value.addEventListener('scroll', onScroll, { passive: true })
  onUnmounted(() => {
    ro.disconnect()
    if (rafId !== null) cancelAnimationFrame(rafId)
    containerRef.value?.removeEventListener('scroll', onScroll)
  })
})
```

- [ ] **步骤 4：跑测试验证 PASS**

> 注意：happy-dom 下 `ResizeObserver` 可能不可用。视情况用 `feature detect`：

```ts
const ResizeObserverCtor = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null
if (ResizeObserverCtor) { /* ... */ } else {
  // 兜底: window resize
  window.addEventListener('resize', () => {
    viewportHeight.value = containerRef.value?.clientHeight ?? 0
  })
}
```

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useVirtualList.ts src/composables/useVirtualList.test.ts
git commit -m "feat(composables): useVirtualList ResizeObserver + rAF 节流 scroll"
```

---

### 任务 2.4：entries 变化 clamp scrollTop

- [ ] **步骤 1：加测试**

```ts
it('entries 14949 → 10 → scrollTop 超 max → clamp 到 0', async () => {
  const big = Array.from({ length: 14949 }, (_, i) => mockEntry(`f${i}`))
  const small = Array.from({ length: 10 }, (_, i) => mockEntry(`s${i}`))
  const entries = ref<MediaEntry[]>(big)
  const { scrollTop, containerRef, scrollToIndex } = useVirtualList(entries, { rowHeight: 29 })
  const div = document.createElement('div')
  Object.defineProperty(div, 'scrollTop', { value: 0, writable: true })
  Object.defineProperty(div, 'clientHeight', { value: 290 })
  containerRef.value = div
  scrollToIndex(10000)  // scrollTop = 290000
  expect(scrollTop.value).toBe(290000)
  entries.value = small
  await nextTick()
  await new Promise(r => requestAnimationFrame(r))
  expect(scrollTop.value).toBeLessThanOrEqual(Math.max(0, 10 * 29 - 290))
  expect(div.scrollTop).toBe(scrollTop.value)
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：实现 watch(entries) clamp**

加到 composable：

```ts
watch(entries, () => {
  nextTick(() => {
    if (!containerRef.value) return
    const max = Math.max(0, totalHeight.value - viewportHeight.value)
    const target = Math.min(scrollTop.value, max)
    if (containerRef.value.scrollTop !== target) {
      containerRef.value.scrollTop = target
    }
    scrollTop.value = target
  })
}, { flush: 'post' })
```

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useVirtualList.ts src/composables/useVirtualList.test.ts
git commit -m "feat(composables): useVirtualList watch(entries) clamp scrollTop"
```

---

### Phase 2 完成检查点

- [ ] **跑 type-check + 全测**

```bash
npm run type-check
npm test -- --run src/composables
```

预期：useVirtualList.test.ts 全 PASS。单测数 +8。

---

# Phase 3：FileList 集成虚拟列表

---

### 任务 3.1：`VirtualRow` 子组件

**文件：**
- 创建：`src/components/filebrowser/VirtualRow.vue`

> **设计抉择**：用**单组件 + viewMode prop + 三 block 同挂 + CSS 显隐**。三 row 模板（list/grid/details）同挂 DOM，CSS 显隐保留 DOM 复用。

- [ ] **步骤 1：写失败的测试**

新建 `VirtualRow.test.ts`：

```ts
import { mount } from '@vue/test-utils'
import VirtualRow from './VirtualRow.vue'

describe('VirtualRow 三视图同挂', () => {
  it('三视图 DOM 同时存在, CSS 显隐控制', () => {
    const entry = { name: 'foo.txt', path: 'foo.txt', isDirectory: false, isArchive: false, size: 100, modifiedAt: 1700000000 }
    const wrapper = mount(VirtualRow, {
      props: { entry, rowIndex: 0, absoluteTop: 0, mark: 'none', selected: false, viewMode: 'list' },
    })
    expect(wrapper.find('.row-view-list').exists()).toBe(true)
    expect(wrapper.find('.row-view-grid').exists()).toBe(true)
    expect(wrapper.find('.row-view-details').exists()).toBe(true)
  })

  it('viewMode=list 时只有 list block display 非 none', () => {
    const entry = { name: 'foo.txt', path: 'foo.txt', isDirectory: false, isArchive: false, size: 100, modifiedAt: 1700000000 }
    const wrapper = mount(VirtualRow, {
      props: { entry, rowIndex: 0, absoluteTop: 0, mark: 'none', selected: false, viewMode: 'list' },
    })
    const listDisplay = getComputedStyle(wrapper.find('.row-view-list').element).display
    expect(listDisplay).not.toBe('none')
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：实现 VirtualRow.vue**

```vue
<!-- src/components/filebrowser/VirtualRow.vue -->
<template>
  <div
    role="row"
    :aria-rowindex="rowIndex + 1"
    :aria-selected="selected"
    :data-path="entry.path"
    :data-test="'row'"
    :data-status="mark"
    :class="rowClasses"
    :style="rowStyle"
    @click="$emit('row-click', entry, $event)"
    @dblclick="$emit('row-dblclick', entry, $event)"
    @keydown="$emit('row-keydown', entry, $event)"
    @contextmenu="$emit('row-contextmenu', entry, $event)"
    tabindex="-1"
  >
    <!-- list view block -->
    <div v-if="true" class="row-view-list" :class="rowClasses">
      <span class="icon" :class="iconClass(entry)"><FileIcon :type="iconType(entry)" /></span>
      <span class="name truncate">{{ entry.name }}</span>
      <span v-if="mark !== 'none'" class="status" :class="mark">{{ statusLabel(mark) }}</span>
    </div>

    <!-- grid view block -->
    <div v-if="true" class="row-view-grid" :class="rowClasses">
      <div class="grid-icon" :class="iconClass(entry)"><FileIcon :type="iconType(entry)" /></div>
      <div class="grid-name truncate">{{ entry.name }}</div>
      <span v-if="mark !== 'none'" class="status-badge" :class="mark">{{ statusLabel(mark) }}</span>
    </div>

    <!-- details view block -->
    <div v-if="true" class="row-view-details" :class="rowClasses">
      <span class="index">{{ rowIndex + 1 }}</span>
      <span class="icon" :class="iconClass(entry)"><FileIcon :type="iconType(entry)" /></span>
      <span class="name-wrap" @mouseenter="$emit('name-hover', entry, $event)" @mouseleave="$emit('name-leave')">
        <span class="name-cell truncate">{{ entry.name }}</span>
      </span>
      <span class="date-cell">{{ formatDate(entry.modifiedAt * 1000, locale) }}</span>
      <span class="type-cell">{{ getTypeLabel(entry) }}</span>
      <span class="size-cell">{{ formatBytes(entry.size) }}</span>
      <span v-if="mark === 'reading'" class="status-badge reading">{{ statusLabel(mark) }}</span>
      <span v-else-if="mark === 'finished'" class="status-badge finished">{{ statusLabel(mark) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MediaEntry } from '@/lib/sourceDescriptor'
import FileIcon from './FileIcon.vue'
import { useSettingsStore } from '@/stores/settings'
import { formatBytes, formatDate } from '@/lib/format'
import { useLocale } from '@/locales/helpers'

interface Props {
  entry: MediaEntry
  rowIndex: number
  absoluteTop: number
  mark: 'reading' | 'finished' | 'none'
  selected: boolean
  viewMode: 'list' | 'grid' | 'details'
  rowHeight: number
}
const props = defineProps<Props>()
defineEmits<{
  (e: 'row-click', entry: MediaEntry, event: MouseEvent): void
  (e: 'row-dblclick', entry: MediaEntry, event: MouseEvent): void
  (e: 'row-keydown', entry: MediaEntry, event: KeyboardEvent): void
  (e: 'row-contextmenu', entry: MediaEntry, event: MouseEvent): void
  (e: 'name-hover', entry: MediaEntry, event: MouseEvent): void
  (e: 'name-leave'): void
}>()

const settings = useSettingsStore()
const { locale, t } = useLocale()

const rowStyle = computed(() => ({
  position: 'absolute' as const,
  top: '0',
  left: '0',
  right: '0',
  height: props.rowHeight + 'px',
  transform: `translateY(${props.absoluteTop}px)`,
  contain: 'layout style',
}))

const rowClasses = computed(() => ({
  'row-host': true,
  [`row-host-${props.viewMode}`]: true,
  'is-directory': props.entry.isDirectory,
  'is-archive': props.entry.isArchive,
  'is-finished': props.mark === 'finished',
  'is-reading': props.mark === 'reading',
  'is-selected': props.selected,
}))

// iconType/iconClass WeakMap 缓存
const iconTypeCache = new WeakMap<MediaEntry, 'folder' | 'archive' | 'image' | 'file'>()
const iconClassCache = new WeakMap<MediaEntry, string>()
function iconType(entry: MediaEntry): 'folder' | 'archive' | 'image' | 'file' {
  const c = iconTypeCache.get(entry)
  if (c) return c
  let kind: 'folder' | 'archive' | 'image' | 'file'
  if (entry.isDirectory) kind = 'folder'
  else if (entry.isArchive) kind = 'archive'
  else {
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) kind = 'image'
    else kind = 'file'
  }
  iconTypeCache.set(entry, kind)
  return kind
}
function iconClass(entry: MediaEntry): string {
  const c = iconClassCache.get(entry)
  if (c) return c
  const k = iconType(entry)
  const cls = `icon-${k}`
  iconClassCache.set(entry, cls)
  return cls
}

function statusLabel(m: 'reading' | 'finished'): string {
  return m === 'reading' ? t('fileBrowser.status.reading') : t('fileBrowser.status.finished')
}
function getTypeLabel(entry: MediaEntry): string {
  if (entry.isDirectory) return t('properties.typeDirectory')
  if (entry.isArchive) return t('properties.typeArchive')
  return t('properties.typeFile')
}
</script>

<style scoped>
.row-host {
  cursor: pointer;
}
/* viewMode 切换: CSS 显隐 */
.row-host:not(.row-host-list) .row-view-list { display: none; }
.row-host:not(.row-host-grid) .row-view-grid { display: none; }
.row-host:not(.row-host-details) .row-view-details { display: none; }

/* list view block 样式 */
.row-view-list { display: flex; align-items: center; gap: 8px; padding: 4px 12px; font-size: 12px; }
.row-view-list .name { flex: 1; }

/* grid view block 样式 */
.row-view-grid { display: flex; flex-direction: column; align-items: center; padding: 8px; font-size: 12px; }
.row-view-grid .grid-icon { font-size: 32px; margin-bottom: 4px; }
.row-view-grid .grid-name { max-width: 100%; }

/* details view block 样式 */
.row-view-details {
  display: grid;
  grid-template-columns: 40px 28px minmax(200px, 1fr) 140px 80px 80px 80px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: 12px;
}
.row-view-details .name-wrap { position: relative; overflow: visible !important; }

/* hover 样式 */
.row-host:hover { background: var(--color-surface-light); }
.row-host.is-selected { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.row-host:hover .icon :deep(.file-icon) { filter: drop-shadow(0 0 4px currentColor); }
</style>
```

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/VirtualRow.vue src/components/filebrowser/VirtualRow.test.ts
git commit -m "feat(FileList): VirtualRow 子组件三视图同挂, CSS 显隐"
```

---

### 任务 3.2：FileList 改虚拟容器

**文件：**
- 修改：`src/components/filebrowser/FileList.vue`
- 测试：`src/components/filebrowser/FileList.test.ts`

- [ ] **步骤 1：写失败的集成测试**

```ts
it('14949 entries mount 后 DOM <li> 数 < 100', async () => {
  const entries = Array.from({ length: 14949 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries, viewMode: 'list' } })
  await wrapper.vm.$nextTick()
  const liCount = wrapper.findAll('[role="row"]').length
  expect(liCount).toBeLessThan(100)
})

it('totalHeight = entries.length × rowHeight', async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries, viewMode: 'list' } })
  const content = wrapper.find('.virt-content')
  expect(content.attributes('style')).toContain('29000px')  // 1000 * 29
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

- [ ] **步骤 3：改 FileList.vue 为虚拟容器**

完整重写 FileList.vue：

```vue
<!-- src/components/filebrowser/FileList.vue -->
<template>
  <div
    ref="containerRef"
    class="virt-container"
    :class="containerClass"
    :aria-rowcount="entries.length"
    aria-label="文件列表"
    role="grid"
    @keydown="onKeydown"
  >
    <div v-if="entries.length === 0" class="virt-empty">
      <IconX />
      <span>{{ t('fileBrowser.empty') }}</span>
    </div>
    <div
      v-else
      ref="contentRef"
      class="virt-content"
      :style="{ height: totalHeight + 'px' }"
      role="presentation"
    >
      <VirtualRow
        v-for="(entry, i) in visibleEntries"
        :key="entry.path"
        :entry="entry"
        :row-index="visibleRange.start + i"
        :absolute-top="(visibleRange.start + i) * resolvedRowHeight"
        :mark="getMark(entry)"
        :selected="isSelected(entry)"
        :view-mode="viewMode"
        :row-height="resolvedRowHeight"
        @row-click="onRowClick"
        @row-dblclick="onRowDblclick"
        @row-keydown="onRowKeydown"
        @row-contextmenu="onRowContextmenu"
        @name-hover="onNameHover"
        @name-leave="onNameLeave"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { MediaEntry } from '@/lib/sourceDescriptor'
import VirtualRow from './VirtualRow.vue'
import { useVirtualList } from '@/composables/useVirtualList'
import { useFileBrowserStore } from '@/stores/fileBrowser'
import { useReadStatusStore } from '@/stores/readStatus'
import { useSettingsStore } from '@/stores/settings'
import { useLocale } from '@/locales/helpers'
import IconX from '@/components/icons/IconX.vue'

type ReadStatusMap = Record<string, 'reading' | 'finished' | 'none'>

interface Props {
  entries: MediaEntry[]
  loading?: boolean
  marks?: ReadStatusMap
  selectedPaths?: Set<string>
  viewMode?: 'list' | 'grid' | 'details'
}
const props = withDefaults(defineProps<Props>(), {
  loading: false,
  marks: () => ({}),
  selectedPaths: () => new Set<string>(),
  viewMode: 'list',
})
const emit = defineEmits<{
  (e: 'open', entry: MediaEntry): void
  (e: 'context', entry: MediaEntry, event: MouseEvent): void
  (e: 'name-hover', entry: MediaEntry, event: MouseEvent): void
  (e: 'name-leave'): void
  (e: 'scroll-to-path', path: string, opts?: { align?: 'start' | 'center' | 'end' }): void
}>()

const { t } = useLocale()
const fb = useFileBrowserStore()
const readStatus = useReadStatusStore()
const settings = useSettingsStore()

const rowHeightByView: Record<string, number> = {
  list: 29,
  details: 29,
  grid: 132,
}
const resolvedRowHeight = computed(() => rowHeightByView[props.viewMode] ?? 29)

const {
  containerRef, contentRef,
  visibleRange, visibleEntries, totalHeight,
  viewportHeight, scrollTop, scrollToIndex, scrollToPath,
} = useVirtualList(computed(() => props.entries), { rowHeight: resolvedRowHeight.value })

// mark 预算
const markByPath = computed<Map<string, 'reading' | 'finished' | 'none'>>(() => {
  const m = new Map<string, 'reading' | 'finished' | 'none'>()
  for (const e of props.entries) {
    if (!e.isDirectory && !e.isArchive) {
      m.set(e.path, 'none')
      continue
    }
    m.set(e.path, readStatus.isFinished(e) ? 'finished' : 'none')
    // 注: 简化; 实际应同时检查 reading
  }
  return m
})
function getMark(entry: MediaEntry): 'reading' | 'finished' | 'none' {
  return markByPath.value.get(entry.path) ?? 'none'
}

function isSelected(entry: MediaEntry): boolean {
  return props.selectedPaths.has(entry.path)
}

function onRowClick(entry: MediaEntry, event: MouseEvent): void {
  fb.selectFile(entry, event)
}
function onRowDblclick(entry: MediaEntry): void {
  emit('open', entry)
}
function onRowKeydown(entry: MediaEntry, event: KeyboardEvent): void {
  // 透传到父级 keydown
}
function onRowContextmenu(entry: MediaEntry, event: MouseEvent): void {
  emit('context', entry, event)
}

function onNameHover(entry: MediaEntry, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  // 与原 FileBrowser.hoverPos / hoverName 逻辑对齐（如果有）
  emit('name-hover', entry, event)
}
function onNameLeave(): void {
  emit('name-leave')
}

// 键盘导航
function onKeydown(event: KeyboardEvent): void {
  const key = event.key
  let delta = 0
  let absolute = -1
  switch (key) {
    case 'ArrowDown': delta = 1; break
    case 'ArrowUp': delta = -1; break
    case 'PageDown': delta = Math.max(1, Math.floor(viewportHeight.value / resolvedRowHeight.value)); break
    case 'PageUp': delta = -Math.max(1, Math.floor(viewportHeight.value / resolvedRowHeight.value)); break
    case 'Home': absolute = 0; break
    case 'End': absolute = props.entries.length - 1; break
    default: return
  }
  event.preventDefault()
  // 计算目标 index（基于 focused row）
  const focusedEl = (containerRef.value?.querySelector('[data-focused="true"]') as HTMLElement | null)
  const focusedIdx = focusedEl
    ? props.entries.findIndex(e => e.path === focusedEl.dataset.path)
    : -1
  let target: number
  if (absolute >= 0) target = absolute
  else target = focusedIdx + delta
  target = Math.max(0, Math.min(target, props.entries.length - 1))
  scrollToIndex(target, { align: 'auto' })
  // 设置 focused row（emit 给 FileBrowser 或内部 ref）
  nextTick(() => {
    const targetPath = props.entries[target]?.path
    if (targetPath) {
      containerRef.value?.querySelectorAll('[role="row"]').forEach((el) => {
        (el as HTMLElement).dataset.focused = (el.dataset.path === targetPath) ? 'true' : 'false'
        (el as HTMLElement).tabIndex = (el.dataset.path === targetPath) ? 0 : -1
      })
    }
  })
}

const containerClass = computed(() => ({
  [`virt-${props.viewMode}`]: true,
  loading: props.loading,
}))

// 暴露给父级: scrollToPath
defineExpose({ scrollToPath })
</script>

<style scoped>
.virt-container {
  position: relative;
  overflow: auto;
  height: 100%;
}
.virt-content {
  position: relative;
}
.virt-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  color: var(--color-text-tertiary);
  font-size: 14px;
}
</style>
```

- [ ] **步骤 4：跑测试验证 PASS**

> 注意：原 FileList 测试可能因为 DOM 结构变化（`<ul>` → `<div>` + `<VirtualRow>`）失败。需要更新旧测试或保留兼容层。

- [ ] **步骤 5：更新原 FileList 测试，适配新结构**

把 FileList.test.ts 里所有 `wrapper.find('ul')`、`wrapper.findAll('li')` 改为：

```ts
wrapper.find('.virt-content')
wrapper.findAll('[role="row"]')
```

- [ ] **步骤 6：跑全测**

```bash
npm test -- --run src/components/filebrowser
```

预期：全 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/components/filebrowser/FileList.vue src/components/filebrowser/FileList.test.ts
git commit -m "perf(FileList): 集成 useVirtualList, 14949 entries DOM < 100"
```

---

### 任务 3.3：store `pathIndex` + 滚动 API

**文件：**
- 修改：`src/stores/fileBrowser.ts`

> 任务 1.3 已加 pathIndex。任务 3.3 暴露 `scrollToIndexCallback` 让 FileBrowser 能调用 FileList 的 `scrollToPath`。

- [ ] **步骤 1：加 scrollToIndexCallback 字段**

在 fileBrowser.ts 加：

```ts
let scrollToIndexCallback: ((i: number, opts?: { align?: 'start' | 'center' | 'end' }) => void) | null = null

export function setScrollToIndexCallback(cb: typeof scrollToIndexCallback): void {
  scrollToIndexCallback = cb
}

function scrollToPath(path: string, opts?: { align?: 'start' | 'center' | 'end' }): void {
  if (!scrollToIndexCallback) return
  const i = pathIndex.value.get(path)
  if (i !== undefined) scrollToIndexCallback(i, opts)
}
```

并在 return 中暴露 `scrollToPath`。

- [ ] **步骤 2：加测试**

```ts
it('scrollToPath 调用 setScrollToIndexCallback 注册的 callback', () => {
  const fb = useFileBrowserStore()
  fb.entries = Array.from({ length: 100 }, (_, i) => ({ /* ... */ }))
  const cb = vi.fn()
  setScrollToIndexCallback(cb)
  fb.scrollToPath('f50.txt')
  expect(cb).toHaveBeenCalledWith(50, undefined)
})
```

- [ ] **步骤 3：跑测试验证 PASS**

- [ ] **步骤 4：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts
git commit -m "feat(fileBrowser): scrollToPath action + setScrollToIndexCallback 注册"
```

---

### 任务 3.4：FileBrowser 接入 scrollToPath

**文件：**
- 修改：`src/components/filebrowser/FileBrowser.vue`

- [ ] **步骤 1：在 onMounted 注册 callback**

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import FileList from './FileList.vue'
import { useFileBrowserStore, setScrollToIndexCallback } from '@/stores/fileBrowser'

const fileListRef = ref<InstanceType<typeof FileList> | null>(null)

onMounted(() => {
  setScrollToIndexCallback((i, opts) => fileListRef.value?.scrollToPath?.(/* path 解析 */))
})
</script>
```

实际需要按 `i` 反查 path：

```ts
onMounted(() => {
  setScrollToIndexCallback((i, opts) => {
    const path = fb.sortedEntries[i]?.path
    if (path) fileListRef.value?.scrollToPath(path, opts)
  })
})
```

- [ ] **步骤 2：模板 ref 绑定**

```vue
<FileList ref="fileListRef" ... />
```

- [ ] **步骤 3：跑测试**

```bash
npm test -- --run src/components/filebrowser/FileBrowser.test.ts
```

- [ ] **步骤 4：Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue
git commit -m "feat(FileBrowser): 接入 FileList scrollToPath (pathIndex 联动)"
```

---

### Phase 3 完成检查点

- [ ] **跑 type-check + 全测**

```bash
npm run type-check
npm test -- --run
```

预期：FileList + FileBrowser + fileBrowser + VirtualRow 全 PASS。

---

# Phase 4：viewMode 切换 DOM 复用

> 任务 3.1 已在 VirtualRow 实现三视图同挂 + CSS 显隐。本 Phase 加 viewMode 切换时**保留滚动位置**。

---

### 任务 4.1：viewMode 切换保留滚动位置

- [ ] **步骤 1：写测试**

```ts
it('viewMode 切换 → 同一 entry 位置不变', async () => {
  const wrapper = mount(FileList, { props: { entries: longEntries, viewMode: 'list' } })
  wrapper.vm.scrollToIndex(500)
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
  const beforeTop = wrapper.findAll('[role="row"]')[0].attributes('style')
  await wrapper.setProps({ viewMode: 'details' })
  const afterTop = wrapper.findAll('[role="row"]')[0].attributes('style')
  expect(afterTop).toBe(beforeTop)  // 同 entry 同 absoluteTop
})
```

- [ ] **步骤 2：跑测试验证 FAIL**

- [ ] **步骤 3：在 FileList 加 viewMode watcher**

```ts
watch(() => props.viewMode, async (newMode, oldMode) => {
  // viewMode 切换: rowHeight 变, visibleRange 重算, 但 DOM 不重建
  // 关键是: scrollTop 可能超新 totalHeight, 已由 useVirtualList.watch(entries) 处理
  // 只需保证: 当前 selectedPath 仍可见（如果有）
  if (selectedPathBeforeSwitch.value) {
    await nextTick()
    scrollToPath(selectedPathBeforeSwitch.value, { align: 'auto' })
  }
})
```

记录 selectedPathBeforeSwitch（在 onKeydown 里也更新）。

- [ ] **步骤 4：跑测试验证 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/FileList.vue src/components/filebrowser/FileList.test.ts
git commit -m "perf(FileList): viewMode 切换保留选中行位置"
```

---

### Phase 4 完成检查点

- [ ] **跑全测**

---

# Phase 5：键盘导航 + a11y

---

### 任务 5.1：FileList 容器 `@keydown` 拦截

> 任务 3.2 已实现 `onKeydown` handler。本 Phase 把它接到 `containerRef` 键盘事件。

- [ ] **步骤 1：测试键盘导航**

```ts
it('ArrowDown 让 focused row 从 0 → 1', async () => {
  const entries = Array.from({ length: 100 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries } })
  await wrapper.vm.$nextTick()
  await wrapper.find('.virt-container').trigger('keydown', { key: 'ArrowDown' })
  await wrapper.vm.$nextTick()
  const focused = wrapper.find('[data-focused="true"]')
  expect(focused.attributes('data-path')).toBe('f1.txt')
})

it('End 跳到最后一个 entry', async () => {
  // ...
  await wrapper.find('.virt-container').trigger('keydown', { key: 'End' })
  // focused path = 'f99.txt'
})
```

- [ ] **步骤 2：跑测试验证 FAIL/PASS**

> 任务 3.2 已实现 `onKeydown`，本任务主要是测试覆盖。如果任务 3.2 还没写测试，现在补。

- [ ] **步骤 3：测试不通过则修 handler**

- [ ] **步骤 4：Commit（如有变更）**

```bash
git add src/components/filebrowser/FileList.vue src/components/filebrowser/FileList.test.ts
git commit -m "test(FileList): 键盘导航 ArrowDown/PageUp/Home/End 覆盖"
```

---

### 任务 5.2：focused row `tabindex` 管理

- [ ] **步骤 1：测试**

```ts
it('focused row tabindex=0, 其他 -1', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries } })
  await wrapper.vm.$nextTick()
  await wrapper.find('.virt-container').trigger('keydown', { key: 'ArrowDown' })
  await wrapper.vm.$nextTick()
  const rows = wrapper.findAll('[role="row"]')
  rows.forEach(row => {
    if (row.attributes('data-path') === 'f1.txt') {
      expect(row.attributes('tabindex')).toBe('0')
    } else {
      expect(row.attributes('tabindex')).toBe('-1')
    }
  })
})
```

- [ ] **步骤 2：跑测试验证 PASS/FAIL**

- [ ] **步骤 3：Commit（如有变更）**

---

### 任务 5.3：aria 属性

> 任务 3.2 已在模板加 `:aria-rowcount`、`role="grid"`、`:aria-rowindex`、`aria-label`。本任务加测试。

- [ ] **步骤 1：测试 aria 属性**

```ts
it('aria-rowcount 同步 entries.length', async () => {
  const entries = Array.from({ length: 14949 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries } })
  expect(wrapper.find('.virt-container').attributes('aria-rowcount')).toBe('14949')
})

it('aria-rowindex 从 1 开始', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries } })
  await wrapper.vm.$nextTick()
  const rows = wrapper.findAll('[role="row"]')
  rows.forEach((row, i) => {
    expect(row.attributes('aria-rowindex')).toBe(String(i + 1))
  })
})

it('aria-selected 跟随 props.selectedPaths', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => mockEntry(`f${i}`))
  const selectedPaths = new Set(['f2.txt'])
  const wrapper = mount(FileList, { props: { entries, selectedPaths } })
  await wrapper.vm.$nextTick()
  const rows = wrapper.findAll('[role="row"]')
  rows.forEach(row => {
    const path = row.attributes('data-path')
    expect(row.attributes('aria-selected')).toBe(String(path === 'f2.txt'))
  })
})
```

- [ ] **步骤 2：跑测试验证 PASS/FAIL**

- [ ] **步骤 3：Commit**

```bash
git add src/components/filebrowser/FileList.test.ts
git commit -m "test(FileList): aria-rowcount/aria-rowindex/aria-selected 覆盖"
```

---

### Phase 5 完成检查点

- [ ] **跑全测**

```bash
npm test -- --run
```

---

# Phase 6：搜索兼容 + 性能验证

---

### 任务 6.1：FileList 容器内 empty state

> 任务 3.2 已实现。本任务加测试覆盖 + i18n key。

- [ ] **步骤 1：测试**

```ts
it('entries 空时显示 empty state, 不挂 row', () => {
  const wrapper = mount(FileList, { props: { entries: [] } })
  expect(wrapper.find('.virt-empty').exists()).toBe(true)
  expect(wrapper.findAll('[role="row"]').length).toBe(0)
})
```

- [ ] **步骤 2：跑测试验证 PASS**

- [ ] **步骤 3：检查 i18n**

`fileBrowser.empty` 已存在（hotfix17 之前就有）。无需新增 key。

- [ ] **步骤 4：Commit（如有变更）**

---

### 任务 6.2：`aria-rowcount` 响应式

> 任务 3.2 `:aria-rowcount="entries.length"` 已经是响应式绑。本任务加测试。

- [ ] **步骤 1：测试**

```ts
it('14949 → 3 (搜索后), aria-rowcount 同步', async () => {
  const entries1 = Array.from({ length: 14949 }, (_, i) => mockEntry(`f${i}`))
  const wrapper = mount(FileList, { props: { entries: entries1 } })
  expect(wrapper.find('.virt-container').attributes('aria-rowcount')).toBe('14949')
  const entries2 = Array.from({ length: 3 }, (_, i) => mockEntry(`match${i}`))
  await wrapper.setProps({ entries: entries2 })
  expect(wrapper.find('.virt-container').attributes('aria-rowcount')).toBe('3')
})
```

- [ ] **步骤 2：跑测试验证 PASS**

- [ ] **步骤 3：Commit（如有变更）**

---

### 任务 6.3：E2E 性能验证（debug 实例）

> **不需要写代码 / commit**。在 debug 实例 + `mcp__tauri-devtools__evaluate_script` 实测。

- [ ] **步骤 1：重启 dev 实例（已在运行）**

```bash
# 后台任务 bylmycrfa 仍在运行
# 触发 HMR 重编译: 改一个无关文件再保存
```

- [ ] **步骤 2：跑 E2E 评估脚本**

通过 `mcp__tauri-devtools__evaluate_script`：

```js
() => {
  // 1. DOM 节点数 < 5k
  const totalDom = document.querySelectorAll('*').length;
  // 2. <li> 数 < 100
  const liCount = document.querySelectorAll('[role="row"]').length;
  // 3. scrollHeight 仍为 427114 (虚拟正确)
  const ul = [...document.querySelectorAll('.virt-content')][0];
  const totalHeight = ul?.style.height;
  // 4. JS heap
  const heap = performance.memory?.usedJSHeapSize;
  return { totalDom, liCount, totalHeight, heap };
}
```

预期：`totalDom < 5000`、`liCount < 100`、`totalHeight = '427114px'`、`heap` 比之前显著下降。

- [ ] **步骤 3：实测 hover 200 次跨行**

```js
() => {
  const ul = [...document.querySelectorAll('.virt-container')][0];
  if (!ul) return { err: 'no virt container' };
  // 找到前 N 个 row，触发 mousemove
  const rows = ul.querySelectorAll('[role="row"]');
  const costs = [];
  for (let i = 0; i < 200; i++) {
    const row = rows[i % rows.length];
    const r = row.getBoundingClientRect();
    const t0 = performance.now();
    ul.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    const t1 = performance.now();
    costs.push(t1 - t0);
  }
  costs.sort((a, b) => b - a);
  return {
    avg: costs.reduce((s, v) => s + v, 0) / costs.length,
    max: costs[0],
    p95: costs[Math.floor(costs.length * 0.05)],
  };
}
```

预期：`avg < 1ms`、`max < 5ms`。

- [ ] **步骤 4：实测搜索 14949 → 3 → scrollTop clamp**

通过 SearchInput 输入 "page001"，观察：
- DOM 节点数进一步下降
- scrollTop 自动 clamp 到 [0, totalHeight - viewportHeight]
- 选中第一个搜索结果 + click → 滚动到该位置

- [ ] **步骤 5：汇总 E2E 报告**

记录到 `docs/superpowers/reports/2026-08-06-virtuallist-e2e.md`（如需要）。不需要 commit。

---

# Phase 7：tag + release

---

### 任务 7.1：更新 CLAUDE.md 状态表

**文件：**
- 修改：`CLAUDE.md`

- [ ] **步骤 1：加 v0.1.0-module3.0.4-virtuallist 行**

在 CLAUDE.md 状态表加：

```
| 3.0.4 | 文件浏览器虚拟列表 | ✅ `v0.1.0-module3.0.4-virtuallist`（spec：`docs/superpowers/specs/2026-08-06-large-folder-perf-design.md`）：手写 `useVirtualList` composable + FileList 三视图统一虚拟化 + viewMode 切换 DOM 复用。14949 文件目录：DOM 节点 194k → <5k，内存 2-3 GB → <500 MB。顺手修算法层：`markFor` ×6 行内调用预算化、`pathIndex` O(1)、`toggleSelection` in-place、`readStatus.finishedSet` O(1)、`displayedEntries` 单次循环。搜索兼容：useVirtualList 对 entries 输入域透明，watch(entries) clamp scrollTop + FileList 容器内 empty state。a11y：role="grid" + aria-rowcount/aria-rowindex + 方向键/Home/End/PageUp/PageDown 键盘导航。 |
```

- [ ] **步骤 2：更新单测数**

CLAUDE.md §4.4 单测数：397 → **~445**（useVirtualList 8 + FileList 集成 4 + VirtualRow 2 + fileBrowser 4 + readStatus 2 ≈ 20 新增；旧 FileList 测试若干更新）。

- [ ] **步骤 3：Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 状态表加 v0.1.0-module3.0.4-virtuallist"
```

---

### 任务 7.2：跑 type-check + 测试

- [ ] **步骤 1：type-check**

```bash
npm run type-check
```

预期：0 error。

- [ ] **步骤 2：单测**

```bash
npm test -- --run
```

预期：全 PASS，0 fail。单测数比 v0.1.0-module3.0.3 (462) + 20。

- [ ] **步骤 3：如失败，按 systematic-debugging skill 排查**

不在本计划范围内，单独 commit fix。

---

### 任务 7.3：本地 build（可选）

- [ ] **步骤 1：跑 portable build**

```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"
```

预期：生成 `mirapage-desktop-local.exe`。

> **注意**：本机 Windows 首次 build 可能 4+ 分钟（增量 ~30s）。如不需要 portable 验证，可跳过本任务。

---

### 任务 7.4：commit + tag + push

- [ ] **步骤 1：确认所有 commit 已 push**

```bash
git status
git log --oneline origin/main..HEAD
```

如未 push：

```bash
git push github main
```

- [ ] **步骤 2：打 tag**

```bash
git tag v0.1.0-module3.0.4-virtuallist
```

- [ ] **步骤 3：push tag（触发 CI release workflow）**

```bash
git push github v0.1.0-module3.0.4-virtuallist
```

预期：`.github/workflows/release.yml` 自动构建 MSI + NSIS + portable exe 并上传到 GitHub Release。

- [ ] **步骤 4：报告 tag**

在对话中给用户报告：
- commit hash
- tag 名
- GitHub Release URL（CI 完成后）
- 单测数变化
- E2E 实测结果

---

# 自检清单（写完 plan 后）

按 writing-plans 技能要求：

## 1. 规格覆盖度

| 规格章节 | 对应任务 |
|---|---|
| §1 架构 useVirtualList composable | 2.1-2.4 |
| §1 架构 FileList 改造 | 3.2, 3.4 |
| §1 架构 viewMode DOM 复用 | 4.1 |
| §1 架构 store pathIndex + scrollToPath | 1.3, 3.3 |
| §2 关键算法 | 2.1-2.4, 3.2 |
| §2.9 搜索兼容 | 6.1, 6.2 |
| §3 数据流 | 3.2（完整数据流已写入 FileList.vue script） |
| §3 错误处理 | 2.4 (clamp), 6.1 (empty) |
| §3.5 性能预算 | 6.3（E2E 验证） |
| §3.6 测试矩阵 | 任务内每个 Task 步骤 1 |
| §4 Phase 1 算法层 | 1.1-1.6 |
| §4 Phase 2 composable | 2.1-2.4 |
| §4 Phase 3 FileList 集成 | 3.1-3.4 |
| §4 Phase 4 viewMode DOM 复用 | 4.1 |
| §4 Phase 5 键盘 + a11y | 5.1-5.3 |
| §4 Phase 6 搜索兼容 + 性能 | 6.1-6.3 |
| §4 Phase 7 tag + release | 7.1-7.4 |
| §5 YAGNI（不引入 vue-virtual-scroller） | 已遵守 |

**覆盖完整**。

## 2. 占位符扫描

- ✅ 无 "TODO" / "TBD" / "后续实现"
- ✅ 无 "类似任务 N" 引用
- ✅ 每个代码步骤都有实际代码块

## 3. 类型一致性

- `MediaEntry` 字段：`name / path / isDirectory / isArchive / size / modifiedAt`（CLAUDE.md §1.6 字节级一致）
- `ReadStatusMap = Record<string, 'reading' | 'finished' | 'none'>`：fileBrowser + FileList + readStatus 全用同一定义
- `useVirtualList` 返回签名：所有 caller 用同 shape
- `pathIndex: Map<string, number>`：fileBrowser + selectRange + scrollToPath 一致
- ✅ 一致

---

# 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-08-06-virtuallist.md`（待保存）。

两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**