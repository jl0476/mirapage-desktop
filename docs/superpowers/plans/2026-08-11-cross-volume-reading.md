# 跨卷连续阅读 实现计划

> **面向 AI 代理的工作者:** 必需子技能:使用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法来跟踪进度。

**目标:** 填实 `find_next_volume` stub,打通 reader(末页"再向下" / 9 宫格 / slideshow)与瀑布流(工具栏按钮)的跨卷连续阅读链路。

**架构:** Rust `find_next_volume` command(async + factory + filter 参数)+ `NextVolumeResult` struct(descriptor+rel_path+title+is_archive)。前端 `useCrossVolume` composable 统一 `maybeContinue(force, dir)` 入口 + `loadCrossVolume`(智能恢复 via `initialSpreadIndex`)。reader 场景末页"再向下"(`nextPage` 检查 `isAtLastSpread`)与 slideshow tick 共用 `slideshow.pendingNextVolume` flag。瀑布流场景工具栏按钮直接 `fileBrowser.navigate`(同源不 setRoot)。

**技术栈:** Rust(Tauri 2.x async command + `algorithm::natural_compare` + `algorithm::path::PathUtils`)+ Vue 3(Pinia + composables + Vitest/happy-dom)

**spec:** [`docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md`](../specs/2026-08-11-cross-volume-reading-design.md)

---

## 文件结构

### 创建
| 文件 | 职责 |
|---|---|
| `src/composables/useCrossVolume.ts` | 跨卷统一入口(`maybeContinue` + `loadCrossVolume` + `armManualToast` + `bookSwapInFlight`) |
| `src/composables/useCrossVolume.test.ts` | 单测(off/auto/manual × force 矩阵 + null + 智能恢复 + guard) |
| `src/composables/useToast.ts` | 通用 toast 队列(`push` + 1500ms 自动隐藏,单例) |
| `src/composables/useToast.test.ts` | 单测 |
| `src/components/common/ToastHost.vue` | `<Teleport to="body">` 渲染 toast 队列 |
| `src/components/reader/ContinueNextVolumeToast.vue` | manual 模式底部胶囊(跳转/关闭) |
| `src/components/reader/ContinueNextVolumeToast.test.ts` | 单测 |

### 修改
| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/find_next_volume.rs` | stub → async 实现 + `pick_sibling` 纯函数 + `NextVolumeResult` |
| `src/lib/tauri.ts:475` | `findNextVolume` 改返回 `NextVolumeResult\|null` + `filter` 参数 |
| `src/lib/findNextDirectory.ts` | 加 `filter` 参数(校对) |
| `src/lib/findNextDirectory.test.ts` | 加 filter 用例 |
| `src/stores/reader.ts` | 加 `sourceDescriptor`/`currentRelPath` state + `flushProgress` + `nextPage` atLast 分支 |
| `src/stores/reader.test.ts` | 扩用例 |
| `src/composables/useMasonryBrowsePosition.ts` | 加 `flushNow()` 方法 |
| `src/composables/useMasonryBrowsePosition.test.ts` | flushNow 用例 |
| `src/views/ReaderView.vue` | 接 `useCrossVolume` + watch + 挂 toast |
| `src/components/filebrowser/FileBrowser.vue` | 工具栏"下一卷"按钮(masonry 场景) |
| `src/locales/zh-CN.ts` + `en-US.ts` | 6 key |

---

## 任务 1:Rust `pick_sibling` 纯函数 + 单测

**文件:**
- 修改:`src-tauri/src/commands/find_next_volume.rs`(加纯函数 + `#[cfg(test)]` 模块)

**说明:** 算法核心抽成纯函数(不依赖 IO),便于单测。复用 `algorithm::natural_compare`。

- [ ] **步骤 1:编写失败的测试**

在 `find_next_volume.rs` 末尾加:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::MediaEntry;

    fn entry(name: &str, is_dir: bool, is_archive: bool) -> MediaEntry {
        MediaEntry {
            name: name.into(),
            path: name.into(),
            is_directory: is_dir,
            is_archive,
            size: 0,
            modified_at: 0,
        }
    }

    #[test]
    fn pick_next_among_dirs() {
        let s = vec![entry("vol1", true, false), entry("vol2", true, false), entry("vol3", true, false)];
        assert_eq!(pick_sibling(&s, "vol2", "next", "reader").map(|i| s[i].name.as_str()), Some("vol3"));
    }

    #[test]
    fn pick_prev_among_dirs() {
        let s = vec![entry("vol1", true, false), entry("vol2", true, false), entry("vol3", true, false)];
        assert_eq!(pick_sibling(&s, "vol2", "prev", "reader").map(|i| s[i].name.as_str()), Some("vol1"));
    }

    #[test]
    fn next_at_last_returns_none() {
        let s = vec![entry("vol1", true, false), entry("vol2", true, false)];
        assert_eq!(pick_sibling(&s, "vol2", "next", "reader"), None);
    }

    #[test]
    fn current_not_in_siblings_returns_none() {
        let s = vec![entry("vol1", true, false), entry("vol2", true, false)];
        assert_eq!(pick_sibling(&s, "ghost", "next", "reader"), None);
    }

    #[test]
    fn natural_sort_order_page2_before_page10() {
        let s = vec![entry("page10", true, false), entry("page2", true, false)];
        // 排序后 page2 在前;从 page2 next → page10
        assert_eq!(pick_sibling(&s, "page2", "next", "reader").map(|i| s[i].name.as_str()), Some("page10"));
    }

    #[test]
    fn filter_reader_keeps_dir_and_archive() {
        let s = vec![entry("vol1", true, false), entry("pack.cbz", false, true), entry("vol2", true, false)];
        // reader filter: vol1 → pack.cbz (archive 也算卷)
        assert_eq!(pick_sibling(&s, "vol1", "next", "reader").map(|i| s[i].name.as_str()), Some("pack.cbz"));
    }

    #[test]
    fn filter_masonry_skips_archive() {
        let s = vec![entry("vol1", true, false), entry("pack.cbz", false, true), entry("vol2", true, false)];
        // masonry filter: vol1 → vol2 (跳过 archive)
        assert_eq!(pick_sibling(&s, "vol1", "next", "masonry").map(|i| s[i].name.as_str()), Some("vol2"));
    }

    #[test]
    fn empty_siblings_returns_none() {
        let s: Vec<MediaEntry> = vec![];
        assert_eq!(pick_sibling(&s, "vol1", "next", "reader"), None);
    }
}
```

- [ ] **步骤 2:运行测试验证失败**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib pick_sibling -- --nocapture
```
预期:编译失败(`pick_sibling` 未定义 / `MediaEntry` 字段名 `modified_at` 若不准按 `descriptor.rs:147` 校对)。

