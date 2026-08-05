# Tauri 阅读器实时调试流程

通过 Chrome DevTools Protocol (CDP) 连接到**运行中的 Tauri app**,实时读写 OpenSeadragon / Vue 组件状态,用于调试缩放、渲染、IPC 等运行时问题。可在任意 Windows 机器复现。

## 适用场景

- 缩放档位效果验证(读 OSD viewport 真实 zoom/bounds/containerSize)
- resize 后是否重算(读 viewport.getBounds 验证图像是否溢出)
- Vue 组件 setupState 运行时检查(读 singleViewerRef / settings store)
- 任何需要"在真实 app 里跑 JS 看状态"的调试

## 原理

Tauri 2 的 WebView2(Rust `wry` crate 封装)在 dev build 下默认启用 DevTools。通过环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 让 WebView2 开 remote debugging 端口(9222),再用 chrome-devtools-mcp 连上去。

```
Tauri app (PID)
  └─ WebView2 runtime
       └─ remote debugging :9222  ← chrome-devtools-mcp 连这里
                                   (不是 Vite 的 :1420)
```

> 注意:连 `http://localhost:1420`(Vite)只能跑纯前端,无 Tauri IPC,开不了书。必须连 9222 才是真实 app。

## 如何开启 Tauri 调试

Tauri 2 的 DevTools 有两种用法:**手动开 F12**(人看)和 **remote debugging 端口**(工具连)。

### 前提:dev build 才有 DevTools

Tauri 2 在 **debug build(`dev` profile,即 `npm run tauri:dev`)下默认启用 DevTools**,不需要额外 feature flag。production release(`tauri build`)默认关闭,需要在 `src-tauri/Cargo.toml` 加 feature:

```toml
# 仅 production 需要显式开 devtools; dev 模式自带
tauri = { version = "2", features = ["protocol-asset", "devtools"] }
```

本项目 dev 模式直接可用,无需改 Cargo.toml。

### 方式 A:F12 开自带 DevTools(最简单,人看)

1. `npm run tauri:dev` 启动
2. 在 app 窗口里按 **F12**(或右键 → 检查)
3. WebView2 自带 DevTools 弹出,可看 Console / Network / Sources / Elements

适合手动调试、看 console.log、查网络请求。无法被外部工具(chrome-devtools-mcp)连接。

### 方式 B:remote debugging 端口(工具可连)

让 WebView2 开一个 CDP remote debugging 端口,chrome-devtools-mcp 等工具能连上去自动读写状态。

启动时设环境变量:

```bash
# Git Bash / Claude Code Bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri:dev
```

```cmd
:: cmd.exe
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
npm run tauri:dev
```

```powershell
# PowerShell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
npm run tauri:dev
```

启动后验证 9222 监听:

```bash
netstat -ano | grep ":9222 " | grep LISTENING   # 应有输出
```

> 也可设其它端口(如 9223),与 MCP 配置里的 `--browserUrl` 保持一致即可。
>
> 方式 A 和方式 B 可同时用——同一个 dev 实例,F12 给人看,9222 给工具连。

## 一次性配置(每台机器做一次)

### 1. 安装 chrome-devtools-mcp

在 Claude Code 里执行 `/plugin` 安装 `chrome-devtools-mcp@claude-plugins-official`(官方插件)。或用 npm 手动装:`npm i -g chrome-devtools-mcp`。

### 2. 配置一个连 9222 的 MCP 服务器

编辑 `~/.claude.json`(全局),在顶层 `mcpServers` 加一条:

```json
{
  "mcpServers": {
    "tauri-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@1.6.0",
        "--browserUrl=http://127.0.0.1:9222"
      ]
    }
  }
}
```

> 不要改插件自带的 `chrome-devtools` 配置(那个启动新 Chrome,用于浏览器调试)。`tauri-devtools` 是独立的、连已运行 Tauri 实例的。
>
> 版本号(`@1.6.0`)按实际安装版本填。可用 `npx chrome-devtools-mcp --help` 确认 `--browserUrl` 参数支持。

### 3. 重启 Claude Code 会话

MCP 服务器配置只在会话启动时加载。重启后会多出 `mcp__tauri-devtools__*` 系列工具。

## 每次调试流程

### Step 1: 杀掉所有残留进程

