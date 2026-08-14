# 移除阅读器 9 宫格触控（module3.0.12）

- **日期**：2026-08-14
- **状态**：已批准（用户拍板"整体移除"）
- **规模**：纯删除模块，无新功能

## 1. 背景与动机

9 宫格触控方案（`useReaderTouchZones` + `TouchAction` 11 动作 + Settings Touch section）源自
PerfectViewer Android 对齐需求。桌面端实际使用中：

1. **入口冗余**——翻页/跳页/缩放/跨卷全部有滚轮、快捷键、顶栏按钮、主菜单、右键菜单等
   多重入口，9 宫格点击无独占价值。
2. **误触源**——全屏点击即触发动作（如 bl=folder-prev、br=folder-next），与鼠标惯用操作冲突。
3. **维护负担**——`prevVolume` 是 TODO 空实现、migration 001 seed 的 9 个 key 是与前端
   格式不匹配的死数据、`inputBindings.mouseRegionCommand` 是从未接线的半死代码。

引用面审计（2026-08-14）确认 `TouchZone`/`TouchAction`/`touchScheme` 的消费方全部在删除面内，
**封闭引用，无隐藏耦合**，可整体移除。

## 2. 删除范围

### 2.1 整文件删除（3 个）

| 文件 | 内容 |
|---|---|
| `src/composables/useReaderTouchZones.ts` | 9 宫格检测 + `dispatchZoneAction` |
| `src/composables/useReaderTouchZones.test.ts` | 23 个用例 |
| `src/components/reader/TouchRegionsOverlay.vue` | 触控区可视化调试覆盖层 |

### 2.2 删段（9 个文件）

- `src/lib/readerSettings.ts`：`TouchZone`/`TOUCH_ZONES`/`TOUCH_ZONE_KEY`/`TouchAction`/
  `TOUCH_ACTIONS`/`DEFAULT_TOUCH_SCHEME`（保留 ScaleMode/ReadDirection 及其默认值）
- `src/stores/settings.ts`：`touchZonesEnabled`/`touchScheme` state、`setTouchAction`/
  `resetTouchScheme`、`touch_zones_enabled` + 9 个 `touch_*` load key、相关 import 与导出
- `src/views/Settings.vue`：Touch section 整段（master toggle + 9 格编辑器 + reset 确认）、
  `sections` 数组的 `'touch'`（8→7）、`touchActionLabels`/`openCell`/`showResetConfirm`/
  `toggleCell`/`pickAction`/`onResetTouch`/`setTouchZonesEnabled`/`touchGridRows`/
  `closeOpenCell` + 根元素 `@mousedown`
- `src/views/ReaderView.vue`：`useReaderTouchZones` import 与调用、`zoneActions` 对象、
  `showTouchRegions` ref、`onShowTouchRegions`、template 两处接线、相关注释
- `src/components/reader/ReaderScreen.vue`：`TouchRegionsOverlay` import/prop/template
- `src/components/reader/ReaderMainMenu.vue`：`show-touch-regions` emit、
  `onShowTouchRegions`、「显示触控区」按钮、相关注释
- `src/components/reader/ReaderOverlay.vue`：`data-test-ignore-touch-zones` 属性（唯一消费方是
  9 宫格 ignoreSelector）
- `src/locales/zh-CN.ts` + `en-US.ts`：`settings.section.touch`、`settings.touch.*`（5 key）、
  `settings.touchAction.*`（11 key）、`reader.showTouchRegions`

### 2.3 顺带清理（同模块一并删除）

1. **孤儿 `reader.*` 扁平 i18n key（16 个，双 locale）**：`pageIndicator` / `nextPage` /
   `prevPage` / `jumpToPage` / `openMainMenu` / `fitWidth` / `folderNext` / `folderPrev` /
   `openFileBrowser` / `slideshowToggle` / `jumpFirst` / `jumpLast` / `toggleChrome` /
   `noNextVolume` / `noPrevVolume` / `addBookmark`——为触控动作预留、从未接线
   （已核实组件实际消费的是 `reader.menu.*` / `reader.{like,unlike,openBookmarks,prev,next,jumpTo}`）。
2. **`inputBindings.mouseRegionCommand` 半死代码**：3×3 鼠标分区映射从未被生产代码接线
   （`useReaderHotkeys` 只走 keyboard/wheel），与 9 宫格语义重复。删除
   `mouseRegionCommand` + `InputContext` 的 mouse 变体 + `resolveHotkey` mouse 分支 +
   测试 `resolveHotkey — mouse 3-region click` describe（4 用例）+ `mouseEventAt` 助手。

## 3. 数据清理（migration 014）

migration 001 曾 seed 9 个 `touch_{top,mid,bot}_{left,center,right}` key（大写枚举值
`FIT_WIDTH` 等，与前端 kebab 值不匹配——本来就是死数据）；`touch_zones_enabled` 为运行时
KV 写入。新增 migration 014 一并清理：

```sql
DELETE FROM settings WHERE key LIKE 'touch_%';
```

幂等（重跑无行可删），带 Rust 单测（seed 后 run → 0 行残留 + 幂等重跑）。

## 4. 行为影响评估

移除后各动作的触发入口（审计结论）：

| 动作 | 移除后入口 | 备注 |
|---|---|---|
| 翻页/跳首末页 | 滚轮、`←→`/`Home`/`End`、顶栏按钮 | 无损失 |
| open-main-menu | `m` 键、顶栏菜单按钮、右键菜单 | 无损失 |
| fit-width | scale 下拉/`W` 键/右键菜单 | 无损失 |
| open-file-browser | `B`/`Esc`、返回按钮、菜单 | 无损失 |
| slideshow-toggle | `Space`/`p`/`F5`、菜单按钮 | 无损失 |
| folder-next（下一卷） | `Alt+→`、末页自动、瀑布流按钮 | 无损失 |
| folder-prev（上一卷） | **彻底失去入口** | 原本就是 TODO 空实现（只打 log），可接受；跨卷 prev 为后续独立模块 |

## 5. 不做清单

- **不改历史 specs/plans**（`docs/superpowers/specs/` + `plans/` 是历史记录，与 likes-merge 等
  先例一致不加头注）。
- **不实现跨卷 prev**（`folder-prev` 失去入口是已知接受项，留独立模块）。
- **不动 `ReaderCommand`/`KeyBindings`/`defaultKeyBindings`**（键盘绑定独立存活，
  `folderPrev` 键位保留给未来跨卷 prev 实现使用）。
- **不清理 Settings.vue 头注释以外的历史版本号注释**（预存在，非本模块范围）。

## 6. 验收标准

1. `npm run type-check` 0 error（无 `touchScheme`/`TouchAction` 等悬空引用）。
2. `npm test -- --run` 全绿（预期净减约 30 用例：23 + 4 + 3 + 1 + 1 section 断言调整）。
3. `cargo test -p mirapage-desktop` 全绿（migration 014 新增 2 测；已知 WebDAV
   `parse_propfind` 预存在红除外——注意该用例在 lib 之外，`--lib` 不受影响）。
4. 全仓 grep `宫格|TouchZone|touchScheme|touch_zones|useReaderTouchZones` 在 `src/` +
   `src-tauri/src/` 无代码残留（living 文档 AGENTS.md/DESIGN.md 更新为已移除表述）。
