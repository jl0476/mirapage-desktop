//! Algorithm 模块:Phase 1 纯 std lib 副本
//!
//! 与 `src-tauri/src/algorithm/*.rs` 严格 1:1 镜像。
//! 用途:独立跑测试,绕开 Tauri 全栈 build 链路。
//!
//! 内含:
//! - natural_compare / natural_sort
//! - SpreadPlanner::plan / spread_index_for_page / first_page_of_spread
//! - extension_of / is_image / is_archive / mime_from_name / supported_extensions
//! - segments / normalize / join / parent / crumbs + PathUtils 命名空间

pub mod image_header;
pub mod mime;
pub mod natural_sort;
pub mod path;
pub mod spread_planner;

pub use image_header::{image_dimensions, ImageDimensions};
pub use mime::{is_archive, is_image, mime_from_name, supported_extensions};
pub use natural_sort::{natural_compare, natural_sort};
pub use path::{PathUtils, join, normalize, parent, segments};
pub use spread_planner::SpreadPlanner;
