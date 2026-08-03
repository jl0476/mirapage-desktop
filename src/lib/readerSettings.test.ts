import { describe, it, expect } from 'vitest';
import {
  TOUCH_ZONES, TOUCH_ACTIONS,
  DEFAULT_TOUCH_SCHEME,
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
} from './readerSettings';

describe('readerSettings', () => {
  it('TOUCH_ZONES covers all 9 cells in row-major order', () => {
    expect(TOUCH_ZONES).toEqual([
      'tl','tm','tr','ml','mm','mr','bl','bm','br',
    ]);
  });

  it('TOUCH_ACTIONS exposes 11 actions (toggle-chrome hidden)', () => {
    expect(TOUCH_ACTIONS).toHaveLength(11);
    expect(TOUCH_ACTIONS).not.toContain('toggle-chrome');
    expect(TOUCH_ACTIONS).toContain('fit-width');
    expect(TOUCH_ACTIONS).toContain('open-file-browser');
  });

  it('DEFAULT_TOUCH_SCHEME aligns with PerfectViewer TouchScheme.DEFAULT', () => {
    expect(DEFAULT_TOUCH_SCHEME).toEqual({
      tl: 'fit-width',      tm: 'open-file-browser', tr: 'jump-last',
      ml: 'prev-page',      mm: 'open-main-menu',    mr: 'next-page',
      bl: 'folder-prev',    bm: 'slideshow-toggle',  br: 'folder-next',
    });
  });

  it('DEFAULT_SCALE_MODE is fit-screen', () => {
    expect(DEFAULT_SCALE_MODE).toBe('fit-screen');
  });

  it('DEFAULT_READ_DIRECTION is ltr', () => {
    expect(DEFAULT_READ_DIRECTION).toBe('ltr');
  });
});
