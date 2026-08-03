/**
 * tailwind.css light theme token override smoke test
 * v0.1.0-module3.0-settings: 验证浅色 token 在 :root:not(.dark) 块生效
 * (xplorer-next 1:1 迁移)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('tailwind.css light theme', () => {
  const css = readFileSync(
    resolve(__dirname, 'tailwind.css'),
    'utf-8',
  );

  it('declares :root:not(.dark) block with light token overrides', () => {
    expect(css).toMatch(/:root:not\(\.dark\)/);
    expect(css).toMatch(/--color-bg/);
  });

  it('light accent is blue-500 (#3b82f6) from xplorer-next', () => {
    // 找 :root:not(.dark) 块内的 --color-accent
    const block = css.match(/:root:not\(\.dark\)\s*\{[^}]+\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/--color-accent:\s*#3b82f6/);
  });

  it('light text-primary is slate-800 (#1e293b)', () => {
    const block = css.match(/:root:not\(\.dark\)\s*\{[^}]+\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/--color-text-primary:\s*#1e293b/);
  });

  it('light body uses solid white (no gradient)', () => {
    expect(css).toMatch(/:root:not\(\.dark\)\s+body\s*\{[^}]*background-image:\s*none/);
  });

  it('dark mode defaults preserved (Tokyo Night @theme block intact)', () => {
    // @theme 块定义 dark color tokens
    expect(css).toMatch(/--color-surface-1:\s*rgba\(17,\s*17,\s*34/);
  });
});