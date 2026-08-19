# 一键热部署 = 开发模式, 改前端代码立刻生效 (HMR)
# 用法: .\热部署.ps1          后台启动/重启开发实例
#       .\热部署.ps1 -Stop    只停掉后台开发实例
#
# 开发实例在后台运行 (无窗口), 日志写到 dev.log, 当前终端立即返回。
# 想停掉或重启, 再跑一次本脚本即可 (会先杀旧实例再启新的)。
#
# 跑的是 pnpm tauri dev:
#   - 前端是 vite dev server, 改 .tsx/.ts/.css 保存即刷新, 不用重新编译
#   - 改了 src-tauri/ 里的 Rust 代码, tauri 会自动重编译并重启窗口
#   - 编译产物在 target/debug/, 和正式版 target/release/ 完全隔离
#
# 想出正式安装包用 .\打包.ps1

param([switch]$Stop)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$debugExe = Join-Path $root "src-tauri\target\debug\terax-prod.exe"
$releaseExe = Join-Path $root "src-tauri\target\release\terax-prod.exe"
$pidFile = Join-Path $root ".terax-dev.pid"
$logFile = Join-Path $root "dev.log"

function Stop-DevInstance {
    Write-Host ""
    Write-Host "==> 关闭上一个开发实例" -ForegroundColor Cyan

    # 首选入口: 上次启动时记下的后台进程树 (pwsh -> pnpm -> node -> cargo -> terax),
    # taskkill /T 连整个子树一起杀, 避免 pnpm/node 残留占着端口
    if (Test-Path -LiteralPath $pidFile) {
        $oldText = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($oldText -match '^\d+$') {
            $oldPid = [int]$oldText
            if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
                & taskkill.exe /PID $oldPid /T /F 2>$null | Out-Null
                Start-Sleep -Milliseconds 500
                Write-Host "  已关闭旧实例 (PID $oldPid)" -ForegroundColor Gray
            } else {
                Write-Host "  旧实例已不在运行" -ForegroundColor Gray
            }
        }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "  没有记录到后台实例" -ForegroundColor Gray
    }

    # 兜底: 只杀 target/debug/ 下的进程, 不动正式版
    $devProcs = Get-Process -Name "terax-prod" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $debugExe }
    if ($devProcs) {
        $devProcs | Stop-Process -Force
        Start-Sleep -Milliseconds 500
        Write-Host "  兜底关闭 $($devProcs.Count) 个开发进程" -ForegroundColor Gray
    }

    # 等旧实例把 exe 让出来。cargo 要覆盖 terax-prod.exe, 进程虽然杀了,
    # 文件句柄还要一会儿才释放, 立刻编译会 "failed to remove ... 拒绝访问"
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $fs = [System.IO.File]::Open(
                $debugExe,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::Delete
            )
            $fs.Dispose()
            break
        } catch {
            if ($i -eq 19) {
                Write-Host "  等不到 terax-prod.exe 解锁, 可能还在被占用" -ForegroundColor Red
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

Stop-DevInstance

if ($Stop) {
    Write-Host ""
    Write-Host "==> 已停止, 可以重新 .\热部署.ps1 启动" -ForegroundColor Green
    exit 0
}

# 上一次的 dev server 没退干净时会把端口占着, 而 vite 是 strictPort, 占用就直接
# 报 "Port 1420 is already in use" 启动失败。而且它常常是个孤儿 node 进程,
# 上面按 exe 路径杀 terax-prod 的逻辑碰不到它。
#   1420   vite dev server
#   1421   vite HMR (只有设了 TAURI_DEV_HOST 才用得上)
#   34269  开发版手机端 Web 服务
# 34268 是正式版的, 不在这个列表里, 也不会被碰。
$devPorts = @(1420, 1421, 34269)

function Clear-DevPort {
    param([int]$Port)

    $owners = @()
    try {
        $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique
    } catch [Microsoft.PowerShell.Cmdletization.Cim.CimJobException] {
        # 端口空闲时 Get-NetTCPConnection 是抛异常而不是返回空
        $owners = @()
    } catch {
        # 精简系统上可能没有 NetTCPIP 模块, 退回 netstat
        $owners = netstat -ano |
            Select-String -Pattern ":$Port\s+\S+\s+LISTENING\s+(\d+)" |
            ForEach-Object { $_.Matches[0].Groups[1].Value } |
            Select-Object -Unique
    }

    if (-not $owners) {
        Write-Host "  $Port 空闲" -ForegroundColor Gray
        return
    }

    foreach ($owner in $owners) {
        # 0 = Idle, 4 = System, 都不是我们的东西
        if ([int]$owner -le 4) { continue }
        $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        # 兜底: 正式版在跑的话放过它, 宁可这次启动失败也不打断你正在用的窗口
        if ($proc.Path -and $proc.Path -eq $releaseExe) {
            Write-Host "  $Port 被正式版占用, 跳过 (PID $owner)" -ForegroundColor Yellow
            continue
        }
        try {
            Stop-Process -Id $owner -Force -ErrorAction Stop
            Write-Host "  $Port 已释放 (杀掉 $($proc.ProcessName) PID $owner)" -ForegroundColor Gray
        } catch {
            Write-Host "  $Port 杀不掉 $($proc.ProcessName) PID $owner : $_" -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "==> 清理开发端口" -ForegroundColor Cyan
foreach ($port in $devPorts) { Clear-DevPort -Port $port }

# 内核回收监听套接字要一点时间, 等端口真正空闲再继续, 否则 vite 还是撞上
for ($i = 0; $i -lt 20; $i++) {
    $stillBusy = foreach ($port in $devPorts) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port }
    }
    if (-not $stillBusy) { break }
    if ($i -eq 19) {
        Write-Host "  端口仍被占用: $($stillBusy -join ', ')" -ForegroundColor Red
        Write-Host "  这次启动多半还会失败, 先确认这些端口上跑的是什么" -ForegroundColor Red
    }
    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "==> 构建手机版 Web 页面" -ForegroundColor Cyan
& node scripts/build-web.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Web 页面构建失败, 停止启动" -ForegroundColor Red
    exit 1
}
Write-Host "  完成" -ForegroundColor Green

Write-Host ""
Write-Host "==> 后台启动开发模式" -ForegroundColor Cyan
Write-Host "  窗口会在 Rust 编译完成后弹出 (首次编译要几分钟)" -ForegroundColor Gray
Write-Host "  日志: dev.log, 改前端保存后窗口自动刷新" -ForegroundColor Gray
Write-Host "  F12 可以开 DevTools 看 console" -ForegroundColor Gray
Write-Host ""

Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
# 后台无窗口运行: 隐藏的 pwsh 把 pnpm tauri dev 的输出全写进 dev.log,
# 本脚本退出不影响它。PID 记下来, 下次运行靠它连树一起杀。
$inner = "pnpm tauri dev *>> '$logFile'"
$proc = Start-Process -FilePath "pwsh" `
    -ArgumentList @("-NoLogo", "-NoProfile", "-Command", $inner) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru
Set-Content -LiteralPath $pidFile -Value $proc.Id

# 等 vite 起来 (tauri dev 先起 vite 再编 Rust), 起不来就把日志尾巴端出来
$up = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $proc.Refresh()
    if ($proc.HasExited) { break }
    if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
        $up = $true
        break
    }
}

Write-Host ""
if ($up) {
    Write-Host "==> 开发模式已后台启动 (PID $($proc.Id))" -ForegroundColor Green
    Write-Host "  窗口等 Rust 编译完弹出, 日志在 dev.log, 再跑本脚本即重启" -ForegroundColor Gray
} else {
    Write-Host "==> 没等到 vite 就绪" -ForegroundColor Red
    if (Test-Path -LiteralPath $logFile) {
        Write-Host "  dev.log 最后几行:" -ForegroundColor Red
        Get-Content -LiteralPath $logFile -Tail 15 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host "  dev.log 还没有内容" -ForegroundColor Red
    }
}
