// SourceDescriptor TypeScript 类型 + 序列化
// 与 Rust 端 `src-tauri/src/source/descriptor.rs` 字节级兼容

export type ArchiveFormat = 'cbz' | 'cbr' | 'zip' | 'rar' | '7z';

export interface SourceDescriptorLocal {
  type: 'local';
  rootPath: string;
}

export interface SourceDescriptorArchive {
  type: 'archive';
  archivePath: string;
  entryPrefix?: string;
  format: ArchiveFormat;
  origin?: SourceDescriptor;
  originEntryPath?: string;
  archiveRelPath?: string;
}

export interface SourceDescriptorSmb {
  type: 'smb';
  accountId: number;
  initialPath: string;
  path: string;
  port?: number;
}

export interface SourceDescriptorWebDav {
  type: 'webdav';
  accountId: number;
  baseUrl: string;
  path: string;
}

export type SourceDescriptor =
  | SourceDescriptorLocal
  | SourceDescriptorArchive
  | SourceDescriptorSmb
  | SourceDescriptorWebDav;

export interface MediaEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isArchive: boolean;
  size: number;
  modifiedAt?: number;
}

/**
 * 阅读状态枚举 — 目录级染色源。
 *
 * v0.1.0-module1.21: 参考 perfect-viewer `ReadStatus` 三态离散模型。
 * - none: 无历史 → 不显示
 * - reading: history 命中 + progress.finished=false → "阅读中"
 * - finished: history 命中 + progress.finished=true → "已读完"
 */
export type ReadStatus = 'none' | 'reading' | 'finished';

/** key 是 `descriptorId(desc) + '|' + relPath` */
export type ReadStatusMap = Record<string, ReadStatus>;

export function descriptorId(desc: SourceDescriptor): string {
  switch (desc.type) {
    case 'local':
      return `local://${desc.rootPath}`;
    case 'archive':
      return `archive://${desc.archivePath}`;
    case 'smb':
      return `smb://${desc.accountId}@${desc.initialPath}:${desc.port ?? 445}${desc.path}`;
    case 'webdav':
      return `webdav://${desc.accountId}@${desc.baseUrl}${desc.path}`;
  }
}

/**
 * 账户根 descriptor（module3.5.0 后续）：Accounts 页「浏览」与 FileBrowser
 * 选根菜单共用的构造——SMB 空 initialPath = share 根（M2 实机修正后的合法形态，
 * 后端 share_root_matches 放行空首段）；WebDAV 从 baseUrl 根。
 * 参数用结构类型避免反向依赖 lib/tauri 的 AccountItem。
 */
export function accountRootDescriptor(
  acct: { id: number; type: 'smb' | 'webdav'; host?: string; port?: number },
): SourceDescriptor {
  return acct.type === 'smb'
    ? { type: 'smb', accountId: acct.id, initialPath: '', path: '', port: acct.port ?? 445 }
    : { type: 'webdav', accountId: acct.id, baseUrl: acct.host ?? '', path: '' };
}