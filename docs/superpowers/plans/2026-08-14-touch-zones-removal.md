# 移除阅读器 9 宫格触控 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 整体移除阅读器 9 宫格触控功能（composable + 类型 + store + Settings UI + 接线 + 可视化层），migration 014 清理 DB 残留 key，顺带清理 `mouseRegionCommand` 半死代码与 16 个孤儿 i18n key。

**架构：** 纯删除模块。`TouchZone`/`TouchAction` 引用面封闭（消费方全在删除清单内），按"lib 类型 → store → 组件接线 → Settings UI → i18n → 测试 → migration"顺序自上而下删，每任务后 type-check 可定位悬空引用。

**技术栈：** Vue 3 + Pinia + vitest（前端）；rusqlite migrations（Rust）；vue-i18n 双 locale。

**规格：** `docs/superpowers/specs/2026-08-14-touch-zones-removal-design.md`

---

## 任务 1：`readerSettings.ts` 删 touch 段（类型源头）

**文件：**
- 修改：`src/lib/readerSettings.ts`
- 修改：`src/lib/readerSettings.test.ts`

- [ ] **步骤 1.1：调整测试（先红）**——`readerSettings.test.ts` 删除 4 个 touch 用例（`TOUCH_ZONES covers all 9 cells`、`TOUCH_ZONE_KEY maps...`、`TOUCH_ACTIONS exposes 11 actions`、`DEFAULT_TOUCH_SCHEME aligns...`），import 收窄为：

```ts
import {
  DEFAULT_SCALE_MODE, DEFAULT_READ_DIRECTION,
} from './readerSettings';
```

- [ ] **步骤 1.2：删实现段**——`readerSettings.ts` 删除 `TouchZone` 类型、`TOUCH_ZONES`、`TOUCH_ZONE_KEY`、`TouchAction` 类型、`TOUCH_ACTIONS`、`DEFAULT_TOUCH_SCHEME`（约 L11-55）。保留 `ScaleMode`/`ReadDirection`/`DEFAULT_SCALE_MODE`/`DEFAULT_READ_DIRECTION`/`normalizeScaleMode`；文件头注释里"阅读器设置相关枚举"表述不变。

- [ ] **步骤 1.3：验证**——`npx vitest run src/lib/readerSettings.test.ts` 2 用例 PASS。

## 任务 2：settings store 删 touch state

**文件：**
- 修改：`src/stores/settings.ts`
- 修改：`src/stores/settings.test.ts`

- [ ] **步骤 2.1：调整测试（先红）**——`settings.test.ts`：
  - mock `getSetting` 里删 `if (key === 'touch_top_left') return 'jump-first';`
  - 删 3 个用例：`load populates touch_top_left to override default`、`setTouchAction updates reactive state and persists to DB`、`resetTouchScheme writes all 9 zones to PV DEFAULT`

- [ ] **步骤 2.2：删实现段**——`settings.ts`：
  - import 行删 `TOUCH_ZONES, TOUCH_ZONE_KEY, DEFAULT_TOUCH_SCHEME,` 与 `type TouchZone, type TouchAction,`（保留 ScaleMode/ReadDirection 相关）
  - 删 state：`touchZonesEnabled`、`touchScheme` 两行
  - `load()` keys 数组删 `['touch_zones_enabled', ...]` 行与 `...TOUCH_ZONES.map(...)` 动态展开段
  - 删方法 `setTouchAction`、`resetTouchScheme` 整段
  - return 删 `touchZonesEnabled, touchScheme,` 与 `setTouchAction, resetTouchScheme,`

- [ ] **步骤 2.3：验证**——`npx vitest run src/stores/settings.test.ts` PASS。

## 任务 3：删除 composable 与可视化组件（3 整文件）+ ReaderView/ReaderScreen/ReaderMainMenu/ReaderOverlay 接线

**文件：**
- 删除：`src/composables/useReaderTouchZones.ts`、`src/composables/useReaderTouchZones.test.ts`、`src/components/reader/TouchRegionsOverlay.vue`
- 修改：`src/views/ReaderView.vue`、`src/components/reader/ReaderScreen.vue`、`src/components/reader/ReaderMainMenu.vue`、`src/components/reader/ReaderOverlay.vue`、`src/views/ReaderView.test.ts`、`src/components/reader/SinglePageViewer.vue`（注释）

