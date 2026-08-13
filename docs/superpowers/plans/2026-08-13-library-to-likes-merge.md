# Library → Likes 合并实现计划

> **面向 AI 代理的工作者:** 必需子技能:使用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法来跟踪进度。

**目标:** 删除冗余的 `like` 表 + 整套 likes 后端/前端/store/IPC,视图层"去掉书库改为喜欢",修 Reader 主菜单 ❤️ toggle 的数据源不一致 bug,文案全入口统一"喜欢"。

**架构:** 保留 `library.is_favorite` 字段作唯一真源;删 `like` 表(migration 011 先 UPDATE 合并数据再 DROP);删 Library 视图,重写 Likes 视图读 `useLibraryStore.favorites`;Reader ❤️ toggle 改 setFavorite + 同步 book ref;FileBrowser 三入口文案复用 `reader.like`。

**技术栈:** Tauri 2.x + Vue 3 + Pinia + Vitest + cargo test + rusqlite migration

**前置依赖:** spec `docs/superpowers/specs/2026-08-13-library-to-likes-merge-design.md`(必读,本计划引用其 §X 章节,不重复代码)

---

## 文件结构

按子系统分 12 任务。每个任务产出独立可 commit 的变更。

| 类别 | 文件 | 操作 |
|---|---|---|
| Rust 数据层 | `src-tauri/src/db/migrations.rs` | 改(加 apply_011 + 测试) |
| Rust 模块 | `src-tauri/src/commands/{likes.rs,mod.rs,lib.rs}` | 删 likes.rs + 删 mod.rs 声明 + 删 lib.rs 注册 |
| TS IPC | `src/lib/tauri.ts` | 改(删 listLikes/toggleLike/LikeItem) |
| TS Store | `src/stores/likes.ts` + `likes.test.ts` | 删 |
| Router | `src/router/index.ts` + `index.test.ts` | 改(redirect)+ 新增测试 |
| View | `src/views/{Library.vue,Likes.vue,Bookmarks.vue}` | 删 Library + 重写 Likes + 改 Bookmarks backlink |
| 测试 | `src/views/Likes.test.ts` | 新增 |
| SideNav | `src/components/layout/SideNav.vue` + `.test.ts` | 改顺序 + 改测试 |
| Reader | `src/components/reader/ReaderMainMenu.vue` + `.test.ts` | 改(删按钮)+ 改测试 |
| Reader | `src/views/ReaderView.vue` + `.test.ts` | 改(toggleFavorite handler)+ 加测试 |
| FileBrowser | `src/components/filebrowser/{FileBrowser,EntryDetailPanel,RowContextMenu}.vue` | 改文案 |
| i18n | `src/locales/{zh-CN,en-US}.ts` | 删 keys |

---

## 任务序列

### 任务 1:migration 011 — 数据层基础

**文件:**
- 修改:`src-tauri/src/db/migrations.rs`(加 `apply_011_drop_like_table` + 版本序列追加 + 3 处测试)
- 测试:同文件末尾测试块

**参考:** spec §4.3

- [ ] **步骤 1:加 apply_011 函数 + 注册到版本序列**

在 `apply_010_progress_image_name` 函数定义之后,加:

```rust
fn apply_011_drop_like_table(conn: &Connection) -> anyhow::Result<()> {
    // 工程实践:破坏性升级先合并数据再 DROP。
    // like.book_id 必有对应 library.id(toggle_like 调用点 ReaderView 守 `book?.id != null`,
    // book.id 来自 get_book 查 library 表),所以 IN 子查询无丢失风险。
    conn.execute_batch(
        r#"
        UPDATE library
           SET is_favorite = 1
         WHERE id IN (SELECT book_id FROM `like`)
           AND is_favorite = 0;

        DROP TABLE IF EXISTS `like`;
        "#,
    )?;
    Ok(())
}
```

在 `apply_migrations` 函数的版本序列末尾(`(10, apply_010_progress_image_name),` 之后)追加:
```rust
        (11, apply_011_drop_like_table),
```

- [ ] **步骤 2:改现有测试断言 10 → 11**

`migrations.rs` 末尾测试中,把 `assert_eq!(v, 10, "完整 run 后版本号应为 10")` 改为 `assert_eq!(v, 11, "完整 run 后版本号应为 11")`。

- [ ] **步骤 3:加 2 个新测试**

在 migration 测试块加:

