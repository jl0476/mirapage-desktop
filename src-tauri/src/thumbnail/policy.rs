//! 缩略图策略纯函数（尺寸档位 / 生成阈值 / 像素预算 / 资源预设 / 内存估算）
//!
//! 全部为纯函数，无 IO / DB / 网络依赖，便于单测。语义对齐
//! `docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md` §6 §8。

use super::{ResourceMode, ResourcePreset, THUMBNAIL_SIZE_BUCKETS, Quality};

// ─── 尺寸档位 ──────────────────────────────────────────────────────────

/// 选择「不小于 `required_width` 的最小尺寸档位」。
/// 超出最大档位时钳到 2048，低于最小档位时取 512。
pub fn select_bucket(required_width: u32) -> u32 {
    for &bucket in THUMBNAIL_SIZE_BUCKETS {
        if bucket >= required_width {
            return bucket;
        }
    }
    // required_width 超过 2048：用最大档位，是否进一步用原图由 decide_source 判断。
    *THUMBNAIL_SIZE_BUCKETS.last().unwrap()
}

// ─── 清晰度策略 ────────────────────────────────────────────────────────

/// 清晰度对应的余量 / WebP 质量 / 最大档位（§6.1）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QualityPolicy {
    pub margin: f32,
    pub webp_quality: f32,
    pub max_bucket: u32,
}

pub fn quality_policy(quality: Quality) -> QualityPolicy {
    match quality {
        Quality::Standard => QualityPolicy {
            margin: 1.0,
            webp_quality: 78.0,
            max_bucket: 1536,
        },
        Quality::High => QualityPolicy {
            margin: 1.25,
            webp_quality: 82.0,
            max_bucket: 2048,
        },
        Quality::Ultra => QualityPolicy {
            margin: 1.5,
            webp_quality: 88.0,
            max_bucket: 2048,
        },
    }
}

/// `required_width = card_css_width × dpr × quality_margin`（§6.1）。
/// 采用四舍五入（half away from zero），与设计文档示例表的数值一致。
pub fn required_width(card_css_width: u32, dpr: f32, margin: f32) -> u32 {
    (card_css_width as f32 * dpr * margin).round() as u32
}

// ─── 资源预设 ──────────────────────────────────────────────────────────

/// 按资源模式解析固定预设（§8.1）。`Custom` 无预设，返回 `None`，
/// 由用户高级参数决定。
pub fn resource_preset(mode: ResourceMode) -> Option<ResourcePreset> {
    match mode {
        ResourceMode::PowerSaver => Some(ResourcePreset {
            worker_limit: 1,
            decode_memory_mb: 64,
            prefetch_screens: 0.5,
            idle_generation: false,
            idle_prefetch_screens: 0.0,
        }),
        ResourceMode::Balanced => Some(ResourcePreset {
            worker_limit: 2,
            decode_memory_mb: 128,
            prefetch_screens: 1.5,
            idle_generation: true,
            idle_prefetch_screens: 1.0,
        }),
        ResourceMode::Performance => Some(ResourcePreset {
            worker_limit: 3,
            decode_memory_mb: 256,
            prefetch_screens: 2.5,
            idle_generation: true,
            idle_prefetch_screens: 2.0,
        }),
        ResourceMode::Custom => None,
    }
}

// ─── 生成决策 ──────────────────────────────────────────────────────────

/// 生成紧迫度。硬阈值命中为 `Required`；灰区为 `Opportunistic`（低优先生成）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationUrgency {
    Required,
    Opportunistic,
}

/// Worker 并发上限常量（v0.1.0+ 1–16；与前端 `WORKER_LIMIT_MAX` 对齐）。
pub const WORKER_LIMIT_MIN: u32 = 1;
pub const WORKER_LIMIT_MAX: u32 = 16;

/// Worker 数钳到合法范围 [WORKER_LIMIT_MIN, WORKER_LIMIT_MAX]。
/// 输入非有限数或低于下界钳到 MIN；高于上界钳到 MAX。
/// 与 `src/lib/thumbnail.ts::normalizeWorkerLimit` 语义对齐。
pub fn normalize_worker_limit(value: u32) -> u32 {
    value.clamp(WORKER_LIMIT_MIN, WORKER_LIMIT_MAX)
}

/// 对单张原图的处置决策（§6.2 §6.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceDecision {
    /// 满足全部直用条件，瀑布流直接用原图。
    UseOriginal,
    /// 需要生成缩略图，输出档位为 `bucket`，紧迫度为 `priority`。
    Generate {
        bucket: u32,
        priority: GenerationUrgency,
    },
}

