#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the Apilix server and Vite dev client in separate background processes.
#>

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

Write-Host "`nAPILIX - Start" -ForegroundColor Yellow
Write-Host "Root: $Root"

# ── Server ─────────────────────────────────────────────────────────────────────

Write-Host "`n==> Starting server (port 3001)..." -ForegroundColor Cyan
$serverJob = Start-Process -FilePath "node" `
    -ArgumentList "$Root\server\index.js" `
    -WorkingDirectory $Root `
    -PassThru `
    -WindowStyle Minimized

Write-Host "  [OK] Server started (PID $($serverJob.Id))" -ForegroundColor Green

# ── Client ─────────────────────────────────────────────────────────────────────

Write-Host "`n==> Starting client (Vite dev server, port 5173)..." -ForegroundColor Cyan
$clientJob = Start-Process -FilePath "cmd" `
    -ArgumentList "/c npm run dev" `
    -WorkingDirectory "$Root\client" `
    -PassThru `
    -WindowStyle Minimized

Write-Host "  [OK] Client started (PID $($clientJob.Id))" -ForegroundColor Green

# ── Summary ────────────────────────────────────────────────────────────────────

Write-Host "`nApilix is starting up:" -ForegroundColor Yellow
Write-Host "  API    : http://localhost:3001"
Write-Host "  App    : http://localhost:5173"
Write-Host "`nRun .\status.ps1 to verify services are up." -ForegroundColor DarkGray