之前没干净退出的 dev 会占端口、锁住 WebView2 user data folder,导致新实例创建失败(`HRESULT 0x8007139F`)。

```bash
# Git Bash (Claude Code Bash)
taskkill //F //IM mirapage-desktop.exe
taskkill //F //IM msedgewebview2.exe     # 可能有些杀不掉(别的程序),忽略
# 确认端口空闲
netstat -ano | grep ":1420 " | grep LISTENING   # 应无输出
netstat -ano | grep ":9222 " | grep LISTENING    # 应无输出
```

> 如果 1420 还被占,`netstat -ano | grep ":1420" | grep LISTENING` 拿到 PID,`taskkill //F //PID <pid>`。

### Step 2: 带 remote debugging 启动 dev

```bash
cd /path/to/mirapage-desktop
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri:dev
```

后台启动(Claude Code 里用 `run_in_background: true`)。首次全量编译约 4 分钟,增量约 15-30 秒。

### Step 3: 确认实例起来

```bash
# 进程活着
tasklist //FI "IMAGENAME eq mirapage-desktop.exe"   # 应有输出
# 9222 监听
netstat -ano | grep ":9222 " | grep LISTENING       # 应有输出
# 日志尾部 (DB 已开 = 起来了)
tail -n 5 "$LOCALAPPDATA/top.racyan.mirapage-desktop/logs/main.log"
```

> 日志路径:`%LOCALAPPDATA%\top.racyan.mirapage-desktop\logs\main.log`
> (不是 Roaming。由 `src-tauri/src/log.rs::log_file_path` 决定,identifier = `top.racyan.mirapage-desktop`)
>
> `$LOCALAPPDATA` = `C:\Users\<user>\AppData\Local`

### Step 4: 连接并验证

```
mcp__tauri-devtools__list_pages   → 应显示 "MiraPage Desktop" (http://localhost:1420/...)
```

连上后用 `evaluate_script` 跑 JS 读真实状态。典型用法见下节。

## 常用调试脚本

通过 `mcp__tauri-devtools__evaluate_script` 执行。所有脚本都从 DOM 找 `[data-test="viewer-container"]`,沿 `__vueParentComponent` 上溯到 ReaderScreen 拿 OSD viewer 实例。

### 读 OSD viewport 真实状态

```js
() => {
  const container = document.querySelector('[data-test="viewer-container"]');
  const vc = container.__vueParentComponent;
  let comp = vc;
  for (let i = 0; i < 20 && comp; i++) {
    const ctx = comp.setupState || {};
    if (ctx.scaleModeRef) {
      const v = ctx.singleViewerRef?.getViewer?.() || ctx.doubleViewerRef?.getViewer?.();
      if (!v) return { err: 'no viewer' };
      const vp = v.viewport;
      const item = v.world.getItemAt(0);
      let vb; try { vb = vp.getBounds(true); } catch(e) { vb = 'err'; }
      return {
        mode: ctx.scaleModeRef.value,
        zoom: vp.getZoom(),
        homeZoom: vp.getHomeZoom(),
        containerSize: vp.getContainerSize(),
        itemBounds: item?.getBounds(),
        sourceDimensions: item?.source?.dimensions ? { x: item.source.dimensions.x, y: item.source.dimensions.y } : null,
        viewportBounds: vb,
      };
    }
    comp = comp.parent;
  }
  return { err: 'no scaleModeRef up the tree' };
}
```

### 触发缩放档位切换(不需手动点 UI)

```js
() => {
  const container = document.querySelector('[data-test="viewer-container"]');
  const vc = container.__vueParentComponent;
  let comp = vc;
  for (let i = 0; i < 20 && comp; i++) {
    const ctx = comp.setupState || {};
    if (ctx.scaleModeRef) {
      ctx.settings.setScaleMode('fit-height');  // 改成要测的 mode
      return { triggered: true };
    }
    comp = comp.parent;
  }
  return { err: 'no' };
}
```

### 验证图像是否溢出容器(fit 各档语义检查)

归一化坐标系下,`viewportBounds.height <= itemBounds.height` 表示垂直不溢出:

