/**
 * fileBrowser store — 模块 #1
 * 管理当前根目录 + 相对当前路径 + 条目列表 + loading/error
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listDirectory } from '@/lib/tauri';
import type { MediaEntry, SourceDescriptorLocal } from '@/lib/sourceDescriptor';

export type FileBrowserError =
  | { kind: 'notFound'; message: string }
  | { kind: 'permissionDenied'; message: string }
  | { kind: 'io'; message: string };

export const useFileBrowserStore = defineStore('fileBrowser', () => {
  const rootPath = ref<string | null>(null);
  const currentPath = ref<string>('');
  const entries = ref<MediaEntry[]>([]);
  const loading = ref(false);
  const error = ref<FileBrowserError | null>(null);

  function toDescriptor(root: string): SourceDescriptorLocal {
    return { type: 'local', rootPath: root };
  }

  async function fetch(path: string): Promise<void> {
    if (rootPath.value === null) return;
    loading.value = true;
    error.value = null;
    try {
      entries.value = await listDirectory(toDescriptor(rootPath.value), path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 简化：统一归为 io，后续可按消息内容分类
      error.value = { kind: 'io', message: msg };
    } finally {
      loading.value = false;
    }
  }

  async function setRoot(root: string | null): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[fileBrowser] setRoot', root);
    rootPath.value = root;
    currentPath.value = '';
    entries.value = [];
    error.value = null;
    if (root !== null) {
      await fetch('');
    }
  }

  async function navigate(path: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[fileBrowser] navigate', path);
    currentPath.value = path;
    await fetch(path);
  }

  async function refresh(): Promise<void> {
    await fetch(currentPath.value);
  }

  async function up(): Promise<void> {
    if (currentPath.value === '') return;
    const parts = currentPath.value.split(/[\\/]/).filter(Boolean);
    parts.pop();
    currentPath.value = parts.join('/');
    await fetch(currentPath.value);
  }

  return { rootPath, currentPath, entries, loading, error, setRoot, navigate, refresh, up };
});
