#requires -Version 7
<#
.SYNOPSIS
  Reclaim space under src-tauri/target, cheapest first.

.DESCRIPTION
  target/ is a cache, not an artifact: everything here can be rebuilt. What
  differs is what deleting it costs on the next build, so the tiers are
  ordered by that price rather than by size.

    (default)  incremental caches only. Pure rebuild state; the next build is
               slower once, nothing else changes.
    -Deep      also drops the whole debug profile. Release stays usable, so a
               packaged build is unaffected; the next `tauri dev` is a full
               rebuild.
    -All       cargo clean. Everything goes, both profiles rebuild from zero.

  Nothing here touches the profile settings in Cargo.toml, which are already
  tuned for size (release: lto fat, codegen-units 1, opt-level "s", strip;
  dev: line-tables-only debuginfo, no debuginfo for dependencies). Those are
  what keep target from returning to the 37 GB it once reached.

.EXAMPLE
  ./清理编译产物.ps1
  ./清理编译产物.ps1 -Deep
#>
[CmdletBinding()]
param(
  [switch]$Deep,
  [switch]$All
)

$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'src-tauri/target'

if (-not (Test-Path $target)) {
  Write-Host "没有 target 目录，无需清理。"
  return
}

function Get-DirSize([string]$path) {
  if (-not (Test-Path $path)) { return 0 }
  $sum = (Get-ChildItem -Recurse -File $path -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return $sum
}

function Show-Size([string]$label, [double]$bytes) {
  '{0,-28} {1,8:N2} GB' -f $label, ($bytes / 1GB)
}

$before = Get-DirSize $target
Write-Host (Show-Size 'target 清理前' $before)
Write-Host ''

# A running instance holds a lock on the exe, and a partial delete leaves a
# target that cargo has to sort out. Say so rather than failing halfway.
$running = Get-Process -Name 'terax-prod' -ErrorAction SilentlyContinue
if ($running) {
  Write-Warning "terax-prod 正在运行（PID $($running.Id -join ', ')），它会锁住 target 里的 exe。"
  Write-Warning "先关掉它再跑本脚本，否则删除会中途失败。"
  return
}

if ($All) {
  Write-Host '执行 cargo clean（两个 profile 全部重建）…'
  Push-Location (Join-Path $PSScriptRoot 'src-tauri')
  try { cargo clean } finally { Pop-Location }
}
else {
  foreach ($p in @('debug/incremental', 'release/incremental')) {
    $full = Join-Path $target $p
    $size = Get-DirSize $full
    if ($size -gt 0) {
      Write-Host (Show-Size "删除 $p" $size)
      Remove-Item -Recurse -Force $full
    }
  }

  if ($Deep) {
    $full = Join-Path $target 'debug'
    $size = Get-DirSize $full
    if ($size -gt 0) {
      Write-Host (Show-Size '删除 debug（release 保留）' $size)
      Remove-Item -Recurse -Force $full
    }
  }
}

Write-Host ''
$after = Get-DirSize $target
Write-Host (Show-Size 'target 清理后' $after)
Write-Host (Show-Size '释放' ($before - $after))
