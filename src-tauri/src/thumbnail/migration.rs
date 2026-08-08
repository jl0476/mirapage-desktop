//! 缓存目录迁移（§11）：校验目标、逐文件复制+校验、manifest 驱动的可恢复/可取消/可回滚。
//!
//! 核心逻辑全部为接受 `&dyn FsOps` 的函数，便于用 temp 目录 + 注入式 fs 单测。
//! 生产用 `RealFs`（std::fs）。
//!
//! 安全约束（§11.4）：整体校验完成（提交）前**不删除任何旧文件**；提交后才在 Move 模式下
//! 删源并删 manifest。取消/回滚只动目标目录。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// manifest 文件名（落在 target 根）。先写 `.tmp` 再原子替换。
pub const MANIFEST_NAME: &str = ".mirapage-thumbnail-migration.json";
pub const MANIFEST_TMP_NAME: &str = ".mirapage-thumbnail-migration.json.tmp";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MigrationPhase {
    Preparing,
    Moving,
    Verifying,
    Committing,
    Completed,
    Cancelled,
    RollingBack,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MigrationMode {
    Move,
    Copy,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationManifest {
    pub version: u32,
    pub source_root: String,
    pub target_root: String,
    pub mode: MigrationMode,
    pub phase: MigrationPhase,
    /// 已复制+校验的相对路径集合（相对缓存根，如 `v1/ab/key.webp`）。
    pub completed: BTreeSet<String>,
    pub total_files: u64,
    pub total_bytes: u64,
    pub copied_bytes: u64,
}

impl MigrationManifest {
    pub fn new(source_root: String, target_root: String, mode: MigrationMode) -> Self {
        Self {
            version: 1,
            source_root,
            target_root,
            mode,
            phase: MigrationPhase::Preparing,
            completed: BTreeSet::new(),
            total_files: 0,
            total_bytes: 0,
            copied_bytes: 0,
        }
    }
    pub fn progress_frac(&self) -> f64 {
        if self.total_bytes == 0 {
            return 1.0;
        }
        self.copied_bytes as f64 / self.total_bytes as f64
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid target: {0}")]
    InvalidTarget(String),
    #[error("cancelled")]
    Cancelled,
    #[error("verify failed for {rel}: {reason}")]
    Verify { rel: String, reason: String },
    #[error("manifest corrupt: {0}")]
    Manifest(String),
}

// ─── FsOps trait（可注入）──────────────────────────────────────────────

pub trait FsOps: Send + Sync {
    fn create_dir_all(&self, p: &Path) -> std::io::Result<()>;
    fn copy(&self, from: &Path, to: &Path) -> std::io::Result<u64>;
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn remove_file(&self, p: &Path) -> std::io::Result<()>;
    fn remove_dir_all(&self, p: &Path) -> std::io::Result<()>;
    fn file_size(&self, p: &Path) -> std::io::Result<u64>;
    fn exists(&self, p: &Path) -> bool;
    /// 递归列出 root 下所有文件（相对 root 的路径 + 字节）。
    fn list_files(&self, root: &Path) -> std::io::Result<Vec<(String, u64)>>;
    fn write(&self, p: &Path, bytes: &[u8]) -> std::io::Result<()>;
}

pub struct RealFs;
impl FsOps for RealFs {
    fn create_dir_all(&self, p: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(p)
    }
    fn copy(&self, from: &Path, to: &Path) -> std::io::Result<u64> {
        std::fs::copy(from, to)
    }
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }
    fn remove_file(&self, p: &Path) -> std::io::Result<()> {
        std::fs::remove_file(p)
    }
    fn remove_dir_all(&self, p: &Path) -> std::io::Result<()> {
        std::fs::remove_dir_all(p)
    }
    fn file_size(&self, p: &Path) -> std::io::Result<u64> {
        Ok(std::fs::metadata(p)?.len())
    }
    fn exists(&self, p: &Path) -> bool {
        p.exists()
    }
    fn list_files(&self, root: &Path) -> std::io::Result<Vec<(String, u64)>> {
        let mut out = Vec::new();
        if !root.exists() {
            return Ok(out);
        }
        walk(root, root, &mut out)?;
        Ok(out)
    }
    fn write(&self, p: &Path, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::write(p, bytes)
    }
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            // 跳过 manifest 自身
            if rel.ends_with(".json") || rel.ends_with(".json.tmp") {
                continue;
            }
            out.push((rel, entry.metadata()?.len()));
        }
    }
    Ok(())
}

