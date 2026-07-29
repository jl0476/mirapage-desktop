<script setup lang="ts">
// 占位视图：书架（Phase 4 实现）
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
</script>

<template>
  <main class="placeholder">
    <h2>{{ t('nav.library') }}</h2>
    <p class="hint">{{ $t('common.loading') }} (Phase 4)</p>
    <RouterLink to="/" class="back">← {{ t('common.back') }}</RouterLink>
  </main>
</template>

<style scoped>
.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
}
.hint { color: #888; font-size: 13px; }
.back { color: #4a9eff; text-decoration: none; font-size: 13px; }
.back:hover { text-decoration: underline; }
</style>