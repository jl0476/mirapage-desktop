/**
 * useReaderTouchZones.test.ts — 9 宫格点击检测
 * v0.1.0-module3.0: 动作源改为 settings.touchScheme (PV DEFAULT 11 动作)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { useSettingsStore } from '@/stores/settings';
import { useReaderTouchZones, dispatchZoneAction } from './useReaderTouchZones';

function makeContainer() {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300,
      width: 300, height: 300, toJSON: () => ({}),
    } as DOMRect),
  });
  document.body.appendChild(el);
  return el;
}

function clickAt(el: HTMLElement, rx: number, ry: number) {
  el.dispatchEvent(new MouseEvent('click', { clientX: rx * 300, clientY: ry * 300, bubbles: true }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('useReaderTouchZones — PV DEFAULT scheme', () => {
  const cases: Array<[string, [number, number], string]> = [
    ['left-top corner (0.1, 0.1)',     [0.1, 0.1], 'fit-width'],
    ['top-center (0.5, 0.1)',          [0.5, 0.1], 'open-file-browser'],
    ['right-top corner (0.9, 0.1)',    [0.9, 0.1], 'jump-last'],
    ['middle-left (0.1, 0.5)',         [0.1, 0.5], 'prev-page'],
    ['center (0.5, 0.5)',              [0.5, 0.5], 'open-main-menu'],
    ['middle-right (0.9, 0.5)',        [0.9, 0.5], 'next-page'],
    ['left-bottom corner (0.1, 0.9)',  [0.1, 0.9], 'folder-prev'],
    ['bottom-center (0.5, 0.9)',       [0.5, 0.9], 'slideshow-toggle'],
    ['right-bottom corner (0.9, 0.9)', [0.9, 0.9], 'folder-next'],
  ];

  for (const [desc, [rx, ry], expected] of cases) {
    it(`${desc} → ${expected}`, async () => {
      const el = makeContainer();
      const containerRef = ref<HTMLElement | null>(el);
      const onAction = vi.fn();
      mount(defineComponent({
        setup() {
          useReaderTouchZones({ containerRef, onAction });
          return () => h('div');
        },
      }));
      await nextTick();
      clickAt(el, rx, ry);
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledWith(expected);
    });
  }
});

describe('useReaderTouchZones — live update from store', () => {
  it('reflects store.touchScheme change', async () => {
    const el = makeContainer();
    const actions: string[] = [];
    const containerRef = ref<HTMLElement | null>(el);
    let store: ReturnType<typeof useSettingsStore>;

    mount(defineComponent({
      setup() {
        store = useSettingsStore();
        useReaderTouchZones({ containerRef, onAction: (a) => actions.push(a) });
        return () => h('div');
      },
    }));
    await nextTick();

    store!.touchScheme.tl = 'jump-first';
    await nextTick();
    clickAt(el, 0.1, 0.1);
    expect(actions[actions.length - 1]).toBe('jump-first');
  });

  it('skips click when target inside ignoreSelector', async () => {
    const el = makeContainer();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-overlay', '');
    const btn = document.createElement('button');
    btn.textContent = 'overlay btn';
    overlay.appendChild(btn);
    el.appendChild(overlay);

    const actions: string[] = [];
    const containerRef = ref<HTMLElement | null>(el);
    mount(defineComponent({
      setup() {
        useReaderTouchZones({
          containerRef,
          ignoreSelector: '[data-overlay]',
          onAction: (a) => actions.push(a),
        });
        return () => h('div');
      },
    }));
    await nextTick();

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 150 }));
    expect(actions).toEqual([]);
  });

  it('master toggle off: ignores all clicks', async () => {
    const el = makeContainer();
    const actions: string[] = [];
    const containerRef = ref<HTMLElement | null>(el);
    let store: ReturnType<typeof useSettingsStore>;

    mount(defineComponent({
      setup() {
        store = useSettingsStore();
        useReaderTouchZones({ containerRef, onAction: (a) => actions.push(a) });
        return () => h('div');
      },
    }));
    await nextTick();

    store!.touchZonesEnabled = false;
    await nextTick();
    clickAt(el, 0.1, 0.1);
    clickAt(el, 0.5, 0.5);
    expect(actions).toEqual([]);
  });
});

describe('dispatchZoneAction — 11 actions', () => {
  function freshCtx() {
    return {
      openMainMenu: vi.fn(), prevPage: vi.fn(), nextPage: vi.fn(),
      jumpToFirst: vi.fn(), jumpToLast: vi.fn(),
      toggleSlideshow: vi.fn(), prevVolume: vi.fn(), nextVolume: vi.fn(),
      fitWidth: vi.fn(), openFileBrowser: vi.fn(),
    };
  }

  const cases: Array<[string, keyof ReturnType<typeof freshCtx>]> = [
    ['none', 'openMainMenu'],
    ['prev-page', 'prevPage'],
    ['next-page', 'nextPage'],
    ['jump-first', 'jumpToFirst'],
    ['jump-last', 'jumpToLast'],
    ['open-main-menu', 'openMainMenu'],
    ['slideshow-toggle', 'toggleSlideshow'],
    ['fit-width', 'fitWidth'],
    ['folder-prev', 'prevVolume'],
    ['folder-next', 'nextVolume'],
    ['open-file-browser', 'openFileBrowser'],
  ];

  for (const [action, expectedCall] of cases) {
    it(`${action} → ${expectedCall}`, () => {
      const ctx = freshCtx();
      dispatchZoneAction(action as never, ctx);
      if (action === 'none') {
        for (const fn of Object.values(ctx)) expect(fn).not.toHaveBeenCalled();
      } else {
        expect(ctx[expectedCall]).toHaveBeenCalledTimes(1);
      }
    });
  }
});