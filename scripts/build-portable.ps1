#!/usr/bin/env pwsh
# scripts/build-portable.ps1 — v0.1.0-module3.0.1+
#
# 流程:
#   [1/5] 检测 mirapage-desktop 是否在运行 → 关闭 + 等待退出
#   [2/5] npm run build (vue-tsc -b && vite build)
#   [3/5] tauri build --no-bundle (Rust release + protocol-asset)
#   [4/5] 复制 D:\compile\rust_target\release\*.exe → 项目本地副本
#          (3 次重试, 解决 Windows 上"Device or resource busy")
#   [5/5] 打印产物大小 + MD5 (与 D:\compile 源文件对比)
#
# 依赖 (与现有 tauri-build-portable.bat 一致, 无新增要求):
#   - D:\compile\.cargo\bin, D:\compile\.rustup, D:\compile\vs\BuildTools\VC\Auxiliary\Build\vcvars64.bat
#   - Node.js 18+, npm
#   - PowerShell 5.1+ (Windows 10/11 自带)
#
# 用法 (Git Bash):
#   powershell.exe -ExecutionPolicy Bypass -File "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\scripts\\build-portable.ps1"
#
# 或直接双击 (PowerShell ISE / 右键 → 用 PowerShell 运行)

[CmdletBinding()]
param(
  [string]$ProjectDir = 'F:\WorkSpaceCollection\git\mirapage-desktop',
  [string]$RustTarget = 'D:\compile\rust_target\release\mirapage-desktop.exe',
  [string]$LocalExeName = 'mirapage-desktop-local.exe',
  [int]$KillRetries = 3,
  [int]$KillWaitSeconds = 2,
  [int]$CopyRetries = 3,
  [int]$CopyWaitSeconds = 2
)

$ErrorActionPreference = 'Stop'

$LocalExe = Join-Path $ProjectDir $LocalExeName
$tauriLog = Join-Path $ProjectDir 'src-tauri\target\release\build.log'

function Step($idx, $total, $msg, $color = 'Cyan') {
  Write-Host "[$idx/$total] $msg" -ForegroundColor $color
}

try {
  # ──────────────────────────────────────────────────────────
  # [1/5] 检测 + 关闭运行实例
  # ──────────────────────────────────────────────────────────
  Step 1 5 '检测 mirapage-desktop 运行实例'
  $running = Get-Process -Name 'mirapage-desktop' -ErrorAction SilentlyContinue
  if ($running) {
    $pids = ($running | Select-Object -ExpandProperty Id) -join ','
    Write-Host "      ⚠ PID($pids) 在跑, 关闭中..." -ForegroundColor Yellow
    for ($i = 1; $i -le $KillRetries; $i++) {
      Stop-Process -Name 'mirapage-desktop' -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds $KillWaitSeconds
      $stillRunning = Get-Process -Name 'mirapage-desktop' -ErrorAction SilentlyContinue
      if (-not $stillRunning) {
        Write-Host "      ✓ 已退出" -ForegroundColor Green
        break
      }
      if ($i -eq $KillRetries) {
        throw "PID($pids) 在 $KillRetries 次后仍未退出. 请手动关闭后重试."
      }
      Write-Host "      retry $i/$KillRetries ..." -ForegroundColor DarkYellow
    }
  } else {
    Write-Host '      ✓ 无运行实例' -ForegroundColor Green
  }

  # ──────────────────────────────────────────────────────────
  # [2/5] 前端 build
  # ──────────────────────────────────────────────────────────
  Step 2 5 'npm run build (vue-tsc + vite)'
  Push-Location $ProjectDir
  try {
    $npmOut = & npm run build 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host $npmOut -ForegroundColor Red
      throw 'npm run build failed'
    }
    Write-Host '      ✓ dist/ 生成' -ForegroundColor Green
  } finally {
    Pop-Location
  }

  # ──────────────────────────────────────────────────────────
  # [3/5] tauri build --no-bundle
  # ──────────────────────────────────────────────────────────
  Step 3 5 'tauri build --no-bundle (Rust release)'
  Push-Location $ProjectDir
  try {
    # 使用 vcvars64.bat 设 MSVC 环境 (与 tauri-build-portable.bat 同源)
    $vcvars = 'D:\compile\vs\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
    if (Test-Path $vcvars) {
      Write-Host "      设置 MSVC 环境 (vcvars64)" -ForegroundColor DarkGray
    }
    & cmd.exe /c "`"$vcvars`" >nul && set PATH=D:\compile\.cargo\bin;%PATH% && set RUSTUP_HOME=D:\compile\.rustup && set CARGO_HOME=D:\compile\.cargo && npm run tauri -- build --no-bundle" 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }
    Write-Host '      ✓ Rust release 完成' -ForegroundColor Green
  } finally {
    Pop-Location
  }

  # ──────────────────────────────────────────────────────────
  # [4/5] 复制 (重试 3 次)
  # ──────────────────────────────────────────────────────────
  Step 4 5 "复制到 $LocalExe"
  if (-not (Test-Path $RustTarget)) {
    throw "找不到构建产物: $RustTarget`n  提示: 检查 \$KillRetries / 项目路径"
  }
  $copied = $false
  for ($i = 1; $i -le $CopyRetries; $i++) {
    try {
      if (Test-Path $LocalExe) {
        Remove-Item $LocalExe -Force -ErrorAction Stop
      }
      Copy-Item $RustTarget $LocalExe -Force -ErrorAction Stop
      $copied = $true
      break
    } catch {
      Write-Host "      ⚠ retry $i/$CopyRetries : $_" -ForegroundColor DarkYellow
      Start-Sleep -Seconds $CopyWaitSeconds
    }
  }
  if (-not $copied) {
    throw "复制失败 $CopyRetries 次. 检查 (a) 防病毒扫描 (b) 文件句柄占用"
  }
  Write-Host '      ✓ 复制完成' -ForegroundColor Green

  # ──────────────────────────────────────────────────────────
  # [5/5] 校验 MD5 一致
  # ──────────────────────────────────────────────────────────
  Step 5 5 'MD5 校验'
  $srcHash = (Get-FileHash $RustTarget -Algorithm MD5).Hash
  $dstHash = (Get-FileHash $LocalExe -Algorithm MD5).Hash
  $sizeBytes = (Get-Item $LocalExe).Length
  $sizeMB = [math]::Round($sizeBytes / 1MB, 2)

  Write-Host ("      src   {0}  {1} MB" -f $srcHash, [math]::Round((Get-Item $RustTarget).Length / 1MB, 2)) -ForegroundColor DarkGray
  Write-Host ("      local {0}  {1} MB" -f $dstHash, $sizeMB) -ForegroundColor DarkGray

  if ($srcHash -eq $dstHash) {
    Write-Host "`n=== DONE ✓ ===" -ForegroundColor Green
    Write-Host "产物: $LocalExe`n" -ForegroundColor Green
    Write-Host "下一步: 双击 .exe 直接运行, 或" -ForegroundColor Cyan
    Write-Host "  git tag vX.Y.Z && git push github vX.Y.Z   # 触发 CI release" -ForegroundColor Cyan
    exit 0
  } else {
    throw "MD5 不一致! src=$srcHash local=$dstHash"
  }
}
catch {
  Write-Host "`n=== FAILED ===" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
