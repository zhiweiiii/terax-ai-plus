# 一键热部署 — 开发模式, 改前端代码立刻生效 (HMR)
# 用法: .\热部署.ps1
#
# 跑的是 pnpm tauri dev:
#   - 前端走 vite dev server, 改 .tsx/.ts/.css 保存即刷新, 不用重新编译
#   - 改了 src-tauri/ 的 Rust 代码, tauri 会自动重编译并重启窗口
#   - 编译产物在 target/debug/, 和正式版 target/release/ 完全隔离
#
# 想出正式安装包用 .\打包.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$debugExe = Join-Path $root "src-tauri\target\debug\terax-awei.exe"

Write-Host ""
Write-Host "==> 关闭上一个开发实例" -ForegroundColor Cyan
# 只杀 target/debug/ 下的进程, 不动正式版
$devProcs = Get-Process -Name "terax-awei" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $debugExe }
if ($devProcs) {
    $devProcs | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    Write-Host "  已关闭 $($devProcs.Count) 个" -ForegroundColor Gray
} else {
    Write-Host "  没有在运行" -ForegroundColor Gray
}

Write-Host ""
Write-Host "==> 启动开发模式 (Ctrl+C 退出)" -ForegroundColor Cyan
Write-Host "  改前端代码保存后窗口自动刷新" -ForegroundColor Gray
Write-Host "  改 Rust 代码会自动重编译重启" -ForegroundColor Gray
Write-Host "  F12 可以开 DevTools 看 console" -ForegroundColor Gray
Write-Host ""

& pnpm tauri dev
