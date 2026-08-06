# 文件浏览器内搜索 + 定位 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 FileBrowser toolbar 加常驻搜索输入框，输入即时过滤当前目录列表（仅当前层、子串匹配、大小写不敏感），对齐 Windows 资源管理器交互；删除旧的全局 `/search` 数据库元数据搜索。

**架构：** 纯前端过滤，不动后端。新增 `SearchInput.vue` 组件 + `searchFilter.ts` 纯函数；扩展 `FileBrowser.vue` 的 `displayedEntries` computed 叠加 searchQuery 过滤；复用 `fileBrowser` store 已有的 `searchQuery` ref + `setSearchQuery` action（stub 接线 + 进目录自动清空）；删旧搜索全套（view/store/IPC/Rust/i18n/路由/侧栏项）。

**技术栈：** Vue 3 + Pinia + Vitest + happy-dom（前端）；Tauri 2 / Rust（后端，仅删除）。

**规格：** `docs/superpowers/specs/2026-08-06-filebrowser-inline-search-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/searchFilter.ts` | 纯函数 `filterByQuery(entries, query)` | 创建 |
| `src/lib/searchFilter.test.ts` | 纯函数单测 | 创建 |
| `src/components/filebrowser/SearchInput.vue` | toolbar 常驻搜索输入框组件 | 创建 |
| `src/components/filebrowser/FileBrowser.vue` | 接线 SearchInput + 扩展 displayedEntries + 面包屑/状态栏切换 | 修改 |
| `src/components/filebrowser/FileBrowser.test.ts` | 加搜索行为测试 | 修改 |
| `src/stores/fileBrowser.ts` | navigate/setRoot 清空 searchQuery | 修改 |
| `src/stores/fileBrowser.test.ts` | 加 searchQuery 清空测试 | 修改 |
| `src/locales/zh-CN.ts` / `en-US.ts` | 加 fileBrowser.search* key；删顶层 search 段 + nav.search | 修改 |
| `src/views/Search.vue` | 旧全局搜索页 | 删除 |
| `src/stores/search.ts` / `search.test.ts` | 旧 search store | 删除 |
| `src/lib/tauri.ts` | 删 SearchHit / search() | 修改 |
| `src/router/index.ts` | 删 /search 路由 | 修改 |
| `src/components/layout/SideNav.vue` | 删侧栏搜索项 | 修改 |
| `src-tauri/src/commands/search.rs` | 旧后端 search 命令 | 删除 |
| `src-tauri/src/commands/mod.rs` / `lib.rs` | 删 search 模块注册 | 修改 |

---

## 任务 1：纯函数 filterByQuery + 单测

**文件：**
- 创建：`src/lib/searchFilter.ts`
- 测试：`src/lib/searchFilter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/lib/searchFilter.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { filterByQuery } from './searchFilter';
import type { MediaEntry } from '@/lib/sourceDescriptor';

function mk(name: string, path = name): MediaEntry {
  return { name, path, isDirectory: !name.includes('.'), isArchive: false, size: 0, modifiedAt: 0 };
}

describe('filterByQuery', () => {
  const entries = [mk('abc.txt'), mk('ABC.md'), mk('report.pdf'), mk('notes'), mk('xyz')];

  it('空 query 返回原列表 (保持引用, 不重建)', () => {
    expect(filterByQuery(entries, '')).toBe(entries);
    expect(filterByQuery(entries, '   ')).toBe(entries);
  });

  it('大小写不敏感子串匹配', () => {
    const r = filterByQuery(entries, 'ABC');
    expect(r.map((e) => e.name)).toEqual(['abc.txt', 'ABC.md']);
  });

  it('无匹配返回空数组', () => {
    const r = filterByQuery(entries, 'zzz');
    expect(r).toEqual([]);
  });

  it('含目录和文件混合过滤', () => {
    const mixed = [mk('vola'), mk('volb.txt'), mk('volc')];
    const r = filterByQuery(mixed, 'vol');
    expect(r.length).toBe(3);
  });

  it('query 前后空白被 trim', () => {
    const r = filterByQuery(entries, '  abc  ');
    expect(r.map((e) => e.name)).toEqual(['abc.txt', 'ABC.md']);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/lib/searchFilter.test.ts`
预期：FAIL，报错 `Failed to resolve import './searchFilter'`

- [ ] **步骤 3：编写实现**

