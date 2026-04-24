#Requires -Version 5.1
<#
.SYNOPSIS
    Installs all dependencies for the Apilix application.
#>

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }

Write-Host "`nAPILIX - Install" -ForegroundColor Yellow
Write-Host "Root: $Root"

# ── Check prerequisites ────────────────────────────────────────────────────────

Write-Step "Checking prerequisites"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js is not installed. Please install it from https://nodejs.org"
    exit 1
}
Write-OK "Node.js $(node --version)"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail "npm is not installed."
    exit 1
}
Write-OK "npm $(npm --version)"

# ── Root dependencies ──────────────────────────────────────────────────────────

Write-Step "Installing root dependencies"
Set-Location $Root
npm install
if ($LASTEXITCODE -ne 0) { Write-Fail "Root npm install failed"; exit 1 }
Write-OK "Root dependencies installed"

# ── Done ───────────────────────────────────────────────────────────────────────

Set-Location $Root
Write-Host "`nInstallation complete. Run .\start.ps1 to launch Apilix." -ForegroundColor Green
