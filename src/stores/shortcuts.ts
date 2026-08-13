/**
 * shortcuts store (v0.1.0-module3.0.5: 跨源 + 子目录)
 * 持久化"目录快捷方式"列表 + 当前 active 追踪
 *
 * 对齐 Android ShortcutEntity:
 *   - 存 sourceDescriptorJson (跨源) + relPath (子目录)
 *   - iconHint 本地派生 (与 Rust 端 icon_hint_for 语义一致)
 *
 * 有意差异 (vs Android):
 *   - 保留 activeId 概念 — Android 的 shortcut 是无状态跳转目标,
 *     桌面端 active = 当前文件浏览器根, 承担 Android lastFbLocation 部分职责.
 *   - 保留独立 /shortcuts 页面 — Android 是 sheet 嵌入式, 桌面大屏用独立页面.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  listShortcuts,
  createShortcut,
  deleteShortcut,
  type ShortcutItem,
} from '@/lib/tauri';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

/** 按 descriptor 类型派生 iconHint (与 Rust 端 icon_hint_for 语义一致) */
export function iconHintFor(desc: SourceDescriptor): string {
  return desc.type;
}

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

  async function add(
    descriptor: SourceDescriptor,
    relPath: string,
    alias: string | null = null,
  ): Promise<number> {
    const sourceDescriptorJson = JSON.stringify(descriptor);
    const iconHint = iconHintFor(descriptor);
    const id = await createShortcut(sourceDescriptorJson, relPath, alias);
    // 后端 INSERT OR IGNORE：若 (descriptor, relPath) 已存在返回旧 id，
    // 本地 items 保留原条目（不重复）。若新插入，构造新条目插入 items 头部。
    if (!items.value.some((s) => s.id === id)) {
      items.value.unshift({
        id,
        sourceDescriptorJson,
        relPath,
        alias,
        iconHint,
        createdAt: Date.now(),
      });
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

  /** 清空激活态（路径身份修复 2026-08-12: openShortcut 拒绝坏 shortcut 时调用）。 */
  function clearActive(): void {
    activeId.value = null;
  }

  const active = computed<ShortcutItem | null>(() =>
    items.value.find((s) => s.id === activeId.value) ?? null,
  );

  return { items, activeId, active, loading, refresh, add, remove, setActive, clearActive };
});
