<script setup lang="ts">
/**
 * FileIcon.vue — 文件类型图标 (lucide 风格线条 SVG)
 *
 * 参考 Xplorer (kimlimjustin/xplorer) 文件类型彩色图标体系:
 * folder=indigo, image=green, archive=orange, file=半透白.
 * 用 currentColor 着色, 父级 .icon-folder / .icon-image / .icon-archive 控制颜色.
 *
 * 用线条 SVG 替代 emoji (Windows WebView2 emoji 渲染不一致/难看).
 */
type FileIconType = 'folder' | 'image' | 'archive' | 'file';

// size 可选（2026-08-27 masonry 占位卡用 28；默认 16 向后兼容 VirtualRow）
const props = withDefaults(defineProps<{ type: FileIconType; size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    class="file-icon"
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- folder (lucide) -->
    <template v-if="props.type === 'folder'">
      <path
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      />
    </template>
    <!-- image (lucide) -->
    <template v-else-if="props.type === 'image'">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </template>
    <!-- archive: 折叠文件 + 拉链 (lucide file-archive) -->
    <template v-else-if="props.type === 'archive'">
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M20 18v-4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4" />
      <path d="M10 12v-1" />
      <path d="M10 18v-2" />
      <path d="M10 7V6" />
      <path
        d="M15.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h3.5"
      />
    </template>
    <!-- default file (lucide file) -->
    <template v-else>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
      />
      <polyline points="14 2 14 8 20 8" />
    </template>
  </svg>
</template>

<style scoped>
.file-icon {
  flex-shrink: 0;
  transition: filter 120ms ease-out;
}
</style>
