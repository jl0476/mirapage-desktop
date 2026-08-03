import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { useSectionAnchors } from './useSectionAnchors';

interface ObserverStub {
  cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
  observed: Element[];
}

declare global {
  // eslint-disable-next-line no-var
  var __lastObserver: ObserverStub | undefined;
}

describe('useSectionAnchors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.__lastObserver = undefined;
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      cb: (entries: IntersectionObserverEntry[]) => void;
      observed: Element[] = [];
      constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
        this.cb = cb;
        globalThis.__lastObserver = {
          cb: (entries) =>
            cb(entries as unknown as IntersectionObserverEntry[]),
          observed: this.observed,
        };
      }
      observe(el: Element) { this.observed.push(el); }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    };
  });

  it('mount defaults activeId to first id, IO callback populates active from collection', async () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    let active: { value: string } | undefined;
    mount(defineComponent({
      setup() {
        const { activeId } = useSectionAnchors(['a', 'b']);
        active = activeId;
        return () => h('div');
      },
    }));
    await nextTick();
    // 让 stub observer fire (a 在前)
    globalThis.__lastObserver!.cb(
      globalThis.__lastObserver!.observed.map((el) => ({
        isIntersecting: true,
        target: el,
        boundingClientRect: { top: 0 } as DOMRect,
      })),
    );
    expect(active?.value).toBe('a');
  });

  it('scrollTo calls scrollIntoView with smooth', () => {
    document.body.innerHTML = '<div id="target"></div>';
    const scrollIntoView = vi.fn();
    document.getElementById('target')!.scrollIntoView = scrollIntoView as unknown as typeof HTMLElement.prototype.scrollIntoView;
    let scroll: ((id: string) => void) | undefined;
    mount(defineComponent({
      setup() {
        const { scrollTo } = useSectionAnchors(['target']);
        scroll = scrollTo;
        return () => h('div');
      },
    }));
    scroll!('target');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