// ─── manifest 持久化 ──────────────────────────────────────────────────

fn manifest_path(target_root: &Path) -> PathBuf {
    target_root.join(MANIFEST_NAME)
}
fn manifest_tmp_path(target_root: &Path) -> PathBuf {
    target_root.join(MANIFEST_TMP_NAME)
}

/// 原子写 manifest：先写 .tmp 再 rename。
pub fn save_manifest(fs: &dyn FsOps, target_root: &Path, m: &MigrationManifest) -> Result<(), MigrationError> {
    let bytes = serde_json::to_vec(m).map_err(|e| MigrationError::Manifest(e.to_string()))?;
    let tmp = manifest_tmp_path(target_root);
    let final_path = manifest_path(target_root);
    fs.write(&tmp, &bytes)?;
    fs.rename(&tmp, &final_path)?;
    Ok(())
}

pub fn load_manifest(fs: &dyn FsOps, target_root: &Path) -> Result<Option<MigrationManifest>, MigrationError> {
    let p = manifest_path(target_root);
    if !fs.exists(&p) {
        return Ok(None);
    }
    let bytes = std::fs::read(&p)?;
    let m: MigrationManifest = serde_json::from_slice(&bytes).map_err(|e| MigrationError::Manifest(e.to_string()))?;
    Ok(Some(m))
}

pub fn remove_manifest(fs: &dyn FsOps, target_root: &Path) {
    let _ = fs.remove_file(&manifest_path(target_root));
    let _ = fs.remove_file(&manifest_tmp_path(target_root));
}

// ─── 校验 ─────────────────────────────────────────────────────────────

/// 校验目标目录：非空、非源目录、非源/目标的子目录、可创建可写。
pub fn validate_target(source: &Path, target: &Path, fs: &dyn FsOps) -> Result<(), MigrationError> {
    let target_str = target.to_string_lossy();
    if target_str.is_empty() {
        return Err(MigrationError::InvalidTarget("目标为空".into()));
    }
    // 不允许磁盘根（路径无父目录或父目录即根）
    if target.parent().map(|p| p.as_os_str().is_empty()).unwrap_or(true) {
        return Err(MigrationError::InvalidTarget("不允许磁盘根目录".into()));
    }
    // 先创建目标（canonicalize 需路径存在），再规范化比较（避免 Windows \\?\ 前缀不一致）
    fs.create_dir_all(target)?;
    let canon_source = source.canonicalize().unwrap_or_else(|_| source.to_path_buf());
    let canon_target = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    if canon_source == canon_target {
        return Err(MigrationError::InvalidTarget("目标不能与源相同".into()));
    }
    if canon_target.starts_with(&canon_source) {
        return Err(MigrationError::InvalidTarget("目标不能是源目录的子目录".into()));
    }
    if canon_source.starts_with(&canon_target) {
        return Err(MigrationError::InvalidTarget("源不能是目标目录的子目录".into()));
    }
    // 可写（写测试文件）
    let probe = target.join(".mirapage-write-probe");
    fs.write(&probe, b"ok")?;
    let _ = fs.remove_file(&probe);
    Ok(())
}

// ─── 迁移执行 ─────────────────────────────────────────────────────────

