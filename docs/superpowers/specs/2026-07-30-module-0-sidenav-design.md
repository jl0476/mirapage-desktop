# 模块 #0 全局导航 SideNav — MiraPage Desktop

- **日期**: 2026-07-30
- **状态**: 已批准（待规格审查）
- **相关**: [DESIGN.md](../../../DESIGN.md) §1.3（核心功能清单）+ §5（实施阶段）

## 1. 背景与目标

MiraPage Desktop 当前的导航完全缺失：

- `src/App.vue` 仅 `RouterView`，无 layout shell
- 6 个 view 各自写一个 `<RouterLink to="/">← 返回</RouterLink>` 顶在右上角（`views/{History,Library,Bookmarks,Likes,Settings,Accounts}.vue`）
- 阅读器 overlay 有 ☰ 按钮（`ReaderOverlay.vue:62`）但按下即退出阅读，无菜单
- DESIGN.md §7.2 `LocationSwitcher` 始终未实现

**目标**：提供一个稳定的左固定侧栏，承载 7 条主导航，让模块 #1 文件浏览器 / 后续模块都有共同的入口框架。

**非目标**：

- 模块 #1（文件浏览器屏幕）的实装
- 模块 #2（阅读器路由）的实装（"进入 reader 时 sidebar 隐藏"行为等 #2 路由加完才能完整测）
- 键盘快捷键（DESIGN §15，`Cmd+B` 切 sidenav — 留输入模块）
- 主题色适配（DESIGN §11 主题未做 — 留 tech debt）
- SideNav SVG / 自定义 icon（emoji Unicode 临时方案）

## 2. 核心决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| 位置 + 形态 | 左固定侧栏 | 桌面阅读器习惯（VSCode/Finder），给内容留最大水平空间 |
| 宽度 | 200px 展开 / 60px 折叠 | 行业标准（VSCode 同款），折叠仍可见 icon |
| 导航项结构 | 平铺 7 项 | 桌面阅读器目标用户用频稀疏，分组反而增加视觉噪音 |
| 折叠机制 | 顶部 ☰ 切换按钮（持久化 settings） | 用户最常见模式；持久化避免每次重开都复原 |
| 阅读器期间 | 完全隐藏 | 阅读体验至上，需要全局沉浸 |
| 状态管理 | App.vue 本地 ref + 路由 gate | 单 UI 状态不上 Pinia，避免过度抽象 |
| 选中态高亮 | Vue Router `router-link-active` 自动 | 无需手写 active 判断 |

## 3. 方案选择

采用**方案 A：App.vue gate + SideNav 本地状态**。

候选方案：

| 方案 | 结构 | 取舍 |
|---|---|---|
| **A. App.vue gate + SideNav 本地状态**（选定） | `App.vue` 模板包 `<SideNav />` + `<main>`；Sidebar 内部 ref 管 collapsed；写 `sidenav_collapsed` 到 settings | 边界最干净；~150 行组件；与未来 Pinia 升级兼容 |
| B. Pinia ui store | 新 `stores/ui.ts` 管 `sidenavCollapsed` 等 | 拓展性好，但当前 1 个开关不值得 |
| C. Route meta | `/reader` 路由加 `meta: { fullscreen: true }` | 声明式优雅，但 1 个路由不值得 |

**选 A 的理由**：模块 #0 仅 1 个 boolean 状态 + 1 个路由 gate，方案 A 是最小可用扩展；模块状态若未来增多（如全局 Cmd+B 快捷键、模态对话框开关）可平滑上 Pinia，不破坏 API。

## 4. 详细设计

### 4.1 文件结构

```
src/
├── App.vue                                    ← 改为 layout shell
├── components/
│   └── layout/                                ← 新目录
│       └── SideNav.vue                        ← 新组件
```

### 4.2 `App.vue`（改造后）

```vue
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import SideNav from '@/components/layout/SideNav.vue';
import { useSettingsStore } from '@/stores/settings';
import { useLocaleSync } from '@/composables/useLocaleSync';

const route = useRoute();
const settings = useSettingsStore();

// /reader 路由由模块 #2 注册；模块 #0 阶段 route.name !== 'reader' 恒为真
const showSideNav = computed(() => route.name !== 'reader');

useLocaleSync();
onMounted(async () => { await settings.load(); });
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
.app-root { width: 100vw; height: 100vh; overflow: hidden; }
.app-root.with-sidenav { display: flex; }
.app-main { flex: 1; height: 100%; overflow: auto; }
</style>
```

### 4.3 `SideNav.vue`

