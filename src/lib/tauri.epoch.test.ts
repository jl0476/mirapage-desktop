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
import {
  beginArchiveSession,
  prepareArchive,
  unlockArchive,
  commitArchiveOpen,
  cancelArchivePrepare,
} from './tauri';
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

  it('epoch 播种 Date.now()（webview 重载不回退到 0，防预载被拒 stale）', async () => {
    await notifyArchiveWindow(webdav, [], 'content');
    const epochs = invokedEpochs();
    // 相对断言：首值在 Date.now() 时间基座量级（播种 + 一次 ++），不钉绝对值防时钟 flake
    expect(epochs[0]).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('archive access session/prepare/unlock/commit/cancel IPC', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('session/prepare/unlock/commit/cancel 使用稳定命令名且密码只放 IPC 参数', async () => {
    const descriptor = { type: 'archive', archivePath: 'C:/book.cbz', entryPrefix: '', format: 'cbz' } as const;
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId = { sessionId, sequence: 1 };
    await beginArchiveSession(sessionId, 1724000000000);
    expect(invokeMock).toHaveBeenCalledWith('begin_archive_session', { sessionId, bootMs: 1724000000000 });
    await prepareArchive(descriptor, requestId);
    expect(invokeMock).toHaveBeenCalledWith('prepare_archive', { descriptor, requestId });
    await unlockArchive(descriptor, 'secret', requestId);
    expect(invokeMock).toHaveBeenCalledWith('unlock_archive', { descriptor, password: 'secret', requestId });
    await commitArchiveOpen(requestId);
    expect(invokeMock).toHaveBeenCalledWith('commit_archive_open', { requestId });
    await cancelArchivePrepare(requestId);
    expect(invokeMock).toHaveBeenCalledWith('cancel_archive_prepare', { requestId });
    expect(JSON.stringify(descriptor)).not.toContain('secret');
  });
});