创建 `src/lib/searchFilter.ts`：

```ts
/**
 * 文件浏览器内搜索过滤 (对齐 Perfect Viewer SearchFilter.filter + Windows 资源管理器).
 * 仅当前目录非递归, 大小写不敏感子串匹配 entry.name.
 * 空 query 返回原数组引用 (不重建, 保持 Vue 列表 key 和滚动位置).
 */
import type { MediaEntry } from '@/lib/sourceDescriptor';

export function filterByQuery(entries: MediaEntry[], query: string): MediaEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/lib/searchFilter.test.ts`
预期：PASS（5 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/lib/searchFilter.ts src/lib/searchFilter.test.ts
git commit -m "feat(search): filterByQuery 纯函数 + 单测"
```

---

## 任务 2：store 进目录清空 searchQuery

**文件：**
- 修改：`src/stores/fileBrowser.ts`（setRoot / navigate 函数）
- 测试：`src/stores/fileBrowser.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/stores/fileBrowser.test.ts` 文件末尾追加新 describe 块：

```ts
describe('fileBrowser store — searchQuery 进目录清空', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
  });

  it('setSearchQuery 写入 searchQuery', () => {
    const store = useFileBrowserStore();
    store.setSearchQuery('abc');
    expect(store.searchQuery).toBe('abc');
  });

  it('navigate 清空 searchQuery', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setSearchQuery('abc');
    expect(store.searchQuery).toBe('abc');
    await store.navigate('sub');
    expect(store.searchQuery).toBe('');
  });

  it('setRoot 清空 searchQuery', async () => {
    const store = useFileBrowserStore();
    await store.setRoot('C:/x');
    store.setSearchQuery('abc');
    await store.setRoot('C:/y');
    expect(store.searchQuery).toBe('');
  });
});
```

> 注：文件顶部已有这些 import（`useFileBrowserStore / mockedList / setActivePinia / createPinia / vi / beforeEach`），无需重复 import。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/fileBrowser.test.ts -t "searchQuery"`
预期：FAIL（navigate 后 searchQuery 还是 'abc'）

- [ ] **步骤 3：编写实现**

修改 `src/stores/fileBrowser.ts`，在 setRoot 和 navigate 函数体里加一行 `searchQuery.value = '';`

setRoot（约 line 89）改为：

```ts
async function setRoot(root: string | null): Promise<void> {
    rootPath.value = root;
    currentPath.value = '';
    lastFetchedPath.value = '';
    entries.value = [];
    error.value = null;
    clearSelection();
    searchQuery.value = ''; // v0.1.0-module3.0.3: 换目录清空搜索 (对齐 PV)
    if (root !== null) {
      await fetch('');
    }
}
```

navigate（约 line 101）改为：

```ts
async function navigate(path: string): Promise<void> {
    currentPath.value = path;
    searchQuery.value = ''; // v0.1.0-module3.0.3: 换目录清空搜索 (对齐 PV)
    await fetch(path);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/fileBrowser.test.ts -t "searchQuery"`
预期：PASS（3 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts
git commit -m "feat(search): store navigate/setRoot 清空 searchQuery"
```

---

## 任务 3：i18n 新增 fileBrowser.search* + 删旧 search 段

**文件：**
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`

> 关键区分：
> - `fileBrowser.search: '搜索'`（约 line 124，toolbar 搜索按钮文案）→ **保留**
> - `nav.search: '搜索'`（约 line 32，侧栏项）→ **删除**
> - 顶层 `search: { ... }` 段（约 line 227，旧全局搜索页文案）→ **删除**

- [ ] **步骤 1：zh-CN 加 fileBrowser.search* key**

在 `src/locales/zh-CN.ts` 的 `fileBrowser:` 对象内，找到：

```ts
    sortAscending: '升序',
    sortDescending: '降序',
    search: '搜索',
```

在 `search: '搜索',` 这一行之后插入三行：

```ts
    searchPlaceholder: '搜索当前文件夹',
    searchResults: '找到 {count} 项',
    searchCurrent: '搜索结果',
```

- [ ] **步骤 2：zh-CN 删 nav.search**

删除 nav 段里的 search 行（约 line 32）。找到 nav 对象内的：

```ts
    search: '搜索',
```

删除该行。

- [ ] **步骤 3：zh-CN 删顶层 search 段**

删除约 line 227-233 的整段：

