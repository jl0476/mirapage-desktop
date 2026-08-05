/**
 * useReaderHotkeys composable 测试
 * - onMounted 注册 keydown listener
 * - 派发到 reader store action(nextPage/prevPage/toggleChrome 等)
 *
 * v0.1.0-module3.0.2-reader-polish (Cluster B #7):
 * - Escape → closeReader → router.back()
 *
 * v0.1.0-reader-review-fix:
 * - 不再监听 window mousedown (与 9 宫格 useReaderTouchZones + chrome 按钮 click
 *   冲突; 用户报告点 btn-mode 后变成下一页).
 * - mouse 位置派发由 9 宫格接管.
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

// Cluster B #7: 模拟 useRouter/useRoute, 让 closeReader dispatch 可被 spy
const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
let currentPath = '/reader/7';
vi.mock('vue-router', () => ({
  useRouter: () => ({
    back: routerBackSpy,
    push: routerPushSpy,
  }),
  useRoute: () => ({
    get fullPath() { return currentPath; },
  }),
}));

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
    routerBackSpy.mockClear();
    routerPushSpy.mockClear();
    currentPath = '/reader/7';
    vi.spyOn(window, 'addEventListener').mockImplementation((event: any, handler: any) => {
      if (event === 'keydown') keyHandler = handler;
      // v0.1.0-module3.0.2-hotfix6 (H12): 不再监听 wheel — useReaderWheel 接管
      // v0.1.0-reader-review-fix: 不再监听 mousedown — 与 9 宫格冲突
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);
  });

  it('registers only keydown listener (不再监听 wheel + mousedown)', () => {
    useReaderHotkeys();
    expect(keyHandler).not.toBeNull();
    expect(wheelHandler).toBeNull();
    expect(mouseHandler).toBeNull();  // 9 宫格接管鼠标位置派发
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

  it('window mousedown 不再派发 prev/next (review-fix: 9 宫格接管)', () => {
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
    // mouseHandler 现在永远 null (review-fix 移除 mousedown listener)
    expect(mouseHandler).toBeNull();
    // 即使 dispatch mousedown, 也不应 prevPage (由 9 宫格接管)
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 400 }));
    expect(r.currentSpreadIndex).toBe(1);  // 不动
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

  // v0.1.0-module3.0.3-hotfix5: Escape 一律 push('/') 回文件浏览器 (不再 router.back(),
  // 避免 library/bookmarks 进 reader 时 Escape 回 library 的问题).
  it('Escape key → closeReader → router.push("/")', () => {
    useReaderHotkeys();
    keyHandler!(new KeyboardEvent('keydown', { key: 'Escape' }) as unknown as KeyboardEvent);
    expect(routerPushSpy).toHaveBeenCalledWith('/');
    expect(routerBackSpy).not.toHaveBeenCalled();
  });

  it('Escape key 不应触发 reader.toggleChrome (openMainMenu 改用 m)', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1, title: 't', pages: ['a.jpg'], spreads: [{ start: 0, end: 1 }], initialSpreadIndex: 0,
    });
    const chromeBefore = r.chromeVisible;
    useReaderHotkeys();
    keyHandler!(new KeyboardEvent('keydown', { key: 'Escape' }) as unknown as KeyboardEvent);
    expect(r.chromeVisible).toBe(chromeBefore);  // 没被 toggle
  });

  it('m key 仍触发 openMainMenu (= toggleChrome)', () => {
    const r = useReaderStore();
    r.openBook({
      bookId: 1, title: 't', pages: ['a.jpg'], spreads: [{ start: 0, end: 1 }], initialSpreadIndex: 0,
    });
    useReaderHotkeys();
    keyHandler!(new KeyboardEvent('keydown', { key: 'm' }) as unknown as KeyboardEvent);
    expect(r.chromeVisible).toBe(!true);  // toggle 一次, 从 true → false
  });
});