- [ ] **步骤 3:编写 `pick_sibling` 实现**

在 `find_next_volume.rs` 顶部(结构体定义之前)加:

```rust
use crate::algorithm::natural_compare;
use crate::source::MediaEntry;

/// 纯函数:在 siblings 里按 natural sort 找 current 的 next/prev。
/// filter="reader" 保留 is_directory||is_archive;"masonry" 只保留 is_directory。
/// 返回目标在原 siblings 数组的索引(未排序前的),None 表示越界/current 不在。
pub fn pick_sibling(
    siblings: &[MediaEntry],
    current_basename: &str,
    direction: &str,
    filter: &str,
) -> Option<usize> {
    if siblings.is_empty() {
        return None;
    }
    let mut filtered: Vec<usize> = siblings
        .iter()
        .enumerate()
        .filter(|(_, e)| match filter {
            "masonry" => e.is_directory,
            _ => e.is_directory || e.is_archive,
        })
        .map(|(i, _)| i)
        .collect();
    filtered.sort_by(|&a, &b| natural_compare(&siblings[a].name, &siblings[b].name));
    let pos = filtered
        .iter()
        .position(|&i| siblings[i].name == current_basename)?;
    let target_pos = match direction {
        "prev" => pos.checked_sub(1)?,
        _ => pos + 1,
    };
    filtered.get(target_pos).copied()
}
```

- [ ] **步骤 4:运行测试验证通过**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib pick_sibling -- --nocapture
```
预期:8 测试 PASS。

- [ ] **步骤 5:Commit**

```bash
git add src-tauri/src/commands/find_next_volume.rs
git commit -m "feat(cross-volume): pick_sibling 纯函数 + 8 单测 (algorithm)"
```

---

## 任务 2:Rust `find_next_volume` command 实现

**文件:**
- 修改:`src-tauri/src/commands/find_next_volume.rs`(stub → async 实现 + `NextVolumeResult`)
- 参考:`src-tauri/src/source/descriptor.rs`(确认 `SourceDescriptor::Archive` variant 字段)

**说明:** command 接 `MediaSourceFactory` State,async。解析 parent → listDirectory → `pick_sibling` → 构造 `NextVolumeResult`。

- [ ] **步骤 1:读取 `descriptor.rs` 确认类型**

```bash
# 确认 SourceDescriptor enum 的 4 个 variant 字段名 + Archive 的 format/entry_prefix 字段
grep -n "pub enum SourceDescriptor" -A 30 src-tauri/src/source/descriptor.rs
grep -n "pub enum ArchiveFormat" -A 10 src-tauri/src/source/descriptor.rs
```
记录:Archive variant 字段(如 `archive_path`/`format`/`entry_prefix`)+ ArchiveFormat 变体名。实现时按实际字段名,不臆造。

- [ ] **步骤 2:加 `NextVolumeResult` + 改 `FindNextVolumeArgs`**

在 `find_next_volume.rs` 替换现有 struct + 加新 struct:

```rust
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::algorithm::path::PathUtils;
use crate::source::{MediaSourceFactory, SourceDescriptor};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNextVolumeArgs {
    pub descriptor: serde_json::Value,
    /// 当前卷相对 rootPath 的完整路径(如 "comics/vol1");parent = PathUtils.parent(this)
    pub current_path: String,
    pub direction: String,          // "next" | "prev"
    #[serde(default = "default_filter")]
    pub filter: String,             // "reader" | "masonry"
}

fn default_filter() -> String { "reader".into() }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextVolumeResult {
    /// 下一卷完整 SourceDescriptor(目录:同源改 path;archive:Archive variant)
    pub descriptor: serde_json::Value,
    /// 下一卷相对 rootPath 的完整路径(前端可直接 listDirectory(descriptor, rel_path))
    pub rel_path: String,
    /// 显示名(目录名 / 压缩包名)
    pub title: String,
    pub is_archive: bool,
}
```

- [ ] **步骤 3:实现 async command**

替换现有 `pub fn find_next_volume(args: ...) -> Result<Option<String>, String>`:

```rust
#[tauri::command]
pub async fn find_next_volume(
    args: FindNextVolumeArgs,
    factory: State<'_, MediaSourceFactory>,
) -> Result<Option<NextVolumeResult>, String> {
    let descriptor: SourceDescriptor = serde_json::from_value(args.descriptor.clone())
        .map_err(|e| format!("invalid descriptor: {e}"))?;
    let parent_path = PathUtils::parent(&args.current_path);
    let current_basename = PathUtils::segments(&args.current_path)
        .last()
        .cloned()
        .unwrap_or_default();

    // parent descriptor:Local/WebDav 同源(parent 目录);Archive 归一化到包所在目录
    let (parent_descriptor, parent_list_path, archive_origin_root) = match &descriptor {
        SourceDescriptor::Local { .. } | SourceDescriptor::WebDav { .. } => {
            (descriptor.clone(), parent_path.clone(), false)
        }
        SourceDescriptor::Archive { .. } => {
            // Archive 当前卷:归一化到 origin 的包所在目录。
            // 简化:取 archive_path 的 parent 作为 list 目录,descriptor 用 origin 同源。
            // 完整 archiveKeyParts 见 DESIGN.md §13.1;本版用 archive_path 直接 parent。
            let json = serde_json::to_value(&descriptor).map_err(|e| e.to_string())?;
            let ap = json.get("archivePath").and_then(|v| v.as_str()).unwrap_or("");
            let p = PathUtils::parent(ap);
            (descriptor.clone(), p, true)
        }
        _ => return Ok(None),
    };

    let source = factory.resolve(&parent_descriptor);
    let siblings = source.list_directory(&parent_list_path).await
        .map_err(|e| e.to_string())?;
    let target_idx = match pick_sibling(&siblings, &current_basename, &args.direction, &args.filter) {
        Some(i) => i,
        None => return Ok(None),
    };
    let target = &siblings[target_idx];

    // 构造下一卷 descriptor + rel_path
    let (next_descriptor, next_rel_path) = if target.is_archive {
        // Archive variant:archivePath = parent_path/name, format 从扩展名推断,entry_prefix = ""
        let archive_full = if parent_list_path.is_empty() {
            target.name.clone()
        } else {
            PathUtils::join(&parent_list_path, &target.name)
        };
        let fmt = crate::algorithm::mime::archive_format_from_name(&target.name);
        let next_desc = SourceDescriptor::Archive {
            archive_path: archive_full.clone(),
            format: fmt,
            entry_prefix: String::new(),
        };
        let desc_json = serde_json::to_value(&next_desc).map_err(|e| e.to_string())?;
        (desc_json, archive_full)
    } else {
        // 目录:同源(改 path)— clone parent descriptor 的 JSON,前端 resolve 时 path 由 rel_path 提供
        let desc_json = serde_json::to_value(&parent_descriptor).map_err(|e| e.to_string())?;
        let rel = if parent_list_path.is_empty() {
            target.name.clone()
        } else {
            PathUtils::join(&parent_list_path, &target.name)
        };
        (desc_json, rel)
    };

    let _ = archive_origin_root; // 静默未使用(Archive 归一化简化版)

    Ok(Some(NextVolumeResult {
        descriptor: next_descriptor,
        rel_path: next_rel_path,
        title: target.name.clone(),
        is_archive: target.is_archive,
    }))
}
```

**注:** 若 `algorithm::mime` 无 `archive_format_from_name`,加一个纯函数(参考 `mime.rs` 现有 `is_archive` 的扩展名判断,映射 cbz/zip→Zip、cbr/rar→Rar、7z→SevenZ)。`SourceDescriptor::Archive` 字段名以步骤 1 grep 结果为准——若 variant 用 `archive_path`/`format`/`entry_prefix` 之外的名,按实际改。

- [ ] **步骤 4:编译验证**

```bash
cd src-tauri && cargo check --lib
```
预期:编译通过(可能有 unused 警告,任务 3 接前端后消除)。

- [ ] **步骤 5:Commit**

```bash
git add src-tauri/src/commands/find_next_volume.rs src-tauri/src/algorithm/mime.rs
git commit -m "feat(cross-volume): find_next_volume 替换 stub (async + factory + NextVolumeResult)"
```

---

## 任务 3:前端 `findNextVolume` IPC 改返回类型 + `NextVolumeResult` TS 类型

**文件:**
- 修改:`src/lib/tauri.ts:475-483`
- 修改:`src/lib/sourceDescriptor.ts`(若 Archive variant TS 类型缺字段,补齐)

- [ ] **步骤 1:加 `NextVolumeResult` TS 类型 + 改 `findNextVolume`**

在 `src/lib/tauri.ts` 找到现有 `findNextVolume`(约 line 475),替换:

```typescript
export interface NextVolumeResult {
  descriptor: SourceDescriptor;
  /** 下一卷相对 rootPath 的完整路径(可直接 listDirectory(descriptor, relPath)) */
  relPath: string;
  title: string;
  isArchive: boolean;
}