/// 直用原图体积上限（2MB，十进制）。
const DIRECT_USE_MAX_BYTES: u64 = 2_000_000;
/// 必生成文件体积硬阈值（4MB，十进制）。
const HARD_MAX_BYTES: u64 = 4_000_000;
/// 直用原图总像素上限（2MP）。
const DIRECT_USE_MAX_PIXELS: u64 = 2_000_000;
/// 必生成总像素硬阈值（4MP）。
const HARD_MAX_PIXELS: u64 = 4_000_000;
/// 必生成单边硬阈值（4096px）。
const HARD_MAX_EDGE: u32 = 4096;
/// 直用宽度相对档位的倍数上限（×1.25）。
const DIRECT_USE_WIDTH_RATIO: f32 = 1.25;
/// 必生成宽度相对档位的倍数硬阈值（×1.5）。
const HARD_WIDTH_RATIO: f32 = 1.5;

/// 判断单张原图是直用、必生成还是灰区生成。
///
/// 判断顺序（计划任务2 步骤3）：方向归一化宽高 -> 硬阈值优先 -> 直用条件全部成立 -> 灰区。
///
/// - `oriented_width/height`：EXIF 方向归一化后的显示宽高。
/// - `file_size`：原文件字节数。
/// - `target_bucket`：本次需求宽度对应的输出档位。
pub fn decide_source(
    oriented_width: u32,
    oriented_height: u32,
    file_size: u64,
    target_bucket: u32,
) -> SourceDecision {
    // 尺寸未知（header 预读失败，前端传 0）：不能判 UseOriginal（不知真实尺寸），
    // 强制 Generate 让生成器 decode 完整文件拿真实尺寸兜底。Opportunistic 低优先级
    //（尺寸未知不命中硬阈值 Required，避免和明确的大图抢 worker）。
    if oriented_width == 0 || oriented_height == 0 {
        return SourceDecision::Generate {
            bucket: target_bucket,
            priority: GenerationUrgency::Opportunistic,
        };
    }
    let pixels = (oriented_width as u64) * (oriented_height as u64);
    let max_edge = oriented_width.max(oriented_height);
    let bucket_f = target_bucket as f32;
    let oriented_w_f = oriented_width as f32;

    // 硬阈值（§6.3）：任一命中即必生成。
    let hard_hit = oriented_w_f > bucket_f * HARD_WIDTH_RATIO
        || pixels > HARD_MAX_PIXELS
        || file_size > HARD_MAX_BYTES
        || max_edge > HARD_MAX_EDGE;
    if hard_hit {
        return SourceDecision::Generate {
            bucket: target_bucket,
            priority: GenerationUrgency::Required,
        };
    }

    // 直用条件（§6.2）：必须全部满足。
    let direct_use = oriented_w_f <= bucket_f * DIRECT_USE_WIDTH_RATIO
        && pixels <= DIRECT_USE_MAX_PIXELS
        && file_size <= DIRECT_USE_MAX_BYTES;
    if direct_use {
        return SourceDecision::UseOriginal;
    }

    // 灰区：仍生成，但低优先级。
    SourceDecision::Generate {
        bucket: target_bucket,
        priority: GenerationUrgency::Opportunistic,
    }
}

// ─── 像素预算 ──────────────────────────────────────────────────────────

const NORMAL_PIXEL_BUDGET: u32 = 3_000_000;
const LONG_IMAGE_PIXEL_BUDGET: u32 = 4_000_000;

/// 输出缩略图像素预算（§6.4）。普通图 3MP；极端长图（宽高比 > 10:1）放宽到 4MP。
/// 任一维为 0 时按普通预算处理，避免除零。
pub fn output_pixel_budget(oriented_width: u32, oriented_height: u32) -> u32 {
    let min = oriented_width.min(oriented_height) as u64;
    let max = oriented_width.max(oriented_height) as u64;
    if min == 0 {
        return NORMAL_PIXEL_BUDGET;
    }
    // max/min > 10  <=>  max > min*10（整数比较，无浮点误差）
    if max > min * 10 {
        LONG_IMAGE_PIXEL_BUDGET
    } else {
        NORMAL_PIXEL_BUDGET
    }
}

// ─── 内存估算 ──────────────────────────────────────────────────────────

