<script setup lang="ts">
// ThumbnailProgressPopover.vue — 单张缩略图生成详情浮层（module3.0.11）
// 阶段时间线（5 步）+ 原图/输出 + 失败重试。定位：角标右侧优先，右→左→下→上。
// 阶段时长推算：timings[phase] = 该阶段开始的累计 elapsed（generate 相对时间）；
//   已完成阶段 X = timings[next] - timings[X]；当前阶段 = Date.now() - generationStartedAt
//   - timings[X]（round-1 P1-4：generationStartedAt 不含排队，startedAt 含排队，
//   直接用 startedAt 会把排队时间算进 decoding 实时耗时）；
//   queued 阶段 = generationStartedAt - startedAt（排队等待）。
// 失败态时间线数据源 = snapshot（round-1 P1-6：failed 事件覆盖 generating 态后
//   phase/timings 已丢，由 useMasonryThumbnails.progressSnapshots 提供）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ThumbnailPhase, ThumbnailProgressSnapshot, ThumbnailState } from '@/lib/thumbnail';
import { THUMBNAIL_PHASES } from '@/lib/thumbnail';
import { formatBytes } from '@/locales/helpers';
import { positionFor, type PopoverPlacement } from '@/lib/thumbnailPosition';

const props = defineProps<{
  state: ThumbnailState;
  fileName: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  /** 角标在视口中的位置（父级点击时算好，滚动时父级更新）。 */
  anchorRect: { left: number; top: number; width: number; height: number };
  /** 失败态时间线快照（round-1 P1-6；generating 态不用）。 */
  snapshot?: ThumbnailProgressSnapshot;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'retry'): void;
}>();

const { t } = useI18n();
const rootEl = ref<HTMLElement | null>(null);
const placement = ref<PopoverPlacement>('right');
const pos = ref({ left: 0, top: 0 });
const nowTick = ref(0); // 500ms tick 驱动耗时文本刷新

function reposition() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popEl = rootEl.value;
  if (!popEl) return;
  const popSize = { width: popEl.offsetWidth || 220, height: popEl.offsetHeight || 120 };
  // round-1 P1-7：anchorRect 线格式只有 4 字段，positionFor 需要 right/bottom——此处补算
  const r = props.anchorRect;
  const anchor = { ...r, right: r.left + r.width, bottom: r.top + r.height };
  const p = positionFor(anchor, { width: vw, height: vh }, popSize);
  placement.value = p.placement;
  pos.value = { left: p.left, top: p.top };
}

let intervalId: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  reposition();
  window.addEventListener('resize', reposition);
  intervalId = setInterval(() => { nowTick.value += 1; reposition(); }, 500);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', reposition);
  if (intervalId) clearInterval(intervalId);
});

const phaseText = (ph: ThumbnailPhase) => t(`thumbnail.phase.${ph}`);

/** 耗时格式化（用户实测反馈：裸毫秒反人类）：<1s → "Xms"；<1min → "X.Xs"；≥1min → "Xm Ys"。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * 顶部"已用时"口径（用户实测反馈修正：贴在 phase 旁的耗时被理解为该阶段耗时，
 * 含排队的总时长会误导——decoding 显示 26 分钟实际 decode 只有几秒）：
 * - queued：排队等待（Date.now() - startedAt）
 * - 其余阶段：当前阶段净耗时（Date.now() - generationStartedAt - timings[phase]，不含排队）
 * 排队等待在时间线 queued 行单独展示。
 */
const headlineDurMs = computed(() => {
  void nowTick.value;
  const s = props.state;
  if (s?.kind !== 'generating') return 0;
  if (s.phase === 'queued') return Math.max(0, Date.now() - s.startedAt);
  const genStart = s.generationStartedAt;
  if (genStart === undefined) return Math.max(0, Date.now() - s.startedAt);
  const phaseStart = s.timings[s.phase] ?? 0;
  return Math.max(0, Date.now() - genStart - phaseStart);
});

/** 时间线数据源：generating 态用自身；failed 态用快照（round-1 P1-6）。 */
const timeline = computed<ThumbnailProgressSnapshot | null>(() => {
  const s = props.state;
  if (s?.kind === 'generating') return s;
  return props.snapshot ?? null;
});

/** 阶段时长：queued = 排队等待；已完成 = timings[next]-timings[this]；
 * 当前 = Date.now()-generationStartedAt-timings[this]（实时）；未到/卡住 = '—'。 */