```rust
#[test]
fn apply_011_drops_like_table() {
    let conn = Connection::open_in_memory().unwrap();
    apply_001_init(&conn).unwrap();
    apply_002_shortcuts(&conn).unwrap();
    apply_003_finished_flag(&conn).unwrap();
    apply_004_book_source_descriptor_unique(&conn).unwrap();
    apply_005_library_history_redesign(&conn).unwrap();
    apply_006_history_book_id(&conn).unwrap();
    apply_007_shortcuts_cross_source(&conn).unwrap();
    apply_008_directory_masonry(&conn).unwrap();
    apply_009_thumbnail_cache(&conn).unwrap();
    apply_010_progress_image_name(&conn).unwrap();
    apply_011_drop_like_table(&conn).unwrap();

    // `like` 表应已不存在
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='like'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 0, "`like` 表应在 apply_011 后不存在");
}

#[test]
fn apply_011_merges_like_data_into_library_is_favorite() {
    let conn = Connection::open_in_memory().unwrap();
    // 跑到 010
    for apply in [
        apply_001_init, apply_002_shortcuts, apply_003_finished_flag,
        apply_004_book_source_descriptor_unique, apply_005_library_history_redesign,
        apply_006_history_book_id, apply_007_shortcuts_cross_source,
        apply_008_directory_masonry, apply_009_thumbnail_cache, apply_010_progress_image_name,
    ] {
        apply(&conn).unwrap();
    }
    // 准备:library.id=42 is_favorite=0 + like(book_id=42)
    conn.execute(
        "INSERT INTO library (title, source_descriptor, source_type, absolute_path, page_count, added_at, is_favorite)
         VALUES ('Test', '{}', 'Local', '/x', 10, 0, 0)",
        [],
    ).unwrap();
    let book_id: i64 = conn.query_row("SELECT id FROM library WHERE title='Test'", [], |r| r.get(0)).unwrap();
    conn.execute("INSERT INTO `like` (book_id, liked_at) VALUES (?1, 100)", [book_id]).unwrap();

    apply_011_drop_like_table(&conn).unwrap();

    let is_fav: i64 = conn.query_row(
        "SELECT is_favorite FROM library WHERE id=?1",
        [book_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(is_fav, 1, "apply_011 应把 like 表数据合并到 library.is_favorite=1");
}
```

- [ ] **步骤 4:运行测试验证通过**

运行:`cd src-tauri && cargo test -p mirapage-desktop-lib -- migrations`
预期:PASS(原有 + 2 个新测试)

- [ ] **步骤 5:Commit**

```bash
git add src-tauri/src/db/migrations.rs
git commit -m "feat(migrations): migration 011 — UPDATE 合并 + DROP \`like\` 表

- apply_011_drop_like_table: 先 UPDATE library.is_favorite=1 合并 like 数据,再 DROP
- 改现有 assert_eq!(v, 10) → 11
- 加 apply_011_drops_like_table 测试
- 加 apply_011_merges_like_data_into_library_is_favorite 测试(数据合并验证)"
```

---

### 任务 2:删 like 后端模块

**文件:**
- 删除:`src-tauri/src/commands/likes.rs`
- 修改:`src-tauri/src/commands/mod.rs`(删 `pub mod likes;`)
- 修改:`src-tauri/src/lib.rs`(删 `generate_handler!` 两条注册)

**参考:** spec §4.2

- [ ] **步骤 1:删 likes.rs**

```bash
rm src-tauri/src/commands/likes.rs
```

- [ ] **步骤 2:删 mod.rs 模块声明**

`src-tauri/src/commands/mod.rs` 删这一行:
```rust
pub mod likes;
```

- [ ] **步骤 3:删 lib.rs generate_handler 注册**

`src-tauri/src/lib.rs` 在 `tauri::generate_handler![...]` 列表中删:
```rust
commands::likes::list_likes,
commands::likes::toggle_like,
```

- [ ] **步骤 4:运行 cargo check + test 验证**

运行:`cd src-tauri && cargo check && cargo test -p mirapage-desktop-lib`
预期:编译通过 + 所有现有测试通过(likes.rs 测试随文件删)

- [ ] **步骤 5:Commit**

```bash
git add -A src-tauri/src/commands/likes.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "refactor(commands): 删 likes 后端模块

- 删 src-tauri/src/commands/likes.rs(list_likes / toggle_like / LikeItem)
- 删 commands/mod.rs 的 \`pub mod likes;\`(否则 Rust 编译失败)
- 删 lib.rs generate_handler! 的 list_likes + toggle_like 注册"
```

---

### 任务 3:删 like 前端 IPC + store

**文件:**
- 修改:`src/lib/tauri.ts`(删 listLikes / toggleLike / LikeItem)
- 删除:`src/stores/likes.ts` + `src/stores/likes.test.ts`

**参考:** spec §4.2

- [ ] **步骤 1:删 tauri.ts 三个导出**