/// 预计单任务解码内存（MB）= 源像素×4 + 输出工作集×4，向上取整为十进制 MB。
/// 25MP 源约 100MB（§8.3）。用于调度器的内存预算准入判断。
pub fn estimated_decode_memory_mb(
    oriented_width: u32,
    oriented_height: u32,
    out_width: u32,
    out_height: u32,
) -> u32 {
    let source_bytes = (oriented_width as u64) * (oriented_height as u64) * 4;
    let output_bytes = (out_width as u64) * (out_height as u64) * 4;
    let total = source_bytes + output_bytes;
    // 向上取整到 MB（预算估算偏保守）
    ((total + 999_999) / 1_000_000) as u32
}

// ─── 并发准入 ──────────────────────────────────────────────────────────

/// 计算当前可并发启动的任务数 = min(worker_limit, 内存允许数, 队列长度)（§8.3）。
///
/// 按任务提交顺序（优先级从高到低）逐个尝试接纳：
/// - 累加后仍在预算内 -> 接纳；
/// - 当前无任务在跑（`acc == 0`）-> 允许单张超预算图独占执行；
/// - 否则跳过该任务，继续尝试队列中能放下者（避免一张大图永久饿死后面的可放下任务）。
///
/// `task_memory_mb` 为各任务预计解码内存（MB），已按优先级排序。
pub fn allowed_jobs(worker_limit: u32, memory_budget_mb: u32, task_memory_mb: &[u32]) -> u32 {
    if worker_limit == 0 || task_memory_mb.is_empty() {
        return 0;
    }
    let budget = memory_budget_mb as u64;
    let mut acc: u64 = 0;
    let mut count: u32 = 0;
    for &mem in task_memory_mb {
        if count >= worker_limit {
            break;
        }
        let m = mem as u64;
        if acc + m <= budget || acc == 0 {
            acc += m;
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── select_bucket ──────────────────────────────────────────────────

    #[test]
    fn select_bucket_picks_smallest_bucket_ge_required() {
        assert_eq!(select_bucket(512), 512);
        assert_eq!(select_bucket(513), 768);
        assert_eq!(select_bucket(801), 1024);
        assert_eq!(select_bucket(1024), 1024);
        assert_eq!(select_bucket(2048), 2048);
    }

    #[test]
    fn select_bucket_clamps_to_max_2048_and_min_512() {
        assert_eq!(select_bucket(2100), 2048);
        assert_eq!(select_bucket(u32::MAX), 2048);
        assert_eq!(select_bucket(0), 512);
        assert_eq!(select_bucket(1), 512);
    }

    // ── normalize_worker_limit ─────────────────────────────────────────

    #[test]
    fn normalize_worker_limit_legal_values_unchanged() {
        assert_eq!(normalize_worker_limit(1), 1);
        assert_eq!(normalize_worker_limit(2), 2);
        assert_eq!(normalize_worker_limit(4), 4);
        assert_eq!(normalize_worker_limit(8), 8);
        assert_eq!(normalize_worker_limit(16), 16);
    }

    #[test]
    fn normalize_worker_limit_clamps_above_max() {
        assert_eq!(normalize_worker_limit(17), 16);
        assert_eq!(normalize_worker_limit(100), 16);
        assert_eq!(normalize_worker_limit(u32::MAX), 16);
    }

    #[test]
    fn normalize_worker_limit_clamps_below_min() {
        assert_eq!(normalize_worker_limit(0), 1);
    }

    #[test]
    fn normalize_worker_limit_bounds_match_frontend_constant() {
        // 与前端 src/lib/thumbnail.ts 的 WORKER_LIMIT_MIN/MAX 对齐；改动需同步。
        assert_eq!(WORKER_LIMIT_MIN, 1);
        assert_eq!(WORKER_LIMIT_MAX, 16);
    }

    // ── quality_policy ─────────────────────────────────────────────────

    #[test]
    fn quality_policy_high_is_1_25_82_2048() {
        let p = quality_policy(Quality::High);
        assert_eq!(p.margin, 1.25);
        assert_eq!(p.webp_quality, 82.0);
        assert_eq!(p.max_bucket, 2048);
    }

    #[test]
    fn quality_policy_standard_caps_at_1536() {
        let p = quality_policy(Quality::Standard);
        assert_eq!(p.margin, 1.0);
        assert_eq!(p.webp_quality, 78.0);
        assert_eq!(p.max_bucket, 1536);
    }

    #[test]
    fn quality_policy_ultra_margin_1_5_quality_88() {
        let p = quality_policy(Quality::Ultra);
        assert_eq!(p.margin, 1.5);
        assert_eq!(p.webp_quality, 88.0);
        assert_eq!(p.max_bucket, 2048);
    }

    // ── required_width ─────────────────────────────────────────────────

    #[test]
    fn required_width_matches_design_examples() {
        // §6.1 示例表（均用 high margin 1.25）
        assert_eq!(required_width(280, 1.0, 1.25), 350);
        assert_eq!(required_width(440, 1.0, 1.25), 550);
        assert_eq!(required_width(600, 1.25, 1.25), 938); // ceil(937.5)
        assert_eq!(required_width(750, 1.5, 1.25), 1406); // ceil(1406.25)
        assert_eq!(required_width(900, 2.0, 1.25), 2250);
    }

    // ── resource_preset ────────────────────────────────────────────────

    #[test]
    fn resource_preset_balanced_matches_design() {
        let p = resource_preset(ResourceMode::Balanced).unwrap();
        assert_eq!(p.worker_limit, 2);
        assert_eq!(p.decode_memory_mb, 128);
        assert_eq!(p.prefetch_screens, 1.5);
        assert!(p.idle_generation);
        assert_eq!(p.idle_prefetch_screens, 1.0);
    }

    #[test]
    fn resource_preset_power_saver_and_performance() {
        let ps = resource_preset(ResourceMode::PowerSaver).unwrap();
        assert_eq!(ps.worker_limit, 1);
        assert_eq!(ps.decode_memory_mb, 64);
        assert_eq!(ps.prefetch_screens, 0.5);
        assert!(!ps.idle_generation);
        assert_eq!(ps.idle_prefetch_screens, 0.0);

        let pf = resource_preset(ResourceMode::Performance).unwrap();
        assert_eq!(pf.worker_limit, 3);
        assert_eq!(pf.decode_memory_mb, 256);
        assert_eq!(pf.prefetch_screens, 2.5);
        assert!(pf.idle_generation);
        assert_eq!(pf.idle_prefetch_screens, 2.0);
    }

    #[test]
    fn resource_preset_custom_is_none() {
        assert!(resource_preset(ResourceMode::Custom).is_none());
    }

    // ── decide_source ──────────────────────────────────────────────────

    #[test]
    fn decide_source_use_original_when_all_direct_conditions_met() {
        // 800x600=0.48MP, 500KB, bucket 1024：宽 800<=1280、像素<=2MP、体积<=2MB
        let d = decide_source(800, 600, 500_000, 1024);
        assert!(matches!(d, SourceDecision::UseOriginal));
    }

    #[test]
    fn decide_source_required_when_width_exceeds_1_5x_bucket() {
        // 4000x3000=12MP, 5MB, bucket 1024：宽 4000 > 1536
        let d = decide_source(4000, 3000, 5_000_000, 1024);
        assert!(matches!(
            d,
            SourceDecision::Generate { priority: GenerationUrgency::Required, .. }
        ));
    }

    #[test]
    fn decide_source_required_when_pixels_over_4mp() {
        // 3000x2000=6MP > 4MP，体积 1MB，宽 3000 同时也超 1.5x 但走硬阈值
        let d = decide_source(3000, 2000, 1_000_000, 1024);
        assert!(matches!(
            d,
            SourceDecision::Generate { priority: GenerationUrgency::Required, .. }
        ));
    }

    #[test]
    fn decide_source_required_when_file_size_over_4mb() {
        // 1000x800=0.8MP, 5MB, bucket 1024：宽 1000<=1280、像素<=2MP，但体积>4MB
        let d = decide_source(1000, 800, 5_000_000, 1024);
        assert!(matches!(
            d,
            SourceDecision::Generate { priority: GenerationUrgency::Required, .. }
        ));
    }

    #[test]
    fn decide_source_required_when_any_edge_over_4096() {
        // 5000x500=2.5MP, 1MB, bucket 1024：max edge 5000 > 4096
        let d = decide_source(5000, 500, 1_000_000, 1024);
        assert!(matches!(
            d,
            SourceDecision::Generate { priority: GenerationUrgency::Required, .. }
        ));
    }

    #[test]
    fn decide_source_opportunistic_in_gray_zone() {
        // 1000x800=0.8MP（<=2MP 通过），3MB（>2MB 不满足直用，<=4MB 不命中硬阈值），
        // bucket 1024：宽 1000<=1280 通过，但体积不满足直用 -> 灰区低优先生成
        let d = decide_source(1000, 800, 3_000_000, 1024);
        assert!(matches!(
            d,
            SourceDecision::Generate { priority: GenerationUrgency::Opportunistic, .. }
        ));
    }

    #[test]
    fn decide_source_generate_carries_target_bucket() {
        let d = decide_source(4000, 3000, 5_000_000, 1024);
        if let SourceDecision::Generate { bucket, .. } = d {
            assert_eq!(bucket, 1024);
        } else {
            panic!("expected Generate");
        }
    }

    #[test]
    fn decide_source_zero_dims_forces_generate() {
        // header 预读失败 -> 前端传 0 尺寸：即使小文件也不判 UseOriginal，
        // 强制 Generate 让生成器 decode 完整文件兜底（避免误判后用原图加载慢）。
        let d = decide_source(0, 0, 500_000, 1024);
        assert!(matches!(
            d,
            SourceDecision::Generate { priority: GenerationUrgency::Opportunistic, bucket: 1024 }
        ));
        // 单边为 0 同样强制生成
        assert!(matches!(
            decide_source(1000, 0, 500_000, 1024),
            SourceDecision::Generate { .. }
        ));
        assert!(matches!(
            decide_source(0, 1000, 500_000, 1024),
            SourceDecision::Generate { .. }
        ));
    }

    // ── output_pixel_budget ────────────────────────────────────────────

    #[test]
    fn output_pixel_budget_3mp_for_normal_image() {
        assert_eq!(output_pixel_budget(1000, 800), 3_000_000);
        assert_eq!(output_pixel_budget(2000, 2000), 3_000_000);
    }

    #[test]
    fn output_pixel_budget_4mp_for_extreme_long_image() {
        // 宽高比 > 10:1 视为极端长图
        assert_eq!(output_pixel_budget(5000, 400), 4_000_000);
        assert_eq!(output_pixel_budget(400, 5000), 4_000_000);
    }

    #[test]
    fn output_pixel_budget_boundary_ratio_10_is_normal() {
        // 大于 10:1 才算长图，恰好 10:1 走普通 3MP
        assert_eq!(output_pixel_budget(4000, 400), 3_000_000);
    }

    #[test]
    fn output_pixel_budget_zero_dim_does_not_panic() {
        assert_eq!(output_pixel_budget(0, 0), 3_000_000);
        assert_eq!(output_pixel_budget(1000, 0), 3_000_000);
    }

    // ── estimated_decode_memory_mb ─────────────────────────────────────

    #[test]
    fn estimated_decode_memory_includes_source_and_output() {
        // 1000x1000 源 = 4MB；500x500 输出 = 1MB；合计 5MB
        assert_eq!(estimated_decode_memory_mb(1000, 1000, 500, 500), 5);
    }

    #[test]
    fn estimated_decode_memory_25mp_about_100mb_plus_output() {
        // 5000x5000=25MP 源 = 100MB；输出再加一点 -> >100
        let m = estimated_decode_memory_mb(5000, 5000, 768, 768);
        assert!(m > 100);
    }

    // ── allowed_jobs ───────────────────────────────────────────────────

    #[test]
    fn allowed_jobs_memory_limits_two_100mb_tasks_under_128() {
        assert_eq!(allowed_jobs(2, 128, &[100, 100]), 1);
    }

    #[test]
    fn allowed_jobs_single_oversized_task_runs_exclusively() {
        assert_eq!(allowed_jobs(2, 64, &[100]), 1);
    }

    #[test]
    fn allowed_jobs_worker_cap_when_memory_allows() {
        // 4 个 100MB 任务、512MB 预算 -> 内存可放 5 个但 worker 上限 4
        assert_eq!(allowed_jobs(4, 512, &[100, 100, 100, 100]), 4);
    }

    #[test]
    fn allowed_jobs_mixed_memory_and_worker() {
        // 3 个 50MB、128 预算：50+50=100<=128，第三个 150>128 -> 2，worker 上限 2 也到顶
        assert_eq!(allowed_jobs(2, 128, &[50, 50, 50]), 2);
    }

    #[test]
    fn allowed_jobs_empty_queue_is_zero() {
        assert_eq!(allowed_jobs(2, 128, &[]), 0);
    }

    #[test]
    fn allowed_jobs_zero_worker_is_zero() {
        assert_eq!(allowed_jobs(0, 128, &[100]), 0);
    }
}
