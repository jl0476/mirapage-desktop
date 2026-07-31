/**
 * logger.ts — 前端日志 wrapper
 *
 * v0.1.0-module1.9+: 三路写入
 * 1. console.log → WebView2 DevTools Console (dev 模式 + production 需 devtools feature)
 * 2. invoke('log_to_file') → tauri command → log::write_log → main.log
 *    production exe 也能看 (前提是 Rust log.rs 已注册 log_to_file)
 * 3. (早期 v0.1.0-module1.7+ 试过 @tauri-apps/plugin-log 写文件 → 启动崩溃, 已回退)
 *
 * 用法: import { log } from '@/lib/logger'; log('[FB] click', entry.name)
 */
import { invoke } from '@tauri-apps/api/core';

export function log(...args: unknown[]): void {
  // 控制台 (DevTools / dev mode)
  // eslint-disable-next-line no-console
  console.log(...args);
  // 文件 (production 也可读) — 通过 Tauri command 转发到 Rust
  // 容错: invoke 在测试环境无 Tauri runtime 会 reject, 静默吞
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  invoke('log_to_file', { level: 'INFO', target: 'frontend', msg }).catch(() => undefined);
}