function stepDuration(ph: ThumbnailPhase): string {
  const src = timeline.value;
  if (!src) return '—';
  void nowTick.value;
  const timings = src.timings;
  if (ph === 'queued') {
    // 排队等待 = generate 实际开始 - 请求发出；未开始生成时实时跳动
    const genStart = src.generationStartedAt;
    if (genStart === undefined) return formatDuration(Date.now() - src.startedAt);
    return formatDuration(genStart - src.startedAt);
  }
  if (timings[ph] === undefined) return '—';
  const start = timings[ph] as number;
  if (src.phase === ph) {
    if (props.state.kind !== 'generating') return '—'; // 失败卡住：结束时间未知
    // round-1 P1-4：用 generationStartedAt（不含排队），不用 startedAt
    const genStart = src.generationStartedAt;
    if (genStart === undefined) return '—';
    return formatDuration(Date.now() - genStart - start);
  }
  const idx = THUMBNAIL_PHASES.indexOf(ph);
  const nextPh = THUMBNAIL_PHASES[idx + 1];
  const end = nextPh && timings[nextPh] !== undefined ? (timings[nextPh] as number) : start;
  return formatDuration(end - start);
}
function stepClass(ph: ThumbnailPhase): string {
  const src = timeline.value;
  if (!src) return '';
  const idx = THUMBNAIL_PHASES.indexOf(ph);
  const curIdx = THUMBNAIL_PHASES.indexOf(src.phase);
  if (props.state.kind === 'failed' && idx === curIdx) return 'fail'; // 卡住的步骤
  if (idx < curIdx) return 'done';
  if (idx === curIdx) return 'cur';
  return 'pending';
}
</script>

<template>
  <div ref="rootEl" class="thumb-popover" :class="`place-${placement}`" :style="{ left: pos.left + 'px', top: pos.top + 'px' }" data-test="thumb-popover">
    <div class="pop-title">{{ fileName }}</div>
    <template v-if="state.kind === 'generating'">
      <div class="pop-state cur">{{ phaseText(state.phase) }} · {{ t('thumbnail.popover.elapsed', { dur: formatDuration(headlineDurMs) }) }}</div>
      <div class="psection">{{ t('thumbnail.popover.stages') }}</div>
      <div v-for="ph in THUMBNAIL_PHASES" :key="ph" class="tl-step" :class="stepClass(ph)">
        <span class="lbl"><span class="dot" />{{ phaseText(ph) }}</span>
        <span class="t">{{ stepDuration(ph) }}</span>
      </div>
      <div class="psection">{{ t('thumbnail.popover.image') }}</div>
      <div class="prow"><span class="k">{{ t('thumbnail.popover.sourceImage') }}</span><span class="v">{{ props.sourceWidth }}×{{ props.sourceHeight }} · {{ formatBytes(props.sourceBytes) }}</span></div>
      <div class="prow"><span class="k">{{ t('thumbnail.popover.output') }}</span><span class="dim">—</span></div>
    </template>
    <template v-else-if="state.kind === 'failed'">
      <div class="pop-state fail">{{ t('thumbnail.popover.failed') }}</div>
      <div class="err-msg">{{ state.message }}</div>
      <!-- round-1 P1-6：失败时间线用 snapshot（无快照——未经生成即失败——省略区块） -->
      <template v-if="snapshot">
        <div class="psection">{{ t('thumbnail.popover.stages') }}</div>
        <div v-for="ph in THUMBNAIL_PHASES" :key="ph" class="tl-step" :class="stepClass(ph)">
          <span class="lbl"><span class="dot" />{{ phaseText(ph) }}</span>
          <span class="t">{{ stepDuration(ph) }}</span>
        </div>
      </template>
      <button class="retry-btn" type="button" @click="emit('retry')">{{ t('thumbnail.popover.retry') }}</button>
    </template>
  </div>
</template>

<style scoped>
.thumb-popover {
  position: fixed;
  z-index: 60;
  width: 220px;
  background: var(--color-surface-3);
  border: 1px solid var(--color-border-default);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  font-size: 11px;
}
/* 箭头按 placement 简化：accent 色边条示意方向 */
.thumb-popover.place-right { border-left: 2px solid var(--color-accent); }
.thumb-popover.place-left { border-right: 2px solid var(--color-accent); }
.thumb-popover.place-bottom { border-top: 2px solid var(--color-accent); }
.thumb-popover.place-top { border-bottom: 2px solid var(--color-accent); }
.pop-title { font-size: 12px; color: var(--color-text-primary); font-weight: 600; margin-bottom: 2px; }
.pop-state { font-size: 11px; margin-bottom: 6px; }
.pop-state.cur { color: var(--color-accent); }
.pop-state.fail { color: var(--color-error); }
.psection { font-size: 9px; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 8px 0 3px; }
.tl-step { display: flex; justify-content: space-between; align-items: center; margin: 3px 0; }
.tl-step .lbl { display: flex; align-items: center; gap: 5px; color: var(--color-text-secondary); }
.tl-step .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-border-default); }
.tl-step.done .dot { background: var(--color-success); }
.tl-step.cur .dot { background: var(--color-accent); box-shadow: 0 0 0 2px rgb(99 102 241 / 0.3); }
.tl-step.fail .dot { background: var(--color-error); }
.tl-step .t { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.prow { display: flex; justify-content: space-between; margin: 2px 0; }
.prow .k { color: var(--color-text-muted); }
.prow .v { color: var(--color-text-secondary); }
.prow .dim { color: var(--color-text-muted); }
.err-msg { font-size: 10px; color: var(--color-error); background: rgb(248 113 113 / 0.1); border-radius: 4px; padding: 5px 6px; margin: 4px 0; line-height: 1.4; word-break: break-all; }
.retry-btn { width: 100%; padding: 5px; background: rgb(99 102 241 / 0.15); border: 1px solid var(--color-accent); color: var(--color-accent); border-radius: 5px; font-size: 11px; cursor: pointer; }
</style>