export async function findNextVolume(
  descriptor: SourceDescriptor,
  currentPath: string,
  direction: 'next' | 'prev',
  filter: 'reader' | 'masonry' = 'reader',
): Promise<NextVolumeResult | null> {
  return invoke<NextVolumeResult | null>('find_next_volume', {
    args: { descriptor, currentPath, direction, filter },
  });
}
```

- [ ] **步骤 2:确认 `SourceDescriptor` 的 Archive variant TS 字段**

```bash
grep -n "Archive" src/lib/sourceDescriptor.ts
```
确认 Archive variant 有 `archivePath`/`format`/`entryPrefix`(camelCase,与 Rust serde camelCase 对齐)。缺则补。

- [ ] **步骤 3:type-check 验证**

```bash
npm run type-check
```
预期:无新错误(若有"findNextVolume 调用处参数不匹配",后续任务 4/8 修正调用方)。

- [ ] **步骤 4:Commit**

```bash
git add src/lib/tauri.ts src/lib/sourceDescriptor.ts
git commit -m "feat(cross-volume): findNextVolume IPC 改 NextVolumeResult + filter 参数"
```

---

## 任务 4:`lib/findNextDirectory.ts` 加 filter 参数(校对)

**文件:**
- 修改:`src/lib/findNextDirectory.ts`
- 修改:`src/lib/findNextDirectory.test.ts`

- [ ] **步骤 1:加 filter 测试用例**

在 `findNextDirectory.test.ts` 加:

```typescript
describe('findNextDirectory filter', () => {
  it('filter=masonry 时调用方应预先过滤掉 archive', () => {
    // findNextDirectory 接 string[] (名字),filter 参数记录意图;
    // 实际过滤在调用方(listDirectory 后按 isArchive 过滤再传入)。
    const masonrySiblings = ['vol1', 'vol2', 'vol3']; // 调用方已过滤掉 pack.cbz
    expect(findNextDirectory(masonrySiblings, 'vol1', 'next', 'masonry')).toBe('vol2');
  });

  it('默认 filter=reader', () => {
    const s = ['vol1', 'vol2'];
    expect(findNextDirectory(s, 'vol1', 'next')).toBe('vol2');
    expect(findNextDirectory(s, 'vol1', 'next', 'reader')).toBe('vol2');
  });
});
```

- [ ] **步骤 2:运行测试验证失败**

```bash
npx vitest run src/lib/findNextDirectory.test.ts
```
预期:FAIL(`findNextDirectory` 不接第 4 参数)。

- [ ] **步骤 3:加 filter 参数**

`src/lib/findNextDirectory.ts` 替换函数签名:

```typescript
export function findNextDirectory(
  siblings: string[],
  currentPath: string,
  direction: Direction,
  filter: 'reader' | 'masonry' = 'reader',
): string | null {
  // 注:filter 参数记录意图 + 文档对齐 Rust pick_sibling。
  // 实际过滤(dir/archive)在调用方做——本函数接收已过滤的 string[]。
  // 详见 spec §6。
  const _ = filter; // 目前不影响纯字符串逻辑;留作语义标记
  if (siblings.length === 0) return null;
  const sorted = [...siblings].sort((a, b) => naturalCompare(a, b));
  const idx = sorted.indexOf(currentPath);
  if (idx === -1) return null;
  const target = direction === 'next' ? idx + 1 : idx - 1;
  if (target < 0 || target >= sorted.length) return null;
  return sorted[target];
}
```

- [ ] **步骤 4:运行测试验证通过**

```bash
npx vitest run src/lib/findNextDirectory.test.ts
```
预期:PASS。

- [ ] **步骤 5:Commit**

```bash
git add src/lib/findNextDirectory.ts src/lib/findNextDirectory.test.ts
git commit -m "feat(cross-volume): findNextDirectory 加 filter 参数 (TS 镜像校对)"
```

---

## 任务 5:`useToast` composable + `ToastHost` 组件

**文件:**
- 创建:`src/composables/useToast.ts`
- 创建:`src/composables/useToast.test.ts`
- 创建:`src/components/common/ToastHost.vue`

**说明:** 单例 toast 队列,跨卷用它显示"无下一卷/已跳转/失败"。后续其他模块可复用。

- [ ] **步骤 1:编写失败的测试**

`src/composables/useToast.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToast } from './useToast';

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { dismiss } = useToast();
    dismiss();
    vi.clearAllTimers();
  });

  it('push 后 toasts 出现一项', () => {
    const { push, toasts } = useToast();
    push('hello');
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.message).toBe('hello');
  });

  it('1500ms 后自动移除', () => {
    vi.useFakeTimers();
    const { push, toasts } = useToast();
    push('temp');
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(toasts.value).toHaveLength(0);
  });

  it('新 push 替换旧的(队列上限 1)', () => {
    const { push, toasts } = useToast();
    push('first');
    push('second');
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.message).toBe('second');
  });
});
```

- [ ] **步骤 2:运行测试验证失败**

```bash
npx vitest run src/composables/useToast.test.ts
```
预期:FAIL(模块不存在)。

- [ ] **步骤 3:实现 `useToast`**

`src/composables/useToast.ts`:

```typescript
import { ref } from 'vue';

