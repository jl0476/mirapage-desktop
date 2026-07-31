/**
 * logger.ts — 统一前端日志
 *
 * console.log → WebView2 DevTools Console (production 需 devtools feature)
 * info() → tauri-plugin-log → 文件 (默认 %APPDATA%/<id>/logs/main.log)
 *
 * 容错: 测试环境 (happy-dom, 无 Tauri runtime) 调 info() 会抛,
 * try/catch 静默吃掉, 不影响测试.
 */
import { info } from '@tauri-apps/plugin-log';

export function log(...args: unknown[]): void {
  // 控制台 (DevTools / dev mode)
  // eslint-disable-next-line no-console
  console.log(...args);
  // 文件 (production 也可读) — 容错静默 (含 promise 拒绝)
  try {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    void info(msg).catch(() => undefined);
  } catch {
    /* no-op (e.g. test 环境无 Tauri runtime) */
  }
}