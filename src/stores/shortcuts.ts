/**
 * shortcuts store — 模块 #1
 * 持久化"根目录快捷方式"列表 + 当前 active 追踪
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { listShortcuts, createShortcut, deleteShortcut, type ShortcutItem } from '@/lib/tauri';

export const useShortcutsStore = defineStore('shortcuts', () => {
  const items = ref<ShortcutItem[]>([]);
  const activeId = ref<number | null>(null);
  const loading = ref(false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      items.value = await listShortcuts();
    } finally {
      loading.value = false;
    }
  }

  async function add(rootPath: string, label: string | null = null): Promise<number> {
    const id = await createShortcut(rootPath, label);
    await refresh();
    return id;
  }

  async function remove(id: number): Promise<void> {
    await deleteShortcut(id);
    if (activeId.value === id) activeId.value = null;
    await refresh();
  }

  function setActive(id: number | null): void {
    activeId.value = id;
  }

  const active = computed<ShortcutItem | null>(() =>
    items.value.find((s) => s.id === activeId.value) ?? null,
  );

  return { items, activeId, active, loading, refresh, add, remove, setActive };
});
