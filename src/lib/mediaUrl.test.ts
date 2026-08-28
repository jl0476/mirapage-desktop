import { afterEach, describe, expect, it, vi } from 'vitest';

// 锁定 Windows WebView2 形态（http://media.localhost/...）；happy-dom 默认 UA 不含 Windows
vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });

import { joinRel, mediaUrl } from './mediaUrl';
import type { SourceDescriptor } from './sourceDescriptor';

afterEach(() => {
  vi.clearAllMocks();
});

const local: SourceDescriptor = { type: 'local', rootPath: 'F:/comics' } as SourceDescriptor;
const webdav: SourceDescriptor = { type: 'webdav', accountId: 7, baseUrl: 'https://d.example/dav', path: '' } as SourceDescriptor;

describe('mediaUrl', () => {
  it('local：absPath 单段 encode', () => {
    expect(mediaUrl(local, 'F:/comics/vol1/001.jpg')).toBe(
      'http://media.localhost/local/' + encodeURIComponent('F:/comics/vol1/001.jpg'));
  });

  it('local：Windows 反斜杠绝对路径完整编码为单段', () => {
    expect(mediaUrl(local, String.raw`C:\comics\001.jpg`)).toBe(
      'http://media.localhost/local/' + encodeURIComponent(String.raw`C:\comics\001.jpg`));
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

describe('mediaUrl smb 分支换算', () => {
  // 空 initialPath + share 前缀 relPath（实机 403 形态）→ 首段补位
  it('initialPath 空时取 relPath 首段作 initial、剩余作 rel', () => {
    const url = mediaUrl(
      { type: 'smb', accountId: 2, initialPath: '', path: '', port: 445 },
      'H/00down/2504/1 (31).jpg',
    );
    expect(url).toBe('http://media.localhost/smb/2/H/' + encodeURIComponent('00down/2504/1 (31).jpg'));
  });
  // initialPath 非空 → relPath 剥前缀
  it('initialPath 非空时 relPath 剥离 initialPath 前缀', () => {
    const url = mediaUrl(
      { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 },
      'share/comics/v1/001.jpg',
    );
    expect(url).toBe('http://media.localhost/smb/3/' + encodeURIComponent('share/comics') + '/' + encodeURIComponent('v1/001.jpg'));
  });
  // 前缀不匹配 → 不剥（防御：返回原样，让 Rust 403 并留日志）
  it('relPath 不以 initialPath 开头时不剥离', () => {
    const url = mediaUrl(
      { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 },
      'other/dir/1.jpg',
    );
    expect(url.endsWith('/' + encodeURIComponent('other/dir/1.jpg'))).toBe(true);
  });
  // R1 P0-1：archive-SMB share 根（origin.initialPath 空 + archiveRelPath 带前缀）同款换算
  it('archive smb 分支：origin.initialPath 空时 archiveRelPath 首段补位、entry 原样', () => {
    const url = mediaUrl(
      { type: 'archive', archivePath: '', entryPrefix: '', format: 'cbz', origin: { type: 'smb', accountId: 2, initialPath: '', path: '', port: 445 }, archiveRelPath: 'H/books/a.cbz' },
      'p1.jpg',
    );
    expect(url).toBe('http://media.localhost/archive/smb/2/H/' + encodeURIComponent('books/a.cbz') + '/' + encodeURIComponent('p1.jpg'));
  });
  it('archive smb 分支：origin.initialPath 非空时剥前缀', () => {
    const url = mediaUrl(
      { type: 'archive', archivePath: '', entryPrefix: '', format: 'cbz', origin: { type: 'smb', accountId: 2, initialPath: 'H/books', path: '', port: 445 }, archiveRelPath: 'H/books/a.cbz' },
      'p1.jpg',
    );
    expect(url).toBe('http://media.localhost/archive/smb/2/' + encodeURIComponent('H/books') + '/' + encodeURIComponent('a.cbz') + '/' + encodeURIComponent('p1.jpg'));
  });
  // local/webdav 分支回归不受影响
  it('local 与 webdav 分支不受影响', () => {
    expect(mediaUrl({ type: 'local', rootPath: 'D:/x' }, 'D:/comics/1.jpg'))
      .toBe('http://media.localhost/local/' + encodeURIComponent('D:/comics/1.jpg'));
    expect(mediaUrl({ type: 'webdav', accountId: 7, baseUrl: 'https://h:5006/home', path: '' }, 'sub/1.jpg'))
      .toBe('http://media.localhost/webdav/7/' + encodeURIComponent('sub/1.jpg'));
  });
});
