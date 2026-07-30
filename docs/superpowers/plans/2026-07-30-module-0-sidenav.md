# 模块 #0 全局导航 SideNav — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 App.vue 加 layout shell + 新增 `<SideNav>` 组件承载 7 项导航，让模块 #1 / #2 / 后续模块有共同入口框架。

**架构：** `App.vue` 路由 gate（`route.name === 'reader'` 时隐藏）；`SideNav.vue` 用本地 ref 管 collapsed，写 `sidenav_collapsed` 到 settings 表持久化；选中态用 Vue Router 内置 `router-link-active`。

**技术栈：** Vue 3 `<script setup>` + vue-router 4 + Pinia（既有 settings store）+ Vitest + happy-dom

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/components/layout/SideNav.vue` | 主组件：7 项导航 + ☰ toggle + 折叠 |
| `src/components/layout/SideNav.test.ts` | 5 个 Vitest 单测（mock `@/lib/tauri`、`vue-router`） |
| `src/App.vue` | 加 layout shell + route gate（route 名 `reader` 时 SideNav 不渲染） |
| `src/locales/zh-CN.ts` | 加 `nav.toggleSidebar` |
| `src/locales/en-US.ts` | 加 `nav.toggleSidebar` |

---

## 任务 1：i18n 新增 `nav.toggleSidebar`（前置）

**文件：**
- 修改：`src/locales/zh-CN.ts:22-30`（在 `nav` 块内追加 1 行）
- 修改：`src/locales/en-US.ts:22-30`（同上）

- [ ] **步骤 1：zh-CN.ts 加 key**

编辑 `src/locales/zh-CN.ts` 第 22-30 行附近 `nav:` 对象，在末尾追加：

```ts
    toggleSidebar: '折叠/展开 侧栏',
```

- [ ] **步骤 2：en-US.ts 加 key**

编辑 `src/locales/en-US.ts` 同样位置追加：

```ts
    toggleSidebar: 'Toggle sidebar',
```

- [ ] **步骤 3：跑 locale 测试确认双 locale key 对称**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/locales/locales.test.ts`

预期：PASS（既有 `locales.test.ts` 校验双 locale key 对称，新加的 key 双边都有就会过）

- [ ] **步骤 4：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add src/locales/zh-CN.ts src/locales/en-US.ts && \
  git commit -m "feat(i18n): 新增 nav.toggleSidebar key (模块 #0 前置)"
```

---

## 任务 2：SideNav 渲染 7 项导航 + i18n 标签（TDD）

**文件：**
- 创建：`src/components/layout/SideNav.test.ts`
- 创建：`src/components/layout/SideNav.vue`

- [ ] **步骤 1：写失败的测试 — 7 项 + 标签渲染**

新建 `src/components/layout/SideNav.test.ts`：

```ts
/**
 * SideNav 模块 #0 单测
 * 覆盖规格 §4.7 5 项测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, type Router } from 'vue-router';
import SideNav from './SideNav.vue';

// mock @/lib/tauri 三个 IPC，本任务只用 getSetting 返回 null
vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { getSetting } from '@/lib/tauri';

function makeRouter(initialRoute = '/'): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/',          name: 'home',       component: { template: '<div />' } },
      { path: '/library',   name: 'library',    component: { template: '<div />' } },
      { path: '/bookmarks', name: 'bookmarks',  component: { template: '<div />' } },
      { path: '/likes',     name: 'likes',      component: { template: '<div />' } },
      { path: '/history',   name: 'history',    component: { template: '<div />' } },
      { path: '/accounts',  name: 'accounts',   component: { template: '<div />' } },
      { path: '/settings',  name: 'settings',   component: { template: '<div />' } },
    ],
  });
}

async function mountSideNav(initialRoute = '/') {
  const router = makeRouter(initialRoute);
  router.push(initialRoute);
  await router.isReady();
  return mount(SideNav, {
    global: { plugins: [router] },
  });
}

describe('SideNav — 7 项导航', () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it('mount 渲染 7 个 RouterLink 指向 7 条路由', async () => {
    const wrapper = await mountSideNav();
    const links = wrapper.findAllComponents({ name: 'RouterLink' });
    expect(links.length).toBe(7);

    const hrefs = links.map((l) => l.props('to'));
    expect(hrefs).toEqual([
      '/',
      '/library',
      '/bookmarks',
      '/likes',
      '/history',
      '/accounts',
      '/settings',
    ]);
  });

  it('7 个项目的 label 通过 i18n key 渲染', async () => {
    const wrapper = await mountSideNav();
    const html = wrapper.html();
    // zh-CN 默认 locale 应包含中文文案
    expect(html).toContain('文件浏览');
    expect(html).toContain('书架');
    expect(html).toContain('书签');
    expect(html).toContain('喜欢');
    expect(html).toContain('阅览记录');
    expect(html).toContain('网络账户');
    expect(html).toContain('设置');
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：FAIL with "Failed to resolve import ./SideNav.vue" 或 "TypeError: Cannot read properties of undefined"

- [ ] **步骤 3：实现 SideNav.vue 最小版本（7 项 + label）**

新建 `src/components/layout/SideNav.vue`：

```vue
<script setup lang="ts">
/**
 * SideNav.vue
 * 模块 #0 全局导航，左固定侧栏 + 7 项导航 + 折叠
 * 规格：docs/superpowers/specs/2026-07-30-module-0-sidenav-design.md
 */
import { ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { getSetting, setSetting } from '@/lib/tauri';

interface NavItem {
  to: string;
  icon: string;
  labelKey: string;
}

const { t } = useI18n();
const collapsed = ref(false);

const items: NavItem[] = [
  { to: '/',          icon: '🗂', labelKey: 'nav.fileBrowser' },
  { to: '/library',   icon: '📚', labelKey: 'nav.library' },
  { to: '/bookmarks', icon: '🔖', labelKey: 'nav.bookmarks' },
  { to: '/likes',     icon: '❤', labelKey: 'nav.likes' },
  { to: '/history',   icon: '🕘', labelKey: 'nav.history' },
  { to: '/accounts',  icon: '🌐', labelKey: 'nav.accounts' },
  { to: '/settings',  icon: '⚙', labelKey: 'nav.settings' },
];

onMounted(async () => {
  try {
    const stored = await getSetting('sidenav_collapsed');
    collapsed.value = stored === '1';
  } catch {
    // 配置回退：静默默认展开
  }
});

watch(collapsed, async (next) => {
  try {
    await setSetting('sidenav_collapsed', next ? '1' : '0');
  } catch (e) {
    console.error('sidenav_collapsed save failed', e);
  }
});

function onToggle() {
  collapsed.value = !collapsed.value;
}
</script>

<template>
  <nav
    class="sidenav"
    :class="{ collapsed }"
    data-test="sidenav"
  >
    <button
      type="button"
      class="toggle"
      :aria-label="t('nav.toggleSidebar')"
      data-test="sidenav-toggle"
      @click="onToggle"
    >≡</button>

    <ol class="items">
      <li v-for="item in items" :key="item.to">
        <RouterLink :to="item.to" class="item" active-class="active">
          <span class="icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="label">{{ $t(item.labelKey) }}</span>
        </RouterLink>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.sidenav {
  width: 200px;
  background: var(--color-bg-elevated, #2a2a2a);
  border-right: 1px solid var(--color-border, #444);
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
  flex-shrink: 0;
  height: 100%;
}
.sidenav.collapsed { width: 60px; }

.toggle {
  width: 100%;
  padding: 8px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-border, #444);
  color: inherit;
  font-size: 18px;
  cursor: pointer;
}

.items {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  color: inherit;
  text-decoration: none;
  font-size: 13px;
}
.item:hover { background: rgba(74, 158, 255, 0.1); }
.item.active { background: rgba(74, 158, 255, 0.2); font-weight: 600; }

.icon {
  width: 20px;
  text-align: center;
  font-size: 16px;
}

.sidenav.collapsed .label { display: none; }
</style>
```

- [ ] **步骤 4：跑测试确认通过**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：2 个测试 PASS

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add src/components/layout/SideNav.vue src/components/layout/SideNav.test.ts && \
  git commit -m "feat(sidenav): SideNav 组件 7 项导航 + 折叠（初始实现）"
```

---

## 任务 3：mount 时同步读 `sidenav_collapsed`（TDD）

**文件：**
- 修改：`src/components/layout/SideNav.test.ts`（追加测试）
- 修改：`src/components/layout/SideNav.vue`（**任务 2 已含此逻辑，本任务只在测试侧加覆盖**）

- [ ] **步骤 1：在 SideNav.test.ts 追加测试**

编辑 `src/components/layout/SideNav.test.ts`，在第一个 `describe` 块末尾追加：

```ts
  it('mount 时同步读 sidenav_collapsed="1" → .sidenav 含 collapsed class + label 隐藏', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('1');
    const wrapper = await mountSideNav();
    // 等 onMounted 的 promise resolve
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).toContain('collapsed');

    const labels = wrapper.findAll('.label');
    expect(labels.every((el) => el.isVisible() === false)).toBe(true);
  });

  it('mount 时 getSetting 抛错 → 默认展开（容错回退）', async () => {
    vi.mocked(getSetting).mockRejectedValueOnce(new Error('ipc fail'));
    const wrapper = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).not.toContain('collapsed');
  });
```

- [ ] **步骤 2：跑测试确认失败**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：3 个测试中后 2 个 **FAIL**（任务 2 实现仅在 mount 时读，但 onMounted 的 promise 还没 resolve 时 className 已定）

- [ ] **步骤 3：检查 SideNav.vue `onMounted` 逻辑是否到位（确认任务 2 已实现）**

任务 2 的步骤 3 已含以下逻辑，无需新增：

```ts
onMounted(async () => {
  try {
    const stored = await getSetting('sidenav_collapsed');
    collapsed.value = stored === '1';
  } catch {
    // 配置回退：静默默认展开
  }
});
```

若任务 2 已提交且源码不变，跳到步骤 4。若改动过源码，确保 `onMounted` 仍包含上述 try/catch。

- [ ] **步骤 4：跑测试确认通过**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：4 个测试全 PASS（含原 2 个 + 新增 2 个）

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add src/components/layout/SideNav.test.ts && \
  git commit -m "test(sidenav): 覆盖 mount 同步读 settings + 容错回退"
```

---

## 任务 4：切换 collapse 写 settings（TDD）

**文件：**
- 修改：`src/components/layout/SideNav.test.ts`（追加测试）
- 验证：`src/components/layout/SideNav.vue`（任务 2 已含此逻辑）

- [ ] **步骤 1：在 SideNav.test.ts 追加测试**

编辑 `src/components/layout/SideNav.test.ts`，在第二个 `describe` 块或新建一个：

```ts
describe('SideNav — 折叠切换', () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it('点击 toggle 按钮 → collapsed 翻转并调用 setSetting("sidenav_collapsed", "1")', async () => {
    const wrapper = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const toggleBtn = wrapper.find('[data-test="sidenav-toggle"]');
    await toggleBtn.trigger('click');

    // 等 watch 异步触发
    await new Promise((r) => setTimeout(r, 0));

    const nav = wrapper.find('[data-test="sidenav"]');
    expect(nav.classes()).toContain('collapsed');

    const { setSetting } = await import('@/lib/tauri');
    expect(setSetting).toHaveBeenCalledWith('sidenav_collapsed', '1');
  });

  it('折叠状态下再点 toggle → setSetting 写入 "0"', async () => {
    const wrapper = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    const toggleBtn = wrapper.find('[data-test="sidenav-toggle"]');
    await toggleBtn.trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    await toggleBtn.trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    const { setSetting } = await import('@/lib/tauri');
    expect(setSetting).toHaveBeenLastCalledWith('sidenav_collapsed', '0');
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：新增 2 个 **FAIL**

- [ ] **步骤 3：验证 watch + setSetting 已在任务 2 实现**

任务 2 的 `SideNav.vue` 已含：

```ts
watch(collapsed, async (next) => {
  try {
    await setSetting('sidenav_collapsed', next ? '1' : '0');
  } catch (e) {
    console.error('sidenav_collapsed save failed', e);
  }
});
```

无需新增代码。

- [ ] **步骤 4：跑测试确认通过**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：6 个测试全 PASS

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add src/components/layout/SideNav.test.ts && \
  git commit -m "test(sidenav): 覆盖折叠切换写 settings + 往返"
```

---

## 任务 5：选中态高亮（TDD）

**文件：**
- 修改：`src/components/layout/SideNav.test.ts`（追加测试）
- 验证：`src/components/layout/SideNav.vue`

- [ ] **步骤 1：在 SideNav.test.ts 追加测试**

编辑 `src/components/layout/SideNav.test.ts` 追加：

```ts
describe('SideNav — 选中态高亮', () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it('当前路由 /library 时，/library 链接含 router-link-active 类', async () => {
    const wrapper = await mountSideNav('/library');
    await new Promise((r) => setTimeout(r, 0));

    const links = wrapper.findAllComponents({ name: 'RouterLink' });
    const libraryLink = links.find((l) => l.props('to') === '/library');
    expect(libraryLink).toBeTruthy();
    expect(libraryLink!.classes()).toContain('router-link-active');
  });

  it('当前路由 /accounts 时仅 /accounts 高亮，其它无 router-link-active', async () => {
    const wrapper = await mountSideNav('/accounts');
    await new Promise((r) => setTimeout(r, 0));

    const links = wrapper.findAllComponents({ name: 'RouterLink' });
    const activeCount = links.filter((l) =>
      l.classes().includes('router-link-active'),
    ).length;
    expect(activeCount).toBe(1);
    expect(links.find((l) => l.props('to') === '/accounts')!.classes())
      .toContain('router-link-active');
  });

  it('7 个 RouterLink 点击后触发 router.push 到对应路由', async () => {
    const wrapper = await mountSideNav();
    await new Promise((r) => setTimeout(r, 0));

    // 利用 router 实例通过 wrapper.vm 访问（vue-router 4 习惯）
    const router = (wrapper.vm as any).$.appContext.config.globalProperties.$router;
    const pushSpy = vi.spyOn(router, 'push');

    const targets = ['/', '/library', '/bookmarks', '/likes', '/history', '/accounts', '/settings'];
    const links = wrapper.findAllComponents({ name: 'RouterLink' });
    for (let i = 0; i < targets.length; i++) {
      await links[i].trigger('click');
    }

    expect(pushSpy).toHaveBeenCalledTimes(7);
    targets.forEach((t, i) => {
      expect(pushSpy).toHaveBeenNthCalledWith(i + 1, t);
    });
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：3 个新增 **FAIL**

- [ ] **步骤 3：验证 SideNav.vue 用 RouterLink（含 active-class）**

任务 2 模板已写：

```vue
<RouterLink :to="item.to" class="item" active-class="active">
```

Vue Router 4 内置同时加 `router-link-active` 与自定义 `active` 类，无需新增代码。

- [ ] **步骤 4：跑测试确认通过**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npx vitest run src/components/layout/SideNav.test.ts`

预期：9 个测试全 PASS

- [ ] **步骤 5：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add src/components/layout/SideNav.test.ts && \
  git commit -m "test(sidenav): 覆盖选中态高亮 + router push 路由"
```

---

## 任务 6：App.vue 改造为 layout shell + /reader 路由 gate

**文件：**
- 修改：`src/App.vue`（重写为 shell）

**注意**：模块 #0 阶段 `/reader` 路由尚未注册（模块 #2 任务），所以 `route.name !== 'reader'` 恒为 true，侧栏始终渲染。本模块不写 App.vue 单测——读者路由相关测试由模块 #2 提供。

- [ ] **步骤 1：重写 App.vue**

完整替换 `src/App.vue`：

```vue
<script setup lang="ts">
/**
 * App.vue — layout shell
 * 模块 #0 全局导航入口
 *   - 始终挂载 Settings + Locale
 *   - 路由名 === 'reader' 时隐藏 SideNav（让阅读器全屏沉浸）
 *   - /reader 路由由模块 #2 注册；本模块下 route.name !== 'reader' 恒为真
 *
 * 规格：docs/superpowers/specs/2026-07-30-module-0-sidenav-design.md §4.2
 */
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import SideNav from '@/components/layout/SideNav.vue';
import { useSettingsStore } from '@/stores/settings';
import { useLocaleSync } from '@/composables/useLocaleSync';

const route = useRoute();
const settings = useSettingsStore();

// 模块 #2 添加 /reader 路由后生效；当前恒为 true
const showSideNav = computed(() => route.name !== 'reader');

useLocaleSync();
onMounted(async () => {
  await settings.load();
});
</script>

<template>
  <div class="app-root" :class="{ 'with-sidenav': showSideNav }">
    <SideNav v-if="showSideNav" />
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style>
.app-root {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.app-root.with-sidenav {
  display: flex;
}
.app-main {
  flex: 1;
  height: 100%;
  overflow: auto;
  min-width: 0;
}
</style>
```

- [ ] **步骤 2：跑 type-check**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npm run type-check`

预期：0 error

- [ ] **步骤 3：跑全量 vitest 确认无回归**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npm test`

预期：所有既有 + 9 个新增 SideNav 测试全 PASS，无回归

- [ ] **步骤 4：Commit**

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add src/App.vue && \
  git commit -m "feat(app): App.vue 改 layout shell + SideNav 挂载 + /reader gate"
```

---

## 任务 7：验证 + 手动跑

- [ ] **步骤 1：完整 Vitest + type-check + Rust check + 前端 build**

运行：

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  npm run type-check && npm test && npm run build && \
  cargo check --manifest-path src-tauri/Cargo.toml && \
  cargo build --manifest-path src-tauri/Cargo.toml
```

预期：全 PASS（TS 0 error / Vitest 全过 / 前端 vite build 产 dist/ / Rust cargo check 无 error / Rust cargo build 完整编译通过）。

**为什么含 cargo build**：用户流程要求"每个模块执行完后触发编译"——`cargo check` 只做语法检查不生成机器码，`cargo build` 真正过链接 + codegen，能抓 cargo check 漏的 codegen / 链接错误。

- [ ] **步骤 2：手动起 tauri:dev**

运行：`cd F:/WorkSpaceCollection/git/mirapage-desktop && npm run tauri:dev`

预期：app 启动后看到左侧 200px 侧栏，含 7 项 + ☰ 按钮 + 顶部"文件浏览"高亮

- [ ] **步骤 3：手动 5 步交互验证**

| # | 动作 | 期望 |
|---|---|---|
| 1 | 点击 ☰ 按钮 | 侧栏缩到 60px，仅 icon |
| 2 | 再点 ☰ | 侧栏恢复 200px，label 可见 |
| 3 | 点击"书架" | 路由 push 到 `/library`，"书架"项高亮 |
| 4 | 关闭 app 重启 | 保留最后一次折叠状态 |
| 5 | 切语言（zh ↔ en），各项目 label 跟随 | zh: 文件浏览/书架/书签... ； en: File Browser/Library/Bookmarks... |

- [ ] **步骤 4：完整 Final Commit（如有微调）**

若有手动验证时的小调整（CSS/间距/i18n），单独 commit：

```bash
cd F:/WorkSpaceCollection/git/mirapage-desktop && \
  git add -u && \
  git commit -m "fix(sidenav): 手动验证微调" || echo "无微调，跳过"
```

---

## 风险点与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| vue-router `router-link-active` 在 happy-dom 默认行为可能与浏览器不同 | 测试 #5-1 选中态不通过 | 任务 5 已用 `findAllComponents({ name: 'RouterLink' })` + `classes()` 检查，happy-dom 与浏览器一致；若仍挂改用 `mount` 注入 `currentRoute` 手动设置 |
| Emoji icon 在 happy-dom 渲染为空或测试断言失败 | 测试 #5-3 `expect(html).toContain('文件浏览')` PASS 但 emoji 视觉检查需要 manual | 不在单测断言 emoji，单测只断言 label |
| `onMounted` 中 `await getSetting` 是异步，测试需手动等微任务 | 测试偶发 flaky | 统一用 `await new Promise((r) => setTimeout(r, 0))` 等待 |
| 现有 6 view 的 inline "返回"链接 与新 SideNav 同时存在造成冗余导航 | 用户混淆 | 本模块不动（spec §4.8 明确），留到后续清理 |
| Vitest 全量跑混入 App.vue 等已挂 SideNav 的组件导致既有测试 mount 失败 | 既有测试挂 | App.vue 修改只影响 top-level shell，未引入 SideNav mount 到既有 view 测试，故无回归 |

---

## 自检结果（写作时执行）

**1. 规格覆盖度**

| 规格章节 | 实现任务 |
|---|---|
| §1 背景与目标 | 任务 2-7 全部覆盖 |
| §2 核心决策 | 任务 2（位置/形态/项数/i18n）、任务 3（折叠持久化）、任务 6（/reader gate） |
| §4.2 App.vue | 任务 6 |
| §4.3 SideNav.vue | 任务 2-5 |
| §4.4 数据持久化 | 任务 3 + 4 |
| §4.5 i18n | 任务 1 |
| §4.6 错误处理 | 任务 3 容错回退测试 + 任务 4 watch 错误 console.error |
| §4.7 测试 | 任务 2-5 共 9 个测试 + 任务 7 全量验证 |

**2. 占位符扫描** — 无 "待定" / "TODO" / 模糊词

**3. 类型一致性**

- `NavItem` interface 在 SideNav.vue 任务 2 定义，测试侧未引用该类型（通过 `.find()` 取 props），无冲突
- `getSetting` / `setSetting` 来源统一来自 `@/lib/tauri`，6 处 mock 一致
- `data-test="sidenav"` / `data-test="sidenav-toggle"` 在 SideNav.vue 与 9 处测试引用一致
