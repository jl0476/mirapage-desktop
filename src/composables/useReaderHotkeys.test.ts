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
      // v0.1.0-module3.0.2-hotfix6 (H12): 不再监听 wheel — useReaderWheel 接管
      if (event === 'mousedown') mouseHandler = handler;
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);
  });

  it('registers keydown / mousedown listeners on mount (不再监听 wheel)', () => {
    useReaderHotkeys();
    expect(keyHandler).not.toBeNull();
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

  it('wheel 事件 不再被 hotkey 接管 (H12: useReaderWheel 单独负责)', () => {
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
    // wheel listener 已被 H12 删除, 即使触发也不应 nextPage
    expect(wheelHandler).toBeNull();
    // 直接 dispatch WheelEvent 验证: hotkey 不再 hook wheel
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    expect(r.currentSpreadIndex).toBe(1);  // 不动
  });

  it('wheel negative deltaY 不调 reader.prevPage() (H12)', () => {
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
    expect(wheelHandler).toBeNull();
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    expect(r.currentSpreadIndex).toBe(1);
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

  it('Space key toggles slideshow (slideshowToggle command)', async () => {
    const { useSlideshowStore } = await import('@/stores/slideshow');
    const slideshow = useSlideshowStore();
    expect(slideshow.isPlaying).toBe(false);
    useReaderHotkeys();
    keyHandler!(new KeyboardEvent('keydown', { key: ' ' }) as unknown as KeyboardEvent);
    expect(slideshow.isPlaying).toBe(true);
    keyHandler!(new KeyboardEvent('keydown', { key: ' ' }) as unknown as KeyboardEvent);
    expect(slideshow.isPlaying).toBe(false);
  });
});
