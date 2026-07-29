<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/settings';
import { ref } from 'vue';

const { t } = useI18n();
const settings = useSettingsStore();

// 设置项表单（Phase 1 仅显示，后续 Phase 增补完整控件）
const languages = [
  { value: 'system', key: 'lang.system' },
  { value: 'zh-CN', key: 'lang.zh-CN' },
  { value: 'en-US', key: 'lang.en-US' },
];

const continueModes = [
  { value: 'off', key: 'reader.continue.off' },
  { value: 'auto', key: 'reader.continue.auto' },
  { value: 'manual', key: 'reader.continue.manual' },
];

async function setLocale(value: string) {
  settings.locale = value as 'system' | 'zh-CN' | 'en-US';
  await settings.update('locale', value);
}

async function setContinueMode(value: string) {
  settings.continueToNextVolume = value as 'off' | 'auto' | 'manual';
  await settings.update('continue_to_next_volume', value);
}
</script>

<template>
  <main class="settings">
    <header>
      <h2>{{ t('nav.settings') }}</h2>
      <RouterLink to="/" class="back">← {{ t('common.back') }}</RouterLink>
    </header>

    <section class="group">
      <h3>{{ t('lang.system') }}</h3>
      <label>
        <span>{{ t('lang.system') }}</span>
        <select :value="settings.locale" @change="setLocale(($event.target as HTMLSelectElement).value)">
          <option v-for="lang in languages" :key="lang.value" :value="lang.value">
            {{ $t(lang.key) }}
          </option>
        </select>
      </label>
    </section>

    <section class="group">
      <h3>{{ t('reader.continue.off') }}</h3>
      <label>
        <span>{{ t('reader.continue.off') }}</span>
        <select :value="settings.continueToNextVolume" @change="setContinueMode(($event.target as HTMLSelectElement).value)">
          <option v-for="mode in continueModes" :key="mode.value" :value="mode.value">
            {{ $t(mode.key) }}
          </option>
        </select>
      </label>
    </section>

    <p class="hint">{{ t('common.loading') }} (Phase 1 minimal UI)</p>
  </main>
</template>

<style scoped>
.settings {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}

h2 { margin: 0; font-size: 20px; }

.back { color: #4a9eff; text-decoration: none; font-size: 13px; }
.back:hover { text-decoration: underline; }

.group {
  padding: 16px;
  border: 1px solid #444;
  border-radius: 8px;
  margin-bottom: 16px;
}

.group h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
}

label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

select {
  padding: 4px 8px;
  background: #2a2a2a;
  color: inherit;
  border: 1px solid #444;
  border-radius: 4px;
}

.hint { color: #888; font-size: 12px; }
</style>