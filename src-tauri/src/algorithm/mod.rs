//! 纯算法模块
//!
//! **设计原则**：所有算法都是纯函数（不依赖 IO / DB / 网络），便于单测。
//! 直接参考 MiraPage Android 的同名算法实现，但用 Rust 重写。
//!
//! ## 参考
//! - `DESIGN.md` §13 Domain 算法清单（待移植）
//! - `DESIGN.md` §13.3 关键重写注意事项

pub mod image_header;
pub mod mime;
pub mod natural_sort;
pub mod path;
pub mod spread_planner;

pub use image_header::{image_dimensions, ImageDimensions};
pub use mime::{is_archive, is_image, mime_from_name, supported_extensions};
pub use natural_sort::{natural_compare, natural_sort};
pub use path::{join, normalize, parent, segments, validate_source_relative, PathUtils, RelPathError};
pub use spread_planner::SpreadPlanner;