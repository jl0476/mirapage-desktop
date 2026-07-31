<script setup lang="ts">
/**
 * SideNav.vue
 * 模块 #0 全局导航，左固定侧栏 + 8 项导航 + 折叠
 *
 * v0.1.0-module1.19: 真·Tailwind utility class (移除 bg-[var(--color-*)] arbitrary 形式,
 *                  因为 Tailwind v4 不编译 var() arbitrary → 全部失效 → 视觉没变)
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
  { to: '/history',   icon: 'M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', labelKey: 'nav.history' },
  { to: '/accounts',  icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', labelKey: 'nav.accounts' },
  { to: '/settings',  icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', labelKey: 'nav.settings' },
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
      'shrink-0 h-full flex flex-col overflow-hidden',
      'border-r border-white/10 bg-surface-1 backdrop-blur-md',
      collapsed ? 'w-[60px]' : 'w-[220px]',
    ]"
    style="transition: width 180ms cubic-bezier(0.16, 1, 0.3, 1);"
    data-test="sidenav"
  >
    <!-- 折叠 / 展开 toggle (顶部) -->
    <button
      type="button"
      class="shrink-0 flex items-center justify-center border-0 border-b border-white/10 bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary cursor-pointer text-base transition-colors duration-100"
      :class="collapsed ? 'h-12' : 'h-10 justify-start pl-4'"
      :aria-label="t('nav.toggleSidebar')"
      data-test="sidenav-toggle"
      @click="onToggle"
    >
      <!-- 折叠态: 横向 hamburger; 展开态: 左对齐文字 -->
      <svg
        v-if="collapsed"
        width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true"
      >
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
      <span v-else class="text-sm font-medium">≡  {{ t('nav.toggleSidebar') }}</span>
    </button>

    <!-- 导航项列表 -->
    <ol class="flex-1 list-none m-0 p-2 flex flex-col gap-0.5 overflow-y-auto">
      <li v-for="item in items" :key="item.to">
        <RouterLink
          :to="item.to"
          :class="[
            'flex items-center gap-2.5 rounded-md text-sm no-underline select-none',
            'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
            'transition-[background,color,transform] duration-100',
            'active:translate-y-px',
            collapsed ? 'h-9 justify-center px-0' : 'h-9 px-2.5',
          ]"
          active-class="is-active"
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
          <span v-if="!collapsed" class="truncate font-medium">{{ $t(item.labelKey) }}</span>
        </RouterLink>
      </li>
    </ol>

    <!-- 底部留白 (填充剩余空间) -->
    <div class="shrink-0 h-2" />
  </nav>
</template>

<style>
/* RouterLink active 态: indigo 软背景 + accent 文本 + 微 glow */
nav .is-active,
nav .router-link-active {
  background-color: rgb(99 102 241 / 0.18);
  color: rgb(129 140 248);
  box-shadow: 0 0 12px -2px rgb(99 102 241 / 0.35);
  border-left: 2px solid rgb(129 140 248);
}
nav .is-active svg,
nav .router-link-active svg {
  color: rgb(129 140 248);
}
</style>
