import { describe, it, expect } from 'vitest';
import { progressWriteKey } from './progressWriteKey';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

const localDesc = (rootPath: string): SourceDescriptor =>
  ({ type: 'local', rootPath }) as SourceDescriptor;

describe('progressWriteKey', () => {
  it('同输入两次调用严格相等(稳定)', () => {
    const d = localDesc('D:\\comics');
    const k1 = progressWriteKey(d, 'vol01', 'a.jpg', undefined);
    const k2 = progressWriteKey(d, 'vol01', 'a.jpg', undefined);
    expect(k1).toBe(k2);
  });

  it('Windows 路径含 \\ 和 / 不碰撞', () => {
    const d = localDesc('D:\\comics');
    const k1 = progressWriteKey(d, 'a\\b', 'x.jpg', true);
    const k2 = progressWriteKey(d, 'a/b', 'x.jpg', true);
    // a\b 与 a/b 是不同字符串, 应不同 key(不因分隔符误判相同)
    expect(k1).not.toBe(k2);
  });

  it('UNC 路径稳定', () => {
    const d = localDesc('\\\\server\\share');
    const k = progressWriteKey(d, 'sub', 'p.jpg', undefined);
    expect(typeof k).toBe('string');
    expect(k.length).toBeGreaterThan(0);
  });

  it('descriptor 含 | 字符不碰撞(结构化序列化)', () => {
    const d1 = localDesc('D:\\a|b');
    const d2 = localDesc('D:\\a');
    const k1 = progressWriteKey(d1, 'x', 'y.jpg', true);
    const k2 = progressWriteKey(d2, '|x', 'y.jpg', true);
    // 若用 | 拼接会碰撞; JSON.stringify 不会
    expect(k1).not.toBe(k2);
  });

  it('finished=undefined 与 finished=null 归一化为同一 key', () => {
    const d = localDesc('D:\\c');
    const k1 = progressWriteKey(d, 'v', 'i.jpg', undefined);
    const k2 = progressWriteKey(d, 'v', 'i.jpg', null as unknown as undefined);
    expect(k1).toBe(k2);
  });

  it('finished=true 与 finished=undefined 不同 key(升级判定基础)', () => {
    const d = localDesc('D:\\c');
    const k1 = progressWriteKey(d, 'v', 'i.jpg', true);
    const k2 = progressWriteKey(d, 'v', 'i.jpg', undefined);
    expect(k1).not.toBe(k2);
  });

  it('不同 descriptor type 不同 key', () => {
    const local = localDesc('D:\\c');
    const archive = { type: 'archive', archivePath: 'D:\\c.zip' } as SourceDescriptor;
    expect(progressWriteKey(local, 'v', 'i.jpg', true))
      .not.toBe(progressWriteKey(archive, 'v', 'i.jpg', true));
  });
});
