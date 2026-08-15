import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Tauri 期望一个固定端口的 dev server（默认 1420）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [vue(), tailwindcss()],

  // Vite 解析别名，方便 `@/` 引用 src/
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // 防止 vite 屏蔽 Rust 错误
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // 只监听前端模块图需要的文件，其余（Rust 侧/文档/脚本/CI/会话产物/
      // 测试素材/构建产物）统统忽略。tailwind v4 会扫描非 gitignore 文本做
      // class 检测——不忽略时改 DESIGN.md 62ms 后触发整页 reload，打断正在
      // 运行的调试会话（2026-08-16 实测）。
      ignored: [
        '**/src-tauri/**',
        '**/src-tauri-algorithm-tests/**',
        '**/*.md',
        'docs/**',
        'scripts/**',
        '.github/**',
        '.claude/**',
        '.superpowers/**',
        'samples/**',
        'test_manga/**',
        'dist/**',
        '*.exe',
        '*.log',
        '*.diff',
      ],
    },
  },

  // 预构建这些包，避免 Tauri 在开发时重新加载
  optimizeDeps: {
    exclude: ['@tauri-apps/api'],
  },

  // 环境变量
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  build: {
    // Tauri 在生产模式下使用 Chromium，因此目标设为支持 Chromium 的版本
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // 不最小化以便调试
    minify: process.env.TAURI_ENV_DEBUG ? false : ('esbuild' as const),
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  // Vitest 配置
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
  },
}));