- [ ] **步骤 3.1：`git rm` 三个文件**

- [ ] **步骤 3.2：ReaderView.test.ts** 删 `vi.mock('@/composables/useReaderTouchZones', ...)` 块（L45-48）。

- [ ] **步骤 3.3：ReaderView.vue**：
  - 删 import 块 `import { useReaderTouchZones, dispatchZoneAction } from '@/composables/useReaderTouchZones';`
  - 删 `showTouchRegions` ref 与注释（L99-100）
  - 删 `onShowTouchRegions` 函数（L226-228）
  - 删 `useReaderTouchZones({...})` 调用块及其注释（L430-436）
  - 删 `zoneActions` 对象整段（L452-468）
  - template：ReaderScreen 删 `:show-touch-regions="showTouchRegions"`（L506）；ReaderMainMenu 删 `@show-touch-regions="onShowTouchRegions"`（L525）
  - 注释改写：L8/L16/L30 处"9 宫格"表述、L329 `即使 hotkey/9宫格/watch 绕过` → `即使 hotkey/watch 绕过`；跨卷 spec §11.3 注释随 zoneActions 一起删

- [ ] **步骤 3.4：ReaderScreen.vue**：删 `import TouchRegionsOverlay`（L45）、props `showTouchRegions`（L53-54、L62 default）、template `<TouchRegionsOverlay v-if="props.showTouchRegions" />`（L418-419）、L29-30 注释行。

- [ ] **步骤 3.5：ReaderMainMenu.vue**：删 emit `'show-touch-regions'`（L58）、`onShowTouchRegions`（L90）、「显示触控区」按钮整块（L243-247，`data-test="menu-lib-regions"`）、头注释 L7/L15/L20 中触控派发表述。

- [ ] **步骤 3.6：ReaderOverlay.vue**：删 L137 `data-test-ignore-touch-zones` 属性行。

- [ ] **步骤 3.7：SinglePageViewer.vue** L67 注释改写：`关闭 OSD 内置滚轮缩放 + 点击缩放，让 click 完全交给 useReaderTouchZones 9 宫格` → `关闭 OSD 内置滚轮缩放 + 点击缩放（桌面端点击不承载翻页语义）`。配置本身保留。

- [ ] **步骤 3.8：验证**——`npm run type-check` 此时会有 Settings.vue 报错（任务 4 未做），属预期；`npx vitest run src/views/ReaderView.test.ts` PASS。

## 任务 4：Settings.vue 删 Touch section

**文件：**
- 修改：`src/views/Settings.vue`
- 修改：`src/views/Settings.test.ts`

- [ ] **步骤 4.1：调整测试（先红）**——`Settings.test.ts`：
  - `renders all 8 sections with anchors` 改 `renders all 7 sections with anchors`：`expect(anchors.length).toBe(7)`；section 列表删 `'touch'`
  - 删用例 `clicking reset shows confirm and resets touch scheme`
  - 头注释 L3 的 `9 宫格 + reset` 表述删

- [ ] **步骤 4.2：删实现段**——`Settings.vue`：
  - import 删 `TOUCH_ACTIONS,` 与 `type TouchZone, type TouchAction,`
  - `sections` 数组删 `'touch'`（8→7）
  - 删 `touchActionLabels` computed（L88-100）、`openCell`/`showResetConfirm`/`toggleCell`/`pickAction`/`onResetTouch`（L102-118）、`setTouchZonesEnabled`（L162-165）、`touchGridRows`（L177-181）、`closeOpenCell`（L183-188）
  - 根 template 元素删 `@mousedown="closeOpenCell"`
  - 删整个 `<section id="touch" ...>` 块（L358-427）
  - 头注释 L4 `6 section + 左侧 anchor nav + 9 宫格触控编辑器 + reset 按钮` → `7 section + 左侧 anchor nav`

