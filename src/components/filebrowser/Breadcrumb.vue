<script setup lang="ts">
/**
 * Breadcrumb.vue
 * 路径面包屑：每段累积路径显示，点击触发 navigate 事件
 * 与 Rust algorithm/path.rs::crumbs 镜像
 */
import { computed } from 'vue';
import { PathUtils } from '@/lib/path';

interface Props {
  /** 根标签（如 "Home" / "Library"） */
  rootLabel: string;
  /** 当前子路径（相对 root），空 = 在根 */
  path: string;
}
const props = defineProps<Props>();

interface Emits {
  /** 点击中间段或根时触发，参数为目标累积路径 */
  (e: 'navigate', toPath: string): void;
}
const emit = defineEmits<Emits>();

const crumbs = computed(() => PathUtils.crumbs(props.rootLabel, props.path));

function onCrumbClick(idx: number) {
  // 最后一段(当前)不可点击
  if (idx === crumbs.value.length - 1) return;
  emit('navigate', crumbs.value[idx].path);
}
</script>

<template>
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <ol>
      <template v-for="(c, idx) in crumbs" :key="c.path + '/' + c.label + '/' + idx">
        <li
          data-test="crumb"
          :aria-disabled="idx === crumbs.length - 1 ? 'true' : 'false'"
          :class="{ active: idx === crumbs.length - 1 }"
        >
          <a
            href="#"
            @click.prevent="onCrumbClick(idx)"
          >{{ c.label }}</a>
        </li>
        <span
          v-if="idx < crumbs.length - 1"
          class="sep"
          aria-hidden="true"
        >/</span>
      </template>
    </ol>
  </nav>
</template>

<style scoped>
.breadcrumb ol {
  display: flex;
  align-items: center;
  gap: 4px;
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 13px;
}
.breadcrumb li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.breadcrumb li a {
  color: #4a9eff;
  text-decoration: none;
  padding: 2px 4px;
  border-radius: 3px;
}
.breadcrumb li a:hover {
  background: rgba(74, 158, 255, 0.1);
  text-decoration: underline;
}
.breadcrumb li.active a {
  color: inherit;
  pointer-events: none;
  cursor: default;
}
.breadcrumb .sep {
  color: #888;
  user-select: none;
}
</style>
