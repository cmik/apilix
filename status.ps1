#Requires -Version 5.1
<#
.SYNOPSIS
    Shows the running status of Apilix services and performs a quick health check.
#>

$ErrorActionPreference = 'SilentlyContinue'

function Get-PortStatus {
    param([int]$Port, [string]$Label)
    $entries = netstat -ano | Select-String ":$Port\s.*LISTENING"
    if ($entries) {
        $pid_ = ($entries | Select-Object -First 1) -replace '.*\s(\d+)$', '$1'
        $proc = Get-Process -Id $pid_.Trim() -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.Name } else { "unknown" }
        Write-Host "  [UP]   $Label (port $Port) - PID $($pid_.Trim()) ($name)" -ForegroundColor Green
        return $true
    } else {
        Write-Host "  [DOWN] $Label (port $Port) - not listening" -ForegroundColor Red
        return $false
    }
}

Write-Host "`nAPILIX - Status" -ForegroundColor Yellow
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

$serverUp = Get-PortStatus -Port 3001 -Label "Server (API)"
$clientUp = Get-PortStatus -Port 5173 -Label "Client (Vite)"

# ── Health check ───────────────────────────────────────────────────────────────

if ($serverUp) {
    Write-Host ""
    Write-Host "  Health check -> http://localhost:3001/api/health" -ForegroundColor Cyan
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:3001/api/health" -TimeoutSec 5
        Write-Host "  [OK]   API responded: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] API health check failed: $_" -ForegroundColor Yellow
    }
}

Write-Host ""