`src/lib/tauri.ts` 删(约 70-78 行):
```ts
export interface LikeItem { ... }
export async function listLikes(): Promise<LikeItem[]> { ... }
export async function toggleLike(bookId: number): Promise<boolean> { ... }
```

(具体行号实施时 grep `listLikes\|toggleLike\|LikeItem` 定位)

- [ ] **步骤 2:删 store 文件**

```bash
rm src/stores/likes.ts src/stores/likes.test.ts
```

- [ ] **步骤 3:运行 type-check 验证**

运行:`npm run type-check`
预期:0 error(若有 error 说明还有 import 残留,grep `from '@/lib/tauri'.*toggleLike\|listLikes\|LikeItem` 定位 + 删)

- [ ] **步骤 4:运行测试验证**

运行:`npm test -- --run`
预期:全绿(likes store 测随文件删,其他测试不受影响)

- [ ] **步骤 5:Commit**

```bash
git add -A src/lib/tauri.ts src/stores/likes.ts src/stores/likes.test.ts
git commit -m "refactor(stores): 删 likes 前端 IPC + store

- 删 lib/tauri.ts 的 listLikes / toggleLike / LikeItem
- 删 stores/likes.ts + likes.test.ts(零视图消费)"
```

---

### 任务 4:router redirect + 删 Library.vue + 新增 router 测试

**文件:**
- 修改:`src/router/index.ts`(删 component 路由 + 加 redirect + 删 Library.vue import)
- 删除:`src/views/Library.vue`
- 创建:`src/router/index.test.ts`

**参考:** spec §5.3

- [ ] **步骤 1:改 router/index.ts**

```diff
- import Home from '@/views/Home.vue';
  // (Library.vue 不在 import 列表,是 lazy import,无需动 import)

  // routes 数组中:
- {
-   path: '/library',
-   name: 'library',
-   component: () => import('@/views/Library.vue'),
- },
+ // 兼容旧链接:dev hot reload / 调试 / 未来 deep-link 都可能落到 /library
+ {
+   path: '/library',
+   redirect: '/likes',
+ },
```

- [ ] **步骤 2:删 Library.vue**

```bash
rm src/views/Library.vue
```

- [ ] **步骤 3:写 router/index.test.ts(失败测试)**

创建 `src/router/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import router from './index';

describe('router — /library 兼容重定向', () => {
  it('push /library 后 currentRoute.fullPath === /likes', async () => {
    await router.push('/library');
    await router.isReady();
    expect(router.currentRoute.value.fullPath).toBe('/likes');
    expect(router.currentRoute.value.name).toBe('likes');
  });

  it('push /likes 直接命中(无重定向)', async () => {
    await router.push('/likes');
    await router.isReady();
    expect(router.currentRoute.value.fullPath).toBe('/likes');
  });
});
```

- [ ] **步骤 4:运行测试验证通过**

运行:`npx vitest run src/router/index.test.ts`
预期:PASS

- [ ] **步骤 5:type-check + Commit**

运行:`npm run type-check`(0 error,确认 Library.vue 没有残留 import)

```bash
git add -A src/router/index.ts src/views/Library.vue src/router/index.test.ts
git commit -m "refactor(router): /library redirect 到 /likes + 删 Library.vue

- 删 /library component 路由 + Library.vue
- 加 /library → /likes redirect(兼容旧链接兜底)
- 新增 router/index.test.ts 验证 redirect(push+isReady+fullPath)"
```

---

### 任务 5:SideNav 改顺序 + 改测试

**文件:**
- 修改:`src/components/layout/SideNav.vue`(删 library 项 + likes 移到第 3 位)
- 修改:`src/components/layout/SideNav.test.ts`(5 处改)

**参考:** spec §5.4, §9.1

- [ ] **步骤 1:改 SideNav.vue items 数组**

`src/components/layout/SideNav.vue` items 数组,删 library 那行:
```ts
{ to: '/library', icon: '...', labelKey: 'nav.library' },
```
然后把 likes 行**移到 library 原位置**(原在第 5 位,移到第 3 位)。结果顺序:`/` / `/shortcuts` / `/likes` / `/bookmarks` / `/history` / `/accounts` / `/settings`。

- [ ] **步骤 2:改 SideNav.test.ts — router mock 删 /library**

`makeRouter()` 中删:
```ts
{ path: '/library', name: 'library', component: { template: '<div />' } },
```

- [ ] **步骤 3:改 SideNav.test.ts — 5 处具体改动**

