@echo off
REM scripts/build-tauri-inner.bat — 由 build-portable.ps1 调用
REM
REM 用 vcvars64.bat 设 MSVC 环境, 然后跑 tauri build --no-bundle
REM 用 ';' 分隔（cmd 原生支持, 不依赖 PowerShell tokenization）

call "D:\compile\vs\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set PATH=D:\compile\.cargo\bin;%PATH%
set RUSTUP_HOME=D:\compile\.rustup
set CARGO_HOME=D:\compile\.cargo
cd /d F:\WorkSpaceCollection\git\mirapage-desktop
npm run tauri -- build --no-bundle