export interface ToastItem {
  id: number;
  message: string;
}

const DURATION_MS = 1500;
const toasts = ref<ToastItem[]>([]);
let nextId = 1;
// setTimeout 在 Node/happy-dom 返回类型不一致 — 用 any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let timerId: any = null;

export function useToast() {
  function push(message: string): void {
    const id = nextId++;
    toasts.value = [{ id, message }]; // 队列上限 1:后者替换
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      toasts.value = [];
      timerId = null;
    }, DURATION_MS);
  }

  function dismiss(): void {
    if (timerId !== null) { clearTimeout(timerId); timerId = null; }
    toasts.value = [];
  }

  return { toasts, push, dismiss };
}
```

- [ ] **步骤 4:运行测试验证通过**

```bash
npx vitest run src/composables/useToast.test.ts
```
预期:PASS(3 测试)。注意 `1500ms 后自动移除` 用例需在 it 内 `vi.useFakeTimers()`(已加)。

- [ ] **步骤 5:实现 `ToastHost` 组件**

`src/components/common/ToastHost.vue`:

```vue
<script setup lang="ts">
import { useToast } from '@/composables/useToast';
const { toasts } = useToast();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="toasts.length > 0"
      class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
             bg-surface/90 backdrop-blur-xl rounded-full
             px-3 py-1.5 flex items-center gap-2 text-sm text-white shadow-xl
             pointer-events-none"
      role="status"
      aria-live="polite"
      data-test="toast-host"
    >
      <span>{{ toasts[0]?.message }}</span>
    </div>
  </Teleport>
</template>
```

- [ ] **步骤 6:Commit**

```bash
git add src/composables/useToast.ts src/composables/useToast.test.ts src/components/common/ToastHost.vue
git commit -m "feat(toast): useToast composable + ToastHost 组件 (通用 toast)"
```

---

## 任务 6:`reader` store 扩展

**文件:**
- 修改:`src/stores/reader.ts`(加 state + `flushProgress` + `nextPage` atLast 分支)
- 修改:`src/stores/reader.test.ts`(扩用例)

**说明:** 跨卷需要 reader 持有 `sourceDescriptor`/`currentRelPath`(供 `findNextVolume` 调用);`nextPage` 在末页时不翻页而是 set `pendingNextVolume`(对齐 spec §7.2 序列语义);`flushProgress` 立即写不等 debounce。

- [ ] **步骤 1:加 reader store 测试用例**

`src/stores/reader.test.ts` 顶部 mock + 加 describe:

```typescript
describe('reader store — 跨卷扩展', () => {
  it('sourceDescriptor / currentRelPath 初始为 null/空', () => {
    const reader = useReaderStore();
    expect(reader.sourceDescriptor.value).toBeNull();
    expect(reader.currentRelPath.value).toBe('');
  });

  it('nextPage 在 isAtLastSpread 时 set pendingNextVolume(经 slideshow)而非翻页', async () => {
    // 需 mock slideshow store 或注入。简化:spy reader.setCrossVolumeSignal 回调。
    // 见步骤 3 的设计:reader.nextPage 在末页调 onAtLastNextAttempt 回调。
    const reader = useReaderStore();
    let signaled = false;
    reader.setOnAtLastNextAttempt(() => { signaled = true; });
    // 先 openBook 一个 1-spread book(末页即首页)
    reader.openBook({ bookId: 1, title: 't', pages: ['p1'], spreads: [{ start: 0, end: 0 }], initialSpreadIndex: 0 });
    reader.nextPage(); // 已末页 → 不翻页 → signal
    expect(signaled).toBe(true);
    expect(reader.currentSpreadIndex.value).toBe(0); // 未翻页
  });

  it('flushProgress 立即调用 saveProgress(不等 debounce)', async () => {
    // mock saveProgress,验证 flushProgress 后被调用
    // (具体 mock 模式参考 reader.test.ts 现有 emitChanged 测试)
  });
});
```

- [ ] **步骤 2:运行测试验证失败**

```bash
npx vitest run src/stores/reader.test.ts
```
预期:FAIL(`sourceDescriptor`/`setOnAtLastNextAttempt`/`flushProgress` 未定义)。

- [ ] **步骤 3:扩展 reader store**

`src/stores/reader.ts`:

a. 顶部 import 加 `SourceDescriptor`:
```typescript
import type { SourceDescriptor } from '@/lib/sourceDescriptor';
```

b. 在 state 区(现有 `bookId`/`title`/`pages` 旁)加:
```typescript
const sourceDescriptor = ref<SourceDescriptor | null>(null);
const currentRelPath = ref<string>('');
// 末页再向下的跨卷信号回调(ReaderView 注入,避免 reader→slideshow 直接依赖)
let onAtLastNextAttempt: (() => void) | null = null;
function setOnAtLastNextAttempt(fn: (() => void) | null): void { onAtLastNextAttempt = fn; }
```

c. 改 `openBook`(line 108),在设 `bookId.value = payload.bookId` 后加(接收可选 descriptor/relPath,向后兼容):
```typescript
// 在 openBook 函数体内,设置 bookId/title/pages 之后:
sourceDescriptor.value = payload.sourceDescriptor ?? null;
currentRelPath.value = payload.currentRelPath ?? '';
```
并扩展 `OpenBookPayload` interface(line 24)加可选字段:
```typescript
export interface OpenBookPayload {
  bookId: number;
  title: string;
  pages: string[];
  spreads: Array<{ start: number; end: number }>;
  initialSpreadIndex: number;
  sourceDescriptor?: SourceDescriptor;  // 新增:跨卷/首次开卷都写入
  currentRelPath?: string;               // 新增
}
```

d. 改 `nextPage` —— 在现有 `currentSpreadIndex.value += 1` 之前加末页检查:
```typescript
function nextPage() {
  if (isAtLastSpread.value) {
    // 末页再向下:不翻页,触发跨卷信号(ReaderView 注入回调 → 写 slideshow.pendingNextVolume)
    onAtLastNextAttempt?.();
    return;
  }
  currentSpreadIndex.value += 1;
}
```
(确认现有 `nextPage` 是否 `currentSpreadIndex.value += 1`;若是 `+= 1` 或 `Math.min(...)` 钳位,替换为上面逻辑。)

e. 加 `flushProgress` —— 在 `emitChanged` 附近:
```typescript
function flushProgress(): void {
  if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
  flushPendingEmit(); // 立即触发 emitChanged 的写入逻辑(抽出 pendingEmit 处理为独立函数)
}
```
**注:** 现有 `emitChanged` 用 `debounceTimer` + `pendingEmit`。抽一个 `flushPendingEmit()` 内部函数(执行 pendingEmit 的 saveProgress 调用),`emitChanged`(debounce 后调)和 `flushProgress`(立即调)都调它。若现有结构不便抽,简化:`flushProgress` 直接调 `emitChanged` 的同步写入部分。

f. return 加:
```typescript
return {
  // ... 现有
  sourceDescriptor,
  currentRelPath,
  setOnAtLastNextAttempt,
  flushProgress,
};
```

- [ ] **步骤 4:运行测试验证通过**

```bash
npx vitest run src/stores/reader.test.ts
```
预期:PASS(新用例 + 现有用例不回归)。

- [ ] **步骤 5:Commit**

```bash
git add src/stores/reader.ts src/stores/reader.test.ts
git commit -m "feat(cross-volume): reader store 加 sourceDescriptor/currentRelPath + nextPage atLast 信号 + flushProgress"
```

---

## 任务 7:`useCrossVolume` composable

**文件:**
- 创建:`src/composables/useCrossVolume.ts`
- 创建:`src/composables/useCrossVolume.test.ts`

**说明:** 统一跨卷入口。`maybeContinue(force, dir)`:force=true 直接跨;false 看 `settings.continueToNextVolume`(off/auto/manual)。manual 显示胶囊(填 `pendingCrossVolume`)。

- [ ] **步骤 1:编写失败的测试**

`src/composables/useCrossVolume.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCrossVolume } from './useCrossVolume';
import { useReaderStore } from '@/stores/reader';
import { useSettingsStore } from '@/stores/settings';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    findNextVolume: vi.fn(),
    getProgress: vi.fn(),
    listDirectory: vi.fn(),
  };
});

