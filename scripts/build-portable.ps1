#!/usr/bin/env pwsh
# scripts/build-portable.ps1 -- v0.1.0-module3.0.1+
#
# Pipeline:
#   [1/5] Detect mirapage-desktop running process -> kill + wait
#   [2/5] npm run build (vue-tsc -b && vite build)
#   [3/5] scripts\build-tauri-inner.bat (vcvars64 + tauri build --no-bundle)
#   [4/5] Copy D:\compile\rust_target\release\*.exe -> project local exe (3 retries)
#   [5/5] Print size + MD5 (compare source vs local)
#
# ASCII-only to avoid PowerShell 5.1 UTF-8 string parser bugs
#
# Usage (Git Bash):
#   powershell.exe -ExecutionPolicy Bypass -File "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\scripts\\build-portable.ps1"

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
$InnerBat = Join-Path $ProjectDir 'scripts\build-tauri-inner.bat'

function Step($idx, $total, $msg, $color = 'Cyan') {
  Write-Host "[$idx/$total] $msg" -ForegroundColor $color
}

# ──────────────────────────────────────────────────────────
# [1/5] Detect + kill running instance
# ──────────────────────────────────────────────────────────
Step 1 5 'Detect mirapage-desktop running instance'
$running = Get-Process -Name 'mirapage-desktop' -ErrorAction SilentlyContinue
if ($running -ne $null) {
  $pids = ($running | Select-Object -ExpandProperty Id) -join ','
  Write-Host ('      [WARN] PID(' + $pids + ') running, killing...') -ForegroundColor Yellow
  $exited = $false
  for ($i = 1; $i -le $KillRetries; $i++) {
    Stop-Process -Name 'mirapage-desktop' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds $KillWaitSeconds
    $stillRunning = Get-Process -Name 'mirapage-desktop' -ErrorAction SilentlyContinue
    if ($stillRunning -eq $null) {
      Write-Host '      [OK] exited' -ForegroundColor Green
      $exited = $true
      break
    }
    if ($i -eq $KillRetries) {
      Write-Host '=== FAILED ===' -ForegroundColor Red
      Write-Host ('PID(' + $pids + ') still running after ' + $KillRetries + ' retries. Please close manually.') -ForegroundColor Red
      exit 1
    }
    Write-Host ('      retry ' + $i + '/' + $KillRetries) -ForegroundColor DarkYellow
  }
  if (-not $exited) { exit 1 }
} else {
  Write-Host '      [OK] no running instance' -ForegroundColor Green
}

# ──────────────────────────────────────────────────────────
# [2/5] Frontend build
# ──────────────────────────────────────────────────────────
Step 2 5 'npm run build (vue-tsc + vite)'
$prevDir = (Get-Location).Path
Set-Location $ProjectDir
try {
  # Use cmd.exe to run npm; PowerShell 5.1 has issues with npm's
  # stderr CSS optimize warnings being treated as errors.
  $cmdLine = 'cd /d "' + $ProjectDir + '" && npm run build'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c ' + $cmdLine
  $psi.WorkingDirectory = $ProjectDir
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($out) { Write-Host $out }
  if ($p.ExitCode -ne 0) {
    if ($err) { Write-Host $err -ForegroundColor Red }
    Write-Host '=== FAILED ===' -ForegroundColor Red
    exit 1
  }
  Write-Host '      [OK] dist/ generated' -ForegroundColor Green
} finally {
  Set-Location $prevDir
}

# ──────────────────────────────────────────────────────────
# [3/5] tauri build --no-bundle (via inner .bat)
# ──────────────────────────────────────────────────────────
Step 3 5 'tauri build --no-bundle (Rust release)'
if (-not (Test-Path $InnerBat)) {
  Write-Host '=== FAILED ===' -ForegroundColor Red
  Write-Host ('inner bat not found: ' + $InnerBat) -ForegroundColor Red
  exit 1
}

# Call inner .bat directly. PowerShell 5.1 doesn't support '&&' as
# statement separator (PS 7+ only), so we keep the cmd.exe chain
# inside the .bat file.
#
# Important: do NOT use Start-Process with RedirectStandardOutput here.
# PowerShell 5.1 has a deadlock when redirecting pipes to large-output
# commands like cargo build --release (cargo writes ~1000+ lines and the
# 4 KB pipe buffer fills up; without async read, child blocks indefinitely).
# Run cmd.exe in foreground and trust $LASTEXITCODE instead.
cmd.exe /c $InnerBat
if ($LASTEXITCODE -ne 0) {
  Write-Host '=== FAILED ===' -ForegroundColor Red
  Write-Host ('tauri build exit code: ' + $LASTEXITCODE) -ForegroundColor Red
  exit 1
}
Write-Host '      [OK] Rust release complete' -ForegroundColor Green

# ──────────────────────────────────────────────────────────
# [4/5] Copy (3 retries)
# ──────────────────────────────────────────────────────────
Step 4 5 ('Copy to ' + $LocalExe)
if (-not (Test-Path $RustTarget)) {
  Write-Host '=== FAILED ===' -ForegroundColor Red
  Write-Host ('source not found: ' + $RustTarget) -ForegroundColor Red
  exit 1
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
    Write-Host ('      [WARN] retry ' + $i + '/' + $CopyRetries + ' : ' + $_.Exception.Message) -ForegroundColor DarkYellow
    Start-Sleep -Seconds $CopyWaitSeconds
  }
}
if (-not $copied) {
  Write-Host '=== FAILED ===' -ForegroundColor Red
  Write-Host ('copy failed ' + $CopyRetries + ' times. Check (a) antivirus scan (b) file handle') -ForegroundColor Red
  exit 1
}
Write-Host '      [OK] copy complete' -ForegroundColor Green

# ──────────────────────────────────────────────────────────
# [5/5] Verify MD5
# ──────────────────────────────────────────────────────────
Step 5 5 'MD5 verification'
$srcHash = (Get-FileHash $RustTarget -Algorithm MD5).Hash
$dstHash = (Get-FileHash $LocalExe -Algorithm MD5).Hash
$sizeBytes = (Get-Item $LocalExe).Length
$sizeMB = [math]::Round($sizeBytes / 1MB, 2)
$srcSizeMB = [math]::Round((Get-Item $RustTarget).Length / 1MB, 2)

Write-Host ('      src   ' + $srcHash + '  ' + $srcSizeMB + ' MB') -ForegroundColor DarkGray
Write-Host ('      local ' + $dstHash + '  ' + $sizeMB + ' MB') -ForegroundColor DarkGray

if ($srcHash -eq $dstHash) {
  Write-Host ''
  Write-Host '=== DONE ===' -ForegroundColor Green
  Write-Host ('Output: ' + $LocalExe) -ForegroundColor Green
  Write-Host ''
  Write-Host 'Next: double-click .exe to run, OR' -ForegroundColor Cyan
  Write-Host '  git tag vX.Y.Z && git push github vX.Y.Z   # trigger CI release' -ForegroundColor Cyan
  exit 0
} else {
  Write-Host '=== FAILED ===' -ForegroundColor Red
  Write-Host ('MD5 mismatch! src=' + $srcHash + ' local=' + $dstHash) -ForegroundColor Red
  exit 1
}