```ts
  search: {
    placeholder: '搜索文件名 / 书名 / 标签',
    noResults: '无匹配',
    modeFuzzy: '模糊',
    modeSubstring: '子串',
    resultsCount: '共 {count} 条结果',
  },
```

- [ ] **步骤 4：en-US 同步**

对 `src/locales/en-US.ts` 做相同结构改动：
- fileBrowser 内加：
```ts
    searchPlaceholder: 'Search this folder',
    searchResults: '{count} results',
    searchCurrent: 'Search results',
```
- 删 nav 段的 `search:` 行
- 删顶层 `search: { ... }` 段

- [ ] **步骤 5：运行 i18n 一致性测试**

运行：`npx vitest run src/locales/i18n-keys.test.ts`
预期：PASS（中英 key 对齐）

- [ ] **步骤 6：Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(search): i18n 加 fileBrowser.search* key, 删旧全局 search 段"
```

---

## 任务 4：SearchInput 组件

**文件：**
- 创建：`src/components/filebrowser/SearchInput.vue`

- [ ] **步骤 1：编写组件**

创建 `src/components/filebrowser/SearchInput.vue`：

```vue
<script setup lang="ts">
/**
 * SearchInput.vue — FileBrowser toolbar 常驻搜索输入框.
 *
 * v0.1.0-module3.0.3: 文件浏览器内 Windows 风格搜索.
 * 输入即时 fb.setSearchQuery (150ms 防抖); X 清空; ESC 清空+失焦.
 * 直接读写 fileBrowser store, 无 props (toolbar 常驻, 单实例).
 */
import { ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFileBrowserStore } from '@/stores/fileBrowser';

const { t } = useI18n();
const fb = useFileBrowserStore();

const inputRef = ref<HTMLInputElement | null>(null);
const localValue = ref(fb.searchQuery);

// 外部清空 (进目录等) 同步到输入框显示
watch(
  () => fb.searchQuery,
  (v) => {
    if (v !== localValue.value) localValue.value = v;
  },
);

let timerId: ReturnType<typeof setTimeout> | null = null;
function onInput(e: Event) {
  localValue.value = (e.target as HTMLInputElement).value;
  if (timerId) clearTimeout(timerId);
  timerId = setTimeout(() => {
    fb.setSearchQuery(localValue.value);
    timerId = null;
  }, 150);
}

function clear() {
  localValue.value = '';
  fb.setSearchQuery('');
  inputRef.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    clear();
    inputRef.value?.blur();
  }
}

onUnmounted(() => {
  if (timerId) clearTimeout(timerId);
});

const ICON_SEARCH = 'M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z';
const ICON_X = 'M18 6L6 18M6 6l12 12';
</script>

<template>
  <div class="relative flex items-center" data-test="search-input-wrap">
    <svg
      class="absolute left-2 pointer-events-none text-text-muted"
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    >
      <path :d="ICON_SEARCH" />
    </svg>
    <input
      ref="inputRef"
      v-model="localValue"
      type="text"
      :placeholder="t('fileBrowser.searchPlaceholder')"
      class="w-48 pl-7 pr-6 py-1 text-xs xp-bd bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:text-accent"
      data-test="search-input"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      v-if="localValue"
      class="absolute right-1 flex items-center justify-center w-5 h-5 text-text-muted hover:text-text-primary"
      data-test="search-clear"
      :title="t('common.cancel')"
      @click="clear"
      type="button"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="ICON_X" />
      </svg>
    </button>
  </div>
</template>
```

> 样式说明：用纯 Tailwind utility class（无自定义 `.tb-input`），靠 `xp-bd` token 边框、dark/light 双主题自动切换。宽度 `w-48`。

- [ ] **步骤 2：type-check 确认组件无类型错误**

运行：`npx vue-tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/components/filebrowser/SearchInput.vue
git commit -m "feat(search): SearchInput 组件 (常驻输入框 + 防抖 + ESC 清空)"
```

---

## 任务 5：FileBrowser 接线（toolbar + displayedEntries + 面包屑 + 状态栏）

**文件：**
- 修改：`src/components/filebrowser/FileBrowser.vue`
- 测试：`src/components/filebrowser/FileBrowser.test.ts`

### 步骤详解

- [ ] **步骤 S1：编写失败测试**

在 `src/components/filebrowser/FileBrowser.test.ts` 文件末尾追加测试块。完整测试代码见本任务末尾「任务5完整测试代码」小节。

- [ ] **步骤 S2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/FileBrowser.test.ts -t "内联搜索"`
预期：FAIL（displayedEntries 没按 searchQuery 过滤；search-breadcrumb 不存在）

