//! 窗口恢复尺寸钳位（3.1.1 遗留打磨项，2026-08-29）。
//!
//! tauri-plugin-window-state 的 restore_state 对 SIZE 无条件 `set_size`（POSITION
//! 才有 monitor.intersects 守卫）——大屏保存的尺寸在小屏/副屏断连后恢复会超屏。
//! 本模块在插件恢复之后对主窗口做一次性钳位：纯函数可单测，OS 交互在 lib.rs setup。

/// 将窗口物理尺寸钳位到显示器尺寸内。
///
/// - 任一维度超出显示器则收窄到显示器该维度；
/// - 显示器尺寸 0（异常枚举值）按 1 兜底，避免产出 0 尺寸窗口；
/// - 未超出的维度原样返回（不放大、不凑整）。
pub fn clamp_window_size(
    width: u32,
    height: u32,
    monitor_width: u32,
    monitor_height: u32,
) -> (u32, u32) {
    let max_w = monitor_width.max(1);
    let max_h = monitor_height.max(1);
    (width.min(max_w), height.min(max_h))
}

#[cfg(test)]
mod tests {
    use super::clamp_window_size;

    #[test]
    fn 超宽超高的窗口双向钳位到显示器尺寸() {
        assert_eq!(clamp_window_size(3840, 2160, 2560, 1440), (2560, 1440));
    }

    #[test]
    fn 仅宽超出的窗口只钳宽_高保留() {
        assert_eq!(clamp_window_size(3840, 800, 2560, 1440), (2560, 800));
    }

    #[test]
    fn 未超出的窗口原样返回() {
        assert_eq!(clamp_window_size(1280, 800, 2560, 1440), (1280, 800));
    }

    #[test]
    fn 恰好等于显示器尺寸不变() {
        assert_eq!(clamp_window_size(2560, 1440, 2560, 1440), (2560, 1440));
    }

    #[test]
    fn 显示器异常零值按一兜底_不产出零尺寸窗口() {
        assert_eq!(clamp_window_size(1280, 800, 0, 0), (1, 1));
        assert_eq!(clamp_window_size(1280, 800, 0, 1440), (1, 800));
    }
}
