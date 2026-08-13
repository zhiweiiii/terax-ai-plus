# 一键打包正式版本
# 用法: .\打包.ps1
#
# 做的事:
#   1. 关掉正在跑的 Terax (不然 exe 被占用, 编译会失败)
#   2. 类型检查
#   3. 编译 CLI + 前端 + Rust 后端
#   4. 生成 NSIS / MSI 安装包

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

$startTime = Get-Date

$releaseExe = Join-Path $root "src-tauri\target\release\terax-awei.exe"

Step "关闭正在运行的正式版 Terax"
# 只杀 target/release/ 下的进程 —— 开发模式 (target/debug/) 不受影响
$procs = Get-Process -Name "terax-awei" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $releaseExe }
if ($procs) {
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1
    Write-Host "  已关闭 $($procs.Count) 个进程" -ForegroundColor Gray
} else {
    Write-Host "  没有在运行" -ForegroundColor Gray
}

Step "类型检查"
& npx tsc --noEmit
if ($LASTEXITCODE -ne 0) {
    Write-Host "类型检查失败, 停止打包" -ForegroundColor Red
    exit 1
}
Write-Host "  通过" -ForegroundColor Green

Step "编译打包 (CLI + 前端 + Rust, 大约 5-6 分钟)"
& pnpm tauri build

# tauri build 最后会因为缺少更新签名私钥而报错退出,
# 但安装包这时候已经生成好了 —— 所以按产物是否存在来判断成败。
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$exe   = $releaseExe
$nsis  = Join-Path $root "src-tauri\target\release\bundle\nsis\Terax_${version}_x64-setup.exe"
$msi   = Join-Path $root "src-tauri\target\release\bundle\msi\Terax_${version}_x64_en-US.msi"

Step "产物"
$ok = $true
foreach ($p in @($exe, $nsis, $msi)) {
    if (Test-Path $p) {
        $size = [math]::Round((Get-Item $p).Length / 1MB, 1)
        $time = (Get-Item $p).LastWriteTime.ToString("HH:mm:ss")
        Write-Host ("  {0,-8} {1,6} MB   {2}" -f $time, $size, $p) -ForegroundColor Green
    } else {
        Write-Host "  缺失: $p" -ForegroundColor Red
        $ok = $false
    }
}

$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)
Write-Host ""
if ($ok) {
    Write-Host "打包完成, 用时 ${elapsed}s" -ForegroundColor Green
    Write-Host "安装包: $nsis" -ForegroundColor Gray
    exit 0
} else {
    Write-Host "打包失败, 用时 ${elapsed}s" -ForegroundColor Red
    exit 1
}
