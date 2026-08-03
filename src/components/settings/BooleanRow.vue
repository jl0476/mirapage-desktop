<script setup lang="ts">
defineProps<{ label: string; value: boolean }>();
const emit = defineEmits<{ (e: 'change', v: boolean): void }>();
</script>

<template>
  <label class="flex items-center justify-between gap-4 cursor-pointer">
    <span class="text-sm text-text-secondary">{{ label }}</span>
    <button
      type="button"
      :class="[
        'w-9 h-5 rounded-full transition-colors relative shrink-0',
        value ? 'bg-accent' : 'bg-surface-2 border border-white/10',
      ]"
      @click="emit('change', !value)"
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
