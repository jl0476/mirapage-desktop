/**
 * useReaderActions.ts — v0.1.0-module3.0
 * - readNow(entry): 临时 import (favorite=false)，Library 不可见，progress 仍能持久化
 * - addToLibrary(entry): 手动加入书库 (favorite=true)，Library 可见
 * - readFromImage(entry) [Cluster A]: 双击/选中图片入口, 从该图开始阅读
 *   用父目录合成 entry 调 ensureBookId, route 带 ?at=imageName
 * - readFromCurrentPath() [m3.0.8]: 顶栏「立即阅读」无选中 entry 时,
 *   从当前目录 progress 恢复阅读位置。cachedProgress 优先, 未命中走 IPC.
 *
 * 不再调 recordHistory（browse_history 已重写为 folder-level，由 FileBrowser.fetch 自动 upsert）
 *
 * **不做** (plan §6 决策):
 * - ❌ 下载全部按钮 (本地文件无下载需求)
 * - ❌ 编辑类 (新建/重命名/删除/拖放)
 *
 * v0.1.0-module3.0.3-hotfix:
 * - Bug 1: MediaEntry.path 相对 currentPath, 但 ensureBookId 之前误用为相对 rootPath,
 *   嵌套目录场景 listDirectory / recordHistory / createBook 全错. 修复: 加 getCurrentPath
 *   选项 + ensureBookId(parentPathOverride) 显式覆盖, 用 PathUtils.join 拼 absPath.
 * - Bug 2: 阅读完 router.push('/') 回到 rootPath, 丢失 currentPath. 修复: 加
 *   saveNavigationContext 选项, readNow/readFromImage 在 router.push 前存 (rootPath,
 *   currentPath), ReaderView 退出时 restore. FileBrowser.onMounted 优先 restore.
 */
import { useRouter } from 'vue-router';
import { createBook, listDirectory, recordHistory, getProgress, type CreateBookArgs, type ProgressItem } from '@/lib/tauri';
import { isImage } from '@/lib/mime';
import { naturalCompare } from '@/lib/naturalSort';
import { PathUtils } from '@/lib/path';
import { validateSourceRelativePath } from '@/lib/relativePath';
import { log } from '@/lib/logger';
import type { MediaEntry, SourceDescriptor } from '@/lib/sourceDescriptor';
import type { Router } from 'vue-router';

export interface ReaderActionsOptions {
  /** 当前列表的 rootPath (FileBrowser 顶层 root) */
  resolveRootPath: () => string;
  /** sourceDescriptor — 桌面端单 source 模式 = { type: 'local', rootPath } */
  buildSourceDescriptor: (rootPath: string) => SourceDescriptor;
  /**
   * Cluster A: FileBrowser 当前已 fetch 的目录路径 (lastFetchedPath).
   * readFromImage 用此路径作为父目录,合成 MediaEntry 走 ensureBookId.
   *
   * 路径身份修复 (2026-08-12): 返回 `string | null` 区分三种状态:
   *   - null  = 未加载 (rootPath 未设或未 fetch), readFromImage 安全 abort
   *   - ''    = 根目录已加载 (合法), createBook/history 写 ''
   *   - 'a/b' = 子目录已加载
   * 旧实现 `string` + `if (!parentPath)` 把根目录 '' 误判为未加载而 abort,
   * 或被 fallback 成绝对 rootPath 污染 library/history.
   */
  getLastFetchedPath: () => string | null;
  /**
   * v0.1.0-module3.0.3-hotfix: 当前列表所在的目录路径 (fb.currentPath, 相对 rootPath).
   * ensureBookId 用此值 + entry.path 拼出 absPath (相对 rootPath 的 IPC 路径).
   * readFromImage 不读此值 — 它显式把 parentPath 作为覆盖传给 ensureBookId,
   * 保证「图片所在目录 = 当前目录」语义绝对正确.
   */
  getCurrentPath?: () => string;
  /**
   * v0.1.0-module3.0.3-hotfix (Bug 2): 保存导航上下文 (rootPath + currentPath),
   * ReaderView 退出时调用. 通常 readNow / readFromImage 内部调用一次,
   * 在 router.push 前; 也可让 FileBrowser 显式传入.
   * 不传则跳过保存 (保持旧行为)。
   */
  saveNavigationContext?: () => void;
  /** 可选 router, 测试时手动传入; 缺省时尝试 useRouter() */
  router?: Router;
  /** 数据变化后回调 (UI 刷新 Reading/Finished 标记 / book 列表) */
  onLibraryChanged?: () => void | Promise<void>;
}

