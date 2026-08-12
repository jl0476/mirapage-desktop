<script setup lang="ts">
/**
 * App.vue — layout shell
 * 模块 #0 全局导航入口
 * v0.1.0-module1.17: Tailwind v4 落地, 显式 layout 尺寸
 */
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import SideNav from '@/components/layout/SideNav.vue';
import ToastHost from '@/components/common/ToastHost.vue';
import { useSettingsStore } from '@/stores/settings';
import { useLocaleSync } from '@/composables/useLocaleSync';
import { useThemeSync } from '@/composables/useThemeSync';

const route = useRoute();
const settings = useSettingsStore();

const showSideNav = computed(() => route.name !== 'reader');

useThemeSync();
useLocaleSync();
onMounted(async () => {
  await settings.load();
});
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden">
    <SideNav v-if="showSideNav" />
    <main class="flex-1 min-w-0 h-full overflow-auto">
      <RouterView />
    </main>
  </div>
  <!-- 跨卷 toast 全局挂载点 (ReaderView + FileBrowser 都可见, 单例队列共享) -->
  <ToastHost />
</template>