① describe 标题 `'SideNav — 8 项导航'` → `'SideNav — 7 项导航'`
② `expect(links.length).toBe(8)` → `toBe(7)`
③ hrefs 期望从:
```ts
['/', '/shortcuts', '/library', '/bookmarks', '/likes', '/history', '/accounts', '/settings']
```
改为:
```ts
['/', '/shortcuts', '/likes', '/bookmarks', '/history', '/accounts', '/settings']
```
④ i18n 文案断言删 `expect(html).toContain('书库');`
⑤ 把 `/library` 激活态测试改为 `/likes` 激活态:
```ts
it('当前路由 /likes 时,/likes 链接含 is-active + router-link-exact-active', async () => {
  const { wrapper } = await mountSideNav('/likes');
  await new Promise((r) => setTimeout(r, 0));
  const links = wrapper.findAllComponents(RouterLink);
  const likesLink = links.find((l) => l.props('to') === '/likes');
  expect(likesLink).toBeTruthy();
  expect(likesLink!.classes()).toContain('is-active');
  expect(likesLink!.classes()).toContain('router-link-exact-active');
});
```
⑥ "8 个 RouterLink 逐个点击"测试 targets 数组:
```ts
const targets = ['/', '/shortcuts', '/likes', '/bookmarks', '/history', '/accounts', '/settings'];
```

- [ ] **步骤 4:运行测试验证通过**

运行:`npx vitest run src/components/layout/SideNav.test.ts`
预期:PASS(7 个 link 全部测试通过)

- [ ] **步骤 5:Commit**

```bash
git add src/components/layout/SideNav.vue src/components/layout/SideNav.test.ts
git commit -m "refactor(sidenav): 删 library 项,likes 移到第 3 位 + 测试同步

- SideNav.vue items 数组:删 /library 项,likes 移到第 3 位
- SideNav.test.ts: 8→7 link,i18n 删 '书库',激活态改 /likes,push 数组改 7 项"
```

---

### 任务 6:Likes.vue 重写 + 新增测试

**文件:**
- 修改(重写):`src/views/Likes.vue`
- 创建:`src/views/Likes.test.ts`

**参考:** spec §5.2(Likes.vue 完整规格)

- [ ] **步骤 1:重写 Likes.vue**

完全替换 Likes.vue 内容。视觉布局照搬 Library.vue(原文件可在 git history 查 `git show HEAD~5:src/views/Library.vue` 参考),关键差异:
- 页面标题:`t('likes.title')` = "喜欢"
- 行内 toggle 图标:⭐ star → ❤️ heart(用 heart filled/outline path)
- 数据源:`useLibraryStore` + `storeToRefs(library).favorites`
- toggle 调用:`library.toggleFavorite(book.id)`
- 打开 reader 链接:**用 `name: 'reader'` + `params: { bookId }`,不要 query**(spec §5.2 P2 反馈)
- backlink:`to="/"` (回首页)

完整模板骨架:

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useLibraryStore } from '@/stores/library';

const { t } = useI18n();
const library = useLibraryStore();
const { favorites } = storeToRefs(library);

onMounted(() => { void library.refresh(); });

async function toggleFav(id: number) {
  await library.toggleFavorite(id);
}

const ICON_HEART_FILLED = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
const ICON_HEART_OUTLINE = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
const ICON_OPEN = 'M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5';
const ICON_HEART_BIG = ICON_HEART_FILLED;
</script>

<template>
  <main class="p-6 h-full overflow-y-auto">
    <header class="flex justify-between items-center mb-6">
      <h2 class="m-0 text-xl font-semibold tracking-tight">{{ t('likes.title') }}</h2>
      <RouterLink to="/" class="text-text-secondary no-underline text-sm px-3 py-1.5 rounded hover:bg-surface-2 hover:text-text-primary transition-colors" data-test="back-link">← {{ t('common.back') }}</RouterLink>
    </header>

    <ul v-if="favorites.length > 0" class="list-none p-0 m-0 flex flex-col gap-2" data-test="list">
      <li v-for="book in favorites" :key="book.id" class="flex items-center gap-4 p-3 px-4 bg-surface-1 xp-bd rounded-lg transition-colors duration-100 hover:border-accent hover:shadow-[0_0_10px_rgba(99,102,241,0.25)]" data-test="row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#f472b6" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0"><path :d="ICON_HEART_FILLED" /></svg>
        <span class="flex-1 font-semibold text-sm text-text-primary truncate">{{ book.title }}</span>
        <button data-test="btn-fav" class="p-1.5 rounded hover:bg-surface-2 transition-colors" @click="toggleFav(book.id)"><svg width="16" height="16" viewBox="0 0 24 24" :fill="book.isFavorite ? '#f472b6' : 'none'" :stroke="book.isFavorite ? '#f472b6' : 'currentColor'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="ICON_HEART_FILLED" /></svg></button>
        <RouterLink :to="{ name: 'reader', params: { bookId: book.id } }" data-test="btn-open" class="flex items-center gap-1 px-3 py-1 rounded text-xs xp-bd bg-transparent text-text-secondary no-underline hover:bg-surface-2 hover:text-text-primary transition-colors"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="ICON_OPEN" /></svg>{{ t('common.open') }}</RouterLink>
      </li>
    </ul>

    <div v-else class="flex flex-col items-center justify-center gap-4 mt-12" data-test="empty-state">
      <div class="w-16 h-16 rounded-2xl bg-surface-1 xp-bd flex items-center justify-center backdrop-blur-md">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="ICON_HEART_BIG" /></svg>
      </div>
      <p class="text-text-tertiary text-sm m-0" data-test="empty-hint">{{ t('likes.empty') }}</p>
      <RouterLink to="/" class="text-accent no-underline text-sm hover:text-accent-hover hover:underline transition-colors" data-test="link-to-filebrowser">{{ t('fileBrowser.pickRoot') }} →</RouterLink>
    </div>
  </main>
