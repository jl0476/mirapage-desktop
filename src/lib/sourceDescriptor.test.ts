/**
 * sourceDescriptor.ts 测试
 * 覆盖类型守卫与 descriptorId() 4 分支
 *
 * 注:Rust 端 descriptor.rs::id() SMB 实现含 `initial_path` 重复字串格式,
 * 与 TS 当前 `smb://{accountId}@{initialPath}:{port}{path}` 不一致。
 * 本测试只锁 TS 当前实现行为,Rust bug 修复时需同步两端。
 */
import { describe, it, expect } from 'vitest';
import { descriptorId } from './sourceDescriptor';
import type {
  SourceDescriptor,
  SourceDescriptorLocal,
  SourceDescriptorArchive,
  SourceDescriptorSmb,
  SourceDescriptorWebDav,
} from './sourceDescriptor';

describe('descriptorId', () => {
  it('formats local with rootPath', () => {
    const d: SourceDescriptorLocal = {
      type: 'local',
      rootPath: '/Users/me/comics',
    };
    expect(descriptorId(d)).toBe('local:///Users/me/comics');
  });

  it('formats archive with archivePath', () => {
    const d: SourceDescriptorArchive = {
      type: 'archive',
      archivePath: '/data/cbz/book.cbz',
      format: 'cbz',
    };
    expect(descriptorId(d)).toBe('archive:///data/cbz/book.cbz');
  });

  it('formats smb with default port when port omitted', () => {
    const d: SourceDescriptorSmb = {
      type: 'smb',
      accountId: 42,
      initialPath: '//nas/share',
      path: '/folder/file.jpg',
    };
    // 当前 TS 实现:`smb://{accountId}@{initialPath}:{port ?? 445}{path}`
    expect(descriptorId(d)).toBe('smb://42@//nas/share:445/folder/file.jpg');
  });

  it('formats smb with explicit port', () => {
    const d: SourceDescriptorSmb = {
      type: 'smb',
      accountId: 7,
      initialPath: '//server/share',
      path: '/x.jpg',
      port: 139,
    };
    expect(descriptorId(d)).toBe('smb://7@//server/share:139/x.jpg');
  });

  it('formats webdav with baseUrl and path', () => {
    const d: SourceDescriptorWebDav = {
      type: 'webdav',
      accountId: 3,
      baseUrl: 'https://dav.example.com',
      path: '/library/photo.jpg',
    };
    expect(descriptorId(d)).toBe('webdav://3@https://dav.example.com/library/photo.jpg');
  });
});

describe('SourceDescriptor discriminated union', () => {
  it('local variant excludes other fields', () => {
    const d: SourceDescriptor = {
      type: 'local',
      rootPath: '/x',
    };
    if (d.type !== 'local') {
      throw new Error('expected local');
    }
    expect(d.rootPath).toBe('/x');
  });

  it('archive variant carries format', () => {
    const d: SourceDescriptor = {
      type: 'archive',
      archivePath: '/a.cbz',
      format: 'cbz',
    };
    if (d.type !== 'archive') {
      throw new Error('expected archive');
    }
    expect(d.format).toBe('cbz');
  });

  it('smb variant has accountId/path/initialPath', () => {
    const d: SourceDescriptor = {
      type: 'smb',
      accountId: 1,
      initialPath: '//s/h',
      path: '/p',
    };
    if (d.type !== 'smb') {
      throw new Error('expected smb');
    }
    expect(d.accountId).toBe(1);
  });

  it('webdav variant has baseUrl + path', () => {
    const d: SourceDescriptor = {
      type: 'webdav',
      accountId: 1,
      baseUrl: 'https://x',
      path: '/y',
    };
    if (d.type !== 'webdav') {
      throw new Error('expected webdav');
    }
    expect(d.baseUrl).toBe('https://x');
  });
});
