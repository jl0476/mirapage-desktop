// useArchiveWindowPrefetch.ts — M3 任务 8：masonry 像素窗口 → 远程 archive 内容预载
//
// 三级预载（spec §7）的内容级：窗口内 is_archive 条目经 notifyArchiveWindow
// 推给 Rust ArchivePrefetcher 低优物化（ensure_cached_cancellable——新 epoch 即停）。
// - 仅 webdav/smb 源（物化器 origin 仅支持这两类；Local/Archive 源不发）
// - rel 构造与 fileBrowser.openArchive 的 relInside 一致（currentPath + name），
//   保证预载 cache_key 与用户双击打开时的强制物化命中同一缓存
// - 100ms 防抖合并快速滚动；切目录天然由新调用的新 epoch 承担取消

import { watch, type Ref } from 'vue';
import { notifyArchiveWindow } from '@/lib/tauri';
import { log } from '@/lib/logger';
import { toRootRelativePath, type ThumbnailWindows } from '@/composables/useMasonryLayout';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';

const DEBOUNCE_MS = 100;

export interface ArchiveWindowPrefetchParams {
  descriptor: Ref<SourceDescriptor>;
  currentPath: Ref<string>;
  entries: Ref<readonly MediaEntry[]>;
  /** 像素窗口四组 paths（useMasonryLayout.thumbnailWindows） */
  windows: Ref<ThumbnailWindows>;
}

export interface ArchiveWindowPrefetchHandle {
  /** 停 watch + 取消 pending 防抖（组件 onUnmounted 调） */
  dispose: () => void;
}

export function useArchiveWindowPrefetch(
  params: ArchiveWindowPrefetchParams,
): ArchiveWindowPrefetchHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(w: ThumbnailWindows): void {
    const d = params.descriptor.value;
    if (d.type !== 'webdav' && d.type !== 'smb') return;
    const windowPaths = new Set([...w.visible, ...w.ahead, ...w.behind, ...w.idle]);
    const rels: string[] = [];
    for (const e of params.entries.value) {
      if (!e.isArchive || !windowPaths.has(e.path)) continue;
      rels.push(toRootRelativePath(params.currentPath.value, e.name));
    }
    if (rels.length === 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void notifyArchiveWindow(d, rels, 'content').catch((e) => {
        log('[useArchiveWindowPrefetch] notifyArchiveWindow failed', e);
      });
    }, DEBOUNCE_MS);
  }

  const stop = watch(params.windows, (w) => schedule(w));

  return {
    dispose: () => {
      stop();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
