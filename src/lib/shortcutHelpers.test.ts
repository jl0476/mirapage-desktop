/**
 * shortcutHelpers 单测 (v0.1.0-module3.0.5)
 * 覆盖: decodeLocalDescriptor / shortcutFullPath / pathBasename / shortcutDisplayLabel
 */
import { describe, it, expect } from 'vitest';
import {
  decodeLocalDescriptor,
  shortcutFullPath,
  pathBasename,
  shortcutDisplayLabel,
} from './shortcutHelpers';
import type { ShortcutItem } from '@/lib/tauri';

function mk(json: string, relPath = '', alias: string | null = null): ShortcutItem {
  return {
    id: 1,
    sourceDescriptorJson: json,
    relPath,
    alias,
    iconHint: 'local',
    createdAt: 100,
  };
}
function localJson(rootPath: string): string {
  return JSON.stringify({ type: 'local', rootPath });
}

describe('decodeLocalDescriptor', () => {
  it('Local descriptor 解码成功', () => {
    const sc = mk(localJson('C:/comics'));
    const d = decodeLocalDescriptor(sc);
    expect(d).not.toBeNull();
    expect(d?.type).toBe('local');
    expect(d?.rootPath).toBe('C:/comics');
  });

  it('非 Local descriptor 返回 null (Phase 7-8 前)', () => {
    const sc = mk(JSON.stringify({ type: 'smb', accountId: 1, initialPath: 'share', path: '', port: 445 }));
    expect(decodeLocalDescriptor(sc)).toBeNull();
  });

  it('非法 JSON 返回 null', () => {
    const sc = mk('not json');
    expect(decodeLocalDescriptor(sc)).toBeNull();
  });
});

describe('shortcutFullPath', () => {
  it('根目录 shortcut (relPath="") → rootPath', () => {
    const sc = mk(localJson('D:/manga'), '');
    expect(shortcutFullPath(sc)).toBe('D:/manga');
  });

  it('子目录 shortcut → rootPath/relPath', () => {
    const sc = mk(localJson('D:/manga'), 'jujutsu/vol05');
    expect(shortcutFullPath(sc)).toBe('D:/manga/jujutsu/vol05');
  });

  it('非 Local shortcut → fallback 原始 JSON', () => {
    const json = JSON.stringify({ type: 'smb', accountId: 1, initialPath: 'share', path: '', port: 445 });
    const sc = mk(json);
    expect(shortcutFullPath(sc)).toBe(json);
  });
});

describe('pathBasename', () => {
  it('正斜杠路径取末段', () => {
    expect(pathBasename('D:/manga/jujutsu/vol05')).toBe('vol05');
  });

  it('反斜杠路径取末段', () => {
    expect(pathBasename('D:\\manga\\x')).toBe('x');
  });

  it('单段路径返回自身', () => {
    expect(pathBasename('vol05')).toBe('vol05');
  });

  it('空路径返回空字符串 (filter(Boolean) pop → ?? path)', () => {
    expect(pathBasename('')).toBe('');
  });
});

describe('shortcutDisplayLabel', () => {
  it('alias 优先', () => {
    const sc = mk(localJson('D:/manga'), 'vol05', '咒术 Vol.05');
    expect(shortcutDisplayLabel(sc)).toBe('咒术 Vol.05');
  });

  it('alias=null → fallback 完整路径 basename', () => {
    const sc = mk(localJson('D:/manga'), 'jujutsu/vol05', null);
    expect(shortcutDisplayLabel(sc)).toBe('vol05');
  });

  it('alias=null 根目录 → rootPath basename', () => {
    const sc = mk(localJson('D:/manga'), '', null);
    expect(shortcutDisplayLabel(sc)).toBe('manga');
  });
});
