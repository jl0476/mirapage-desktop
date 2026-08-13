# Likes 页「取消喜欢」明确化 + 浏览跳转瀑布流 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Likes 页行内「取消喜欢」改为文本按钮（语义直白化），并新增「浏览」按钮跳转文件浏览器该书所在目录 + 瀑布流视图。

**架构：** fileBrowser store 新增一次性跳转意图 `pendingOpenLocation`（request 时点同时清理 `savedNavigationContext` + `shortcuts.activeId` 两类陈旧导航意图）；FileBrowser `onMounted` 在 `loadLayout()` 之后消费（校验 relPath → setRoot → navigate → setViewMode('masonry')）；Likes.vue 只写意图 + `push('/')`。对齐 shortcut activeId 收敛模式（spec §4.3）。

**技术栈：** Vue 3 + Pinia setup store + Vitest/happy-dom + vue-i18n。纯前端改动，无 Rust/DB 变更。

**规格：** `docs/superpowers/specs/2026-08-13-likes-browse-jump-design.md`（两轮审查定稿，commit `4ab5d55`）

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/stores/fileBrowser.ts` | 修改 | 新增 `PendingOpenLocation` + request/consume（~35 行） |
| `src/stores/fileBrowser.test.ts` | 修改 | +4 用例（一次性 consume / 空 / 清上下文 / 清 activeId） |
| `src/components/filebrowser/FileBrowser.vue` | 修改 | onMounted 消费块 + `openPendingLocation`（~30 行） |
| `src/components/filebrowser/FileBrowser.test.ts` | 修改 | factory +1 mock；+5 用例（导航/''/非法/优先级/重放回归） |
| `src/views/Likes.vue` | 修改 | btn-fav→btn-unlike 文本按钮；+btn-browse + `openInBrowser` |
| `src/views/Likes.test.ts` | 修改 | 改 3 用例 + 新增 2 用例 |
| `src/locales/zh-CN.ts` / `src/locales/en-US.ts` | 修改 | 删 `likes.toggleOn`；加 `likes.browse` / `likes.browseTitle` |
| `AGENTS.md` | 修改 | 当前状态表加 3.0.10 行 |

已验证的关键事实（实现者不需要重新调查）：

- `src/stores/shortcuts.ts` 只依赖 `lib/tauri` + vue/pinia，不反向依赖 fileBrowser → fileBrowser → shortcuts 单向，无循环。fileBrowser 已有 store 间依赖先例（`useDirectorySortStore`，line 21）。
- `validateSourceRelativePath`（`@/lib/relativePath`）返回 `{ ok: true, normalized: string } | { ok: false, reason: string }`；`relPath=''` 合法且 `normalized === ''`。
- `fb.setRoot()` 会重置 `currentPath` 为 `''`（openShortcut 依赖此语义）。
- `fb.setViewMode(m)` 同时持久化 `fb_view_mode`（`fileBrowser.ts:261-264`）。
- FileBrowser.test.ts 的 vi.mock factory **整体替换** `@/lib/tauri`（无 importActual）；`useMasonrySettings.resolve` 内部 try/catch 静默兜底未 mock 的 IPC（`useMasonrySettings.ts:45-47`），但新测试显式补 `getDirectoryMasonry` mock 消除偶发 undefined 调用。
- `loadLayout()` 的 4 次 `getSetting` 调用顺序固定：`fb_sort_field` / `fb_sort_ascending` / `fb_view_mode` / `fb_hide_finished`（`fileBrowser.ts:273-278` Promise.all 数组序）。
- FileBrowser.test.ts 已有 FileList stub 模式（`FileBrowser.test.ts:1166-1192`）与全局卸载兜底 `_mountedWrappers`（afterEach，`FileBrowser.test.ts:75-80`）。

---

### 任务 1：fileBrowser store — `pendingOpenLocation` 一次性跳转意图

**文件：**
- 修改：`src/stores/fileBrowser.ts`（import 区 + `restoreNavigationContext` 之后 + return 导出块）
- 测试：`src/stores/fileBrowser.test.ts`（文件末尾追加 describe）

- [ ] **步骤 1：编写失败的测试**

在 `src/stores/fileBrowser.test.ts` 顶部 import 区追加：

```ts
import { useShortcutsStore } from '@/stores/shortcuts';
```

文件末尾追加：

```ts
describe('fileBrowser store — pendingOpenLocation（likes 浏览跳转意图）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('requestOpenLocation 写入 → consume 返回并清空（一次性）', () => {
    const store = useFileBrowserStore();
    store.requestOpenLocation('C:/comics', 'VOL.11');
    expect(store.consumePendingOpenLocation()).toEqual({ rootPath: 'C:/comics', relPath: 'VOL.11' });
    expect(store.consumePendingOpenLocation()).toBeNull();
  });

  it('无意图时 consume 返回 null', () => {
    const store = useFileBrowserStore();
    expect(store.consumePendingOpenLocation()).toBeNull();
  });

  it('requestOpenLocation 清空 savedNavigationContext（新意图取代残留上下文）', async () => {
    mockedList.mockResolvedValue(makeEntries('a'));
    const store = useFileBrowserStore();
    await store.setRoot('C:/old');
    store.saveNavigationContext();
    store.requestOpenLocation('C:/comics', '');
    expect(await store.restoreNavigationContext()).toBe(false);
  });

  it('requestOpenLocation 清空 shortcuts.activeId（防重挂载重放旧快捷方式）', () => {
    const store = useFileBrowserStore();
    const shortcuts = useShortcutsStore();
    shortcuts.setActive(3);
    store.requestOpenLocation('C:/comics', '');
    expect(shortcuts.activeId).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/fileBrowser.test.ts`
预期：FAIL——4 个新用例报 `store.requestOpenLocation is not a function`（现有用例仍 PASS）。

- [ ] **步骤 3：编写最少实现代码**

`src/stores/fileBrowser.ts` 顶部 import 区（`useDirectorySortStore` import 之后）追加：

```ts
import { useShortcutsStore } from '@/stores/shortcuts';
```

在 `restoreNavigationContext` 函数结束（约 line 220，`// ─── v0.1.0-module1.22: sort/viewMode/hideFinished actions ───` 注释之前）插入：

```ts
// ─── v0.1.0-module3.0.10: likes「浏览」跳转意图（一次性）───
// Likes.vue 点「浏览」→ requestOpenLocation + push('/')；FileBrowser.onMounted
// 在 loadLayout 之后 consume（spec §4.3：消费点后置让 setViewMode('masonry')
// 不被 loadLayout 读到的旧持久化值覆盖）。
export interface PendingOpenLocation {
  rootPath: string;
  relPath: string;
}
const pendingOpenLocation = ref<PendingOpenLocation | null>(null);

function requestOpenLocation(rootPath: string, relPath: string): void {
  pendingOpenLocation.value = { rootPath, relPath };
  // 显式新意图取代两类陈旧导航意图（spec 审查必须修复项）：
  // 1. reader 残留的 savedNavigationContext —— 否则本跳转 early-return 跳过
  //    restoreNavigationContext 后旧上下文滞留 store，下次挂载 '/' 会把用户拽回旧目录
  savedNavigationContext.value = null;
  // 2. shortcuts.activeId —— lastOpenedShortcutId 是 FileBrowser 组件局部变量，
  //    重挂载即重置失效；不清 activeId 的话离开再回 '/' 会重放旧快捷方式
  useShortcutsStore().clearActive();
}

function consumePendingOpenLocation(): PendingOpenLocation | null {
  const p = pendingOpenLocation.value;
  pendingOpenLocation.value = null;
  return p;
}
```

在 store 的 `return { ... }` 导出块（`viewMode,` 附近）追加：

```ts
  pendingOpenLocation,
  requestOpenLocation,
  consumePendingOpenLocation,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/fileBrowser.test.ts`
预期：PASS（全文件，含 4 个新用例）。

- [ ] **步骤 5：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts
git commit -m "feat(store): pendingOpenLocation 一次性跳转意图（module3.0.10 任务 1）

- requestOpenLocation 写入意图 + 清 savedNavigationContext + shortcuts.clearActive()
  （新显式意图取代陈旧导航意图，防旧上下文滞留 / shortcut 重挂载重放）
- consumePendingOpenLocation 读后即清（一次性，天然去重）
- TDD 4 用例：往返清空 / 空 null / 清上下文 / 清 activeId"
```

---

### 任务 2：FileBrowser.vue — onMounted 消费 pending + `openPendingLocation`

**文件：**
- 修改：`src/components/filebrowser/FileBrowser.vue`（onMounted 内 `await fb.loadLayout();` 之后 + `openShortcut` 函数之前）
- 测试：`src/components/filebrowser/FileBrowser.test.ts`（import 区 + mock factory + 文件末尾追加 describe）

- [ ] **步骤 1：编写失败的测试**

`src/components/filebrowser/FileBrowser.test.ts` 三处改动：

① import 区（现有 `@/lib/tauri` import 行）追加 `getSetting`：

```ts
import { listDirectory, listShortcuts, createShortcut, findNextVolume, createBook, getSetting } from '@/lib/tauri';
```

② mock factory（`vi.mock('@/lib/tauri', () => ({ ... }))` 内）追加一行（消除 masonry resolve watch 的 undefined IPC 调用）：

```ts
  getDirectoryMasonry: vi.fn(async () => null),
```

③ `const mockedFindNextVolume = vi.mocked(findNextVolume);` 之后追加：

```ts
const mockedGet = vi.mocked(getSetting);
```

④ 文件末尾追加：

```ts
// ─── v0.1.0-module3.0.10: pendingOpenLocation 消费（likes「浏览」跳转）───
// spec §4.3/§5.3：消费点必须在 loadLayout 之后（否则旧持久化 fb_view_mode 覆盖
// setViewMode('masonry')）；优先级 pending > restoreNavigationContext > shortcut。
// FileList stub 对齐 Task 10 模式（避免真实 MasonryView 拉起未 mock 的缩略图 IPC）。
describe('FileBrowser — pendingOpenLocation 消费（likes 浏览跳转）', () => {
  const FileListNullStub = { name: 'FileList', setup: () => () => null };

  function mountBrowser() {
    const wrapper = mount(FileBrowser, {
      global: { plugins: [i18n], stubs: { FileList: FileListNullStub } },
    });
    _mountedWrappers.push(wrapper);
    return wrapper;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // 必须含图片条目：FileBrowser.vue 有守卫 watch([viewMode, hasImages])——
    // masonry + 无图目录会自动回落 details，空 mock 会让 viewMode 断言失败
    mockedList.mockResolvedValue([
      { name: 'p1.jpg', path: 'p1.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 0 },
    ] as never);
    mockedShortcuts.mockResolvedValue([]);
  });

  it('消费 pending → setRoot + navigate + masonry，且 loadLayout 旧持久化值(list)不覆盖', async () => {
    // loadLayout 的 4 次 getSetting 依序: fb_sort_field / fb_sort_ascending / fb_view_mode / fb_hide_finished
    mockedGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('list')
      .mockResolvedValueOnce(null);
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    fb.requestOpenLocation('C:/comics', 'VOL.11');
    mountBrowser();
    await flushPromises();

    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('VOL.11');
    expect(fb.viewMode).toBe('masonry');
    // 一次性：已消费
    expect(fb.consumePendingOpenLocation()).toBeNull();
  });

  it("relPath=''（root 级书）→ 仅 setRoot + masonry，不 navigate", async () => {
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    fb.requestOpenLocation('C:/comics', '');
    mountBrowser();
    await flushPromises();

    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('');
    expect(fb.viewMode).toBe('masonry');
  });

  it('relPath 非法 → 不 setRoot 不 navigate，viewMode 保持 details', async () => {
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    fb.requestOpenLocation('C:/comics', '..\\evil');
    mountBrowser();
    await flushPromises();

    expect(fb.rootPath).toBeNull();
    expect(fb.viewMode).toBe('details');
  });

  it('pending 优先于 savedNavigationContext（request 时点已清空旧上下文）', async () => {
    setActivePinia(createPinia());
    const fb = useFileBrowserStore();
    await fb.setRoot('C:/old');
    fb.saveNavigationContext();
    fb.requestOpenLocation('C:/comics', 'VOL.11');
    mountBrowser();
    await flushPromises();

    // 导航到 pending 目标，而非旧上下文 C:/old
    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('VOL.11');
  });

  it('setActive(3) 后浏览跳转 → 重挂载不重放旧 shortcut', async () => {
    mockedShortcuts.mockResolvedValue([mkShortcut(3, 'C:/other', '别的', 'sub')]);
    setActivePinia(createPinia());
    const shortcuts = useShortcutsStore();
    const fb = useFileBrowserStore();
    shortcuts.setActive(3);
    fb.requestOpenLocation('C:/comics', 'VOL.11');

    const w1 = mountBrowser();
    await flushPromises();
    // pending 执行、shortcut 未导航；activeId 已在 request 时点清空
    expect(fb.currentPath).toBe('VOL.11');
    expect(shortcuts.activeId).toBeNull();
    w1.unmount();

    // 二次挂载（无新意图）：activeId 已清 → 不得重放 shortcut 3（C:/other/sub）
    mountBrowser();
    await flushPromises();
    expect(fb.rootPath).toBe('C:/comics');
    expect(fb.currentPath).toBe('VOL.11');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/FileBrowser.test.ts`
预期：FAIL——用例 1/2/4/5 报 `fb.rootPath` 为 null / currentPath 不符（pending 未被消费，onMounted 走了 LAST_ROOT_KEY 分支）；用例 3 可能已 PASS（防御分支未实现时也不导航，属预期）。

- [ ] **步骤 3：编写最少实现代码**

`src/components/filebrowser/FileBrowser.vue` 的 `onMounted` 内，`await fb.loadLayout();`（约 line 237）之后、`if (await fb.restoreNavigationContext())` 之前插入：

```ts
  // v0.1.0-module3.0.10: likes「浏览」跳转意图 —— 一次性 consume，显式新意图
  // 优先于 reader 残留上下文 / shortcut 重放（两类陈旧意图已在 requestOpenLocation
  // 写入时点清理）。必须在 loadLayout 之后：setViewMode('masonry') 不能被旧持久化值覆盖。
  const pendingLoc = fb.consumePendingOpenLocation();
  if (pendingLoc) {
    await openPendingLocation(pendingLoc);
    return;
  }
```

在 `openShortcut` 函数（约 line 295 的注释块）之前插入：

```ts
// v0.1.0-module3.0.10: pendingOpenLocation 消费逻辑（likes「浏览」跳转）。
// 防御模式对齐 openShortcut：relPath 校验非法则 log + 放弃不导航；
// setRoot 无条件调（同 openShortcut：避免同根不同 relPath 切换时 currentPath 残留）。
async function openPendingLocation(p: { rootPath: string; relPath: string }): Promise<void> {
  const relCheck = validateSourceRelativePath(p.relPath);
  if (!relCheck.ok) {
    log('[FileBrowser] pendingOpenLocation relPath 越界, 拒绝打开', { relPath: p.relPath, reason: relCheck.reason });
    return;
  }
  await fb.setRoot(p.rootPath);
  if (relCheck.normalized) {
    await fb.navigate(relCheck.normalized);
  }
  // 无图目录由 watch([viewMode, hasImages]) 守卫自动回落 details
  fb.setViewMode('masonry');
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/FileBrowser.test.ts`
预期：PASS（全文件，含 5 个新用例 + 全部既有用例）。

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts
git commit -m "feat(filebrowser): onMounted 消费 pendingOpenLocation + openPendingLocation（module3.0.10 任务 2）

- 消费点位于 loadLayout 之后 / restoreNavigationContext 之前（优先级:
  pending > 残留上下文 > LAST_ROOT_KEY > shortcut 重放）
- openPendingLocation: relPath 校验非法 log+放弃; setRoot 无条件; navigate 仅非空;
  setViewMode('masonry') 持久化（无图目录现有守卫自动回落 details）
- 测试 factory 补 getDirectoryMasonry mock; +5 用例含 loadLayout 覆盖时序守卫
  与 shortcut 重放回归（双 mount）"
```

---

### 任务 3：Likes.vue —「取消喜欢」文本按钮 + 「浏览」按钮 + i18n

**文件：**
- 修改：`src/views/Likes.vue`（script import 区 + 新函数 + 模板 btn-fav 块替换）
- 修改：`src/locales/zh-CN.ts` / `src/locales/en-US.ts`（likes section）
- 测试：`src/views/Likes.test.ts`

- [ ] **步骤 1：编写失败的测试（改造 + 新增）**

`src/views/Likes.test.ts` 四处改动：

① 文件头注释第 7 行改为（`btn-fav` → `btn-unlike`）：

```ts
 *  - 行内 btn-unlike 文本按钮点击调 toggleFavorite（取消喜欢，行消失）
 *  - 行内 btn-browse 点击写 pendingOpenLocation + 跳转 /
```

② import 区追加：

```ts
import { useFileBrowserStore } from '@/stores/fileBrowser';
```

③ i18n 内联 messages（`likes:` 行）改为（删 toggleOn，加 browse/browseTitle）：

```ts
      likes: { title: '喜欢', empty: '还没有喜欢的书', toggleOff: '取消喜欢', browse: '浏览', browseTitle: '在文件浏览器中打开（瀑布流视图）' },
```

④ `FAV_BOOK` 的 `absolutePath` 由 `'/x'`（不符合后端 source-relative 契约）改为：

```ts
  absolutePath: 'VOL.11',
```

⑤ 现有用例「行内 btn-fav 点击调 setFavorite(7, false)...」标题与选择器改名：

```ts
  it('行内 btn-unlike 点击调 setFavorite(7, false)，book.isFavorite=false 后行消失', async () => {
    const tauri = await import('@/lib/tauri');
    (tauri.listLibrary as any).mockResolvedValueOnce([FAV_BOOK]);
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="row"]').exists()).toBe(true);

    await wrapper.find('[data-test="btn-unlike"]').trigger('click');
    await flushPromises();

    // library.toggleFavorite 内部调 setFavorite(id, nextFav=!isFavorite=false)
    expect(tauri.setFavorite).toHaveBeenCalledWith(7, false);
    // favorites 是 computed filter isFavorite,false 后该行从 favorites 移除
    expect(wrapper.find('[data-test="row"]').exists()).toBe(false);
    // empty state 应出现
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
  });
```

⑥ describe 末尾追加 2 个新用例：

```ts
  it('点击「浏览」→ 写入 pendingOpenLocation + 跳转 /', async () => {
    const tauri = await import('@/lib/tauri');
    (tauri.listLibrary as any).mockResolvedValueOnce([FAV_BOOK]);
    const { wrapper, router } = await mountLikes();

    await wrapper.find('[data-test="btn-browse"]').trigger('click');
    await flushPromises();

    const fb = useFileBrowserStore();
    expect(fb.pendingOpenLocation).toEqual({ rootPath: '/x', relPath: 'VOL.11' });
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('非 Local 书不渲染「浏览」按钮（防御分支）', async () => {
    const tauri = await import('@/lib/tauri');
    const remote = {
      ...FAV_BOOK,
      id: 8,
      sourceDescriptor: { type: 'webdav', accountId: 1, baseUrl: 'http://x', path: '/' },
    };
    (tauri.listLibrary as any).mockResolvedValueOnce([remote]);
    const { wrapper } = await mountLikes();

    expect(wrapper.find('[data-test="row"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-browse"]').exists()).toBe(false);
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/views/Likes.test.ts`
预期：FAIL——btn-unlike / btn-browse 选择器不存在；新用例 1 报 `fb.pendingOpenLocation` 为 null。

- [ ] **步骤 3：编写最少实现代码**

`src/views/Likes.vue`：

① script import 区改为：

```ts
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';
import { useFileBrowserStore } from '@/stores/fileBrowser';
import type { BookItem } from '@/lib/tauri';
```

② `const { favorites } = storeToRefs(library);` 之后追加：

```ts
const router = useRouter();
const fb = useFileBrowserStore();

// v0.1.0-module3.0.10: 「浏览」— 跳文件浏览器该书所在目录 + 瀑布流视图。
// 只写一次性意图（requestOpenLocation 内部清 savedNavigationContext + shortcut
// activeId），实际 setRoot/navigate/setViewMode 由 FileBrowser.onMounted 单点执行。
function openInBrowser(book: BookItem): void {
  const sd = book.sourceDescriptor;
  if (sd.type !== 'local') return; // 防御：非 Local 无跳转（Phase 1，当前库中不可达）
  fb.requestOpenLocation(sd.rootPath, book.absolutePath);
  void router.push('/');
}
```

③ 图标常量区（`ICON_OPEN` 之后）追加：

```ts
const ICON_GRID = 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z';
```

④ 文件头注释块「跟旧版差异」段追加一行：

```ts
 * - v0.1.0-module3.0.10: ❤️ 图标 toggle → 「取消喜欢」文本按钮；新增「浏览」跳瀑布流
```

⑤ 模板中现有 `btn-fav` 按钮（`Likes.vue:71-86`）整块替换为：

```html
        <button
          data-test="btn-unlike"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
          @click="toggleFav(book.id)"
        >{{ t('likes.toggleOff') }}</button>
        <button
          data-test="btn-browse"
          :title="t('likes.browseTitle')"
          class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
                 text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
          @click="openInBrowser(book)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="ICON_GRID" />
          </svg>
          {{ t('likes.browse') }}
        </button>
```

`src/locales/zh-CN.ts`（约 line 193-198）likes section 改为：

```ts
  likes: {
    title: '喜欢',
    empty: '还没有喜欢的书',
    toggleOff: '取消喜欢',
    browse: '浏览',
    browseTitle: '在文件浏览器中打开（瀑布流视图）',
  },
```

`src/locales/en-US.ts`（约 line 191-196）likes section 改为：

```ts
  likes: {
    title: 'Likes',
    empty: 'No liked books yet',
    toggleOff: 'Unlike',
    browse: 'Browse',
    browseTitle: 'Open in file browser (masonry view)',
  },
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/views/Likes.test.ts`
预期：PASS（5 用例）。

再跑 i18n 双语一致性测试确认删 key 无残留引用：

运行：`npx vitest run src/locales`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/views/Likes.vue src/views/Likes.test.ts src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(likes): 取消喜欢文本按钮 + 浏览跳转瀑布流按钮（module3.0.10 任务 3）

- btn-fav 图标 toggle → btn-unlike 文本按钮（复用 likes.toggleOff，语义直白）
- 新增 btn-browse: openInBrowser 写 pendingOpenLocation + push('/')
  （非 Local 防御不渲染）；瀑布流图标 12px inline lucide layout-grid
- i18n: 删孤儿 likes.toggleOn（zh/en），加 likes.browse / likes.browseTitle
- fixture absolutePath 修正为 source-relative 'VOL.11'（对齐 create_book 契约）"
```

---

### 任务 4：全量验证 + 文档收尾 + tag

**文件：**
- 修改：`AGENTS.md`（当前状态表）
- 修改：`docs/superpowers/specs/2026-08-13-likes-browse-jump-design.md`（状态行）

- [ ] **步骤 1：全量验证**

```bash
npm run type-check && npm test -- --run
```

预期：type-check 0 error；单测全绿（基线 717 → 约 728：+4 store、+5 FileBrowser、+2 Likes）。

- [ ] **步骤 2：更新 AGENTS.md 当前状态表**

「当前状态（Phase 1-8 主体完成）」表格 3.0.9 行之后追加（内容按实际实现微调）：

```markdown
| 3.0.10 | Likes 页打磨：取消喜欢 + 浏览跳转瀑布流 | ✅ `v0.1.0-module3.0.10-likes-browse-jump`（spec：`docs/superpowers/specs/2026-08-13-likes-browse-jump-design.md`，plan：`docs/superpowers/plans/2026-08-13-likes-browse-jump.md`）：**A 取消喜欢明确化** — 行内 ❤️ 图标 toggle → 「取消喜欢」文本按钮（复用 `likes.toggleOff`，删孤儿 `likes.toggleOn`），点击后行消失语义不变。**B 浏览跳转瀑布流** — fileBrowser store 新增 `pendingOpenLocation` 一次性意图（`requestOpenLocation` 写入时清 `savedNavigationContext` + `shortcuts.clearActive()` 两类陈旧导航意图，防旧上下文滞留/shortcut 重挂载重放）；FileBrowser onMounted 在 `loadLayout()` 之后、`restoreNavigationContext()` 之前消费（校验 relPath → setRoot → navigate → setViewMode('masonry') 持久化；无图目录现有守卫回落 details）；Likes 每行「浏览」按钮写意图 + push('/')，非 Local 防御不渲染。对齐 shortcut activeId 收敛模式（2026-08-12 路径身份修复方向）。消费点后置结构性避开 loadLayout 覆盖 viewMode 的 IPC 时序竞争。单测 717→约 728（+11）。 |
```

- [ ] **步骤 3：更新 spec 状态行**

`docs/superpowers/specs/2026-08-13-likes-browse-jump-design.md` 头部 `- **状态**: 设计中` 改为 `- **状态**: 已实现`。

- [ ] **步骤 4：Commit + tag + push**

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-13-likes-browse-jump-design.md
git commit -m "docs: AGENTS.md 状态表 3.0.10 + spec 状态已实现（module3.0.10 收尾）"
git tag v0.1.0-module3.0.10-likes-browse-jump
git push github main
git push github v0.1.0-module3.0.10-likes-browse-jump
```

- [ ] **步骤 5：更新跨会话 memory**

`C:\Users\jl0476\.zcode\cli\memories\projects\mirapage-desktop-51803698543167dc\memory\likes-page-polish-design.md` 更新为完成态（模块号、tag、两轮审查要点），并在 `MEMORY.md` 同步该行 hook。

---

## 自检记录

- **规格覆盖度**：spec §4.1（btn-unlike）→ 任务 3；§4.2（store 机制 + 双清理）→ 任务 1；§4.3（消费点 + openPendingLocation）→ 任务 2；§4.4（btn-browse + openInBrowser + 非 Local 防御）→ 任务 3；§4.5（i18n 三变更）→ 任务 3；§5.1-5.3 测试矩阵 → 任务 1/2/3 一一对应；§6 验收清单 → 任务 4 步骤 1 + 各任务断言。
- **占位符扫描**：无 TODO/待定；所有代码步骤含完整代码。
- **类型一致性**：`PendingOpenLocation` 任务 1 定义、任务 2 `openPendingLocation(p: { rootPath: string; relPath: string })` 结构一致；`requestOpenLocation/consumePendingOpenLocation` 命名全程一致；`btn-unlike`/`btn-browse` data-test 命名与测试选择器一致。
