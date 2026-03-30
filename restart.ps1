#Requires -Version 5.1
<#
.SYNOPSIS
    Stops any running Apilix processes (server on :3001, Vite dev server on :5173)
    then starts them again.
#>

$Root = $PSScriptRoot

# Re-use stop logic
& "$Root\stop.ps1"

Start-Sleep -Milliseconds 500

# Re-use start logic
& "$Root\start.ps1"
