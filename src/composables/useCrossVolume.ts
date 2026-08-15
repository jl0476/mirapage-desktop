/**
 * useCrossVolume.ts — CrossVolumeController (v0.1.0-module3.0.8-cross-volume 任务 5)
 *
 * 跨卷连续阅读状态机（spec §10）：
 * - phase: idle | resolving | awaiting-confirm | navigating
 * - pendingCrossVolume 只在 awaiting-confirm 非空（不变量 7）
 * - requestSeq + sameBookIdentity 结构化竞态校验
 * - trySave 包裹（保存失败 toast，不阻断跨卷 —— 不变量 10）
 * - clearPendingState（仅清数据+slideshow flag）vs dismissManual（toast close 专用，推 seq）
 * - settleIdle 集中收口所有终止路径
 * - canStart 注入：加载期（bookLoadPhase !== 'ready'）拒绝新跨卷（P1-1）
 *
 * 全部依赖经 opts 注入，可独立单测（仅 findNextVolume 直接 import @/lib/tauri，
 * types/sameBookIdentity 从 useReaderBookLoader 导入）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { findNextVolume } from '@/lib/tauri';
import { log } from '@/lib/logger';
import { sameBookIdentity, type BookIdentity, type NextVolumeTarget } from '@/composables/useReaderBookLoader';
import type { ContinueMode } from '@/stores/settings';

export type CrossVolumePhase = 'idle' | 'resolving' | 'awaiting-confirm' | 'navigating';

export interface UseCrossVolumeOpts {
  /** 读当前卷身份（加载期返回 null —— Controller 拒绝发起跨卷） */
  identity: () => BookIdentity | null;
  /** ReaderView 注入：ensureBookId + router.replace */
  navigateToVolume: (target: NextVolumeTarget) => Promise<void>;
  /** = reader.saveCurrentProgressNow：构造当前快照 await 写入 */
  saveCurrentProgressNow: () => Promise<void>;
  /** Toast key 推送（ReaderView 在注入时 t(k, p) 转文案） */
  pushToast: (key: string, params?: Record<string, unknown>) => void;
  /** settings.continueToNextVolume（注入而非直接读 store，便于测） */
  getContinueMode: () => ContinueMode;
  /** 注入 slideshow.pause */
  pauseSlideshow: () => void;
  /** 注入 slideshow.consumePendingNextVolume */
  consumePendingNextVolume: () => void;
  /** 注入 bookLoadPhase === 'ready' 守卫 —— 加载期拒绝新跨卷 */
  canStart: () => boolean;
  /** A7 修复: 调用前捕获 slideshow.isPlaying 状态 —— 仅 auto/force 路径续播 (manual 是用户主动确认不续播) */
  isSlideshowPlaying?: () => boolean;
  /** A7 修复: 跨卷成功后 resume slideshow 播放（ReaderView 注入 slideshow.start） */
  resumeSlideshow?: () => void;
}

export interface UseCrossVolumeReturn {
  phase: Ref<CrossVolumePhase>;
  pendingCrossVolume: Ref<NextVolumeTarget | null>;
  busy: ComputedRef<boolean>;
  maybeContinue: (force: boolean, dir: 'next' | 'prev') => Promise<void>;
  confirmManual: () => Promise<void>;
  dismissManual: () => void;
}

