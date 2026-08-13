# Likes 页「取消喜欢」明确化 + 跳转文件浏览器瀑布流设计

- **日期**: 2026-08-13
- **模块**: v0.1.0-module3.0.10-likes-browse-jump
- **状态**: 设计中
- **相关代码**: `src/views/Likes.vue` / `src/stores/fileBrowser.ts` / `src/components/filebrowser/FileBrowser.vue` / `src/locales/{zh-CN,en-US}.ts`

---

## 1. 背景与动机

v0.1.0-module3.0.9（Library→Likes 合并）后，Likes 页是"喜欢"的唯一列表视图。两个可用性问题：

1. **「取消喜欢」语义不明确**：行内是纯 ❤️ 图标 toggle，点击后行直接从列表消失。用户分不清刚执行的是"取消喜欢"还是"删除记录"——移除是结果，但动作本身不可见。阅读器主菜单用文本「喜欢 / 取消喜欢」（`reader.like` / `reader.unlike`），Likes 页却只有图标，不一致。
2. **缺少跳转文件浏览器的入口**：行内只有「打开」（进阅读器）。用户想回到该书所在目录用瀑布流浏览图片时，需要手动重走 文件浏览器 → root → 层层进目录，路径信息明明就在 `BookItem.sourceDescriptor + absolutePath` 里。

## 2. 目标 / 非目标

### 目标

1. Likes 行内「取消喜欢」改为**文本按钮**，动作语义直白（用户拍板：文本按钮方案）
2. 每行新增「浏览」按钮：跳转文件浏览器到该书所在目录，并切到**瀑布流视图**
3. 跳转走 FileBrowser 统一消费模式（对齐 2026-08-12 路径身份修复的收敛方向）
4. TDD：store / Likes / FileBrowser 三层测试先行

### 非目标

- **不**改 `useLibraryStore` / `toggleFavorite` / 后端任何命令与 schema（`set_favorite` 语义已正确）
- **不**做行不消失 / 显示全部书（与「Likes 只显示 `is_favorite=1`」产品语义冲突）
- **不**做 toast / undo
- **不**做多源跳转（SMB/WebDAV descriptor——Phase 7-8 实装后扩展，store 字段留结构余量）
- **不**顺手收敛 History.vue `openEntry` 到新模式（预存在，另行处理）
- **不**做导航失败的错误 UI（目录被删等场景静默 + log，与 History/shortcut 同策略）

## 3. 核心决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| 取消喜欢呈现 | 文本按钮「取消喜欢」（复用 `likes.toggleOff`） | 用户拍板；对齐阅读器主菜单措辞；改动最小 |
| 取消后行为 | 行从 `favorites` 消失（不变） | "Likes 列表只显示喜欢的书"语义自洽 |
| 跳转执行模式 | **方案 B**：store 一次性意图 + FileBrowser 单点消费 | 用户拍板；对齐 shortcut activeId 收敛模式（spec §6.4 路径身份修复）；结构性避开 `loadLayout()` 覆盖 viewMode 的时序竞争 |
| 意图数据结构 | `{ rootPath, relPath }`（Local 所需最小集） | `fb.setRoot` 现有签名只收 rootPath；多源实装时再扩 descriptor |
| viewMode 切换 | `fb.setViewMode('masonry')`（持久化） | 与工具栏瀑布流按钮行为一致 |
| 无图目录 | 不特判，依赖现有 watch 守卫自动回落 details | `FileBrowser.vue:162-166` 已有 |
| 非 Local 书 | 「浏览」按钮不渲染（`sd.type !== 'local'` 防御） | 与 `History.vue:33` 同策略；当前库中实际只可能有 Local 书 |
| 消费优先级 | `pendingOpenLocation` > `restoreNavigationContext` > LAST_ROOT_KEY | 显式新意图优先于 reader 残留上下文 |
| 陈旧意图清理 | `requestOpenLocation` 写入时清 `savedNavigationContext` + `shortcuts.clearActive()` | 单点收口；防旧上下文滞留与 shortcut 重放（`lastOpenedShortcutId` 组件局部，重挂载失效） |
| data-test | `btn-fav` → `btn-unlike`；新增 `btn-browse` | 语义清晰，测试同步改名 |
| 孤儿 i18n | 删 `likes.toggleOn`（zh/en） | favorites 列表所有行必然已喜欢，toggleOn 无消费点 |

## 4. 详细设计

### 4.1 Likes.vue「取消喜欢」文本按钮

现状（`Likes.vue:71-86`）：`btn-fav` 是 ❤️ 图标按钮，aria-label 按 `book.isFavorite` 三元取 `toggleOff`/`toggleOn`。

改为：

