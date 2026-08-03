/**
 * inputBindings 测试
 * 覆盖 DESIGn §14.1 全键盘映射 + §15.3 鼠标映射 + §15.4 滚轮映射
 *
 * API 设计:
 * - resolveHotkey(event, bindings) → ReaderCommand | null
 * - 纯函数,无副作用,便于单测
 * - bindings 由 useInputBindingsStore 提供(此文件先锁默认映射)
 */
import { describe, it, expect } from 'vitest';
import { resolveHotkey, defaultKeyBindings } from './inputBindings';

function keyboardEvent(
  key: string,
  options: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: !!options.ctrlKey,
    altKey: !!options.altKey,
    shiftKey: !!options.shiftKey,
    metaKey: !!options.metaKey,
  } as KeyboardEvent;
}

function mouseEventAt(
  x: number,
  y: number,
  options: { width?: number; height?: number; button?: number } = {},
): MouseEvent {
  const w = options.width ?? 1200;
  const h = options.height ?? 800;
  return {
    clientX: x,
    clientY: y,
    button: options.button ?? 0,
    width: w,
    height: h,
  } as unknown as MouseEvent;
}

function wheelEvent(deltaY: number, ctrlKey = false): WheelEvent {
  return { deltaY, ctrlKey } as WheelEvent;
}

describe('defaultKeyBindings', () => {
  it('exposes a frozen bindings record per TouchAction', () => {
    expect(defaultKeyBindings.nextPage).toContain('ArrowRight');
    expect(defaultKeyBindings.nextPage).toContain('PageDown');
    expect(defaultKeyBindings.slideshowToggle).toContain(' ');
    expect(defaultKeyBindings.prevPage).toContain('ArrowLeft');
    expect(defaultKeyBindings.prevPage).toContain('PageUp');
    expect(defaultKeyBindings.toggleChrome).toContain('c');
    // v0.1.0-module3.0.2-reader-polish: Escape 移到 closeReader
    expect(defaultKeyBindings.openMainMenu).toContain('m');
    expect(defaultKeyBindings.openMainMenu).not.toContain('Escape');
    expect(defaultKeyBindings.closeReader).toContain('Escape');
    expect(defaultKeyBindings.jumpFirst).toContain('Home');
    expect(defaultKeyBindings.jumpLast).toContain('End');
    expect(defaultKeyBindings.fitWidth).toContain('w');
    expect(defaultKeyBindings.openFileBrowser).toContain('b');
    expect(defaultKeyBindings.slideshowToggle).toContain('p');
    expect(defaultKeyBindings.slideshowToggle).toContain('F5');
    expect(defaultKeyBindings.folderNext).toContain('Alt+ArrowRight');
    expect(defaultKeyBindings.folderPrev).toContain('Alt+ArrowLeft');
  });
});