```js
// 在上一脚本读出 vb/ib 后:
// noLetterboxV: vb.height <= ib.height + 0.0001   // 垂直不溢出
// noLetterboxH: vb.width  <= ib.width  + 0.0001   // 水平不溢出
// heightFilled: Math.abs(vb.height - ib.height) < 0.001  // 高度刚好填满(fit-height 语义)
```

## OSD 归一化坐标系关键事实(踩坑总结)

调试时必须知道,否则会误判:

- **`item.getBounds()` 返回归一化坐标**:image width 归一到 1,height 按比例(如 16:9 图 → height=0.5625)。**不是像素尺寸**。
- **`homeZoom` 永远 = 1**(归一化系下)。
- **`zoomTo(z)` 的 z 是绝对 zoom,不是相对 homeZoom 的倍数**:zoom=1 时图宽(bounds.width=1)刚好填满 container 宽。
- **像素尺寸在 `item.source.dimensions`**:`{x: 像素宽, y: 像素高}`。仅 `{type:'image'}` tileSource 保证可用。
- **渲染像素宽 = `zoom × container.x`**:验证 1:1 用这个。
- **`goHome(true)` 不根据当前 containerSize 重算**:它用 image open 时存的 `_homeBounds` 快照。resize 后调 goHome 是 no-op。fit-screen 在 resize 后"看起来对"是靠 OSD `autoResize:true` 的附带行为,不是 goHome 生效。
- **正确的 fit 公式(归一化系)**:
  - fit-width:`viewport.fitHorizontally(true)`(OSD 原生)
  - fit-height:`viewport.fitVertically(true)`(OSD 原生)
  - full-screen(不留黑边):`zoomTo(max(1, container.y/(bounds.height×container.x)))` + panTo center
  - original(真 1:1):`zoomTo(dims.x/container.x)` + panTo center

## 调试结束清理

```bash
# 停后台 dev 任务 (Claude Code TaskStop) 或:
taskkill //F //IM mirapage-desktop.exe
# WebView2 进程会随之退出; 残留的 msedgewebview2.exe 可忽略(可能是别的程序)
```

如果想从 `~/.claude.json` 移除 `tauri-devtools` 配置(不再需要):

```bash
node -e "
const fs=require('fs');
const p=require('os').homedir()+'/.claude.json';
const c=JSON.parse(fs.readFileSync(p,'utf8'));
delete c.mcpServers['tauri-devtools'];
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('removed');
"
```

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `failed to create webview: HRESULT 0x8007139F` | 上个 WebView2 实例 user data folder 未释放 | 杀所有 mirapage-desktop.exe + msedgewebview2.exe,重试 |
| `Port 1420 is already in use` | 上次 vite 没干净退出 | `netstat -ano \| grep :1420` 找 PID,`taskkill //F //PID <pid>` |
| `list_pages` 只显示 about:blank | chrome-devtools-mcp 启动了新 Chrome,没连 9222 | 确认 `--browserUrl=http://127.0.0.1:9222` 参数;确认 dev 带环境变量启动;确认会话重启过 |
| `evaluate_script` 报 `no __vueParentComponent` | 不在 Vue 组件元素上,或 dev 模式 Vue devtools 未启用 | 确认元素是 Vue 渲染的(`[data-test=*]`);Vite dev 模式默认带 Vue devtools |
| app 起来但 9222 不监听 | 环境变量没传到子进程 | Git Bash 里确认 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 在同一行命令内;Windows 环境变量大小写敏感用全大写 |

## 关键文件位置

| 用途 | 路径 |
|---|---|
| 日志文件(前端 + Rust) | `%LOCALAPPDATA%\top.racyan.mirapage-desktop\logs\main.log` |
| SQLite 数据库 | `%APPDATA%\top.racyan.mirapage-desktop\mirapage.db`(Roaming) |
| MCP 全局配置 | `~/.claude.json`(顶层 `mcpServers`) |
| 阅读器缩放逻辑 | `src/composables/useReaderScale.ts` |
| OSD viewer 组件 | `src/components/reader/SinglePageViewer.vue`(单页)、`DoublePageViewer.vue`(双页) |
| 接线层 | `src/components/reader/ReaderScreen.vue`(useReaderScale 调用处) |
| Rust 日志写入 | `src-tauri/src/log.rs`(路径计算)+ `src-tauri/src/commands/log.rs`(IPC 入口) |
