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
    // 后端 INSERT OR IGNORE：若 rootPath 已存在返回旧 id，本地 items 保留原条目（不重复）。
    // 若新插入，构造新条目插入 items 头部（DB 按 created_at DESC 排序）。
    if (!items.value.some((s) => s.id === id)) {
      items.value.unshift({ id, rootPath, label, createdAt: Date.now() });
    }
    return id;
  }

  async function remove(id: number): Promise<void> {
    await deleteShortcut(id);
    const idx = items.value.findIndex((s) => s.id === id);
    if (idx >= 0) items.value.splice(idx, 1);
    if (activeId.value === id) activeId.value = null;
  }

  function setActive(id: number | null): void {
    activeId.value = id;
  }

  const active = computed<ShortcutItem | null>(() =>
    items.value.find((s) => s.id === activeId.value) ?? null,
  );

  return { items, activeId, active, loading, refresh, add, remove, setActive };
});
