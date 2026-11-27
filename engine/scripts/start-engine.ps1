# scripts/start-engine.ps1
# Script para iniciar el engine con logging
$ErrorActionPreference = "Continue"
$logDir = Join-Path $PSScriptRoot "..\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$date = Get-Date -Format "yyyy-MM-dd"
$logFile = Join-Path $logDir "engine-$date.log"
Set-Location (Join-Path $PSScriptRoot "..")
poetry run python -m src.cli.main run *>&1 | Tee-Object -FilePath $logFile -Append
