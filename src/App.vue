<script setup lang="ts">
import { onMounted } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { useLocaleSync } from '@/composables/useLocaleSync';

const settings = useSettingsStore();

// 启动同步(把 settings.locale 写入 vue-i18n locale + watch 后续变化)
useLocaleSync();

onMounted(async () => {
  // 加载 settings（locale 已在 useLocaleSync 里被读）
  await settings.load();
});
</script>

<template>
  <div class="app-root">
    <RouterView />
  </div>
</template>

<style>
.app-root {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
</style>