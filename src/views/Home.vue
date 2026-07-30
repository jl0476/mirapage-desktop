<script setup lang="ts">
/**
 * Home.vue — 模块 #1
 * Thin wrapper 挂载 FileBrowser 主屏
 * 规格：docs/superpowers/specs/2026-07-30-module-1-file-browser-design.md §4.9
 */
import FileBrowser from '@/components/filebrowser/FileBrowser.vue';
</script>

<template>
  <main class="file-browser-view">
    <FileBrowser />
  </main>
</template>

<style scoped>
.file-browser-view {
  height: 100%;
  overflow: hidden;
}
</style>