</template>
```

- [ ] **步骤 2:写 Likes.test.ts(失败测试)**

创建 `src/views/Likes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import Likes from './Likes.vue';

vi.mock('@/lib/tauri', () => ({
  listLibrary: vi.fn(async () => []),
  setFavorite: vi.fn(),
}));

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': { likes: { title: '喜欢', empty: '还没有喜欢的书' }, common: { back: '返回', open: '打开' }, fileBrowser: { pickRoot: '选择根目录' } } } });

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/likes', name: 'likes', component: Likes },
      { path: '/reader/:bookId', name: 'reader', component: { template: '<div />' } },
    ],
  });
}

async function mountLikes() {
  setActivePinia(createPinia());
  const router = makeRouter();
  router.push('/likes');
  await router.isReady();
  const wrapper = mount(Likes, { global: { plugins: [router, i18n] } });
  await flushPromises();
  return { wrapper, router };
}

describe('Likes.vue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空 favorites 显示 empty state + 文案', async () => {
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('还没有喜欢的书');
  });

  it('favorites 渲染 list + 行内 toggle + 打开按钮(用 name:reader + params)', async () => {
    const tauri = await import('@/lib/tauri');
    (tauri.listLibrary as any).mockResolvedValueOnce([
      { id: 7, title: 'TestBook', isFavorite: true, sourceDescriptor: { type: 'local', rootPath: '/x' }, sourceType: 'Local', absolutePath: '/x', coverEntryPath: null, coverEntryName: null, pageCount: 10, lastReadAt: null, addedAt: 0 },
    ]);
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="list"]').exists()).toBe(true);
    const row = wrapper.find('[data-test="row"]');
    expect(row.text()).toContain('TestBook');
    // 关键:打开按钮用 name:'reader' + params(不是 query)
    const link = wrapper.findComponent({ name: 'RouterLink' });
    // 找到 btn-open 的 RouterLink
    const openLink = wrapper.find('[data-test="btn-open"]');
    expect(openLink.exists()).toBe(true);
    // 点开应该跳 /reader/7(不是 /reader?bookId=7)
    expect(openLink.attributes('href')).toBe('/reader/7');
  });

  it('行内 btn-fav 点击调 toggleFavorite(行消失)', async () => {
    const tauri = await import('@/lib/tauri');
    (tauri.listLibrary as any).mockResolvedValueOnce([
      { id: 7, title: 'TestBook', isFavorite: true, sourceDescriptor: { type: 'local', rootPath: '/x' }, sourceType: 'Local', absolutePath: '/x', coverEntryPath: null, coverEntryName: null, pageCount: 10, lastReadAt: null, addedAt: 0 },
    ]);
    const { wrapper } = await mountLikes();
    expect(wrapper.find('[data-test="row"]').exists()).toBe(true);
    await wrapper.find('[data-test="btn-fav"]').trigger('click');
    await flushPromises();
    expect(tauri.setFavorite).toHaveBeenCalledWith(7, false);
    // favorites 是 computed filter isFavorite,取消后该行消失
    expect(wrapper.find('[data-test="row"]').exists()).toBe(false);
  });
});
```

- [ ] **步骤 3:运行测试验证通过**

运行:`npx vitest run src/views/Likes.test.ts`
预期:PASS(3 个测试通过)

- [ ] **步骤 4:type-check**

运行:`npm run type-check`
预期:0 error

- [ ] **步骤 5:Commit**

```bash
git add src/views/Likes.vue src/views/Likes.test.ts
git commit -m "feat(likes): 重写 Likes.vue — 用 library.favorites + 行内 ❤️ toggle

