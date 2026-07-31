/**
 * logger.ts — 前端日志 wrapper
 *
 * v0.1.0-module1.6+: console.log (visible via devtools / dev mode).
 * v0.1.0-module1.7: 加 tauri-plugin-log 写文件, 启动崩溃, 回退.
 *                  logger 仍调用 console.log, 等待后续单独排查日志方案.
 *
 * 用法: import { log } from '@/lib/logger'; log('[FB] click', entry.name)
 */
export function log(...args: unknown[]): void {
  // 控制台 (DevTools / dev mode)
  // eslint-disable-next-line no-console
  console.log(...args);
}