import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`,
}));

import { joinRel, mediaUrl } from './mediaUrl';
import type { SourceDescriptor } from './sourceDescriptor';

const local: SourceDescriptor = { type: 'local', rootPath: 'F:/comics' } as SourceDescriptor;
const webdav: SourceDescriptor = { type: 'webdav', accountId: 7, baseUrl: 'https://d.example/dav', path: '' } as SourceDescriptor;

describe('mediaUrl', () => {
  it('local：absPath 单段 encode', () => {
    expect(mediaUrl(local, 'F:/comics/vol1/001.jpg')).toBe(
      'http://media.localhost/local/' + encodeURIComponent('F:/comics/vol1/001.jpg'));
  });

  it('webdav：accountId + relPath 两段', () => {
    expect(mediaUrl(webdav, 'sub/页.jpg')).toBe(
      'http://media.localhost/webdav/7/' + encodeURIComponent('sub/页.jpg'));
  });

  it('smb：initialPath 与 relPath 各自单段（内部 / 被编码）', () => {
    const smb = { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 } as SourceDescriptor;
    const url = mediaUrl(smb, 'v1/001.jpg');
    expect(url).toBe('http://media.localhost/smb/3/' + encodeURIComponent('share/comics') + '/' + encodeURIComponent('v1/001.jpg'));
  });

  it('archive(local)：archivePath + entryPath 单段', () => {
    const ar = { type: 'archive', archivePath: 'D:/a.cbz', entryPrefix: '', format: 'cbz' } as SourceDescriptor;
    const url = mediaUrl(ar, 'inner/p1.jpg');
    expect(url).toBe('http://media.localhost/archive/local/' + encodeURIComponent('D:/a.cbz') + '/' + encodeURIComponent('inner/p1.jpg'));
  });

  it('archive(origin=local)：既有契约变体，与 origin 缺省同形态（rev4）', () => {
    const ar = {
      type: 'archive', archivePath: 'D:/a.cbz', entryPrefix: '', format: 'cbz',
      origin: { type: 'local', rootPath: 'D:/' },          // 既有 descriptor 契约允许
      originEntryPath: 'a.cbz', archiveRelPath: 'a.cbz',
    } as SourceDescriptor;
    const url = mediaUrl(ar, 'inner/p1.jpg');
    expect(url).toBe('http://media.localhost/archive/local/' + encodeURIComponent('D:/a.cbz') + '/' + encodeURIComponent('inner/p1.jpg'));
  });

  it('archive(origin=webdav/smb)：远程形态段序', () => {
    const arW = {
      type: 'archive', archivePath: 'x', entryPrefix: '', format: 'zip',
      origin: { type: 'webdav', accountId: 7, baseUrl: 'https://d', path: '' }, archiveRelPath: 'books/a.zip',
    } as SourceDescriptor;
    expect(mediaUrl(arW, 'p1.jpg')).toBe(
      'http://media.localhost/archive/webdav/7/' + encodeURIComponent('books/a.zip') + '/' + encodeURIComponent('p1.jpg'));
    const arS = {
      type: 'archive', archivePath: 'x', entryPrefix: '', format: 'zip',
      origin: { type: 'smb', accountId: 3, initialPath: 'share', path: '', port: 445 }, archiveRelPath: 'books/a.zip',
    } as SourceDescriptor;
    expect(mediaUrl(arS, 'p1.jpg')).toBe(
      'http://media.localhost/archive/smb/3/' + encodeURIComponent('share') + '/' + encodeURIComponent('books/a.zip') + '/' + encodeURIComponent('p1.jpg'));
  });

  it('含 % 文件名合法通过（rev3：100%25.jpg → 100%.jpg）', () => {
    expect(mediaUrl(webdav, '100%.jpg')).toContain(encodeURIComponent('100%.jpg'));
  });

  it('joinRel 拼接规范', () => {
    expect(joinRel('', 'a')).toBe('a');
    expect(joinRel('a', 'b')).toBe('a/b');
    expect(joinRel('a/', '/b')).toBe('a/b');
    expect(joinRel('a', '')).toBe('a');
  });
});
