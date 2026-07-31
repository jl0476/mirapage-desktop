<script setup lang="ts">
/**
 * SideNav.vue
 * 模块 #0 全局导航，左固定侧栏 + 8 项导航 + 折叠
 * 规格：docs/superpowers/specs/2026-07-30-module-0-sidenav-design.md
 */
import { ref, onMounted } from 'vue';
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
  { to: '/shortcuts', icon: '⭐', labelKey: 'nav.shortcuts' },
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

async function onToggle() {
  collapsed.value = !collapsed.value;
  try {
    await setSetting('sidenav_collapsed', collapsed.value ? '1' : '0');
  } catch (e) {
    console.error('sidenav_collapsed save failed', e);
  }
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
    >
      <span class="toggle-icon" aria-hidden="true">≡</span>
    </button>

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
  width: var(--layout-sidenav-w);
  background: var(--surface-1);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  height: 100%;
  transition: width var(--dur-base) var(--ease-out);
}
.sidenav.collapsed { width: var(--layout-sidenav-w-collapsed); }

.toggle {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
.toggle:hover { background: var(--surface-2); color: var(--text-primary); }
.toggle:active { transform: translateY(1px); }
.toggle-icon { font-size: 16px; line-height: 1; }

.items {
  list-style: none;
  margin: 0;
  padding: var(--space-2) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: var(--text-base);
  font-weight: var(--weight-normal);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
.item:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}
.item:active { transform: translateY(1px); }
.item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: var(--weight-semibold);
}

.icon {
  width: 20px;
  text-align: center;
  font-size: 15px;
  flex-shrink: 0;
}

.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidenav.collapsed .label { display: none; }
.sidenav.collapsed .item { justify-content: center; padding: var(--space-2); }
.sidenav.collapsed .icon { margin: 0; }
</style>