- [ ] **步骤 4.3：验证**——`npm run type-check` 0 error（全仓悬空引用清零）；`npx vitest run src/views/Settings.test.ts` PASS。

## 任务 5：i18n 双 locale 清理

**文件：**
- 修改：`src/locales/zh-CN.ts`、`src/locales/en-US.ts`

- [ ] **步骤 5.1：zh-CN.ts**：
  - `reader.*` 扁平段删 17 个 key：`pageIndicator`/`nextPage`/`prevPage`/`jumpToPage`/`openMainMenu`/`fitWidth`/`folderNext`/`folderPrev`/`openFileBrowser`/`slideshowToggle`/`jumpFirst`/`jumpLast`/`toggleChrome`/`noNextVolume`/`noPrevVolume`/`addBookmark`/`showTouchRegions`（保留 `like`/`unlike`/`openBookmarks`/`prev`/`next`/`jumpTo` 及 scale/mode/direction/continue/menu/crossVolume 子树）
  - `settings.section` 删 `touch: '触控分区',`
  - 删 `touch: { title/hint/enabled/reset/resetConfirm }` 整段
  - 删 `touchAction: { none...openFileBrowser }` 整段（11 key）

- [ ] **步骤 5.2：en-US.ts** 同步删除对应英文 key（`showTouchRegions: 'Show touch regions'` 在 L74，其余同结构）。

- [ ] **步骤 5.3：验证**——`npx vitest run src/locales` PASS（双语一致性测试兜底）+ `npm run type-check`。

## 任务 6：migration 014 清理 DB key

**文件：**
- 修改：`src-tauri/src/db/migrations.rs`

- [ ] **步骤 6.1：注册 migration**——`run()` 末尾（`current < 13` 块后）追加：

```rust
    if current < 14 {
        apply_014_drop_touch_zone_settings(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (14, ?1)",
            [chrono_now()],
        )?;
    }
```

- [ ] **步骤 6.2：实现函数**（放在 `apply_013_descriptor_canonical_dedupe` 之后）：

```rust
/// Migration 014 —— 移除 9 宫格触控残留 key（v0.1.0-module3.0.12-touch-zones-removal）
/// touch_zones_enabled（运行时写入）+ 001 seed 的 9 个 touch_{...}（大写枚举死数据）
fn apply_014_drop_touch_zone_settings(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM settings WHERE key LIKE 'touch_%'", [])?;
    Ok(())
}
```

- [ ] **步骤 6.3：Rust 单测**（tests mod 末尾追加）：

```rust
    #[test]
    fn migration_014_removes_touch_keys() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO settings (key, value) VALUES
             ('touch_zones_enabled', '1'),
             ('touch_top_left', 'FIT_WIDTH'),
             ('unrelated_key', 'x')",
        )
        .unwrap();

        super::apply_014_drop_touch_zone_settings(&conn).unwrap();

        let touch: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'touch_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touch, 0, "touch_* key 全部清除");
        let other: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'unrelated_key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(other, 1, "非 touch key 不受影响");
    }

    #[test]
    fn migration_014_idempotent_rerun() {
        let conn = Connection::open_in_memory().unwrap();
        super::apply_014_drop_touch_zone_settings(&conn).unwrap();
        super::apply_014_drop_touch_zone_settings(&conn).unwrap(); // 幂等重跑
    }
```

- [ ] **步骤 6.4：验证**——`cargo test -p mirapage-desktop --lib migration_014` 2 测 PASS。
  注意：settings 表列名以 001 schema 为准（若 run() 后 seed 已含 touch_*，INSERT 可能撞唯一约束——先 `DELETE FROM settings WHERE key LIKE 'touch_%'` 再插入构造场景）。

## 任务 7：`inputBindings.ts` 删 mouseRegionCommand

**文件：**
- 修改：`src/lib/inputBindings.ts`
- 修改：`src/lib/inputBindings.test.ts`

- [ ] **步骤 7.1：调整测试（先红）**——删 `describe('resolveHotkey — mouse 3-region click')` 整段（4 用例）与 `mouseEventAt` 助手函数。