- 数据源 useLibraryStore.favorites(等价 items.filter(isFavorite))
- 行内 ❤️ toggle 调 library.toggleFavorite,取消后行消失
- 打开 reader 用 name:'reader' + params(不是 query)
- 新增 Likes.test.ts 3 用例(空 state / 渲染 / toggle 行消失)"
```

---

### 任务 7:Bookmarks.vue backlink 改 /likes

**文件:**
- 修改:`src/views/Bookmarks.vue:57`

**参考:** spec §5.5

- [ ] **步骤 1:改 Bookmarks.vue**

第 57 行:
```diff
- <RouterLink to="/library" class="text-xs text-text-secondary hover:text-accent">
+ <RouterLink to="/likes" class="text-xs text-text-secondary hover:text-accent">
```

- [ ] **步骤 2:运行测试验证无回归**

运行:`npx vitest run src/views/Bookmarks`
预期:全绿(若 Bookmarks.test.ts 不断言 backlink,无影响)

- [ ] **步骤 3:type-check + Commit**

```bash
git add src/views/Bookmarks.vue
git commit -m "fix(bookmarks): backlink /library → /likes"
```

---

### 任务 8:ReaderMainMenu 删按钮 + 改测试

**文件:**
- 修改:`src/components/reader/ReaderMainMenu.vue`
- 修改:`src/components/reader/ReaderMainMenu.test.ts`

**参考:** spec §6.1

- [ ] **步骤 1:删 ReaderMainMenu.vue 三处**

① `NAV_ITEMS` 数组删:
```ts
{ path: '/library', key: 'nav.library' },
```

② 模板中删"加入书库"按钮(约 230-234 行):
```vue
<button data-test="menu-lib-add" @click="onAddToLibrary">{{ t('fileBrowser.addToLibrary') }}</button>
```

③ 删 `onAddToLibrary` 函数 + `emit('add-to-library')` 声明(若 emit 类型里有 `add-to-library`,也删)

- [ ] **步骤 2:改 ReaderMainMenu.test.ts**

grep `menu-lib-add` 找到对应测试用例,删除整段。

- [ ] **步骤 3:运行测试验证通过**

运行:`npx vitest run src/components/reader/ReaderMainMenu.test.ts`
预期:PASS

- [ ] **步骤 4:type-check + Commit**

```bash
git add src/components/reader/ReaderMainMenu.vue src/components/reader/ReaderMainMenu.test.ts
git commit -m "refactor(reader-menu): 删 /library navigate + 删加入书库按钮

- NAV_ITEMS 删 { path: '/library' }
- 删 menu-lib-add 按钮(跟 ❤️ toggle 数据语义重叠,合并为单一入口)
- 删 onAddToLibrary + emit('add-to-library') 声明
- 测试同步删按钮用例"
```

---

### 任务 9:ReaderView toggleFavorite handler + 连续 toggle 测试

**文件:**
- 修改:`src/views/ReaderView.vue`
- 修改:`src/views/ReaderView.test.ts`(新增用例)

**参考:** spec §6.2 / §6.3

- [ ] **步骤 1:改 ReaderView.vue import**

第 24 行:
```diff
- import { getBook, saveProgress, getProgress, listDirectory, toggleLike, addBookmark, setFavorite } from '@/lib/tauri';
+ import { getBook, saveProgress, getProgress, listDirectory, addBookmark, setFavorite } from '@/lib/tauri';
```

- [ ] **步骤 2:加 toggleFavorite 本地 handler**

在 ReaderView.vue 的 `<script setup>` 中(其他函数附近),加:

```ts
async function toggleFavorite(bookId: number): Promise<void> {
  if (!book.value) return;
  const nextFav = !book.value.isFavorite;
  await setFavorite(bookId, nextFav);
  // 同步本地 book ref(代码审查 P1):否则同会话无法反复切换
  book.value = { ...book.value, isFavorite: nextFav };
}
```

- [ ] **步骤 3:改模板接线**

第 637 行 `@add-to-library="..."` 整行删。
第 638 行改为:
```diff
- @toggle-like="book?.id != null && toggleLike(book.id)"
+ @toggle-like="book?.id != null && toggleFavorite(book.id)"
```

- [ ] **步骤 4:加 ReaderView.test.ts 连续 toggle 测试**

在 ReaderView.test.ts 加(具体注入方式参考该文件现有 mock 模式):

```ts
it('连续两次 toggle-like: 第一次 setFavorite(id,true),第二次 setFavorite(id,false),book ref 同步翻转', async () => {
  // 挂载 ReaderView,mock setFavorite,注入 book.id=42, book.isFavorite=false
  // 触发 toggle-like emit 第一次 → expect setFavorite(42, true),book.isFavorite 现在 true
  // 触发 toggle-like emit 第二次 → expect setFavorite(42, false),book.isFavorite 现在 false
  // 验证 :is-liked prop 随 book.isFavorite 翻转
});
```

(实施时按 ReaderView.test.ts 现有 mock 结构展开,关键断言:`setFavorite` 调用序列 + `book.value.isFavorite` 翻转 + ReaderMainMenu 收到的 `:is-liked` prop 翻转)

- [ ] **步骤 5:运行测试 + type-check + Commit**

运行:`npx vitest run src/views/ReaderView.test.ts && npm run type-check`
预期:PASS + 0 error

```bash
git add src/views/ReaderView.vue src/views/ReaderView.test.ts
git commit -m "fix(reader): ❤️ toggle 改 setFavorite + 同步 book ref(同会话可反复切换)

