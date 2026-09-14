# Router 启动脚本（Windows PowerShell）
# 用法：.\start.ps1   已配置好令牌与端口，后台启动
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:NEWAPI_TOKEN = if ($env:NEWAPI_TOKEN) { $env:NEWAPI_TOKEN } else { 'sk-oV9ttdE0SGdBe5cp5tiSPP8MtBdIPtt06LoCluaH5FFhKH6F' }
$env:NEWAPI_BASE = if ($env:NEWAPI_BASE) { $env:NEWAPI_BASE } else { 'http://127.0.0.1:22222' }
$env:ROUTER_PORT = if ($env:ROUTER_PORT) { $env:ROUTER_PORT } else { '33333' }
$env:ROUTER_HOST = '127.0.0.1'

# 若已在运行则先提示
$existing = Get-NetTCPConnection -LocalPort 33333 -State Listen -ErrorAction SilentlyContinue
if ($existing) { Write-Host '[router] 33333 已在监听，未重复启动'; exit 0 }

Start-Process -FilePath 'node' -ArgumentList '--import','tsx','src/server.ts' `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput "$root\router.log" -RedirectStandardError "$root\router.err.log"
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:ROUTER_PORT)/api/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "[router] OK: $($r.Content)"
} catch {
  Write-Host "[router] 启动失败，见 router.err.log"
  Get-Content "$root\router.err.log" -ErrorAction SilentlyContinue | Select-Object -First 20
}