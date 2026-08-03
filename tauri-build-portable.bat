@echo off
rem ─── 修复版 tauri-build-portable.bat ─────────────────────────────────────
rem 改动:
rem   1. chcp 65001 解决 cmd codepage GBK 中文显示乱码
rem   2. 检测正在运行的旧 mirapage 实例并拒绝继续 (避免文件锁)
rem   3. 优先 CARGO_TARGET_DIR (env 设了的话), 回退 src-tauri\target
rem   4. copy 失败不再静默 (去掉 1>nul 2>nul), 用 errorlevel 判断
rem   5. 每个 step 加明显的 banner, 失败立即 abort
rem ──────────────────────────────────────────────────────────────────────
chcp 65001 >nul

rem 检查旧实例
tasklist /FI "IMAGENAME eq mirapage-desktop.exe" 2>nul | find /I "mirapage-desktop.exe" >nul
if not errorlevel 1 (
  echo [ERROR] 旧 mirapage-desktop.exe 进程仍在运行. 请先关闭再构建.
  tasklist /FI "IMAGENAME eq mirapage-desktop.exe"
  exit /b 1
)

call "D:\compile\vs\BuildTools\VC\Auxiliary\Build\vcvars64.bat" 1>nul 2>nul
set PATH=D:\compile\.cargo\bin;%PATH%
set RUSTUP_HOME=D:\compile\.rustup
set CARGO_HOME=D:\compile\.cargo
cd /d F:\WorkSpaceCollection\git\mirapage-desktop

rem 决定 cargo target 路径 (env 优先)
if defined CARGO_TARGET_DIR (
  set "CARGO_OUT=%CARGO_TARGET_DIR%\release\mirapage-desktop.exe"
) else (
  set "CARGO_OUT=src-tauri\target\release\mirapage-desktop.exe"
)

echo.
echo === [1/3] npm run build (vue-tsc + vite) ===
call npm run build
if errorlevel 1 goto err

echo.
echo === [2/3] tauri build --no-bundle (cargo --release) ===
call npm run tauri -- build --no-bundle
if errorlevel 1 goto err

echo.
echo === [3/3] 拷贝产物到 mirapage-desktop-local.exe ===
echo 来源: %CARGO_OUT%

if not exist "%CARGO_OUT%" (
  echo [ERROR] 找不到 cargo 产物: %CARGO_OUT%
  goto err
)

copy /Y "%CARGO_OUT%" "mirapage-desktop-local.exe"
if errorlevel 1 goto err

echo.
echo === DONE ===
echo Output: F:\WorkSpaceCollection\git\mirapage-desktop\mirapage-desktop-local.exe
for %%I in ("mirapage-desktop-local.exe") do echo Size: %%~zI bytes
goto end

:err
echo.
echo === FAILED ===
exit /b 1

:end
