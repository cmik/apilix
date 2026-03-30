#Requires -Version 5.1
<#
.SYNOPSIS
    Creates a desktop shortcut to launch Apilix.
#>

$Root      = $PSScriptRoot
$Desktop   = [System.Environment]::GetFolderPath('Desktop')
$Shortcut  = Join-Path $Desktop 'Apilix.lnk'

$WshShell  = New-Object -ComObject WScript.Shell
$lnk       = $WshShell.CreateShortcut($Shortcut)

$lnk.TargetPath       = 'powershell.exe'
$lnk.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\start.ps1`""
$lnk.WorkingDirectory = $Root
$lnk.Description      = 'Start APILIX (server + client)'

# Use the Vite/Node icon if available, otherwise fall back to PowerShell's icon
$icoPath = Join-Path $Root 'apilix_new.ico'
if (Test-Path $icoPath) {
    $lnk.IconLocation = "$icoPath,0"
} else {
    $lnk.IconLocation = 'powershell.exe,0'
}

$lnk.Save()

Write-Host "`nShortcut created on your Desktop: $Shortcut" -ForegroundColor Green
Write-Host "Double-click 'APILIX' to start the app." -ForegroundColor Cyan