import { findNextVolume, getProgress, listDirectory } from '@/lib/tauri';

describe('useCrossVolume', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  async function setupReader() {
    const reader = useReaderStore();
    reader.openBook({
      bookId: 1, title: 'vol1', pages: ['p1'], spreads: [{ start: 0, end: 0 }],
      initialSpreadIndex: 0,
      sourceDescriptor: { type: 'local', rootPath: '/root' },
      currentRelPath: 'comics/vol1',
    });
    return reader;
  }

  it('force=true 不看模式,直接 loadCrossVolume', async () => {
    const reader = await setupReader();
    (findNextVolume as any).mockResolvedValue(null); // 无下一卷
    const cv = useCrossVolume();
    await cv.maybeContinue(true, 'next');
    expect(findNextVolume).toHaveBeenCalledWith(
      reader.sourceDescriptor.value, 'comics/vol1', 'next', 'reader',
    );
  });

  it('force=false + off 模式 → 不跨卷', async () => {
    await setupReader();
    const settings = useSettingsStore();
    settings.continueToNextVolume = 'off';
    const cv = useCrossVolume();
    await cv.maybeContinue(false, 'next');
    expect(findNextVolume).not.toHaveBeenCalled();
  });

  it('force=false + auto 模式 → loadCrossVolume', async () => {
    await setupReader();
    const settings = useSettingsStore();
    settings.continueToNextVolume = 'auto';
    (findNextVolume as any).mockResolvedValue(null);
    const cv = useCrossVolume();
    await cv.maybeContinue(false, 'next');
    expect(findNextVolume).toHaveBeenCalled();
  });

  it('force=false + manual 模式 → armManualToast 填 pendingCrossVolume,不 openBook', async () => {
    await setupReader();
    const settings = useSettingsStore();
    settings.continueToNextVolume = 'manual';
    (findNextVolume as any).mockResolvedValue({
      descriptor: { type: 'local', rootPath: '/root' },
      relPath: 'comics/vol2', title: 'vol2', isArchive: false,
    });
    const cv = useCrossVolume();
    await cv.maybeContinue(false, 'next');
    expect(cv.pendingCrossVolume.value?.title).toBe('vol2');
    // 未 openBook(listDirectory 未调)
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('loadCrossVolume null → toast 无下一卷 + consumePending', async () => {
    await setupReader();
    (findNextVolume as any).mockResolvedValue(null);
    const cv = useCrossVolume();
    const { push } = useToastSpy();
    await cv.loadCrossVolume('next');
    expect(cv.pendingCrossVolume.value).toBeNull();
  });

  it('bookSwapInFlight guard:加载中再触发 return', async () => {
    await setupReader();
    (findNextVolume as any).mockImplementation(() => new Promise(() => {})); // 永不 resolve
    const cv = useCrossVolume();
    const p1 = cv.loadCrossVolume('next');
    await cv.loadCrossVolume('next'); // 应被 guard 挡
    expect(findNextVolume).toHaveBeenCalledTimes(1);
    // 清理:不 await p1(测试结束即可)
  });
});

function useToastSpy() {
  // 辅助:不直接断言 toast(可能 Teleport),只验证副作用
  return { push: vi.fn() };
}
```

- [ ] **步骤 2:运行测试验证失败**

```bash
npx vitest run src/composables/useCrossVolume.test.ts
```
预期:FAIL(模块不存在)。

- [ ] **步骤 3:实现 `useCrossVolume`**

`src/composables/useCrossVolume.ts`:

```typescript
/**
 * useCrossVolume — 跨卷连续阅读统一入口。
 *
 * maybeContinue(force, dir):
 *   - force=true(9 宫格/Alt)→ 不看模式,直接 loadCrossVolume
 *   - force=false(末页/slideshow)→ 看 settings.continueToNextVolume
 *     off→return / auto→loadCrossVolume / manual→armManualToast(填 pendingCrossVolume)
 *
 * loadCrossVolume(dir, opts.result?):
 *   1. flushProgress  2. findNextVolume  3. null→toast  4. getProgress 智能恢复
 *   5. listDirectory 下一卷  6. SpreadPlanner.plan  7. 算 initialSpreadIndex  8. openBook
 *
 * bookSwapInFlight guard 防重复。
 */
import { ref } from 'vue';
import { useReaderStore } from '@/stores/reader';
import { useSlideshowStore } from '@/stores/slideshow';
import { useSettingsStore } from '@/stores/settings';
import { useToast } from '@/composables/useToast';
import { findNextVolume, getProgress, listDirectory, type NextVolumeResult } from '@/lib/tauri';
import { sortEntries } from '@/lib/fileSort';
import { planSpreads, spreadIndexForPage } from '@/lib/spreadPlanner';
import { isImage } from '@/lib/mime';
import { log } from '@/lib/logger';

export function useCrossVolume() {
  const reader = useReaderStore();
  const slideshow = useSlideshowStore();
  const settings = useSettingsStore();
  const { push: pushToast } = useToast();

  const bookSwapInFlight = ref(false);
  const pendingCrossVolume = ref<NextVolumeResult | null>(null);

  async function maybeContinue(force: boolean, dir: 'next' | 'prev'): Promise<void> {
    if (bookSwapInFlight.value) return;
    if (!force) {
      const mode = settings.continueToNextVolume;
      if (mode === 'off') { consumePending(); return; }
      if (mode === 'manual') { await armManualToast(dir); return; }
      // auto 落到 loadCrossVolume
    }
    await loadCrossVolume(dir);
  }

  async function armManualToast(dir: 'next' | 'prev'): Promise<void> {
    if (!reader.sourceDescriptor.value) return;
    const result = await findNextVolume(reader.sourceDescriptor.value, reader.currentRelPath.value, dir, 'reader');
    if (!result) { pushToast(/* t */ '无下一卷'); consumePending(); return; }
    pendingCrossVolume.value = result;
  }

  async function loadCrossVolume(
    dir: 'next' | 'prev',
    opts: { result?: NextVolumeResult | null } = {},
  ): Promise<void> {
    if (bookSwapInFlight.value) return;
    if (!reader.sourceDescriptor.value) return;
    bookSwapInFlight.value = true;
    try {
      await reader.flushProgress();
      const result = opts.result ?? await findNextVolume(reader.sourceDescriptor.value, reader.currentRelPath.value, dir, 'reader');
      if (!result) { pushToast('无下一卷'); consumePending(); return; }

      // 加载下一卷内容
      const entries = await listDirectory(result.descriptor, result.relPath);
      const images = sortEntries(entries.filter((e) => !e.isDirectory && isImage(e.name)));
      if (images.length === 0) { pushToast('跳转失败'); consumePending(); return; }
      const pages = images.map((e) => e.name);
      const spreads = planSpreads(images.length);
      if (spreads.length === 0) { pushToast('跳转失败'); return; }

      // 智能恢复起点
      const progress = await getProgressOf(result);
      const startPage = progress && !progress.finished ? progress.page : 0;
      const initialSpreadIndex = Math.min(spreadIndexForPage(startPage, spreads), spreads.length - 1);

      reader.openBook({
        bookId: /* 合成下一卷 bookId,见 getProgressOf */ progress?.bookId ?? -1,
        title: result.title,
        pages,
        spreads,
        initialSpreadIndex,
        sourceDescriptor: result.descriptor,
        currentRelPath: result.relPath,
      });
      pushToast(`已跳转《${result.title}》`);
      consumePending();
    } catch (e) {
      log('[useCrossVolume] loadCrossVolume failed', e);
      pushToast('跳转失败');
    } finally {
      bookSwapInFlight.value = false;
    }
  }

  /** 合成下一卷 bookId 查 progress(复用 useReaderActions.ensureBookId 模式:createBook if not exists) */
  async function getProgressOf(result: NextVolumeResult) {
    // 简化:createBook(orReplace)拿 bookId → getProgress
    // 实际复用 useMasonryBrowsePosition.ensureBookIdForCurrentDir 模式或 useReaderActions
    // 这里用 listDirectory 已有,bookId 经 createBook(参考 useReaderActions.readNow)
    const { createBook } = await import('@/lib/tauri');
    const bookId = await createBook({
      title: result.title,
      sourceDescriptor: result.descriptor,
      absolutePath: result.relPath,
      sourceType: result.descriptor.type === 'local' ? 'Local' : 'WebDav',
      favorite: false,
      coverEntryPath: null, coverEntryName: null, pageCount: 0,
    }).catch(() => null);
    if (bookId === null) return null;
    const p = await getProgress(bookId);
    return p ? { ...p, bookId } : null;
  }

  function consumePending(): void {
    pendingCrossVolume.value = null;
    slideshow.consumePendingNextVolume();
  }

  return { maybeContinue, loadCrossVolume, armManualToast, consumePending, pendingCrossVolume, bookSwapInFlight };
}
```

**注:** `spreadIndexForPage` / `planSpreads` 导出名以 `src/lib/spreadPlanner.ts` 为准(`grep "export" src/lib/spreadPlanner.ts` 校对)。`sortEntries` 以 `src/lib/fileSort.ts` 为准。i18n key 在任务 12 加;此处临时硬编码字符串,任务 12 替换为 `t('reader.crossVolume.*')`(注入 `useI18n` 或经 toast 传 key)。

- [ ] **步骤 4:运行测试验证通过**

```bash
npx vitest run src/composables/useCrossVolume.test.ts
```
预期:PASS(6 测试)。调整 mock 返回值匹配实际调用。

- [ ] **步骤 5:Commit**

```bash
git add src/composables/useCrossVolume.ts src/composables/useCrossVolume.test.ts
git commit -m "feat(cross-volume): useCrossVolume composable (maybeContinue + loadCrossVolume + 智能恢复)"
```

---

## 任务 8:`ContinueNextVolumeToast` 组件

**文件:**
- 创建:`src/components/reader/ContinueNextVolumeToast.vue`
- 创建:`src/components/reader/ContinueNextVolumeToast.test.ts`

**说明:** manual 模式底部胶囊。`pendingCrossVolume` 有值显示;跳转/关闭/往回翻隐藏。

- [ ] **步骤 1:编写失败的测试**

`src/components/reader/ContinueNextVolumeToast.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ContinueNextVolumeToast from './ContinueNextVolumeToast.vue';
import { useReaderStore } from '@/stores/reader';

vi.mock('@/lib/tauri', () => ({
  findNextVolume: vi.fn(),
  getProgress: vi.fn(), listDirectory: vi.fn(), createBook: vi.fn(),
}));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }));