- [ ] **步骤 S3：扩展 displayedEntries computed**

修改 `src/components/filebrowser/FileBrowser.vue` 的 `displayedEntries` computed（hotfix17 已有 hideFinished 过滤），叠加 searchQuery 过滤。

找到（约 line 76-80）：

```ts
const displayedEntries = computed<MediaEntry[]>(() => {
  const sorted = fb.sortedEntries;
  if (!fb.hideFinished) return sorted;
  return sorted.filter((e) => !readStatus.isFinished(e));
});
```

替换为：

```ts
const displayedEntries = computed<MediaEntry[]>(() => {
  const sorted = fb.sortedEntries;
  // hotfix17: hideFinished 过滤
  const afterHide = fb.hideFinished ? sorted.filter((e) => !readStatus.isFinished(e)) : sorted;
  // v0.1.0-module3.0.3: searchQuery 过滤 (叠加在 hideFinished 之后)
  return filterByQuery(afterHide, fb.searchQuery);
});
```

在 script 顶部 import 区加：

```ts
import { filterByQuery } from '@/lib/searchFilter';
```

- [ ] **步骤 S4：toolbar 加 SearchInput**

在 `src/components/filebrowser/FileBrowser.vue` 的 toolbar 内，`<ViewModeDropdown />` 之后、`</header>` 之前加分隔条 + SearchInput。

找到（约 line 466-468）：

```vue
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <SortDropdown />
        <ViewModeDropdown />
      </header>
```

替换为：

```vue
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <SortDropdown />
        <ViewModeDropdown />
        <span class="xp-divider-v shrink-0" aria-hidden="true" />
        <SearchInput />
      </header>
```

并在 script import 区加（约 line 27-34 的组件 import 处）：

```ts
import SearchInput from './SearchInput.vue';
```

- [ ] **步骤 S5：面包屑搜索态切换**

修改 Breadcrumb 区域。找到（约 line 470-475）：

```vue
      <Breadcrumb
        :root-label="rootLabel"
        :path="fb.currentPath"
        data-test="breadcrumb"
        @navigate="onBreadcrumbNavigate"
      />
```

替换为（v-if 切换静态文本 / 原 Breadcrumb）：

```vue
      <div
        v-if="fb.searchQuery"
        class="bg-surface xp-bdb px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted"
        data-test="search-breadcrumb"
      >
        <span>{{ t('fileBrowser.searchCurrent') }}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span class="text-text-primary">{{ rootLabel }}</span>
      </div>
      <Breadcrumb
        v-else
        :root-label="rootLabel"
        :path="fb.currentPath"
        data-test="breadcrumb"
        @navigate="onBreadcrumbNavigate"
      />
```

> `rootLabel` 已是 FileBrowser 现有变量（Breadcrumb 用过），直接复用。

- [ ] **步骤 S6：状态栏搜索态计数**

找到 StatusBar 组件用法（约 line 520-528 区域）。读 StatusBar props 看它怎么接 count 文案。

先读 StatusBar.vue 确认 props 结构，再决定改法：
- 若 StatusBar 的左段文案由父级传入 → 加 computed `statusBarText`：搜索态用 `t('fileBrowser.searchResults', { count: displayedEntries.value.length })`，非搜索态用原 `t('fileBrowser.statusBar.items', { count: fb.sortedEntries.length })`
- 若 StatusBar 内部自己读 store → 在 StatusBar 内加 searchQuery 判断

**执行此步时先 Read `src/components/filebrowser/StatusBar.vue`**，按其结构二选一实现。

- [ ] **步骤 S7：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/FileBrowser.test.ts`
预期：PASS（所有测试，含新增内联搜索测试）

- [ ] **步骤 S8：Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts src/components/filebrowser/StatusBar.vue
git commit -m "feat(search): FileBrowser 接线内联搜索 (过滤+面包屑+状态栏)"
```

### 任务5完整测试代码

追加到 `src/components/filebrowser/FileBrowser.test.ts` 文件末尾（在最后一个 describe 之后、`makeEntries` function 之前）。完整代码：

