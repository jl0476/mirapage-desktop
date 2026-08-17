/**
 * useReaderHotkeys composable 测试
 * - onMounted 注册 keydown listener
 * - 派发到 reader store action(nextPage/prevPage/toggleChrome 等)
 *
 * v0.1.0-module3.0.2-reader-polish (Cluster B #7):
 * - Escape → closeReader → router.back()
 *
 * v0.1.0-reader-review-fix:
 * - 不再监听 window mousedown (与 chrome 按钮 click 冲突;
 *   用户报告点 btn-mode 后变成下一页).
 * - 桌面端鼠标点击不承载翻页语义.
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
      // v0.1.0-reader-review-fix: 不再监听 mousedown — 与 chrome 按钮冲突
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);
  });

  it('registers only keydown listener (不再监听 wheel + mousedown)', () => {
    useReaderHotkeys();
    expect(keyHandler).not.toBeNull();
    expect(wheelHandler).toBeNull();
    expect(mouseHandler).toBeNull();  // 鼠标点击不承载翻页语义
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

  it('window mousedown 不再派发 prev/next (review-fix: 移除 mousedown listener)', () => {
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
    // 即使 dispatch mousedown, 也不应 prevPage (鼠标点击不承载翻页语义)
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 400 }));
    expect(r.currentSpreadIndex).toBe(1);  // 不动
  });

  it('webtoon nextPage 使用 override 而不推进 reader store', () => {
    const r = useReaderStore();
    r.openBook({ bookId: 1, title: 't', pages: ['a.jpg', 'b.jpg'], spreads: [{ start: 0, end: 1 }, { start: 1, end: 2 }], initialSpreadIndex: 0 });
    const nextPage = vi.fn();
    useReaderHotkeys({ isWebtoon: () => true, nextPage });
    keyHandler!(new KeyboardEvent('keydown', { key: 'ArrowDown' }) as unknown as KeyboardEvent);
    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(r.currentSpreadIndex).toBe(0);
  });

  it('webtoon 四个命令分别调用 override', () => {
    const actions = { isWebtoon: () => true, nextPage: vi.fn(), prevPage: vi.fn(), jumpFirst: vi.fn(), jumpLast: vi.fn() };
    useReaderHotkeys(actions);
    for (const [key, fn] of [['ArrowDown', actions.nextPage], ['ArrowUp', actions.prevPage], ['Home', actions.jumpFirst], ['End', actions.jumpLast]] as const) {
      keyHandler!(new KeyboardEvent('keydown', { key }) as unknown as KeyboardEvent);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('未启用 webtoon 时保持原有 store 行为', () => {
    const r = useReaderStore();
    r.openBook({ bookId: 1, title: 't', pages: ['a.jpg', 'b.jpg'], spreads: [{ start: 0, end: 1 }, { start: 1, end: 2 }], initialSpreadIndex: 0 });
    const nextPage = vi.fn();
    useReaderHotkeys({ nextPage });
    keyHandler!(new KeyboardEvent('keydown', { key: 'ArrowRight' }) as unknown as KeyboardEvent);
    expect(nextPage).not.toHaveBeenCalled();
    expect(r.currentSpreadIndex).toBe(1);
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

  // 命中命令必须 preventDefault——webtoon 滚动容器里 Space/箭头/PageX 的浏览器
  // 默认行为是再滚一屏，会与 slideshowToggle/scrollScreen 叠加成双动作
  it('命中命令的 keydown 调 preventDefault（webtoon Space 不再叠浏览器默认滚屏）', () => {
    useReaderHotkeys();
    const e = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    const spy = vi.spyOn(e, 'preventDefault');
    keyHandler!(e as unknown as KeyboardEvent);
    expect(spy).toHaveBeenCalled();
  });

  it('未命中命令的 keydown 不 preventDefault（如任意字母 x）', () => {
    useReaderHotkeys();
    const e = new KeyboardEvent('keydown', { key: 'x', cancelable: true });
    const spy = vi.spyOn(e, 'preventDefault');
    keyHandler!(e as unknown as KeyboardEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  it('焦点在输入控件内不拦截（跳页 dialog 输入 p/空格 归输入框）', async () => {
    const { useSlideshowStore } = await import('@/stores/slideshow');
    useReaderHotkeys();
    const e = new KeyboardEvent('keydown', { key: 'p', cancelable: true });
    Object.defineProperty(e, 'target', { value: document.createElement('input') });
    const spy = vi.spyOn(e, 'preventDefault');
    keyHandler!(e as unknown as KeyboardEvent);
    expect(spy).not.toHaveBeenCalled();
    expect(useSlideshowStore().isPlaying).toBe(false);  // 命令也不触发
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

  // ─── 2026-08-12 跨卷任务 8 (P1-2): actions 参数 + folderNext/folderPrev 派发 ───
  // 不传 actions (向后兼容) → folderNext/folderPrev 静默 no-op, 不抛.
  // actions.nextVolume/prevVolume 注入 → Alt+ArrowRight / Alt+ArrowLeft 派发对应回调.
  // 用例顺序: 4 个 (向后兼容默认 / nextVolume 调 / prevVolume 调 / 不传不抛).

  it('不传 actions 参数 (向后兼容): folderNext/folderPrev 静默 no-op 不抛', () => {
    expect(() => useReaderHotkeys()).not.toThrow();
    // Alt+ArrowRight / Alt+ArrowLeft 应被接受为有效 hotkey, 静默 no-op
    expect(() => keyHandler!(new KeyboardEvent('keydown', {
      key: 'ArrowRight', altKey: true,
    } as unknown as KeyboardEvent))).not.toThrow();
    expect(() => keyHandler!(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', altKey: true,
    } as unknown as KeyboardEvent))).not.toThrow();
  });

  it('actions.nextVolume 注入: Alt+ArrowRight (folderNext) 派发该回调', () => {
    const nextVolume = vi.fn();
    const prevVolume = vi.fn();
    useReaderHotkeys({ nextVolume, prevVolume });
    keyHandler!(new KeyboardEvent('keydown', {
      key: 'ArrowRight', altKey: true,
    } as unknown as KeyboardEvent));
    expect(nextVolume).toHaveBeenCalledTimes(1);
    expect(prevVolume).not.toHaveBeenCalled();
  });

  it('actions.prevVolume 注入: Alt+ArrowLeft (folderPrev) 派发该回调', () => {
    const nextVolume = vi.fn();
    const prevVolume = vi.fn();
    useReaderHotkeys({ nextVolume, prevVolume });
    keyHandler!(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', altKey: true,
    } as unknown as KeyboardEvent));
    expect(prevVolume).toHaveBeenCalledTimes(1);
    expect(nextVolume).not.toHaveBeenCalled();
  });

  it('actions 局部字段缺失: 仅注入 nextVolume 时 prevVolume 不被调, Alt+ArrowLeft 静默 no-op', () => {
    const nextVolume = vi.fn();
    useReaderHotkeys({ nextVolume });
    // folderPrev 没注入 → 应静默 no-op, 不抛
    expect(() => keyHandler!(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', altKey: true,
    } as unknown as KeyboardEvent))).not.toThrow();
    expect(nextVolume).not.toHaveBeenCalled();
  });
});
