<script setup lang="ts">
// v0.1.0-module3.0.8 (任务 12): 支持 disabled + description
// - 父开关关闭时禁用子开关（restoreBrowsePositionOnEnter 的 BooleanRow :disabled="!recordBrowsePosition"）
// - description: 开关下方的说明文字（可选）
// - data-test 通过 $attrs 自动 fallthrough 到根 <label>
defineProps<{ label: string; value: boolean; disabled?: boolean; description?: string }>();
const emit = defineEmits<{ (e: 'change', v: boolean): void }>();
</script>

<template>
  <label
    class="flex items-start justify-between gap-4"
    :class="disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'"
  >
    <span class="flex flex-col gap-0.5">
      <span class="text-sm text-text-secondary">{{ label }}</span>
      <span v-if="description" class="text-xs text-text-tertiary">{{ description }}</span>
    </span>
    <button
      type="button"
      :disabled="disabled"
      :class="[
        'w-9 h-5 rounded-full transition-colors relative shrink-0 mt-0.5',
        value ? 'bg-accent' : 'bg-surface-2 border border-white/10',
      ]"
      @click="disabled ? undefined : emit('change', !value)"
    >
      <span
        :class="[
          'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
          value ? 'translate-x-[18px]' : 'translate-x-0.5',
        ]"
      />
    </button>
  </label>
</template>
