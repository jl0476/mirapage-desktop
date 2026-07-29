<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import { resolveSystemLocale } from '@/locales';

const { locale } = useI18n();
const settings = useSettingsStore();

onMounted(async () => {
  // 加载 settings
  await settings.load();

  // 应用 locale
  const target = settings.locale === 'system'
    ? resolveSystemLocale(navigator.language)
    : settings.locale;
  locale.value = target;
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