//! 远程 Archive 物化（M3）：`archive_cache` 索引 + 物化器。
//!
//! 本模块按任务逐个启用子模块；任务 1 仅包含 DAO。

pub mod backend;
pub mod cache_coordinator;
pub mod dao;
pub mod materializer;
pub mod password;
pub mod prefetch;
pub mod rar_backend;
pub mod rar_callback;
pub mod service;
pub mod sevenz_backend;
pub mod sevenz_header_precheck;
pub mod zip_backend;
