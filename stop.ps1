#Requires -Version 5.1
<#
.SYNOPSIS
    Stops the Apilix server (:3001) and Vite dev client (:5173).
#>

$ErrorActionPreference = 'SilentlyContinue'

function Stop-Port {
    param([int]$Port, [string]$Label)
    $pids = (netstat -ano | Select-String ":$Port\s") |
            ForEach-Object { ($_ -split '\s+')[-1] } |
            Where-Object { $_ -match '^\d+$' } |
            Sort-Object -Unique

    if (-not $pids) {
        Write-Host "  [--] $Label (port $Port) - not running" -ForegroundColor DarkGray
        return
    }

    foreach ($id in $pids) {
        try {
            Stop-Process -Id $id -Force
            Write-Host "  [OK] $Label (port $Port) - stopped PID $id" -ForegroundColor Green
        } catch {
            Write-Host "  [WARN] Could not stop PID $id : $_" -ForegroundColor Yellow
        }
    }
}

Write-Host "`nAPILIX - Stop" -ForegroundColor Yellow

Stop-Port -Port 3001 -Label "Server"
Stop-Port -Port 5173 -Label "Client (Vite)"

Write-Host "`nDone." -ForegroundColor Green
