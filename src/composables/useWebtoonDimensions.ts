/**
 * Webtoon 图头渐进测量：估算未测量图片为 3:4，按窗口批量读取真实尺寸。
 */
import { ref, watch, type Ref } from 'vue';
import { listImageDimensions, type ImageDim } from '@/lib/tauri';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
import { PathUtils } from '@/lib/path';
import { log } from '@/lib/logger';

export interface WebtoonImageDimension {
  width: number;
  height: number;
}

export function useWebtoonDimensions(
  descriptor: Ref<SourceDescriptor>,
  names: Ref<readonly string[]>,
  relPath: Ref<string>,
  opts: { onBeforeApply?: () => void } = {},
) {
  const measuredMap = ref(new Map<string, WebtoonImageDimension>());
  const requested = new Set<string>();
  const fullNameToName = new Map<string, string>();
  let inFlight: Promise<void> | null = null;
  let epoch = 0;

  async function ensureRange(start: number, end: number): Promise<void> {
    const batch: string[] = [];
    const first = Math.max(0, start);
    const last = Math.min(end, names.value.length);
    for (let i = first; i < last; i += 1) {
      const name = names.value[i];
      if (requested.has(name)) continue;
      requested.add(name);
      const fullPath = relPath.value ? PathUtils.join(relPath.value, name) : name;
      fullNameToName.set(fullPath, name);
      batch.push(fullPath);
    }
    if (batch.length === 0) return;
    if (inFlight) await inFlight.catch(() => undefined);
    const myEpoch = epoch;
    const request = (async () => {
      try {
        const dimensions: ImageDim[] = await listImageDimensions(descriptor.value, batch);
        if (myEpoch !== epoch) return;
        const next = new Map(measuredMap.value);
        for (const dimension of dimensions) {
          if (dimension.width <= 0 || dimension.height <= 0) continue;
          const name = fullNameToName.get(dimension.path);
          if (name) next.set(name, { width: dimension.width, height: dimension.height });
        }
        if (next.size !== measuredMap.value.size) {
          opts.onBeforeApply?.();
          measuredMap.value = next;
        }
      } catch (error) {
        log('[webtoon] listImageDimensions failed', error);
        // 整批失败按瞬时错误处理：从 requested 移除，允许后续窗口经过时重试
        // （本地挂载盘临时 I/O 失败不至于永久退化为估算尺寸）。
        for (const fullPath of batch) {
          requested.delete(fullNameToName.get(fullPath) ?? fullPath);
        }
      }
    })();
    inFlight = request;
    try {
      await request;
    } finally {
      if (inFlight === request) inFlight = null;
    }
  }

  watch([relPath, descriptor], () => {
    epoch += 1;
    requested.clear();
    fullNameToName.clear();
    measuredMap.value = new Map();
  });

  return { measuredMap, ensureRange };
}