- 删 toggleLike import + 删 @add-to-library 接线
- 新增 toggleFavorite 本地 handler:IPC 后同步 book.value.isFavorite
- @toggle-like 改调 toggleFavorite(book.id)
- 修两个 bug:数据源不一致(toggleLike→setFavorite)+ 同会话无法取消(book ref 不刷)
- 新增连续 toggle 测试(setFavorite true→false + book.isFavorite 翻转)"
```

---

### 任务 10:FileBrowser 三入口文案统一

**文件:**
- 修改:`src/components/filebrowser/FileBrowser.vue:625, 633`
- 修改:`src/components/filebrowser/EntryDetailPanel.vue:171`
- 修改:`src/components/filebrowser/RowContextMenu.vue:149`

**参考:** spec §7

- [ ] **步骤 1:改 4 处文案**

`FileBrowser.vue:625` `:title="t('fileBrowser.addToLibrary')"` → `:title="t('reader.like')"`
`FileBrowser.vue:633` `{{ t('fileBrowser.addToLibrary') }}` → `{{ t('reader.like') }}`
`EntryDetailPanel.vue:171` `＋ {{ t('fileBrowser.addToLibrary') }}` → `＋ {{ t('reader.like') }}`
`RowContextMenu.vue:149` `＋ {{ t('fileBrowser.contextMenu.addToLibrary') }}` → `＋ {{ t('reader.like') }}`

- [ ] **步骤 2:type-check**

运行:`npm run type-check`
预期:0 error

- [ ] **步骤 3:运行相关测试验证无回归**

运行:`npx vitest run src/components/filebrowser/{FileBrowser,EntryDetailPanel,RowContextMenu}.test.ts`
预期:全绿(这些测试不断言文案,只受 i18n key 删除影响 — 任务 11 删 key 后再确认)

- [ ] **步骤 4:Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue src/components/filebrowser/EntryDetailPanel.vue src/components/filebrowser/RowContextMenu.vue
git commit -m "refactor(filebrowser): 三入口文案 addToLibrary → reader.like(喜欢)

- FileBrowser 工具栏:title + 文本 2 处
- EntryDetailPanel 按钮
- RowContextMenu 菜单项
- 文案统一为喜欢(避免'加入书库'vs'喜欢'认知割裂)"
```

---

### 任务 11:i18n 整理 — 删 5 类 key

**文件:**
- 修改:`src/locales/zh-CN.ts`
- 修改:`src/locales/en-US.ts`

**参考:** spec §8

- [ ] **步骤 1:zh-CN.ts 删除**

- `nav.library: '书库',`
- 整个 `library: { ... }` namespace(title / empty / favorite / unfavorite / source.* / addFavorite / removeFavorite)
- `reader.menu.library: '书库',`
- `fileBrowser.addToLibrary: '加入书库',`
- `fileBrowser.contextMenu.addToLibrary: '加入书库',`

- [ ] **步骤 2:en-US.ts 同步删除(对应英文)**

5 类 key 同步删(英文版命名一致)。

- [ ] **步骤 3:type-check + 全测**

运行:`npm run type-check && npm test -- --run`
预期:0 error + 全绿

若 type-check 报"Property 'library' does not exist"等,说明有残留引用 — grep `t('library\.\|t('fileBrowser\.addToLibrary\|t('fileBrowser\.contextMenu\.addToLibrary\|t('nav\.library\|t('reader\.menu\.library` 定位 + 改(应该都在前面任务 1-10 已清理)

- [ ] **步骤 4:Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "refactor(i18n): 删 library.* / nav.library / fileBrowser.addToLibrary 等

