/**
 * useReaderHotkeys composable 测试
 * - onMounted 注册 keydown / wheel / mousedown listener
 * - 派发到 reader store action(nextPage/prevPage/toggleChrome 等)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useReaderStore } from '@/stores/reader';

// 让 onMounted 同步触发、onBeforeUnmount 不触发（测试不需要卸载验证）
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue');
  return {
    ...actual,
    onMounted: (cb: () => void) => cb(),
    onBeforeUnmount: () => undefined,
  };
});

import { useReaderHotkeys } from './useReaderHotkeys';

type KeyHandler = (e: KeyboardEvent) => void;
type WheelHandler = (e: WheelEvent) => void;
type MouseHandler = (e: MouseEvent) => void;

describe('useReaderHotkeys', () => {
  let keyHandler: KeyHandler | null = null;
  let wheelHandler: WheelHandler | null = null;
  let mouseHandler: MouseHandler | null = null;

  beforeEach(() => {
    setActivePinia(createPinia());
    keyHandler = null;
    wheelHandler = null;
    mouseHandler = null;
    vi.spyOn(window, 'addEventListener').mockImplementation((event: any, handler: any) => {
      if (event === 'keydown') keyHandler = handler;
      if (event === 'wheel') wheelHandler = handler;
      if (event === 'mousedown') mouseHandler = handler;
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);
  });

  it('registers keydown / wheel / mousedown listeners on mount', () => {
    useReaderHotkeys();
    expect(keyHandler).not.toBeNull();
    expect(wheelHandler).not.toBeNull();
    expect(mouseHandler).not.toBeNull();
  });

  it('ArrowRight on keyboard calls reader.nextPage()', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 't',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 0,
    });
    useReaderHotkeys();
    keyHandler!(new KeyboardEvent('keydown', { key: 'ArrowRight' }) as unknown as KeyboardEvent);
    expect(r.currentSpreadIndex).toBe(1);
  });

  it('wheel positive deltaY calls reader.nextPage()', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 't',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 0,
    });
    useReaderHotkeys();
    wheelHandler!(new WheelEvent('wheel', { deltaY: 100 }) as unknown as WheelEvent);
    expect(r.currentSpreadIndex).toBe(1);
  });

  it('wheel negative deltaY calls reader.prevPage()', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 't',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 1,
    });
    useReaderHotkeys();
    wheelHandler!(new WheelEvent('wheel', { deltaY: -100 }) as unknown as WheelEvent);
    expect(r.currentSpreadIndex).toBe(0);
  });

  it('left mouse click in left 1/3 calls reader.prevPage()', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const r = useReaderStore();
    r.openBook({
      bookId: 1,
      title: 't',
      pages: ['a.jpg', 'b.jpg'],
      spreads: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      initialSpreadIndex: 1,
    });
    useReaderHotkeys();
    mouseHandler!(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 400 }));
    expect(r.currentSpreadIndex).toBe(0);
  });
});
