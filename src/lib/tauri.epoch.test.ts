// 终审 P1-4：notifyArchiveWindow 的 epoch 必须每次调用严格递增——
// 旧实现取 Date.now()，快速连续调用（防抖窗内多次触发 / IPC 乱序重放）可产生
// 同毫秒重复值，后端无法区分新旧窗口身份。本用例 mock IPC 层，断言连续调用
// 发出的 epoch 严格递增（同毫秒不重复）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn(async (...args: unknown[]) => {
  void args;
  return undefined;
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  convertFileSrc: (p: string) => p,
}));

import { notifyArchiveWindow } from './tauri';
import type { SourceDescriptor } from './sourceDescriptor';

const webdav: SourceDescriptor = {
  type: 'webdav',
  accountId: 1,
  baseUrl: 'https://d/x',
  path: '',
};

function invokedEpochs(): number[] {
  return invokeMock.mock.calls.map(
    (c) => (c[1] as { epoch: number }).epoch,
  );
}

describe('notifyArchiveWindow epoch 递增计数器', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('连续调用 epoch 严格递增（同毫秒不重复）', async () => {
    await notifyArchiveWindow(webdav, [], 'content');
    await notifyArchiveWindow(webdav, [], 'content');
    await notifyArchiveWindow(webdav, ['a.cbz'], 'metadata');
    await notifyArchiveWindow(webdav, ['b.cbz'], 'content');
    const epochs = invokedEpochs();
    expect(epochs).toHaveLength(4);
    for (let i = 1; i < epochs.length; i++) {
      // 严格大于：旧 Date.now() 实现同毫秒内调用会相等，此断言钉死单调递增语义
      expect(epochs[i]).toBeGreaterThan(epochs[i - 1]);
    }
  });

  it('epoch 从 1 起（与后端 advance_epoch 单调推进配合，0 保留给初始态）', async () => {
    await notifyArchiveWindow(webdav, [], 'content');
    const epochs = invokedEpochs();
    expect(epochs[0]).toBeGreaterThanOrEqual(1);
  });
});