- [ ] **步骤 7.2：删实现**——`inputBindings.ts`：
  - 删 `mouseRegionCommand` 函数（L103-122）
  - `InputContext` 收窄为 `{ kind: 'keyboard' } | { kind: 'wheel' }`
  - `resolveHotkey` 删 `clientX` mouse 分支（L147-149）与 `ctx` 参数的 mouse 语义；jsdoc 同步
  - 头注释 L2 `键盘/鼠标/滚轮` → `键盘/滚轮`

- [ ] **步骤 7.3：验证**——`npx vitest run src/lib/inputBindings.test.ts` PASS + `npm run type-check`（确认 `useReaderHotkeys` 未传 ctx，无连带报错）。

## 任务 8：useReaderHotkeys 注释清理 + 全量验证

**文件：**
- 修改：`src/composables/useReaderHotkeys.ts`（仅注释 L6/L32 的 9 宫格表述）

- [ ] **步骤 8.1：注释改写**——`与 9 宫格 useReaderTouchZones + 顶栏/底栏按钮 click 冲突` → `与顶栏/底栏按钮 click 冲突`；其余提及 9 宫格处同理。

- [ ] **步骤 8.2：全量验证**：
  - `npm run type-check` → 0 error
  - `npm test -- --run` → 全绿（预期净减约 31 用例：23+4+3+1）
  - `cargo test -p mirapage-desktop --lib` → 全绿（+2 migration 014）
  - 残留扫描：`grep -rn "宫格\|TouchZone\|touchScheme\|touch_zones\|useReaderTouchZones\|touchAction" src src-tauri/src` → 无代码命中

## 任务 9：living 文档更新 + commit + tag

**文件：**
- 修改：`AGENTS.md`、`DESIGN.md`
- 修改（视情况）：`BUILD.md`

- [ ] **步骤 9.1：AGENTS.md**：
  - 删 §0.3「9 宫格点击」整段（L183 起）
  - §0.4/0.5/0.6 重编号为 0.3/0.4/0.5（标题号顺延修正）
  - L135 状态行 Phase 2 描述删「/ 9 宫格」；L144「+ 9 宫格触控方案」表述保留（历史记录）但补 3.0.12 行说明已移除
  - §3.3 域枚举表述删 `TouchZone / TouchAction` 与 `DEFAULT_TOUCH_SCHEME`
  - §6 删「9 宫格触控 master toggle」决策条目，新增「移除 9 宫格触控」决策条目
  - 状态表新增 3.0.12 行

- [ ] **步骤 9.2：DESIGN.md**：
  - L72 实现状态清单删 9 宫格条目
  - §13 设置表删 L1079-1080 两行 + L1084 起的触控映射段
  - §14/§15 输入映射表删「触控 XX 区」列（保留键位列）；L1317-1333 表述改写为纯键鼠映射
  - L589 对照表 `TouchRegionOverlay` 行删
  - L1274「触控分区覆盖」行删

- [ ] **步骤 9.3：BUILD.md**——版本历史表 3.0.12 行补记（历史行不动）。

- [ ] **步骤 9.4：commit + tag + push**：

```bash
npm run type-check && npm test -- --run
cargo test -p mirapage-desktop --lib
git add -A
git commit -m "refactor(reader): 移除 9 宫格触控功能（module3.0.12）

- 删 useReaderTouchZones + TouchRegionsOverlay + TouchAction/TouchZone 类型体系
- Settings 删 Touch section（8→7）；settings store 删 touchScheme/touchZonesEnabled
- migration 014 清理 touch_* settings key（含 001 死数据 seed）
- 顺带清理 mouseRegionCommand 半死代码 + 16 个孤儿 reader.* i18n key"
git tag v0.1.0-module3.0.12-touch-zones-removal
git push github main
git push github v0.1.0-module3.0.12-touch-zones-removal
```

## 自检结论

- 规格覆盖：spec §2.1→任务 3；§2.2→任务 1/2/3/4/5；§2.3→任务 5/7；§3→任务 6；§6 验收→任务 8/9。
- 类型一致性：任务 1 删类型后，任务 2/3/4 依次解除引用；type-check 在任务 4 步骤 4.3 归零。
- 无占位符：所有删除点带精确行号或完整代码块。
