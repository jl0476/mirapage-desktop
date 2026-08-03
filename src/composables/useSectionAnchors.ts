// useSectionAnchors — IntersectionObserver 跟踪哪个 section 在视口顶部
// 用法: const { activeId, scrollTo } = useSectionAnchors(['reader', 'appearance', ...])
import { onMounted, onUnmounted, ref, type Ref } from 'vue';

export interface UseSectionAnchorsReturn {
  activeId: Ref<string>;
  scrollTo: (id: string) => void;
}

export function useSectionAnchors(sectionIds: string[]): UseSectionAnchorsReturn {
  const activeId = ref<string>(sectionIds[0] ?? '');
  let observer: IntersectionObserver | null = null;

  onMounted(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) activeId.value = visible.target.id;
      },
      { rootMargin: '-16px 0px -60% 0px', threshold: [0, 1] },
    );
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
  });

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
  });

  function scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { activeId, scrollTo };
}
