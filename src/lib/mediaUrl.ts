/**
 * media:// 统一 URL 构造（spec rev3 §3.1）。
 * 铁律：每个逻辑字段整体 encode 为恰好一个 segment（字段内 `/` 被编码），
 * URL 段数固定；Rust 端 media_protocol.rs 逐段 decode 恰好一次。
 *
 * 平台分派对齐官方 convertFileSrc，但**不走 convertFileSrc**——它对 path 整体
 * encodeURIComponent，本函数的 segment 已编码，会被二次编码（%3A → %253A），
 * Rust 端 decode 一次后仍是编码态导致解析失败（任务 7 冒烟路径的实测结论）。
 */
import type { SourceDescriptor } from './sourceDescriptor';

export function joinRel(base: string, rel: string): string {
  if (!base) return rel;
  if (!rel) return base;
  return `${base}/${rel}`.replace(/\/+/g, '/');
}

function seg(s: string): string {
  return encodeURIComponent(s);
}

/** WebView 可请求形态：Windows 走 http://{scheme}.localhost（WebView2），其余 {scheme}:// */
function mediaSrc(encodedPath: string): string {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
    ? `http://media.localhost/${encodedPath}`
    : `media://localhost/${encodedPath}`;
}

export function mediaUrl(descriptor: SourceDescriptor, relPath: string): string {
  switch (descriptor.type) {
    case 'local':
      // relPath 传文件绝对路径（Local 的 URL 语义 = absPath 单段）
      return mediaSrc(`local/${seg(relPath)}`);
    case 'webdav':
      return mediaSrc(`webdav/${descriptor.accountId}/${seg(relPath)}`);
    case 'smb':
      return mediaSrc(`smb/${descriptor.accountId}/${seg(descriptor.initialPath)}/${seg(relPath)}`);
    case 'archive': {
      const origin = descriptor.origin;
      // rev4：origin 缺省 与 origin=local 同形态（既有契约变体——本地 ZIP 无论 origin 字段如何，
      // 读取都只依赖 archivePath；Rust 端 /archive/local/ 重建为 origin:None，语义等价）
      if (!origin || origin.type === 'local') {
        return mediaSrc(`archive/local/${seg(descriptor.archivePath)}/${seg(relPath)}`);
      }
      if (origin.type === 'webdav') {
        return mediaSrc(`archive/webdav/${origin.accountId}/${seg(descriptor.archiveRelPath ?? '')}/${seg(relPath)}`);
      }
      if (origin.type === 'smb') {
        return mediaSrc(
          `archive/smb/${origin.accountId}/${seg(origin.initialPath)}/${seg(descriptor.archiveRelPath ?? '')}/${seg(relPath)}`,
        );
      }
      // TS 穷尽检查兜底（契约加新源时编译期暴露，不静默走错分支）
      throw new Error(`mediaUrl: unsupported archive origin type: ${(origin as { type: string }).type}`);
    }
  }
}