```ts
describe('FileBrowser — 内联搜索', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedShortcuts.mockResolvedValue([]);
    mockedList.mockResolvedValue([]);
  });

  it('setSearchQuery 后列表按名过滤 (大小写不敏感)', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'report.pdf', path: 'report.pdf', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'XYZ', path: 'XYZ', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();

    const fileList = wrapper.findComponent({ name: 'FileList' });
    expect(fileList.props('entries').map((e) => e.name)).toEqual(['abc.txt']);
  });

  it('清空 query 恢复完整列表', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      { name: 'report.pdf', path: 'report.pdf', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'FileList' }).props('entries').length).toBe(1);

    fb.setSearchQuery('');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'FileList' }).props('entries').length).toBe(2);
  });

  it('搜索态显示 search-breadcrumb 静态文本, 清空恢复 breadcrumb', async () => {
    mockedList.mockResolvedValueOnce([
      { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
    ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    // 非搜索态: 原 breadcrumb 在
    expect(wrapper.find('[data-test="breadcrumb"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="search-breadcrumb"]').exists()).toBe(false);

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="search-breadcrumb"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="breadcrumb"]').exists()).toBe(false);

    fb.setSearchQuery('');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="breadcrumb"]').exists()).toBe(true);
  });

  it('navigate 后 searchQuery 被清空 (列表恢复)', async () => {
    mockedList
      .mockResolvedValueOnce([
        { name: 'sub', path: 'sub', isDirectory: true, isArchive: false, size: 0, modifiedAt: 0 },
        { name: 'abc.txt', path: 'abc.txt', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never)
      .mockResolvedValueOnce([
        { name: 'page1.jpg', path: 'page1.jpg', isDirectory: false, isArchive: false, size: 0, modifiedAt: 0 },
      ] as never);
    const wrapper = await mountFileBrowser();
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/comics');
    await flushPromises();

    fb.setSearchQuery('abc');
    await wrapper.vm.$nextTick();
    expect(fb.searchQuery).toBe('abc');

    await fb.navigate('sub');
    await flushPromises();
    expect(fb.searchQuery).toBe('');
  });
});
```

> 注：测试不直接验证 StatusBar 文案（StatusBar 内部 i18n 细节，组件单元测试已覆盖），只验证 entries 过滤 + 面包屑切换 + navigate 清空这三个核心行为。单击选中/双击打开的交互在「隐藏已读完」及既有 Cluster A 测试里已覆盖行点击行为，搜索态复用同一 FileList 行组件，无需重复测。

---

## 任务 6：删除旧全局搜索（前端）

**文件：**
- 删除：`src/views/Search.vue`
- 删除：`src/stores/search.ts` / `src/stores/search.test.ts`
- 修改：`src/router/index.ts`（删 /search 路由）
- 修改：`src/lib/tauri.ts`（删 SearchHit / search）
- 修改：`src/components/layout/SideNav.vue`（删侧栏项）

- [ ] **步骤 1：删除 Search.vue**

```bash
git rm src/views/Search.vue
```

- [ ] **步骤 2：删除 search store**

```bash
git rm src/stores/search.ts src/stores/search.test.ts
```

- [ ] **步骤 3：删 /search 路由**

修改 `src/router/index.ts`，删除：

```ts
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/Search.vue'),
    },
```

- [ ] **步骤 4：删 tauri.ts 的 SearchHit / search**

修改 `src/lib/tauri.ts`，删除：

```ts
// ─── Search (Phase 4) ───────────────────────────────────────────────────
export interface SearchHit {
  source: 'library' | 'bookmark' | 'history' | 'tag';
  bookId: number;
  title: string;
  snippet?: string;
}
export async function search(query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search', { query });
}
```

- [ ] **步骤 5：删侧栏搜索项**

修改 `src/components/layout/SideNav.vue`，删除：

```ts
  { to: '/search', icon: '...', labelKey: 'nav.search' },
```

那一行（约 line 24）。

- [ ] **步骤 6：检查 SideNav.test.ts 是否引用了 search 项**

运行：`grep -n "search" src/components/layout/SideNav.test.ts`

若有引用（如断言侧栏含 search 链接），更新测试删掉对应断言。

- [ ] **步骤 7：type-check + 全套测试**

运行：`npm run type-check && npm test -- --run`
预期：PASS（无残留引用）

- [ ] **步骤 8：Commit**

```bash
git add -A
git commit -m "refactor(search): 删除旧全局 /search 数据库元数据搜索 (前端)"
```

