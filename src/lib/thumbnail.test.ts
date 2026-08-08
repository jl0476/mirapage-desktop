import { describe, it, expect } from 'vitest';
import {
  resolveThumbnailPreset,
  normalizeWorkerLimit,
  normalizeDecodeMemoryMb,
  normalizeCacheLimitMb,
  THUMBNAIL_SIZE_BUCKETS,
  DEFAULT_THUMBNAIL_RESOURCE_MODE,
  DEFAULT_THUMBNAIL_QUALITY,
  type ThumbnailResourceMode,
  type ThumbnailQuality,
  type ThumbnailPriority,
  type ThumbnailRequestItem,
  type ThumbnailState,
  type ThumbnailPreset,
  type ThumbnailSizeBucket,
} from './thumbnail';

describe('thumbnail protocol', () => {
  describe('resolveThumbnailPreset', () => {
    it('balanced 预设对齐设计文档 §8.1', () => {
      expect(resolveThumbnailPreset('balanced')).toEqual({
        workerLimit: 2,
        decodeMemoryMb: 128,
        prefetchScreens: 1.5,
        idleGeneration: true,
        idlePrefetchScreens: 1,
      });
    });

    it('powerSaver 预设：1 worker / 64MB / 0.5屏 / 关闭空闲生成', () => {
      expect(resolveThumbnailPreset('powerSaver')).toEqual({
        workerLimit: 1,
        decodeMemoryMb: 64,
        prefetchScreens: 0.5,
        idleGeneration: false,
        idlePrefetchScreens: 0,
      });
    });

    it('performance 预设：3 worker / 256MB / 2.5屏 / 空闲额外 2 屏', () => {
      expect(resolveThumbnailPreset('performance')).toEqual({
        workerLimit: 3,
        decodeMemoryMb: 256,
        prefetchScreens: 2.5,
        idleGeneration: true,
        idlePrefetchScreens: 2,
      });
    });

    it('custom 没有固定预设，返回 null', () => {
      expect(resolveThumbnailPreset('custom')).toBeNull();
    });
  });

  describe('normalizeWorkerLimit', () => {
    it('低于下界钳到 1', () => {
      expect(normalizeWorkerLimit(0)).toBe(1);
      expect(normalizeWorkerLimit(-3)).toBe(1);
    });

    it('高于上界钳到 4（第一阶段 Local 不允许超过 4）', () => {
      expect(normalizeWorkerLimit(9)).toBe(4);
      expect(normalizeWorkerLimit(100)).toBe(4);
    });

    it('合法值原样返回', () => {
      expect(normalizeWorkerLimit(1)).toBe(1);
      expect(normalizeWorkerLimit(2)).toBe(2);
      expect(normalizeWorkerLimit(3)).toBe(3);
      expect(normalizeWorkerLimit(4)).toBe(4);
    });
  });

  describe('normalizeDecodeMemoryMb', () => {
    it('snap 到最近的合法档位 {64,128,256,512}', () => {
      // 129 离 128 最近（差 1），离 256 差 127
      expect(normalizeDecodeMemoryMb(129)).toBe(128);
      // 200 离 256（差 56）比离 128（差 72）近
      expect(normalizeDecodeMemoryMb(200)).toBe(256);
    });

    it('低于最小档位钳到 64', () => {
      expect(normalizeDecodeMemoryMb(0)).toBe(64);
      expect(normalizeDecodeMemoryMb(10)).toBe(64);
    });

    it('高于最大档位钳到 512', () => {
      expect(normalizeDecodeMemoryMb(1000)).toBe(512);
    });

    it('合法档位原样返回', () => {
      expect(normalizeDecodeMemoryMb(64)).toBe(64);
      expect(normalizeDecodeMemoryMb(128)).toBe(128);
      expect(normalizeDecodeMemoryMb(256)).toBe(256);
      expect(normalizeDecodeMemoryMb(512)).toBe(512);
    });
  });

  describe('normalizeCacheLimitMb', () => {
    it('低于最小 128MB 钳到 128', () => {
      expect(normalizeCacheLimitMb(1)).toBe(128);
      expect(normalizeCacheLimitMb(0)).toBe(128);
      expect(normalizeCacheLimitMb(-50)).toBe(128);
    });

    it('不设上界（用户自定义大容量允许）', () => {
      expect(normalizeCacheLimitMb(128)).toBe(128);
      expect(normalizeCacheLimitMb(512)).toBe(512);
      expect(normalizeCacheLimitMb(2048)).toBe(2048);
    });
  });

  describe('协议常量', () => {
    it('尺寸档位升序且为设计文档定义的固定值', () => {
      expect(THUMBNAIL_SIZE_BUCKETS).toEqual([512, 768, 1024, 1536, 2048]);
    });

    it('默认资源模式与清晰度', () => {
      expect(DEFAULT_THUMBNAIL_RESOURCE_MODE).toBe('balanced');
      expect(DEFAULT_THUMBNAIL_QUALITY).toBe('high');
    });
  });

  describe('类型契约（编译期断言）', () => {
    it('ThumbnailRequestItem 字段对齐 §13.2 + 计划任务1', () => {
      const item: ThumbnailRequestItem = {
        path: 'a.jpg',
        sourceRelPath: 'normal/a.jpg',
        fileSize: 5_000_000,
        modifiedAt: 1700000000,
        sourceWidth: 4000,
        sourceHeight: 3000,
        requiredWidth: 768,
        priority: 'visible',
      };
      expect(item.requiredWidth).toBe(768);
    });

    it('ThumbnailState 联合覆盖 6 种卡片状态', () => {
      const states: ThumbnailState[] = [
        { kind: 'original', url: 'asset://localhost/a.jpg' },
        { kind: 'cached', cacheKey: 'k1', path: 'C:/cache/v1/ab/k1.webp', width: 768, height: 576 },
        { kind: 'queued', cacheKey: 'k1' },
        { kind: 'generating', cacheKey: 'k1' },
        { kind: 'failed', cacheKey: 'k1', retryable: true, message: 'decode error' },
        { kind: 'unsupported' },
      ];
      expect(states).toHaveLength(6);
    });

    it('优先级四档', () => {
      const priorities: ThumbnailPriority[] = ['visible', 'ahead', 'behind', 'idle'];
      expect(priorities).toHaveLength(4);
    });

    it('Preset 字段名与 balanced 断言一致', () => {
      const preset: ThumbnailPreset | null = resolveThumbnailPreset('balanced');
      expect(preset).not.toBeNull();
    });

    it('资源模式 / 清晰度 / 档位枚举类型可构造', () => {
      const mode: ThumbnailResourceMode = 'balanced';
      const quality: ThumbnailQuality = 'high';
      const bucket: ThumbnailSizeBucket = 512;
      expect(mode).toBe('balanced');
      expect(quality).toBe('high');
      expect(bucket).toBe(512);
      // 档位属于固定集合
      expect(THUMBNAIL_SIZE_BUCKETS).toContain(bucket);
    });
  });
});