```vue
<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { getSetting, setSetting } from '@/lib/tauri';
import { useI18n } from 'vue-i18n';

interface NavItem { to: string; icon: string; labelKey: string; }
const items: NavItem[] = [
  { to: '/',          icon: '🗂', labelKey: 'nav.fileBrowser' },
  { to: '/library',   icon: '📚', labelKey: 'nav.library' },
  { to: '/bookmarks', icon: '🔖', labelKey: 'nav.bookmarks' },
  { to: '/likes',     icon: '❤', labelKey: 'nav.likes' },
  { to: '/history',   icon: '🕘', labelKey: 'nav.history' },
  { to: '/accounts',  icon: '🌐', labelKey: 'nav.accounts' },
  { to: '/settings',  icon: '⚙', labelKey: 'nav.settings' },
];

const collapsed = ref(false);
const { t } = useI18n();

onMounted(async () => {
  const stored = await getSetting('sidenav_collapsed');
  collapsed.value = stored === '1';
});

watch(collapsed, async (next) => {
  await setSetting('sidenav_collapsed', next ? '1' : '0');
});

function onToggle() {
  collapsed.value = !collapsed.value;
}
</script>

<template>
  <nav class="sidenav" :class="{ collapsed }" data-test="sidenav">
    <button
      class="toggle"
      :aria-label="t('nav.toggleSidebar')"
      data-test="sidenav-toggle"
      @click="onToggle"
    >≡</button>
    <ol class="items">
      <li v-for="item in items" :key="item.to">
        <RouterLink
          :to="item.to"
          class="item"
          active-class="active"
        >
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
.items { list-style: none; margin: 0; padding: 4px 0; }
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
.icon { width: 20px; text-align: center; font-size: 16px; }
.sidenav.collapsed .label { display: none; }
</style>
```

### 4.4 数据 / 持久化

| Key | Type | Default | 说明 |
|---|---|---|---|
| `sidenav_collapsed` | boolean | `0` (展开) | 写入值：collapsed=`'1'` / 展开=`'0'` |

DB migration 已有 8 张表 + 25 个 settings 默认值（`db/migrations.rs:115-136`），新增 key **不**走 migration，而是在代码层兜底：`useSettingsStore.load()` + `getSetting('sidenav_collapsed')` 返回 null 时用 `'0'`（与现有 settings 处理一致）。

### 4.5 i18n

现有 key 全可用，无需新增（`locales/zh-CN.ts:23-29 + en-US.ts:对应位置`）：

- `nav.fileBrowser` / `library` / `bookmarks` / `likes` / `history` / `accounts` / `settings`

**新增 1 个 key**（仅 aria-label 用）：

- `nav.toggleSidebar`: 「折叠/展开侧栏」 / "Toggle sidebar"

### 4.6 错误处理

- `getSetting('sidenav_collapsed')` 抛错（理论上不应发生，settings 命令有 `Result<Option<String>, String>` 容错）：catch 后默认 `collapsed=false`，不显示 toast（配置回退，静默）
- `setSetting(...)` 抛错：catch 后 `console.error`，UI 状态不变（用户看不到折叠会以为成功了 → 这个边界本期不处理，留作 tech debt）

### 4.7 测试策略（TDD）

**Vitest 单测**（`src/components/layout/SideNav.test.ts`，新文件）：

| 测试 | 断言 |
|---|---|
| mount 时渲染 7 个 RouterLink | 链接数 = 7，href 各为 `/`, `/library`, `/bookmarks`, `/likes`, `/history`, `/accounts`, `/settings` |
| mount 时同步读 settings | mock `getSetting('sidenav_collapsed')` 返回 `'1'` → 组件 mount 后 `collapsed=true`，`.label` 不可见 |
| 切换触发写 settings | 点击 toggle 按钮 → 调用 `setSetting('sidenav_collapsed', '1')` |
| 选中态高亮 | push 到 `/library` → `/library` 链接有 `router-link-active` 类 |
| mount 后 navigation 都可达 | 7 条链接点击都触发对应路由 push（用 vue-router mock 验证） |

**Manual 验证**：

- `npm run tauri:dev`
- 启动看到左侧栏 + 7 项
- 点击 ≡ → 折叠 icon-only
- 重启 app → 应保留折叠状态
- 路由跳转高亮跟随

### 4.8 不在本模块范围

| 项目 | 后续模块 |
|---|---|
| `/reader` 路由（让 sidebar 阅读期隐藏行为可测） | #2 |
| 文件浏览器屏幕（Home.vue 当前 placeholder） | #1 |
| ReaderScreen 集成（`router.push({ path: '/reader', ... })` 在 Library 等视图中已写但无路由） | #2 |
| 清理现有 6 view 的 `<RouterLink to="/">← 返回</RouterLink>` | 不清理，保留作为辅助返回路径 |
| 键盘快捷键（DESIGN §15 `Cmd+B` / `B` 切 sidenav） | 输入模块（DESIGN §15） |
| SideNav 主题色适配（4 套色板 — DESIGN §11） | 主题模块（tech debt） |
| 自定义 SVG icon | tech debt |

## 5. 验证清单

模块 #0 完成时跑：

| # | 命令 | 期望 |
|---|---|---|
| V1 | `npm run type-check` | 0 error（vue-tsc） |
| V2 | `npm test SideNav` | 5 个新增测试全过；既有测试无影响 |
| V3 | `npm run tauri -- build --no-bundle` | 完整 Rust 全编译（随手验证 schema 不破） |
| V4 | `npm run tauri:dev` + 手动 5 步骤（见 §4.7 manual） | sidebar 渲染 / 折叠 / 持久化 / 路由跳转 / 高亮 全 work |
