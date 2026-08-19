/**
 * media:// 统一 URL 构造（spec rev3 §3.1）。
 * 铁律：每个逻辑字段整体 encodeURIComponent 为恰好一个 segment（字段内 `/` 被编码），
 * URL 段数固定；Rust 端 media_protocol.rs 逐段 decode 恰好一次。
 * 经 convertFileSrc(path, 'media') 转 WebView 可请求形态（Windows: http://media.localhost/...）。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { SourceDescriptor } from './sourceDescriptor';

export function joinRel(base: string, rel: string): string {
  if (!base) return rel;
  if (!rel) return base;
  return `${base}/${rel}`.replace(/\/+/g, '/');
}

function seg(s: string): string {
  return encodeURIComponent(s);
}

export function mediaUrl(descriptor: SourceDescriptor, relPath: string): string {
  switch (descriptor.type) {
    case 'local':
      // relPath 传文件绝对路径（Local 的 URL 语义 = absPath 单段）
      return convertFileSrc(`local/${seg(relPath)}`, 'media');
    case 'webdav':
      return convertFileSrc(`webdav/${descriptor.accountId}/${seg(relPath)}`, 'media');
    case 'smb':
      return convertFileSrc(`smb/${descriptor.accountId}/${seg(descriptor.initialPath)}/${seg(relPath)}`, 'media');
    case 'archive': {
      const origin = descriptor.origin;
      // rev4：origin 缺省 与 origin=local 同形态（既有契约变体——本地 ZIP 无论 origin 字段如何，
      // 读取都只依赖 archivePath；Rust 端 /archive/local/ 重建为 origin:None，语义等价）
      if (!origin || origin.type === 'local') {
        return convertFileSrc(`archive/local/${seg(descriptor.archivePath)}/${seg(relPath)}`, 'media');
      }
      if (origin.type === 'webdav') {
        return convertFileSrc(`archive/webdav/${origin.accountId}/${seg(descriptor.archiveRelPath ?? '')}/${seg(relPath)}`, 'media');
      }
      if (origin.type === 'smb') {
        return convertFileSrc(
          `archive/smb/${origin.accountId}/${seg(origin.initialPath)}/${seg(descriptor.archiveRelPath ?? '')}/${seg(relPath)}`,
          'media',
        );
      }
      // TS 穷尽检查兜底（契约加新源时编译期暴露，不静默走错分支）
      throw new Error(`mediaUrl: unsupported archive origin type: ${(origin as { type: string }).type}`);
    }
  }
}
