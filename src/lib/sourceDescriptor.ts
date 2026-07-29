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