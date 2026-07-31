<script setup lang="ts">
/**
 * SideNav.vue
 * 模块 #0 全局导航，左固定侧栏 + 8 项导航 + 折叠
 * v0.1.0-module1.17: 全部 Tailwind utility class, 紧凑无拥挤
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
  { to: '/',          icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', labelKey: 'nav.fileBrowser' },
  { to: '/shortcuts', icon: 'M12 2l2.39 7.36H22l-6.18 4.49L18.21 22 12 17.27 5.79 4.73 2.39-8.15L4 9.36h7.61Z', labelKey: 'nav.shortcuts' },
  { to: '/library',   icon: 'M3 19V5a2 2 0 0 1 2-2h5v16H5a2 2 0 0 1-2-2Zm8-16h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-8V3Z', labelKey: 'nav.library' },
  { to: '/bookmarks', icon: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z', labelKey: 'nav.bookmarks' },
  { to: '/likes',     icon: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z', labelKey: 'nav.likes' },
  { to: '/history',   icon: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l4 2', labelKey: 'nav.history' },
  { to: '/accounts',  icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c2 0 4 4 4 8s-2 8-4 8-4-4-4-8 4-8Zm0 0a16 16 0 0 1 16 16', labelKey: 'nav.accounts' },
  { to: '/settings',  icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0a9 9 0 0 0 9-9 9 9 0 0 0-9-9', labelKey: 'nav.settings' },
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
    :class="[
      'shrink-0 h-full border-r border-[var(--color-border-subtle)] flex flex-col',
      'bg-[var(--color-surface-1)] backdrop-blur-md',
      collapsed ? 'w-[60px]' : 'w-[220px]'
    ]"
    style="transition: width 180ms cubic-bezier(0.16, 1, 0.3, 1);"
    data-test="sidenav"
  >
    <button
      type="button"
      class="w-full px-4 py-3 bg-transparent border-0 border-b border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)] cursor-pointer text-base"
      :aria-label="t('nav.toggleSidebar')"
      data-test="sidenav-toggle"
      @click="onToggle"
    >
      <span aria-hidden="true">≡</span>
    </button>

    <ol class="list-none m-0 p-2 flex flex-col gap-0.5">
      <li v-for="item in items" :key="item.to">
        <RouterLink
          :to="item.to"
          :class="[
            'flex items-center gap-3 py-1.5 px-2.5 rounded text-sm no-underline',
            'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]',
            'hover:text-[var(--color-text-primary)] active:translate-y-px',
            collapsed ? 'justify-center px-1.5' : '',
            // active-class 通过 RouterLink 自动加 'router-link-active' / 'active'
            // 用 Tailwind 的 [] 形式 + CSS @apply 不可, 直接挂 :class 链
          ]"
          active-class="active"
        >
          <svg
            class="w-[15px] h-[15px] shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="item.icon" />
          </svg>
          <span v-if="!collapsed" class="truncate">{{ $t(item.labelKey) }}</span>
        </RouterLink>
      </li>
    </ol>
  </nav>
</template>

<style>
/* Tailwind v4 utility class 已覆盖大多数样式. 这里只放不能表达的 active 态 */
nav .active,
nav .router-link-active {
  background-color: var(--color-accent-soft) !important;
  color: var(--color-accent) !important;
  font-weight: 600 !important;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.3) !important;
}
</style>