export function useReaderActions(opts: ReaderActionsOptions) {
  let router: Router | null;
  try {
    router = useRouter() ?? null;
  } catch {
    router = null;
  }
  if (!router && opts.router) router = opts.router;

  /**
   * 枚举 entry 下的图片页（供 create_book 写入封面 + 页数）
   * 失败时返 fallback（封面 null / 页数 0），不影响主流程。
   */
  async function enumerateCover(
    descriptor: SourceDescriptor,
    absPath: string,
  ): Promise<{ coverEntryPath: string | null; coverEntryName: string | null; pageCount: number }> {
    try {
      log('[useReaderActions/enumerateCover] IPC[listDirectory] →', { descriptor, absPath });
      const entries = await listDirectory(descriptor, absPath);
      log('[useReaderActions/enumerateCover] IPC[listDirectory] ←', entries.length, 'entries');
      const images = entries
        .filter((e) => !e.isDirectory && isImage(e.name))
        .sort((a, b) => naturalCompare(a.name, b.name));
      log('[useReaderActions/enumerateCover] filtered images=', images.length, images.slice(0, 3).map((i) => i.name));
      if (images.length === 0) {
        log('[useReaderActions/enumerateCover] no images at', absPath, '— book will have cover=null, pageCount=0');
        return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
      }
      const first = images[0]!;
      log('[useReaderActions/enumerateCover] picked cover=', first.name, 'pageCount=', images.length);
      return {
        coverEntryPath: first.path,
        coverEntryName: first.name,
        pageCount: images.length,
      };
    } catch (e) {
      log('[useReaderActions/enumerateCover] IPC[listDirectory] failed', absPath, e);
      return { coverEntryPath: null, coverEntryName: null, pageCount: 0 };
    }
  }

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * 复用 / 创建 bookId (Android LibraryRepository.importFromSource 行为)
   * favorite=true → is_favorite=1（Library 可见）；false → is_favorite=0（Library 不可见）
   *
   * v0.1.0-module3.0.3-hotfix:
   * - 改返回 { bookId, absPath } — recordHistory 需要 absPath (相对 rootPath 的 IPC 路径)
   * - absPath = entry.path ? PathUtils.join(currentPath, entry.path) : currentPath
   *   其中 currentPath 优先取 parentPathOverride (readFromImage 用), 否则 opts.getCurrentPath() ?? ''
   * - readFromImage 合成 parentDir.path = '' → absPath 直接 = currentPath (即 parentPath)
   */
  async function ensureBookId(
    entry: MediaEntry,
    favorite: boolean,
    parentPathOverride?: string,
  ): Promise<{ bookId: number | null; absPath: string }> {
    if (!entry.isDirectory) {
      log('[useReaderActions/ensureBookId] entry is not a directory, skip', entry.name);
      return { bookId: null, absPath: '' };
    }
    const rootPath = opts.resolveRootPath();
    const currentPath = parentPathOverride ?? opts.getCurrentPath?.() ?? '';
    const absPath = entry.path ? PathUtils.join(currentPath, entry.path) : currentPath;
    // 路径身份修复 (2026-08-12): createBook 前校验 absPath 必须 source-relative。
    // 非法（绝对/UNC/../NUL）则不写库，返回 null 中止。
    const pathCheck = validateSourceRelativePath(absPath);
    if (!pathCheck.ok) {
      log('[useReaderActions/ensureBookId] absPath 越出数据源根, 拒绝 createBook', { absPath, reason: pathCheck.reason });
      return { bookId: null, absPath: '' };
    }
    log('[useReaderActions/ensureBookId] entry=', entry.name, 'rootPath=', rootPath, 'currentPath=', currentPath, 'absPath=', absPath, 'favorite=', favorite);
    const descriptor = opts.buildSourceDescriptor(rootPath);
    const sourceType = descriptor.type === 'local' ? 'Local' : capitalize(descriptor.type);

    log('[useReaderActions/ensureBookId] IPC[listDirectory/enumerateCover] →', { descriptor, absPath });
    const cover = await enumerateCover(descriptor, absPath);
    log('[useReaderActions/ensureBookId] cover=', cover);

    try {
      const args: CreateBookArgs = {
        title: entry.name,
        sourceDescriptor: descriptor,
        absolutePath: absPath,
        sourceType,
        favorite,
        ...cover,
      };
      log('[useReaderActions/ensureBookId] IPC[createBook] →', args);
      const bookId = await createBook(args);
      log('[useReaderActions/ensureBookId] IPC[createBook] ←', favorite ? 'favorite=true' : 'favorite=false', '→ bookId', bookId);
      return { bookId, absPath };
    } catch (e) {
      log('[useReaderActions/ensureBookId] createBook failed', e);
      return { bookId: null, absPath };
    }
  }

  /**
   * 路径身份修复 (2026-08-12): recordHistory 前校验 relPath 必须 source-relative。
   * 非法则跳过 IPC（不写污染行），记 log。容错不抛。
   */
  async function safeRecordHistory(
    descriptor: SourceDescriptor,
    relPath: string,
    displayName: string,
    bookId: number | null,
  ): Promise<void> {
    const check = validateSourceRelativePath(relPath);
    if (!check.ok) {
      log('[useReaderActions/safeRecordHistory] relPath 越出数据源根, 跳过 recordHistory', { relPath, reason: check.reason });
      return;
    }
    try {
      await recordHistory(descriptor, check.normalized, displayName, bookId ?? undefined);
    } catch (e) {
      log('[useReaderActions/safeRecordHistory] recordHistory failed (容错)', e);
    }
  }

  async function readNow(entry: MediaEntry): Promise<void> {
    log('[useReaderActions] readNow called', entry.name, 'isDirectory=', entry.isDirectory);
    const { bookId, absPath } = await ensureBookId(entry, /*favorite=*/false);
    if (bookId === null) {
      log('[useReaderActions] readNow: bookId is null, abort');
      return;
    }
    // v0.1.0-module3.0.1: 进入 reader 才记录阅览（Android BrowseHistoryRepository.record 行为）
    // —— 单纯文件夹浏览不进 history。bookId 关联 library, readStatus 据此派生 reading/finished。
    const rootPath = opts.resolveRootPath();
    const descriptor = opts.buildSourceDescriptor(rootPath);
    await safeRecordHistory(descriptor, absPath, entry.name, bookId);
    if (opts.onLibraryChanged) {
      try {
        await opts.onLibraryChanged();
      } catch (e) {
        log('[useReaderActions] onLibraryChanged failed', e);
      }
    }
    // Bug 2 修复: 在 router.push 前保存导航上下文, ReaderView 退出时恢复
    if (opts.saveNavigationContext) {
      try {
        opts.saveNavigationContext();
      } catch (e) {
        log('[useReaderActions] saveNavigationContext failed (容错)', e);
      }
    }
    if (router) {
      log('[useReaderActions] readNow: router.push /reader/' + bookId);
      await router.push(`/reader/${bookId}`);
      log('[useReaderActions] readNow: pushed');
    } else {
      log('[useReaderActions] router unavailable, cannot navigate');
    }
  }

  async function addToLibrary(entry: MediaEntry): Promise<number | null> {
    log('[useReaderActions] addToLibrary called', entry.name);
    const { bookId } = await ensureBookId(entry, /*favorite=*/true);
    if (bookId !== null && opts.onLibraryChanged) {
      try {
        await opts.onLibraryChanged();
      } catch (e) {
        log('[useReaderActions] onLibraryChanged failed', e);
      }
    }
    return bookId;
  }

  /**
   * Cluster A: 双击图片 / 选中图片立即阅读入口.
   *
   * 父目录 = opts.getLastFetchedPath() (FileBrowser 当前列表所在路径).
   * 用 parent dir 合成 MediaEntry 走 ensureBookId(favorite=false),与 readNow 一致.
   * router.push 时带 ?at=imageName (encodeURIComponent),ReaderView 解析后从该图开始.
   *
   * v0.1.0-module3.0.3-hotfix:
   * - parentDir.path 改为 '' (旧值 parentPath 会让 PathUtils.join 重复拼).
   *   ensureBookId 内部 `entry.path ? join(...) : currentPath` 走 fallback 分支,
   *   absPath = currentPath = parentPath (读 From Image 时这就是图片所在目录).
   * - ensureBookId 加 parentPathOverride 显式覆盖 currentPath, 不依赖 opts.getCurrentPath().
   *   即使 FileBrowser.currentPath 尚未更新, readFromImage 也能保证 absPath 正确.
   */
  async function readFromImage(imageEntry: MediaEntry): Promise<void> {
    log('[useReaderActions] readFromImage called', imageEntry.name);
    const parentPath = opts.getLastFetchedPath();
    // 路径身份修复 (2026-08-12): 只在 null (未加载) 时 abort;
    // 根目录 '' 是合法值, 继续走 createBook/history 写 ''.
    if (parentPath === null) {
      log('[useReaderActions] readFromImage: no loaded directory (lastFetchedPath null), abort');
      return;
    }
    // 根目录 '' 时 parentName fallback 到 rootPath 最后一段; 子目录取最后一段.
    const rootPath = opts.resolveRootPath();
    const parentName = parentPath.split(/[\\/]/).filter(Boolean).pop()
      ?? rootPath.split(/[\\/]/).filter(Boolean).pop()
      ?? imageEntry.name;
    const parentDir: MediaEntry = {
      name: parentName,
      path: '',  // 改: 之前是 parentPath, 现在用空串走 ensureBookId fallback = currentPath
      isDirectory: true,
      isArchive: false,
      size: 0,
    };

    const { bookId, absPath } = await ensureBookId(parentDir, /*favorite=*/false, parentPath);
    if (bookId === null) {
      log('[useReaderActions] readFromImage: bookId is null, abort');
      return;
    }
    const descriptor = opts.buildSourceDescriptor(rootPath);
    await safeRecordHistory(descriptor, absPath, parentName, bookId);
    if (opts.onLibraryChanged) {
      try {
        await opts.onLibraryChanged();
      } catch (e) {
        log('[useReaderActions] readFromImage: onLibraryChanged failed', e);
      }
    }
    // Bug 2 修复: 在 router.push 前保存导航上下文
    if (opts.saveNavigationContext) {
      try {
        opts.saveNavigationContext();
      } catch (e) {
        log('[useReaderActions] readFromImage: saveNavigationContext failed (容错)', e);
      }
    }
    if (router) {
      const query = { at: encodeURIComponent(imageEntry.name) };
      log('[useReaderActions] readFromImage: router.push /reader/' + bookId, '?at=', imageEntry.name);
      await router.push({ path: `/reader/${bookId}`, query });
    } else {
      log('[useReaderActions] readFromImage: router unavailable, cannot navigate');
    }
  }

  /**
   * v0.1.0-...: 顶栏「立即阅读」无选中 entry 时的入口.
   *
   * 流程:
   * 1) readProgress 拿当前目录的阅读进度:
   *    - cachedProgress 命中 (有 imageName) → 短路返回.
   *    - 否则 → ensureBookId + getProgress 查后端.
   * 2) 共享前置 (两条路径都要做): 写 history + 触发 readStatus.refresh.
   *    - recordHistory 是 INSERT OR UPDATE, 幂等.
   *    - 缺这一步会导致 readStatus.refresh 拿不到 history 行, 详情/瀑布流
   *      不显示"阅读中" / "已读完" 徽章 (典型症状: '水淼 Aqua summer II').
   * 3) progress 有 imageName → 从上次阅读的那张图进入 (router.push 带 ?at=).
   * 4) progress 为 null (从未阅读) → 从第一张图开始 (走 readNow 同款链路).
   * 5) bookId null → abort (测试场景或后端异常).
   * 6) router 不存在 → 仅 log, 不抛 (测试场景友好).
   *
   * opts.getCurrentPath 缺省或根目录 currentPath='' 时, 用 localRoot (resolveRootPath)
   * 最后一段做 dirName fallback, 保证不 abort.
   *
   * 内部用 readProgress 拿进度 — 见 readProgress 注释。
   */
  async function readFromCurrentPath(
    args: { cachedProgress?: ProgressItem | null } = {},
  ): Promise<void> {
    log('[useReaderActions] readFromCurrentPath called');
    const progress = await readProgress(args.cachedProgress ?? null);

    if (opts.saveNavigationContext) {
      try {
        opts.saveNavigationContext();
      } catch (e) {
        log('[useReaderActions] readFromCurrentPath: saveNavigationContext failed (容错)', e);
      }
    }

    // ─── 共享前置: 解析 bookId / absPath / displayName + 写 history + refresh ───
    const rootPath = opts.resolveRootPath();
    const currentPath = opts.getCurrentPath?.() ?? '';
    const descriptor = opts.buildSourceDescriptor(rootPath);
    const localRoot = descriptor.type === 'local'
      ? (descriptor as { rootPath: string }).rootPath : '';

    let bookId: number | null;
    let absPath: string;
    let displayName: string;
    if (progress?.imageName) {
      // 有上次记录: 复用 progress.bookId, absPath 用当前目录
      bookId = progress.bookId;
      absPath = currentPath;
      displayName = currentPath.split(/[\\/]/).filter(Boolean).pop() || localRoot.split(/[\\/]/).filter(Boolean).pop() || 'root';
    } else {
      // 没记录: 走 ensureBookId 创建/获取 bookId
      const dirName =
        currentPath.split(/[\\/]/).filter(Boolean).pop() ||
        localRoot.split(/[\\/]/).filter(Boolean).pop() ||
        'root';
      const dirEntry: MediaEntry = {
        name: dirName, path: '', isDirectory: true,
        isArchive: false, size: 0, modifiedAt: 0,
      };
      const result = await ensureBookId(dirEntry, /*favorite=*/false);
      bookId = result.bookId;
      absPath = result.absPath;
      displayName = dirName;
    }
    if (bookId === null) {
      log('[useReaderActions] readFromCurrentPath: bookId null, abort');
      return;
    }
    await safeRecordHistory(descriptor, absPath, displayName, bookId);
    if (opts.onLibraryChanged) {
      try {
        await opts.onLibraryChanged();
      } catch (e) {
        log('[useReaderActions] readFromCurrentPath: onLibraryChanged failed', e);
      }
    }

    // ─── 跳路由 ───
    if (!router) {
      log('[useReaderActions] readFromCurrentPath: router unavailable, cannot navigate');
      return;
    }
    if (progress?.imageName) {
      // 有上次阅读 → 从该图进入
      log('[useReaderActions] readFromCurrentPath: push with ?at=', progress.imageName);
      await router.push({
        name: 'reader',
        params: { bookId: String(bookId) },
        query: { at: encodeURIComponent(progress.imageName) },
      });
      return;
    }
    // 没记录 → 从第一张开始
    log('[useReaderActions] readFromCurrentPath: push to first page /reader/' + bookId);
    await router.push(`/reader/${bookId}`);
  }

  /**
   * 纯查询版: 给 FileBrowser 在目录加载后读一次进度, 决定"立即阅读"按钮是否可点.
   *
   * 与 readFromCurrentPath 区别: 不跳路由、不调 saveNavigationContext、不依赖 router,
   * 只返回阅读进度 (或 null). cachedProgress 有 imageName 时短路返回.
   *
   * 流程:
   * 1) cachedProgress 有 imageName → 直接返回.
   * 2) 否则 → 走 ensureBookId (获取/创建图书 ID) + getProgress.
   * 3) bookId 为 null 或 getProgress.imageName 为 null → 返回 null.
   */
  async function readProgress(
    cachedProgress: ProgressItem | null,
  ): Promise<ProgressItem | null> {
    log('[useReaderActions] readProgress called', cachedProgress?.imageName);
    if (cachedProgress?.imageName) return cachedProgress;
    const rootPath = opts.resolveRootPath();
    const currentPath = opts.getCurrentPath?.() ?? '';
    const descriptor = opts.buildSourceDescriptor(rootPath);
    const localRoot = descriptor.type === 'local'
      ? (descriptor as { rootPath: string }).rootPath : '';
    const dirName =
      currentPath.split(/[\\/]/).filter(Boolean).pop() ||
      localRoot.split(/[\\/]/).filter(Boolean).pop() ||
      'root';
    const dirEntry: MediaEntry = {
      name: dirName, path: '', isDirectory: true,
      isArchive: false, size: 0, modifiedAt: 0,
    };
    const { bookId } = await ensureBookId(dirEntry, /*favorite=*/false);
    if (bookId === null) {
      log('[useReaderActions] readProgress: ensureBookId 返 null');
      return null;
    }
    const progress = await getProgress(bookId);
    return progress?.imageName ? progress : null;
  }

  return { readNow, addToLibrary, readFromImage, readFromCurrentPath, readProgress };
}