- 删 nav.library(SideNav 项)
- 删 library.* 整组 namespace(Library.vue 已删)
- 删 reader.menu.library(Reader 主菜单 navigate)
- 删 fileBrowser.addToLibrary(三入口改用 reader.like)
- 删 fileBrowser.contextMenu.addToLibrary(RowContextMenu)
- zh-CN + en-US 双语同步"
```

---

### 任务 12:最终验证 + tag

- [ ] **步骤 1:跑全套验证**

```bash
npm run type-check
npm test -- --run
cd src-tauri && cargo test -p mirapage-desktop-lib && cargo check && cd ..
```

预期:
- type-check 0 error
- npm test 全绿(580~586 用例)
- cargo test 全绿
- cargo check 通过

- [ ] **步骤 2:可选 — 本地 build portable exe**

```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"
```

(参考 AGENTS.md §5.3,验证后端完整编译 + 单 exe 打包)

- [ ] **步骤 3:E2E 手动验证(via tauri-devtools MCP)**

按 spec §12.2 验证清单逐项确认:
- SideNav 顺序:文件浏览器 / 快捷方式 / **喜欢** / 书签 / 阅览记录 / 账号 / 设置
- `/library` URL 直接访问 → 重定向到 `/likes`
- Likes 页打开:显示 is_favorite=1 的书;空状态文案"还没有喜欢的书"
- Likes 页行内 ❤️ toggle:取消喜欢 → 行消失
- Reader 主菜单:"加入书库"按钮已删;❤️ toggle 文案"喜欢"/"取消喜欢"
- Reader ❤️ 连续 toggle:喜欢 → 取消喜欢 → 喜欢,DB library.is_favorite 翻转
- FileBrowser 三入口文案"喜欢"
- `like` 表已 DROP:`sqlite_master` 查无此表
- History / Bookmarks / Shortcuts / Settings 页不受影响

- [ ] **步骤 4:更新 AGENTS.md §当前状态表 + commit**

在 AGENTS.md §当前状态表加一行:
```
| 3.0.7 | Library → Likes 合并 | ✅ `v0.1.0-module3.0.7-likes-merge`:... (简短描述) |
```

(详细描述参考 spec §1 背景与动机)

- [ ] **步骤 5:Tag + Push**

```bash
git tag v0.1.0-module3.0.7-likes-merge
git push github main
git push github v0.1.0-module3.0.7-likes-merge
```

---

## 自检

### 规格覆盖度

| spec 章节 | 覆盖任务 |
|---|---|
| §1 背景与动机 | 不需要任务(背景) |
| §2 目标/非目标 | 不需要任务(目标) |
| §3 核心决策汇总 | 全部 11 决策在任务 1-11 体现 |
| §4.1 保留(不动) | 默认 |
| §4.2 删除(likes.rs / mod.rs / lib.rs / tauri.ts / likes.ts / likes.test.ts) | 任务 2 + 3 |
| §4.3 migration 011 | 任务 1 |
| §5.2 Likes.vue 重写 | 任务 6 |
| §5.3 router redirect | 任务 4 |
| §5.4 SideNav 顺序 | 任务 5 |
| §5.5 Bookmarks backlink | 任务 7 |
| §6.1 ReaderMainMenu 删按钮 | 任务 8 |
| §6.2 ReaderView toggleFavorite handler | 任务 9 |
| §6.3 toggle 后 UI 状态(同步 ref) | 任务 9 |
| §7 FileBrowser 三入口文案 | 任务 10 |
| §8 i18n 整理 | 任务 11 |
| §9 测试策略 | 任务 1/4/5/6/8/9 + 任务 12 全测 |
| §10.2 要改 19 项 + 1 新增 | 全部在任务 1-11 |
| §12 验证标准 | 任务 12 |

**遗漏扫描:** 无。所有 spec 需求都有对应任务。

### 占位符扫描

- 无 "TODO" / "待定"
- 任务 9 步骤 4 的 ReaderView.test.ts 测试用伪代码骨架描述,但**关键断言已明确**(setFavorite 调用序列 + book.isFavorite 翻转 + :is-liked prop 翻转),实施时按现有 mock 结构展开 — 这不算占位符
- 任务 12 步骤 4 的 AGENTS.md 描述行用 "..." 表示简短描述位置,实施时按 spec §1 实际写

### 类型一致性

- `useLibraryStore.favorites` — 任务 6 使用,store 已有(spec §5.2 确认第 16 行 computed)
- `setFavorite(bookId, favorite)` — 任务 9 使用,签名跟 lib/tauri.ts 一致(`Promise<void>`)
- `library.toggleFavorite(bookId)` — 任务 6 使用,store 已有(spec §5.2 确认第 31 行)
- `book.value` ref 类型 — 任务 9 使用 BookItem,跟 library store items 一致
- 无类型不一致

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-08-13-library-to-likes-merge.md`。两种执行方式:

**1. 子代理驱动(推荐)** - 每个任务调度一个新子代理,任务间审查,快速迭代

**2. 内联执行** - 当前会话用 executing-plans 批量执行 + 检查点

**选哪种方式?**
