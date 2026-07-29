<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { open } from '@tauri-apps/plugin-dialog';
import { useRouter } from 'vue-router';
import type { SourceDescriptorLocal } from '@/lib/sourceDescriptor';

const { t } = useI18n();
const router = useRouter();

const currentDir = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function pickDirectory() {
  try {
    loading.value = true;
    error.value = null;
    const path = await open({
      directory: true,
      multiple: false,
    });
    if (path && typeof path === 'string') {
      currentDir.value = path;
      // TODO (Phase 2): 跳转到 reader 并打开选中目录
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function goLibrary() {
  router.push('/library');
}

function goSettings() {
  router.push('/settings');
}
</script>

<template>
  <main class="home">
    <header class="hero">
      <h1>{{ t('app.name') }}</h1>
      <p class="version">v{{ t('app.version') }}</p>
    </header>

    <section class="actions">
      <button
        class="primary"
        :disabled="loading"
        @click="pickDirectory"
      >
        {{ loading ? t('common.loading') : t('fileBrowser.pickDirectory') }}
      </button>

      <button @click="goLibrary">{{ t('nav.library') }}</button>
      <button @click="goSettings">{{ t('nav.settings') }}</button>
    </section>

    <p v-if="currentDir" class="current-path">
      {{ t('fileBrowser.currentPath') }}: <code>{{ currentDir }}</code>
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <footer class="status">
      <p>{{ t('reader.mode.single') }} / {{ t('reader.mode.double') }} — OpenSeadragon</p>
    </footer>
  </main>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  gap: 24px;
}

.hero h1 {
  font-size: 32px;
  margin: 0;
  font-weight: 600;
}

.version {
  color: var(--color-muted, #888);
  margin: 4px 0 0 0;
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 12px;
}

button {
  padding: 10px 20px;
  border: 1px solid var(--color-border, #444);
  border-radius: 6px;
  background: var(--color-bg-elevated, #2a2a2a);
  color: inherit;
}

button.primary {
  background: var(--color-primary, #4a9eff);
  border-color: var(--color-primary, #4a9eff);
  color: white;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.current-path {
  font-size: 13px;
  color: var(--color-muted, #888);
}

.current-path code {
  background: var(--color-bg-elevated, #2a2a2a);
  padding: 2px 6px;
  border-radius: 3px;
}

.error {
  color: var(--color-error, #ff6b6b);
  font-size: 13px;
}

.status {
  color: var(--color-muted, #888);
  font-size: 12px;
  margin-top: auto;
}
</style>