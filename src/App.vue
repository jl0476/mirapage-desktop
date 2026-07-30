<script setup lang="ts">
/**
 * App.vue — layout shell
 * 模块 #0 全局导航入口
 *   - 始终挂载 Settings + Locale
 *   - 路由名 === 'reader' 时隐藏 SideNav（让阅读器全屏沉浸）
 *   - /reader 路由由模块 #2 注册；模块 #0 阶段 route.name !== 'reader' 恒为真
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
