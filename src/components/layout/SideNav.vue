<script setup lang="ts">
/**
 * SideNav.vue
 * 模块 #0 全局导航，左固定侧栏 + 7 项导航 + 折叠
 * 规格：docs/superpowers/specs/2026-07-30-module-0-sidenav-design.md
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

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
