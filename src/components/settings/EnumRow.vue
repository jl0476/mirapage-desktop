<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}>();
const emit = defineEmits<{ (e: 'change', v: string): void }>();
</script>

<template>
  <label class="flex items-center justify-between gap-4">
    <span class="text-sm text-text-secondary shrink-0">{{ label }}</span>
    <div class="relative" data-test="enum-select">
      <select
        :value="value"
        class="bg-surface-2 border border-white/10 rounded-md text-xs px-3 py-1.5 text-text-primary hover:border-white/20 focus:outline-none focus:border-accent transition-colors cursor-pointer min-w-[170px]"
        @change="emit('change', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in options" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>
  </label>
</template>