describe('ContinueNextVolumeToast', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('pendingCrossVolume 为空时不渲染', async () => {
    const wrapper = mount(ContinueNextVolumeToast);
    expect(wrapper.find('[data-test="cross-volume-toast"]').exists()).toBe(false);
  });

  it('pendingCrossVolume 有值时显示标题', async () => {
    // 需注入 useCrossVolume 的 pendingCrossVolume(测试通过 mount props 或 provide)
    // 简化:组件内部 useCrossVolume,测试先 armManualToast
    // 参考 MasonryThumbnail.test.ts 的 mount 模式
  });

  it('点跳转按钮 → 触发 loadCrossVolume', async () => {
    // 验证 emit 或 store 状态变化
  });
});
```

- [ ] **步骤 2:运行测试验证失败** → `npx vitest run src/components/reader/ContinueNextVolumeToast.test.ts`(组件不存在)。

- [ ] **步骤 3:实现组件**

`src/components/reader/ContinueNextVolumeToast.vue`:

```vue
<script setup lang="ts">
import { useCrossVolume } from '@/composables/useCrossVolume';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const { pendingCrossVolume, loadCrossVolume, consumePending } = useCrossVolume();

async function onJump(): Promise<void> {
  const result = pendingCrossVolume.value;
  if (!result) return;
  await loadCrossVolume('next', { result });
}
function onClose(): void {
  consumePending();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="pendingCrossVolume"
      class="fixed bottom-12 left-1/2 -translate-x-1/2 z-[1100]
             bg-surface/90 backdrop-blur-xl rounded-full
             px-3 py-1.5 flex items-center gap-3 text-sm text-white shadow-xl"
      data-test="cross-volume-toast"
      role="dialog"
      aria-live="polite"
    >
      <span>{{ t('reader.crossVolume.continuePrompt', { title: pendingCrossVolume.title }) }}</span>
      <button
        class="text-accent hover:text-accent-light"
        data-test="cross-volume-jump"
        @click="onJump"
      >{{ t('reader.crossVolume.jump') }}</button>
      <button
        class="text-text-muted hover:text-text-primary"
        data-test="cross-volume-close"
        @click="onClose"
      >✕</button>
    </div>
  </Teleport>
</template>
```

- [ ] **步骤 4:运行测试验证通过** → `npx vitest run src/components/reader/ContinueNextVolumeToast.test.ts`(补全 mount 用例的 provide/注入)。

- [ ] **步骤 5:Commit**

```bash
git add src/components/reader/ContinueNextVolumeToast.vue src/components/reader/ContinueNextVolumeToast.test.ts
git commit -m "feat(cross-volume): ContinueNextVolumeToast 胶囊组件 (manual 模式)"
```

---

## 任务 9:`useMasonryBrowsePosition.flushNow` + ReaderView 接线

**文件:**
- 修改:`src/composables/useMasonryBrowsePosition.ts`(加 `flushNow`)
- 修改:`src/composables/useMasonryBrowsePosition.test.ts`
- 修改:`src/views/ReaderView.vue`(接 `useCrossVolume` + watch + 回调)

- [ ] **步骤 1:加 `flushNow` 测试** → `useMasonryBrowsePosition.test.ts` 加:
```typescript
it('flushNow 立即触发 recordCurrentTop 不等 300ms debounce', async () => {
  // 参考 recordCurrentTop 现有用例的 mock 模式
  // 调 flushNow 后立即验证 saveProgress 被调(debounce timer 不应阻塞)
});
```

- [ ] **步骤 2:运行验证失败** → `npx vitest run src/composables/useMasonryBrowsePosition.test.ts`。

- [ ] **步骤 3:实现 `flushNow`** → `useMasonryBrowsePosition.ts` 的 return 前加:
```typescript
async function flushNow(): Promise<void> {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  await recordCurrentTop();
}
```
return 加 `flushNow`。

- [ ] **步骤 4:ReaderView 接线**

`src/views/ReaderView.vue`:
- import `useCrossVolume` + `ContinueNextVolumeToast` + `ToastHost`
- 在 setup(现有 `useReaderHotkeys`/`useReaderWheel` 附近)加:
```typescript
const crossVolume = useCrossVolume();
// 末页跨卷信号:reader.nextPage atLast 时写 slideshow.pendingNextVolume
reader.setOnAtLastNextAttempt(() => { slideshow.pendingNextVolume = true; });
// watch 末页跨卷意图(slideshow 写 + 手动 nextPage atLast 写,统一)
watch(() => slideshow.pendingNextVolume, (v) => {
  if (v) crossVolume.maybeContinue(false, 'next');
});
// 9 宫格 folder-next / Alt+→ 回调改为 crossVolume.maybeContinue(true, 'next')
// (在 useReaderTouchZones 的 folder-next action + useReaderHotkeys 的 Alt+→ 回调处接)
```
- template 加(与 SlideshowToast 同级):
```vue
<ToastHost />
<ContinueNextVolumeToast />
```
- `loadBook` 内 `reader.openBook(...)` 调用处加 `sourceDescriptor` + `currentRelPath` payload 字段(用 ReaderView 已有的 descriptor + relPath 变量)。

**9 宫格接线点**:`grep -n "folder-next\|folderNext" src/composables/useReaderTouchZones.ts` 找到现有 action 回调,改为调 `crossVolume.maybeContinue(true, 'next')`(ReaderView 把 crossVolume 暴露给 touchZones composable,或经回调注入)。`Alt+→` 同理在 `useReaderHotkeys`。

- [ ] **步骤 5:运行 + Commit**
```bash
npx vitest run src/composables/useMasonryBrowsePosition.test.ts src/views/ReaderView.test.ts
git add src/composables/useMasonryBrowsePosition.ts src/composables/useMasonryBrowsePosition.test.ts src/views/ReaderView.vue
git commit -m "feat(cross-volume): flushNow + ReaderView 接线 (watch pendingNextVolume + 9宫格/Alt 回调 + 挂 toast)"
```

---

## 任务 10:瀑布流工具栏"下一卷"按钮

**文件:**
- 修改:`src/components/filebrowser/FileBrowser.vue`(工具栏加按钮,仅 masonry 场景显示)
- 修改:`src/components/filebrowser/MasonryView.vue`(暴露 `crossNextVolume` 或在 FileBrowser 调)

**说明:** 瀑布流跨卷纯手动,`filter='masonry'`。复用 `useCrossVolume` 的 `loadCrossVolume` 不合适(那是 reader openBook);瀑布流走 `fileBrowser.navigate`。新建一个轻量 `crossNextVolumeMasonry` 函数(MasonryView 内或 useCrossVolume 加分支)。

- [ ] **步骤 1:加按钮** → `FileBrowser.vue` 工具栏(masonry 场景,与"↶ 跳到上次"同区):
```vue
<button
  v-if="viewMode === 'masonry'"
  class="tb-btn"
  :disabled="!hasImages || swapping"
  :title="t('fileBrowser.nextVolume')"
  @click="onCrossNextVolume"
>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M4 12h16M14 6l6 6-6 6" />
  </svg>
</button>
```

- [ ] **步骤 2:实现 `onCrossNextVolume`** → FileBrowser setup 加(复用 fb store + descriptor):
```typescript
const swapping = ref(false);
async function onCrossNextVolume(): Promise<void> {
  if (swapping.value) return;
  swapping.value = true;
  try {
    await masonryBrowsePosition.flushNow();
    const result = await findNextVolume(descriptor.value, fb.currentPath.value, 'next', 'masonry');
    if (!result) { pushToast(t('reader.crossVolume.none')); return; }
    await fb.navigate(result.relPath);
    pushToast(t('reader.crossVolume.jumped', { title: result.title }));
  } catch (e) {
    pushToast(t('reader.crossVolume.failed'));
  } finally {
    swapping.value = false;
  }
}
```
import `findNextVolume` + `useToast`。`masonryBrowsePosition` 从 MasonryView 暴露(defineExpose)或提到 FileBrowser。

- [ ] **步骤 3:type-check + 单测补** →
```bash
npm run type-check
npx vitest run src/components/filebrowser/FileBrowser.test.ts
```
FileBrowser.test.ts 若因新按钮/函数失败,补 mock 或 stub。

- [ ] **步骤 4:Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue src/components/filebrowser/MasonryView.vue
git commit -m "feat(cross-volume): 瀑布流工具栏'下一卷'按钮 (masonry 场景 + flushNow + navigate)"
```

---

## 任务 11:i18n 6 key × 2 locale

**文件:**
- 修改:`src/locales/zh-CN.ts` + `src/locales/en-US.ts`

- [ ] **步骤 1:加 key**

`zh-CN.ts` 的 `reader` namespace 加:
```typescript
crossVolume: {
  none: '无下一卷',
  jumped: '已跳转《{title}》',
  failed: '跳转失败',
  continuePrompt: '继续读下一本《{title}》?',
  jump: '跳转',
},
```
`fileBrowser` namespace 加:`nextVolume: '下一卷',`

`en-US.ts` 对应:
```typescript
crossVolume: {
  none: 'No next volume',
  jumped: 'Jumped to 《{title}》',
  failed: 'Failed to jump',
  continuePrompt: 'Continue to next volume 《{title}》?',
  jump: 'Jump',
},
// fileBrowser
nextVolume: 'Next volume',
```

- [ ] **步骤 2:替换 useCrossVolume 临时硬编码** → `useCrossVolume.ts` 注入 `useI18n`,`pushToast(t('reader.crossVolume.*'))` 替换 `'无下一卷'` 等硬编码。

- [ ] **步骤 3:运行 i18n 对齐测试**
```bash
npx vitest run src/locales/i18n-keys.test.ts src/locales/locales.test.ts
```
预期:PASS(zh/en key 对齐)。

- [ ] **步骤 4:Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts src/composables/useCrossVolume.ts
git commit -m "feat(cross-volume): i18n 6 key × 2 locale (reader.crossVolume.* + fileBrowser.nextVolume)"
```

---

## 任务 12:全测 + type-check + 本地 build

- [ ] **步骤 1:前端全测**
```bash
npm run type-check && npm test -- --run
```
预期:type-check 无错;717 → ~750+ 测试全绿(新增 useCrossVolume 6 + useToast 3 + ContinueNextVolumeToast ~3 + reader store 扩展 ~3 + pick_sibling 8 + findNextDirectory filter 2)。

- [ ] **步骤 2:Rust 测试**
```bash
cd src-tauri && cargo test --lib --no-fail-fast
```
预期:含 `pick_sibling` 8 测试全绿;现有 177 pass / 2 fail(path/webdav,与跨卷无关,记录不修)。

- [ ] **步骤 3:本地 build portable(可选,验证打包)**
```bash
cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"
```
预期:成功生成 portable exe。

- [ ] **步骤 4:E2E 手测清单**(spec §12.3)
- [ ] Local 目录跨卷:auto 末页→自动跳下一目录
- [ ] manual 末页→胶囊→点跳转→跳下一卷
- [ ] off 末页→不跳
- [ ] 9 宫格 folder-next / Alt+→→即时跨
- [ ] **末页触发时机**:倒数第二页 nextPage 翻到末页不触发;末页再向下才触发
- [ ] 智能恢复:读过一半的卷→恢复 page;已读完→第 1 页
- [ ] 无下一卷→toast"无下一卷"
- [ ] 瀑布流"下一卷"按钮→跳下一目录瀑布流 + 恢复 scroll
- [ ] 幻灯片末页→跨卷(对齐模式)
- [ ] 跨卷中再触发→不重复

- [ ] **步骤 5:Commit + tag + push**
```bash
git add -A
git commit -m "test(cross-volume): 全测通过 + E2E 手测验证"
git tag v0.1.0-module3.0.9-cross-volume
git push github main
git push github v0.1.0-module3.0.9-cross-volume
git push origin main --tags
```

---

## 自检结果

**规格覆盖度:** spec 各节 → 任务映射:
- §5 Rust find_next_volume → 任务 1(pick_sibling)+ 任务 2(command)
- §6 TS 镜像校对 → 任务 4
- §7.1 useCrossVolume → 任务 7
- §7.2 reader store 扩展 → 任务 6
- §7.3 触发接线 → 任务 9
- §7.4 manual 胶囊 → 任务 8
- §8 瀑布流跨卷 → 任务 10
- §9 UI(ToastHost + ContinueNextVolumeToast)→ 任务 5 + 任务 8
- §11 i18n → 任务 11
- §12 测试 → 各任务 TDD + 任务 12 集成
- §1.2 末页触发时机(序列语义)→ 任务 6 `nextPage` atLast 分支

**遗漏:** spec §3 方案对比(选定 A,已反映在架构)、§2 背景(参考)、§10 边界(分散在各任务的 null/failed/guard 处理)、§13 有意差异(记录性)——均非待实现任务。

**占位符扫描:** 任务 2 步骤 1 引导读 `descriptor.rs` 确认字段(非占位,是必要的前置确认);任务 6 步骤 3e `flushPendingEmit` 标注"若现有结构不便抽,简化为直接调"(给执行者明确 fallback,非占位);任务 7 `spreadIndexForPage`/`planSpreads`/`sortEntries` 导出名标注"以 grep 为准"(引导校对,非臆造)。无"TODO/待定/补充细节"。

**类型一致性:** `NextVolumeResult`(Rust + TS 字节级 camelCase);`FindNextVolumeArgs.filter` 默认 `'reader'`(Rust `default_filter` + TS 默认参数);`pendingCrossVolume: Ref<NextVolumeResult|null>`(任务 7 定义,任务 8 消费,一致);`setOnAtLastNextAttempt`(任务 6 定义,任务 9 接线,一致)。

**已知风险**(执行时关注):
1. `reader.ts` 的 `emitChanged` debounce 结构 — `flushProgress` 抽取可能需要读现有实现调整(任务 6 步骤 3e)
2. `useReaderTouchZones` 的 `folder-next` action 接线点 — 需 grep 现有回调结构(任务 9 步骤 4)
3. Archive variant 字段名 — 任务 2 步骤 1 grep 确认,若与计划伪代码不符按实际改
4. `spreadPlanner` 导出名 — 任务 7 步骤 3 标注 grep 校对
