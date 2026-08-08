/**
 * MasonryView.vue 集成守卫测试（计划任务9）
 *
 * 核心断言：MasonryView 不再构造脱离 DOM 的原图 `new Image()` 预读（缩略图队列取代）。
 * 通过读取源码字符串守卫，防止以后重新引入大图预解码（卡顿根因）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, './MasonryView.vue'), 'utf8');

describe('MasonryView.vue 集成守卫', () => {
  it('不再构造 new Image() 预读原图（缩略图队列取代）', () => {
    expect(source).not.toMatch(/new\s+Image\s*\(/);
  });

  it('接入缩略图队列 composable', () => {
    expect(source).toContain('useMasonryThumbnails');
  });

  it('使用像素窗口 thumbnailWindows（而非旧 prefetchPaths）', () => {
    expect(source).toContain('thumbnailWindows');
  });

  it('向 MasonryRow 传递缩略图状态而非原图 src', () => {
    expect(source).toContain(':thumb-state');
    expect(source).not.toMatch(/:src="v\.src"/);
  });

  it('保留 header 尺寸预读（布局骨架必需）', () => {
    expect(source).toContain('listImageDimensions');
  });
});