export function useCrossVolume(opts: UseCrossVolumeOpts): UseCrossVolumeReturn {
  const phase = ref<CrossVolumePhase>('idle');
  const pendingCrossVolume = ref<NextVolumeTarget | null>(null);
  const busy = computed(() => phase.value !== 'idle');
  // 结构化身份（不 stringify），manual arm 时冻结 + confirm/navigate 时再校验
  let identityAtArm: BookIdentity | null = null;
  // 单调递增序号：旧请求（陈旧）丢弃依据
  let requestSeq = 0;

  /**
   * 集中收口：所有终止路径都走 settleIdle，保证 pendingCrossVolume 只在 awaiting-confirm 非空（不变量 7）。
   * clearPendingState 清数据 + 消费 slideshow flag；此处再 phase='idle'。
   */
  function settleIdle(): void {
    clearPendingState();
    phase.value = 'idle';
  }

  /** 仅清数据 + 消费 slideshow flag，不动 phase（settleIdle / dismissManual 调） */
  function clearPendingState(): void {
    pendingCrossVolume.value = null;
    identityAtArm = null;
    opts.consumePendingNextVolume();
  }

  /**
   * manual 点跳转。P1-2 修复：开头 phase 守卫防双击（第二次直接 return）。
   * identity 校验推迟到 navigateResolvedTarget ①（统一处理）。
   * A7 修复：manual 模式不续播 slideshow —— 传 wasSlideshowPlaying=false (force 走 maybeContinue 已捕获).
   */
  async function confirmManual(): Promise<void> {
    if (phase.value !== 'awaiting-confirm') return;
    const target = pendingCrossVolume.value;
    const expected = identityAtArm;
    if (!target || !expected) {
      settleIdle();
      return;
    }
    const seq = ++requestSeq;
    // manual 模式：传 false（用户主动确认，不续播；不推 jumped toast，用 confirmManual 自己的 capsule）
    await navigateResolvedTarget(target, expected, seq, false, false /* manual */);
  }

  /**
   * 实际导航：① identity 初校验 → ② trySave（失败 toast 不阻断） → ③ pauseSlideshow
   *   → ④ requestSeq+identity 再校验 → ⑤⑥ navigateToVolume → A7 跨卷成功 resume slideshow (auto/force only) → ⑦⑧ settleIdle (finally)
   */
  async function navigateResolvedTarget(
    target: NextVolumeTarget,
    expected: BookIdentity,
    seq: number,
    wasSlideshowPlaying: boolean,
    // auto/force=true 路径调 jumped toast; manual=confirmManual 路径不调 (用自己 capsule).
    autoOrForce: boolean,
  ): Promise<void> {
    phase.value = 'navigating';
    // ① 初校验 identity（navigateToVolume 前确认当前卷未变）
    if (!sameBookIdentity(opts.identity(), expected)) {
      settleIdle();
      return;
    }
    // ② trySave（不变量 10：保存失败不阻断跨卷）
    await trySaveCurrentProgress();
    // ③ pauseSlideshow
    opts.pauseSlideshow();
    // ④ 再校验 seq + identity（ensureBookId/replace 前必须校验）
    if (seq !== requestSeq || !sameBookIdentity(opts.identity(), expected)) {
      settleIdle();
      return;
    }
    try {
      // ⑤⑥ 由 opts.navigateToVolume 做（ensureBookId + router.replace）
      await opts.navigateToVolume(target);
      // A7 修复: auto/force 跨卷成功 + 调用前 isPlaying=true → resume slideshow.
      // 失败路径 (catch) 不续播 —— 让用户主动重试/暂停 (避免半截 state).
      if (wasSlideshowPlaying) {
        opts.resumeSlideshow?.();
      }
      // A7 补丁: auto/force 跨卷成功 → 短暂 toast "已跳转《XXX》" (spec §13/§7.2).
      // 任务5实现漏调, A7 E2E 发现. manual 模式由 confirmManual 自己的胶囊提示,
      // 这里只在 auto/force 路径触发, 避免重复提示.
      if (autoOrForce) {
        opts.pushToast?.('reader.crossVolume.jumped', { title: target.title });
      }
    } catch (e) {
      opts.pushToast('reader.crossVolume.failed');
      log('[crossVolume] navigate failed', e);
      // 导航失败：清理（恢复 awaiting-confirm 供重试有风险，本版清理）
    } finally {
      // ⑦ clearPendingState + ⑧ phase idle（成功/失败都清，保证 pending 不变量）
      settleIdle();
    }
  }

  /** 保存失败不阻断跨卷（不变量 10：取消旧 debounce 与本次保存成功分离） */
  async function trySaveCurrentProgress(): Promise<void> {
    try {
      await opts.saveCurrentProgressNow();
    } catch (e) {
      opts.pushToast('reader.crossVolume.progressSaveFailed');
      log('[crossVolume] save progress failed', e);
    }
  }

  /** toast close 专用：只在 awaiting-confirm 生效 + 推 seq 失效旧请求 + settleIdle */
  function dismissManual(): void {
    if (phase.value !== 'awaiting-confirm') return;
    requestSeq += 1;
    settleIdle();
  }

  /**
   * 统一入口。流程：
   * 1. phase!=='idle' 直接 return（防并发）
   * 2. !canStart() → consumePendingNextVolume + return（加载期拒绝，P1-1）
   * 3. identity()===null → return（无卷身份）
   * 4. off 模式前置处理（P0-1：必须在 findNextVolume 前）
   * 5. findNextVolume → 陈旧校验（seq + canStart + sameBookIdentity）→ null/异常/mode 分支
   */
  async function maybeContinue(force: boolean, dir: 'next' | 'prev'): Promise<void> {
    if (phase.value !== 'idle') return;
    // P1-1 修复：加载期（bookLoadPhase!=='ready'）拒绝；消费已置位的 pendingNextVolume
    // 防止 flag 停留 true 导致后续跨卷意图丢失
    if (!opts.canStart()) {
      opts.consumePendingNextVolume();
      return;
    }
    const startIdentity = opts.identity();
    if (!startIdentity) return;

    // P0-1 修复：off 必须在 findNextVolume 之前处理
    const mode: ContinueMode = force ? 'auto' : opts.getContinueMode();
    if (mode === 'off') {
      settleIdle();
      return;
    }

    // 2026-08-16: 自动跨卷（非 force + auto 档）跳过已读完的相邻卷；
    // manual 档 toast 目标由用户确认、force（Alt+→）是显式跳卷 —— 都不跳。
    const skipFinished = !force && mode === 'auto';
    const seq = ++requestSeq;
    phase.value = 'resolving';
    // A7 修复: 进入 maybeContinue 入口立即捕获 isSlideshowPlaying, 避免 race 期间手动 toggle 后误判.
    // 仅 auto/force 路径续播 — manual 模式走 confirmManual 显式 confirm, 传 false.
    // 入口早捕获: 即使 phase='resolving' 期间用户切换 slideshow 也不影响本判断.
    const wasSlideshowPlaying = mode !== 'manual' ? (opts.isSlideshowPlaying?.() ?? false) : false;
    try {
      const result = await findNextVolume(startIdentity.descriptor, startIdentity.relPath, dir, { skipFinished });
      // 陈旧校验：seq / canStart / identity 任一变化即丢弃
      if (seq !== requestSeq || !opts.canStart() || !sameBookIdentity(opts.identity(), startIdentity)) {
        settleIdle();
        return;
      }
      if (!result) {
        opts.pushToast('reader.crossVolume.none');
        settleIdle();
        return;
      }
      const t: NextVolumeTarget = {
        descriptor: result.descriptor as NextVolumeTarget['descriptor'],
        relPath: result.relPath,
        title: result.title,
      };
      if (mode === 'manual') {
        // 冻结身份供 confirmManual 再校验
        pendingCrossVolume.value = t;
        identityAtArm = startIdentity;
        phase.value = 'awaiting-confirm';
        return;
      }
      await navigateResolvedTarget(t, startIdentity, seq, wasSlideshowPlaying, true /* auto/force */);
    } catch (e) {
      opts.pushToast('reader.crossVolume.failed');
      log('[crossVolume] resolve failed', e);
      settleIdle();
    }
  }

  return { phase, pendingCrossVolume, busy, maybeContinue, confirmManual, dismissManual };
}