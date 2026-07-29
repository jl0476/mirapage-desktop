// Tauri IPC 桥
// 集中封装所有 invoke 调用，前端代码不直接用 @tauri-apps/api

import { invoke } from '@tauri-apps/api/core';
import type { SourceDescriptor, MediaEntry } from './sourceDescriptor';

/** 读取设置项 */
export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>('get_setting', { key });
}

/** 写入设置项 */
export async function setSetting(key: string, value: string): Promise<void> {
  await invoke<void>('set_setting', { key, value });
}

/** 列出目录内容 */
export async function listDirectory(
  descriptor: SourceDescriptor,
  path: string,
): Promise<MediaEntry[]> {
  return invoke<MediaEntry[]>('list_directory', { descriptor, path });
}

/** 读取文件字节 */
export async function readFile(
  descriptor: SourceDescriptor,
  path: string,
  range?: { offset: number; length: number },
): Promise<Uint8Array> {
  const offset = range?.offset ?? null;
  const length = range?.length ?? null;
  const bytes = await invoke<number[]>('read_file', { descriptor, path, offset, length });
  return new Uint8Array(bytes);
}