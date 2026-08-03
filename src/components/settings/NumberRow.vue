<script setup lang="ts">
const props = defineProps<{
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
}>();
const emit = defineEmits<{ (e: 'change', v: number): void }>();
</script>

<template>
  <label class="flex items-center justify-between gap-4">
    <span class="text-sm text-text-secondary shrink-0">{{ label }}</span>
    <div class="flex items-center gap-2">
      <input
        type="number"
        :value="value"
        :min="props.min"
        :max="props.max"
        class="w-20 bg-surface-2 border border-white/10 rounded-md text-xs px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent"
        @change="emit('change', Number(($event.target as HTMLInputElement).value))"
      />
      <span v-if="suffix" class="text-xs text-text-secondary">{{ suffix }}</span>
    </div>
  </label>
</template>