describe('resolveHotkey — keyboard', () => {
  it('maps ArrowRight / PageDown to nextPage, Space to slideshowToggle', () => {
    expect(resolveHotkey(keyboardEvent('ArrowRight'), defaultKeyBindings)).toBe('nextPage');
    expect(resolveHotkey(keyboardEvent('PageDown'), defaultKeyBindings)).toBe('nextPage');
    expect(resolveHotkey(keyboardEvent(' '), defaultKeyBindings)).toBe('slideshowToggle');
  });

  it('maps ArrowLeft / PageUp to prevPage', () => {
    expect(resolveHotkey(keyboardEvent('ArrowLeft'), defaultKeyBindings)).toBe('prevPage');
    expect(resolveHotkey(keyboardEvent('PageUp'), defaultKeyBindings)).toBe('prevPage');
  });

  it('maps Home to jumpFirst, End to jumpLast', () => {
    expect(resolveHotkey(keyboardEvent('Home'), defaultKeyBindings)).toBe('jumpFirst');
    expect(resolveHotkey(keyboardEvent('End'), defaultKeyBindings)).toBe('jumpLast');
  });

  it('maps m to openMainMenu (case insensitive)', () => {
    expect(resolveHotkey(keyboardEvent('m'), defaultKeyBindings)).toBe('openMainMenu');
    expect(resolveHotkey(keyboardEvent('M'), defaultKeyBindings)).toBe('openMainMenu');
  });

  // v0.1.0-module3.0.2-reader-polish (#7): Escape 改映射 closeReader (was: openMainMenu)
  it('maps Escape to closeReader (router.back to file browser)', () => {
    expect(resolveHotkey(keyboardEvent('Escape'), defaultKeyBindings)).toBe('closeReader');
  });

  it('maps c / Ctrl+h to toggleChrome', () => {
    expect(resolveHotkey(keyboardEvent('c'), defaultKeyBindings)).toBe('toggleChrome');
    expect(
      resolveHotkey(keyboardEvent('h', { ctrlKey: true }), defaultKeyBindings),
    ).toBe('toggleChrome');
  });

  it('maps w to fitWidth', () => {
    expect(resolveHotkey(keyboardEvent('w'), defaultKeyBindings)).toBe('fitWidth');
  });

  it('maps b to openFileBrowser', () => {
    expect(resolveHotkey(keyboardEvent('b'), defaultKeyBindings)).toBe('openFileBrowser');
  });

  it('maps Alt+ArrowRight to folderNext and Alt+ArrowLeft to folderPrev', () => {
    expect(
      resolveHotkey(keyboardEvent('ArrowRight', { altKey: true }), defaultKeyBindings),
    ).toBe('folderNext');
    expect(
      resolveHotkey(keyboardEvent('ArrowLeft', { altKey: true }), defaultKeyBindings),
    ).toBe('folderPrev');
  });

  it('maps p and F5 to slideshowToggle', () => {
    expect(resolveHotkey(keyboardEvent('p'), defaultKeyBindings)).toBe('slideshowToggle');
    expect(resolveHotkey(keyboardEvent('F5'), defaultKeyBindings)).toBe('slideshowToggle');
  });

  it('returns null for unmapped keys', () => {
    expect(resolveHotkey(keyboardEvent('z'), defaultKeyBindings)).toBeNull();
    expect(resolveHotkey(keyboardEvent('q'), defaultKeyBindings)).toBeNull();
  });
});

describe('resolveHotkey — mouse 3-region click', () => {
  it('left click at left 1/3 → prevPage', () => {
    // x=200, width=1200 → in left 0..400
    expect(resolveHotkey(mouseEventAt(200, 400), defaultKeyBindings, {
      kind: 'mouse',
      width: 1200,
      height: 800,
    })).toBe('prevPage');
  });

  it('left click at right 1/3 → nextPage', () => {
    // x=1000, width=1200 → in right 800..1200
    expect(resolveHotkey(mouseEventAt(1000, 400), defaultKeyBindings, {
      kind: 'mouse',
      width: 1200,
      height: 800,
    })).toBe('nextPage');
  });

  it('left click at center 1/3 (or middle vertical) → openMainMenu', () => {
    expect(resolveHotkey(mouseEventAt(600, 400), defaultKeyBindings, {
      kind: 'mouse',
      width: 1200,
      height: 800,
    })).toBe('openMainMenu');
  });

  it('right click returns null (reserved for future context menu)', () => {
    const ev = mouseEventAt(600, 400, { button: 2 });
    expect(resolveHotkey(ev, defaultKeyBindings, {
      kind: 'mouse',
      width: 1200,
      height: 800,
    })).toBeNull();
  });
});

describe('resolveHotkey — wheel', () => {
  it('positive deltaY → nextPage', () => {
    expect(resolveHotkey(wheelEvent(100), defaultKeyBindings)).toBe('nextPage');
  });

  it('negative deltaY → prevPage', () => {
    expect(resolveHotkey(wheelEvent(-100), defaultKeyBindings)).toBe('prevPage');
  });

  it('zero deltaY → null', () => {
    expect(resolveHotkey(wheelEvent(0), defaultKeyBindings)).toBeNull();
  });
});