---

## 任务 7：删除旧全局搜索（后端 Rust）

**文件：**
- 删除：`src-tauri/src/commands/search.rs`
- 修改：`src-tauri/src/commands/mod.rs`
- 修改：`src-tauri/src/lib.rs`

- [ ] **步骤 1：删除 search.rs**

```bash
git rm src-tauri/src/commands/search.rs
```

- [ ] **步骤 2：删 mod.rs 注册**

修改 `src-tauri/src/commands/mod.rs`，删除：

```rust
pub mod search;
pub use search::*;
```

（约 line 17 及对应 use 行；按实际文件内容删 `pub mod search;` 和 `pub use search::*;`）

- [ ] **步骤 3：删 lib.rs invoke_handler 注册**

修改 `src-tauri/src/lib.rs`，从 `tauri::generate_handler![...]` 列表里删除：

```rust
            commands::search::search,
```

（约 line 76）

- [ ] **步骤 4：cargo check 验证**

运行：`cd src-tauri && cargo check`
预期：PASS（无编译错误，无残留 search 引用）

> 注：cargo check 在本地 Git Bash 里按记忆需 `cmd //C "vcvars64 && cargo check"` 套壳（见 MEMORY.md windows-toolchain-dcompile）。若环境变量已配好可直接 cargo check。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "refactor(search): 删除旧全局 search 后端命令 (Rust)"
```

---

## 任务 8：最终验证 + debug 实例实测

- [ ] **步骤 1：全套前端测试 + type-check**

运行：`npm run type-check && npm test -- --run`
预期：全部 PASS

- [ ] **步骤 2：cargo test**

运行：`cd src-tauri && cargo test`
预期：全部 PASS（algorithm/ 模块单测）

- [ ] **步骤 3：debug 实例实测**

启动带 remote debugging 的 dev 实例（参照 `docs/tauri-devtools-debugging.md`）：

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri:dev
```

实测清单（用 chrome-devtools-mcp 或手动）：
1. 选一个有多文件的目录
2. 在 toolbar 搜索框输入文件名片段 → 列表即时过滤
3. 大小写不敏感（输大写匹配小写文件名）
4. 面包屑变成"搜索结果 > 文件夹名"
5. 点 X 清空 → 列表恢复
6. ESC 键清空 + 失焦
7. 双击搜索结果里的目录 → 进入子目录 + query 自动清空
8. 进目录后搜索框是空的

- [ ] **步骤 4：更新 CLAUDE.md 当前状态表**

在 CLAUDE.md「当前状态」表加一行（或更新 Phase 行）：

```
| 3.0.3 | 文件浏览器内搜索 + 定位 | ✅ Windows 风格 (仅当前目录非递归, 子串匹配, 原地过滤); 删旧全局 /search |
```

- [ ] **步骤 5：tag + push**

```bash
git tag v0.1.0-module3.0.3-search
git push github main
git push github v0.1.0-module3.0.3-search
```

---

## 自检

**1. 规格覆盖度：**
- 仅当前目录非递归过滤 → 任务1 filterByQuery + 任务5 displayedEntries ✓
- 子串匹配大小写不敏感 → 任务1 测试覆盖 ✓
- toolbar 常驻输入框 + 防抖 → 任务4 SearchInput ✓
- 原地替换列表 → 任务5 FileList :entries=displayedEntries ✓
- 单击选中 / 双击打开 → 复用 FileList 现有行为，任务5注释说明 ✓
- 清空/X 恢复 → 任务4 SearchInput clear() + 任务5测试 ✓
- ESC 清空+失焦 → 任务4 onKeydown ✓
- 面包屑静态文本切换 → 任务5 S5 ✓
- 状态栏计数 → 任务5 S6 ✓
- 进目录清空 query → 任务2 ✓
- 删旧全局搜索全套 → 任务6（前端）+ 任务7（后端）+ 任务3 i18n ✓

**2. 占位符扫描：** 无 TODO/待定。任务5 S6 状态栏改法给了二选一明确路径（先 Read StatusBar.vue 再选），不是占位符。

**3. 类型一致性：** `filterByQuery(entries, query)` 签名在任务1定义、任务5 S3 使用一致；`SearchInput.vue` 无 props 直接用 store，与规格一致；store 的 `searchQuery` / `setSearchQuery` 是既有 API，任务2只接线不改签名。