```html
<button
  data-test="btn-unlike"
  class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent
         text-text-secondary no-underline hover:bg-surface-2 hover:text-text-primary
         transition-colors"
  @click="toggleFav(book.id)"
>{{ t('likes.toggleOff') }}</button>
```

- 样式对齐「打开」按钮（同 `text-xs xp-bd px-3 py-1 rounded` 族）
- 文本即无障碍标签，删原 aria-label 三元
- 行首装饰性 ❤ 图标（`Likes.vue:61-67`）保留
- 点击行为不变：`toggleFav(book.id)` → `library.toggleFavorite(id)` → IPC `setFavorite(id, false)` → `favorites` computed 过滤 → 行消失

### 4.2 fileBrowser store：`pendingOpenLocation`

```ts
interface PendingOpenLocation {
  rootPath: string;  // Local descriptor 的 rootPath
  relPath: string;   // source-relative，'' = 根目录
}

const pendingOpenLocation = ref<PendingOpenLocation | null>(null);

function requestOpenLocation(rootPath: string, relPath: string): void {
  pendingOpenLocation.value = { rootPath, relPath };
  // 显式新意图取代任何残留的 reader 导航上下文——否则本跳转 early-return 跳过
  // restoreNavigationContext 后，旧上下文滞留 store，下次挂载 '/' 会把用户拽回旧目录
  savedNavigationContext.value = null;
  // 同时取代遗留的 shortcut 意图——否则 activeId 残留 + lastOpenedShortcutId 是
  // FileBrowser 组件局部变量（重挂载重置），用户离开再回 '/' 时 onMounted 会
  // 重放旧快捷方式，把用户从浏览目录拽回 shortcut 目录（审查必须修复项）
  useShortcutsStore().clearActive();
}

function consumePendingOpenLocation(): PendingOpenLocation | null {
  const p = pendingOpenLocation.value;
  pendingOpenLocation.value = null;
  return p;
}
```

- 读后即清（一次性），天然去重——**不需要** shortcut 的 `lastOpenedShortcutId` 守卫
- 三个符号加入 store 返回值导出

### 4.3 FileBrowser.vue 消费点

`onMounted` 现有顺序（`FileBrowser.vue:221-264`）中，在 `loadLayout()` **之后**、`restoreNavigationContext()` **之前**插入：

```ts
await fb.loadLayout();
// likes「浏览」跳转意图（一次性 consume，显式意图优先于 reader 残留上下文）
const pendingLoc = fb.consumePendingOpenLocation();
if (pendingLoc) {
  await openPendingLocation(pendingLoc);
  return;
}
if (await fb.restoreNavigationContext()) { ... }  // 原逻辑不动
```

`openPendingLocation`（新函数，放 `openShortcut` 旁，防御模式对齐）：

```ts
async function openPendingLocation(p: { rootPath: string; relPath: string }): Promise<void> {
  const relCheck = validateSourceRelativePath(p.relPath);
  if (!relCheck.ok) {
    log('[FileBrowser] pendingOpenLocation relPath 越界, 拒绝打开', { ...p, reason: relCheck.reason });
    return;
  }
  // setRoot 无条件调（同 openShortcut 注释：避免同根不同 relPath 切换时 currentPath 残留）
  await fb.setRoot(p.rootPath);
  if (relCheck.normalized) {
    await fb.navigate(relCheck.normalized);
  }
  fb.setViewMode('masonry'); // 无图目录由 watch([viewMode, hasImages]) 守卫自动回落 details
}
```

为什么消费点必须在 `loadLayout()` 之后：`loadLayout` 会从 DB 重读 `fb_view_mode` 覆盖内存 viewMode。若 Likes 端先切 masonry 再 push，挂载时被旧持久化值覆盖（写入与读取两个 IPC 的完成顺序无保证）。消费点后置让 setViewMode 成为最后一次写入，结构性消除竞争——这正是选方案 B 的主因。

early-return 同时跳过 `restoreNavigationContext` 与 shortcuts 检查，均为有意优先级（显式新意图 > 残留上下文 > shortcut 重放）。两层陈旧意图的清理都收口在 `requestOpenLocation` 写入时点（`savedNavigationContext` 清空 + `shortcuts.clearActive()`），而非消费时点——写入是单点，消费点可能增加（未来多入口复用 pending 机制）。shortcut 清理不放 FileBrowser 消费侧的另一原因：清理必须发生在 activeId watch 触发前才不会与重放守卫交互，request 时点天然早于挂载。

依赖方向（已验证）：fileBrowser → shortcuts 单向（fileBrowser 已有 `useDirectorySortStore` store 间依赖先例；shortcuts 只依赖 `lib/tauri`），无循环。`useShortcutsStore()` 在 action 函数体内调用（Pinia 标准），不在 store 顶层同步调用。

