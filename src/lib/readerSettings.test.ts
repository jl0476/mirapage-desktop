import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION, DEFAULT_READ_MODE,
  normalizeReadMode, type ReadMode,
} from './readerSettings';

describe('readerSettings', () => {
  it('DEFAULT_SCALE_MODE is fit-screen', () => {
    expect(DEFAULT_SCALE_MODE).toBe('fit-screen');
  });

  it('DEFAULT_READ_DIRECTION is ltr', () => {
    expect(DEFAULT_READ_DIRECTION).toBe('ltr');
  });

  describe('ReadMode（module3.1.0）', () => {
    it('DEFAULT_READ_MODE 是 single', () => {
      expect(DEFAULT_READ_MODE).toBe<ReadMode>('single');
    });

    it('normalizeReadMode 合法值透传', () => {
      expect(normalizeReadMode('webtoon')).toBe('webtoon');
      expect(normalizeReadMode('double')).toBe('double');
    });

    it('normalizeReadMode 非法值 fallback single', () => {
      expect(normalizeReadMode('rtl')).toBe('single');
      expect(normalizeReadMode('')).toBe('single');
    });
  });
});
