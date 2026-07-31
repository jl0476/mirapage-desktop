/**
 * fileBrowser store — 模块 #1
 * 管理当前根目录 + 相对当前路径 + 条目列表 + loading/error
 *
 * v0.1.0-module1.12+: 加 `lastFetchedPath` 锁住"列表 base path"语义.
 * 区别于 `currentPath` (导航目标):
 *   - currentPath: 已被 navigate() 更新, 但 entries 还在拉取中
 *   - lastFetchedPath: 当前 entries 的实际生成路径 (反映用户看到列表时的状态)
 *
 * 快速连点两个目录场景: 用 lastFetchedPath 拼接, 避免把第 2 次点击
 * 当作第 1 次的子目录.
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
  /**
   * 拉当前 entries 时所在的目录路径. 反映用户看到列表时的状态.
   * 点击 entry 拼接路径时用这个, 不是 currentPath.
   */
  const lastFetchedPath = ref<string>('');
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
      lastFetchedPath.value = path; // 列表生成完, 同步 lastFetchedPath
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 简化：统一归为 io；后续可按消息内容分类
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
    lastFetchedPath.value = ''; // 根目录切换, 重置
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

  return {
    rootPath,
    currentPath,
    lastFetchedPath,
    entries,
    loading,
    error,
    setRoot,
    navigate,
    refresh,
    up,
  };
});