### 4.4 Likes.vue「浏览」按钮 + 触发

```ts
const fb = useFileBrowserStore();
const router = useRouter();

function openInBrowser(book: BookItem): void {
  const sd = book.sourceDescriptor;
  if (sd.type !== 'local') return; // 防御（当前不可达：库中只有 Local 书）
  fb.requestOpenLocation(sd.rootPath, book.absolutePath);
  void router.push('/');
}
```

按钮（`btn-browse`，位于「取消喜欢」与「打开」之间）：

```html
<button
  data-test="btn-browse"
  :title="t('likes.browseTitle')"
  class="...同 btn-unlike 样式族"
  @click="openInBrowser(book)"
>
  <svg ...瀑布流图标（复用 FileBrowser ICON_MASONRY path）/>
  {{ t('likes.browse') }}
</button>
```

行布局：❤ | 标题 | [取消喜欢] [浏览] [打开]。

`book.absolutePath` 是 source-relative（`create_book` 后端已做 `validate_source_relative` 规范化，`commands/library.rs:200`），'' 表示 root 级书——此时 navigate 跳过，仅 setRoot + masonry。

### 4.5 i18n

| key | zh-CN | en-US | 说明 |
|---|---|---|---|
| `likes.toggleOff` | 取消喜欢 | Unlike | 已存在，文本按钮复用 |
| `likes.toggleOn` | ~~喜欢~~ | ~~Like~~ | **删除**（无消费点，zh/en 同步） |
| `likes.browse` | 浏览 | Browse | 新增 |
| `likes.browseTitle` | 在文件浏览器中打开（瀑布流视图） | Open in file browser (masonry view) | 新增，按钮 tooltip |

## 5. 测试设计（TDD：先写失败测试）

### 5.1 `src/stores/fileBrowser.test.ts`（新增 describe）

1. `requestOpenLocation` 写入 → `consumePendingOpenLocation` 返回该值且**清空**（二次 consume 得 null）
2. 无意图时 consume 返回 null
3. `requestOpenLocation` 清空已有 `savedNavigationContext`（新意图取代残留上下文）
4. `requestOpenLocation` 清空 shortcuts.activeId（`setActive(3)` → request → `activeId === null`；防重挂载重放旧快捷方式）

### 5.2 `src/views/Likes.test.ts`

1. 改造现有用例：`btn-fav` → `btn-unlike`，点击 → `setFavorite(7, false)` → 行消失（断言不变，选择器改名）
2. 新增：点击 `btn-browse` → fileBrowser store `pendingOpenLocation` 等于 `{ rootPath: '/x', relPath: <absolutePath> }` + 路由跳到 `/`
   - fixture 修正：`FAV_BOOK.absolutePath` 由 `/x`（绝对路径，不符合真实后端契约）改为 source-relative 值（如 `VOL.11`）
3. 新增：非 Local descriptor 的书不渲染 `btn-browse`（防御分支）

### 5.3 `src/components/filebrowser/FileBrowser.test.ts`（新增用例）

1. mount 前 `requestOpenLocation('/root', 'VOL.11')` → mount 后 `fb.setRoot('/root')` / `fb.navigate('VOL.11')` / `fb.setViewMode('masonry')` 依序调用
2. `relPath = ''`（root 级书）→ 仅 setRoot + setViewMode，不 navigate
3. `relPath` 非法（如 `..\\evil`）→ 不 setRoot 不 navigate（log + 放弃）
4. **优先级组合**：`savedNavigationContext` 与 pending 同时存在 → mount 导航到 pending 目标（restoreNavigationContext 不执行、其上下文已被 request 时点清空）
5. **shortcut 重放回归**：`setActive(3)` + `requestOpenLocation` → mount 导航到 pending 目标且未执行 shortcut → unmount → 二次 mount（无新意图）→ 仍不重放 shortcut
6. 无 pending → 走原 onMounted 逻辑（现有用例即回归，不新增）

## 6. 验收清单

- [ ] Likes 行内「取消喜欢」为文本按钮，点击后行消失
- [ ] Likes 行内「浏览」点击 → 文件浏览器定位到书所在目录 + 瀑布流视图
- [ ] 目标目录无图片 → 自动回落 details（现有守卫，不新增代码）
- [ ] 非 Local 书无「浏览」按钮
- [ ] 有 active shortcut 时点「浏览」→ 之后离开再回 `/`，不重放旧快捷方式
- [ ] `npm run type-check` 0 error；`npm test` 全绿（新增 ~8 用例）
- [ ] zh/en i18n key 一致（删 toggleOn，增 browse/browseTitle）