/// 列出 source 下全部缓存文件 + 总字节（排除 manifest）。
pub fn plan_migration(source: &Path, fs: &dyn FsOps) -> Result<(Vec<(String, u64)>, u64), MigrationError> {
    let files = fs.list_files(source)?;
    let total: u64 = files.iter().map(|(_, b)| b).sum();
    Ok((files, total))
}

/// 执行迁移：逐文件 copy→.tmp→校验大小→rename，每完成一个文件原子更新 manifest。
/// 可恢复：跳过 `completed`；可取消：检查 `cancel`，取消后 phase=Cancelled。
/// **整体校验（提交）前不删源文件**。
pub fn run_migration(
    source: &Path,
    target: &Path,
    mode: MigrationMode,
    fs: &dyn FsOps,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(&MigrationManifest),
) -> Result<MigrationManifest, MigrationError> {
    fs.create_dir_all(target)?;
    let mut manifest = load_manifest(fs, target)?
        .unwrap_or_else(|| MigrationManifest::new(source.to_string_lossy().into_owned(), target.to_string_lossy().into_owned(), mode));
    manifest.mode = mode;

    // 规划（统计源文件）
    let (files, total_bytes) = plan_migration(source, fs)?;
    manifest.total_files = files.len() as u64;
    manifest.total_bytes = total_bytes;

    manifest.phase = MigrationPhase::Moving;
    save_manifest(fs, target, &manifest)?;
    on_progress(&manifest);

    for (rel, size) in &files {
        if cancel.load(Ordering::Relaxed) {
            manifest.phase = MigrationPhase::Cancelled;
            save_manifest(fs, target, &manifest)?;
            on_progress(&manifest);
            return Err(MigrationError::Cancelled);
        }
        if manifest.completed.contains(rel) {
            continue; // resume 跳过
        }
        let src_file = source.join(rel);
        let dst_file = target.join(rel);
        let dst_tmp = target.join(format!("{rel}.tmp"));
        if let Some(parent) = dst_file.parent() {
            fs.create_dir_all(parent)?;
        }
        // copy → .tmp → 校验大小 → rename
        let copied = fs.copy(&src_file, &dst_tmp)?;
        if copied == 0 || copied != *size {
            let _ = fs.remove_file(&dst_tmp);
            return Err(MigrationError::Verify {
                rel: rel.clone(),
                reason: format!("size mismatch: copied {copied}, expected {size}"),
            });
        }
        // 目标若已存在（重试），先删再 rename
        if fs.exists(&dst_file) {
            let _ = fs.remove_file(&dst_file);
        }
        fs.rename(&dst_tmp, &dst_file)?;
        manifest.completed.insert(rel.clone());
        manifest.copied_bytes += size;
        save_manifest(fs, target, &manifest)?;
        on_progress(&manifest);
    }

    // 整体校验：每个 completed 在 target 存在且大小匹配
    manifest.phase = MigrationPhase::Verifying;
    save_manifest(fs, target, &manifest)?;
    for rel in manifest.completed.clone() {
        let src_size = files.iter().find(|(r, _)| r == &rel).map(|(_, s)| *s);
        let dst_file = target.join(&rel);
        if !fs.exists(&dst_file) {
            return Err(MigrationError::Verify { rel, reason: "missing after copy".into() });
        }
        if let Some(expected) = src_size {
            let got = fs.file_size(&dst_file).unwrap_or(0);
            if got != expected {
                return Err(MigrationError::Verify { rel, reason: format!("size {got} != {expected}") });
            }
        }
    }

    manifest.phase = MigrationPhase::Completed;
    save_manifest(fs, target, &manifest)?;
    on_progress(&manifest);
    Ok(manifest)
}

