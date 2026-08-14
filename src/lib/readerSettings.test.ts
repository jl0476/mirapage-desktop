import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
} from './readerSettings';

describe('readerSettings', () => {
  it('DEFAULT_SCALE_MODE is fit-screen', () => {
    expect(DEFAULT_SCALE_MODE).toBe('fit-screen');
  });

  it('DEFAULT_READ_DIRECTION is ltr', () => {
    expect(DEFAULT_READ_DIRECTION).toBe('ltr');
  });
});
