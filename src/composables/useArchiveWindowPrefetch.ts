// useArchiveWindowPrefetch.ts — M3 任务 8：masonry 像素窗口 → 远程 archive 内容预载
//
// 三级预载（spec §7）的内容级：窗口内 is_archive 条目经 notifyArchiveWindow
// 推给 Rust ArchivePrefetcher 低优物化（ensure_cached_cancellable——新 epoch 即停）。
// - rel 构造与 fileBrowser.openArchive 的 relInside 一致（currentPath + name），
//   保证预载 cache_key 与用户双击打开时的强制物化命中同一缓存
// - 100ms 防抖合并快速滚动；切目录天然由新调用的新 epoch 承担取消
// - 复审修复（epoch 触发面）：空 rels / Local 源也调用（rels 恒空只推 epoch），
//   dispose 立即发一次空窗口取消——notify_window 的 new_epoch 是后端唯一取消通道，
//   空 rels 调用即取消惯用法（后端测试 epoch_bump_cancels_pending_prefetch 用
//   notify_window(2, []) 验证）；前端早退会把这条通道断掉，旧批次继续串行下载

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
  /** 停 watch + 取消 pending 防抖 + 立即发一次空窗口取消（组件 onUnmounted 调） */
  dispose: () => void;
}

export function useArchiveWindowPrefetch(
  params: ArchiveWindowPrefetchParams,
): ArchiveWindowPrefetchHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function schedule(w: ThumbnailWindows): void {
    const d = params.descriptor.value;
    const remote = d.type === 'webdav' || d.type === 'smb';
    const rels: string[] = [];
    if (remote) {
      const windowPaths = new Set([...w.visible, ...w.ahead, ...w.behind, ...w.idle]);
      for (const e of params.entries.value) {
        if (!e.isArchive || !windowPaths.has(e.path)) continue;
        rels.push(toRootRelativePath(params.currentPath.value, e.name));
      }
    }
    // Local 源 rels 恒空：不下载，但调用照发（空窗口 = 推新 epoch 取消旧批次）
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
      if (disposed) return;
      disposed = true;
      stop();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // 即时取消（不走防抖）：推一次空窗口 epoch，停掉旧批次的待开始 rels。
      // 切 details 视图 / 离开 masonry 时旧批次不再串行下载。失败静默（组件已走）。
      void notifyArchiveWindow(params.descriptor.value, [], 'content').catch(() => {
        /* 卸载取消失败无需重试 */
      });
    },
  };
}
