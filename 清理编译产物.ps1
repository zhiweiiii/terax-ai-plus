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
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$target = [IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri/target'))

function Assert-BuildDirectory([string]$path) {
  $absolute = [IO.Path]::GetFullPath($path)
  if ($absolute -ne $target -and
      -not $absolute.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理 target 以外的路径: $absolute"
  }
  $current = $absolute
  while ($current -and $current -ne $projectRoot) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (-not $item.PSIsContainer -or
          ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "拒绝清理非目录或链接路径: $current"
      }
    }
    $current = Split-Path -Parent $current
  }
  return $absolute
}

$target = Assert-BuildDirectory $target

if (-not (Test-Path -LiteralPath $target)) {
  Write-Host "没有 target 目录，无需清理。"
  return
}

function Get-DirSize([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
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
$running = Get-Process -Name 'awei-work' -ErrorAction SilentlyContinue
if ($running) {
  Write-Warning "awei-work 正在运行（PID $($running.Id -join ', ')），它会锁住 target 里的 exe。"
  Write-Warning "先关掉它再跑本脚本，否则删除会中途失败。"
  return
}

if ($All) {
  Write-Host '执行 cargo clean（两个 profile 全部重建）…'
  Push-Location (Join-Path $PSScriptRoot 'src-tauri')
  try {
    cargo clean --target-dir $target
    if ($LASTEXITCODE -ne 0) { throw "cargo clean 失败" }
  } finally { Pop-Location }
}
else {
  foreach ($p in @('debug/incremental', 'release/incremental')) {
    $full = Assert-BuildDirectory (Join-Path $target $p)
    $size = Get-DirSize $full
    if ($size -gt 0) {
      Write-Host (Show-Size "删除 $p" $size)
      Remove-Item -LiteralPath $full -Recurse -Force
    }
  }

  if ($Deep) {
    $full = Assert-BuildDirectory (Join-Path $target 'debug')
    $size = Get-DirSize $full
    if ($size -gt 0) {
      Write-Host (Show-Size '删除 debug（release 保留）' $size)
      Remove-Item -LiteralPath $full -Recurse -Force
    }
  }
}

Write-Host ''
$after = Get-DirSize $target
Write-Host (Show-Size 'target 清理后' $after)
Write-Host (Show-Size '释放' ($before - $after))
