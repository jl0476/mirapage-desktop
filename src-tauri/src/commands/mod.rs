//! Tauri commands(前端 IPC 入口)
//!
//! **设计原则**:所有 commands 都走 `MediaSourceFactory::resolve(descriptor)`,
//! UI 不直接接触具体实现。新增远程源不影响 commands 签名。

pub mod accounts;
pub mod bookmarks;
pub mod directory_sort;
pub mod file_browser;
pub mod find_next_volume;
pub mod history;
pub mod keep_screen_on;
pub mod library;
pub mod likes;
pub mod log;
pub mod progress;
pub mod settings;
pub mod shortcuts;
pub mod tags;