/// 提交：Move 模式删源文件（保留源根目录），删 manifest。Copy 模式只删 manifest。
/// 调用前需完成 run_migration（phase=Completed）并已切换缓存根设置。
pub fn commit_migration(source: &Path, target: &Path, mode: MigrationMode, fs: &dyn FsOps) -> Result<(), MigrationError> {
    if matches!(mode, MigrationMode::Move) {
        // 删源文件（不删源根目录本身）
        let files = fs.list_files(source)?;
        for (rel, _) in files {
            let _ = fs.remove_file(&source.join(&rel));
        }
    }
    remove_manifest(fs, target);
    Ok(())
}

/// 回滚：删 target 下所有已复制文件（含 manifest），保留源目录。
pub fn rollback_migration(target: &Path, fs: &dyn FsOps) -> Result<(), MigrationError> {
    if fs.exists(target) {
        // 删 target 下文件（按 manifest 列表，或整体清空 target 子树）
        let files = fs.list_files(target)?;
        for (rel, _) in files {
            let _ = fs.remove_file(&target.join(&rel));
        }
    }
    remove_manifest(fs, target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn write_cache(fs: &RealFs, root: &Path, files: &[(&str, &[u8])]) {
        for (rel, data) in files {
            let p = root.join(rel);
            fs.create_dir_all(p.parent().unwrap()).unwrap();
            fs.write(&p, data).unwrap();
        }
    }

    #[test]
    fn validate_rejects_same_and_subdir() {
        let fs = RealFs;
        let src = tempfile::tempdir().unwrap();
        let srcp = src.path().to_path_buf();
        // 同目录
        assert!(validate_target(&srcp, &srcp, &fs).is_err());
        // 子目录
        let sub = src.path().join("sub");
        assert!(validate_target(&srcp, &sub, &fs).is_err());
        // 合法目标
        let tgt = tempfile::tempdir().unwrap();
        assert!(validate_target(&srcp, tgt.path(), &fs).is_ok());
    }

    #[test]
    fn run_migration_copies_all_and_verifies() {
        let fs = RealFs;
        let src = tempfile::tempdir().unwrap();
        let tgt = tempfile::tempdir().unwrap();
        write_cache(&fs, src.path(), &[
            ("v1/ab/a.webp", b"webp-a"),
            ("v1/cd/b.webp", b"webp-bb"),
        ]);
        let cancel = AtomicBool::new(false);
        let mut noop = |_: &MigrationManifest| {};
        let m = run_migration(src.path(), tgt.path(), MigrationMode::Move, &fs, &cancel, &mut noop).unwrap();
        assert_eq!(m.phase, MigrationPhase::Completed);
        assert_eq!(m.completed.len(), 2);
        // target 有文件
        assert!(fs.exists(&tgt.path().join("v1/ab/a.webp")));
        assert!(fs.exists(&tgt.path().join("v1/cd/b.webp")));
        // 源未删（提交前不删）
        assert!(fs.exists(&src.path().join("v1/ab/a.webp")));
    }

    #[test]
    fn commit_move_deletes_source_and_manifest() {
        let fs = RealFs;
        let src = tempfile::tempdir().unwrap();
        let tgt = tempfile::tempdir().unwrap();
        write_cache(&fs, src.path(), &[("v1/ab/a.webp", b"x"), ("v1/cd/b.webp", b"yy")]);
        let cancel = AtomicBool::new(false);
        let mut noop = |_: &MigrationManifest| {};
        let m = run_migration(src.path(), tgt.path(), MigrationMode::Move, &fs, &cancel, &mut noop).unwrap();
        assert_eq!(m.phase, MigrationPhase::Completed);
        commit_migration(src.path(), tgt.path(), MigrationMode::Move, &fs).unwrap();
        // 源文件已删
        assert!(!fs.exists(&src.path().join("v1/ab/a.webp")));
        // target 保留
        assert!(fs.exists(&tgt.path().join("v1/ab/a.webp")));
        // manifest 删除
        assert!(!fs.exists(&manifest_path(tgt.path())));
    }

    #[test]
    fn cancel_keeps_source_and_marks_cancelled() {
        let fs = RealFs;
        let src = tempfile::tempdir().unwrap();
        let tgt = tempfile::tempdir().unwrap();
        write_cache(&fs, src.path(), &[
            ("v1/a/1.webp", b"1"), ("v1/a/2.webp", b"2"), ("v1/a/3.webp", b"3"),
        ]);
        let cancel = AtomicBool::new(false);
        // 在第 1 个文件后取消
        let counter = AtomicUsize::new(0);
        let mut on_prog = |m: &MigrationManifest| {
            counter.fetch_add(1, Ordering::Relaxed);
            if m.completed.len() >= 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let res = run_migration(src.path(), tgt.path(), MigrationMode::Move, &fs, &cancel, &mut on_prog);
        assert!(matches!(res, Err(MigrationError::Cancelled)));
        // 源全部保留
        assert!(fs.exists(&src.path().join("v1/a/1.webp")));
        assert!(fs.exists(&src.path().join("v1/a/3.webp")));
    }

    #[test]
    fn resume_skips_completed() {
        let fs = RealFs;
        let src = tempfile::tempdir().unwrap();
        let tgt = tempfile::tempdir().unwrap();
        write_cache(&fs, src.path(), &[("v1/a/1.webp", b"11"), ("v1/a/2.webp", b"22")]);
        // 第一轮：完成
        let cancel = AtomicBool::new(false);
        let mut noop = |_: &MigrationManifest| {};
        let m1 = run_migration(src.path(), tgt.path(), MigrationMode::Copy, &fs, &cancel, &mut noop).unwrap();
        assert_eq!(m1.completed.len(), 2);
        // 第二轮（resume）：manifest 已存，completed 跳过，不再复制（progress 直接到完成）
        let mut copies = 0;
        let mut on_prog = |m: &MigrationManifest| {
            if m.phase == MigrationPhase::Moving {
                copies += 1;
            }
        };
        let _m2 = run_migration(src.path(), tgt.path(), MigrationMode::Copy, &fs, &cancel, &mut on_prog).unwrap();
        // Moving 阶段不会因复制产生额外 completed（已全完成）
        assert_eq!(copies, 1); // 仅初始 Moving 一次
    }

    #[test]
    fn rollback_deletes_target_keeps_source() {
        let fs = RealFs;
        let src = tempfile::tempdir().unwrap();
        let tgt = tempfile::tempdir().unwrap();
        write_cache(&fs, src.path(), &[("v1/a/1.webp", b"11"), ("v1/a/2.webp", b"22")]);
        let cancel = AtomicBool::new(false);
        let mut noop = |_: &MigrationManifest| {};
        // 复制完成后再 rollback（模拟取消后回滚）
        let _m = run_migration(src.path(), tgt.path(), MigrationMode::Move, &fs, &cancel, &mut noop).unwrap();
        rollback_migration(tgt.path(), &fs).unwrap();
        // target 副本删除
        assert!(!fs.exists(&tgt.path().join("v1/a/1.webp")));
        // 源保留（rollback 不动源）
        assert!(fs.exists(&src.path().join("v1/a/1.webp")));
        // manifest 删除
        assert!(!fs.exists(&manifest_path(tgt.path())));
    }

    #[test]
    fn manifest_persists_across_save_load() {
        let fs = RealFs;
        let tgt = tempfile::tempdir().unwrap();
        let mut m = MigrationManifest::new("/src".into(), tgt.path().to_string_lossy().into_owned(), MigrationMode::Move);
        m.completed.insert("v1/a/1.webp".into());
        m.copied_bytes = 100;
        m.total_bytes = 1000;
        save_manifest(&fs, tgt.path(), &m).unwrap();
        let loaded = load_manifest(&fs, tgt.path()).unwrap().unwrap();
        assert_eq!(loaded.copied_bytes, 100);
        assert!(loaded.completed.contains("v1/a/1.webp"));
    }
}
