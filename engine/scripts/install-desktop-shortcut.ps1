# install-desktop-shortcut.ps1
# Crea un acceso directo "Quant.Agent · Engine" en el escritorio del usuario.
# Apunta a launch-engine.ps1 y usa quant-agent.ico como ícono.
# Corré esto UNA sola vez desde: C:\development\trading-agent\engine\scripts\
#
# Uso:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\install-desktop-shortcut.ps1

$ErrorActionPreference = "Stop"

$scriptsDir = $PSScriptRoot
$launcher   = Join-Path $scriptsDir "launch-engine.ps1"
$iconPath   = Join-Path $scriptsDir "quant-agent.ico"

if (-not (Test-Path $launcher)) { throw "No encuentro launch-engine.ps1 en $scriptsDir" }
if (-not (Test-Path $iconPath)) { throw "No encuentro quant-agent.ico en $scriptsDir" }

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Quant.Agent Engine.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)

# Ejecuta PowerShell con política relajada SOLO para este proceso y lanza el .ps1
$sc.TargetPath       = "powershell.exe"
$sc.Arguments        = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$sc.WorkingDirectory = (Resolve-Path (Join-Path $scriptsDir "..")).Path
$sc.IconLocation     = "$iconPath,0"
$sc.Description      = "Iniciar el engine del agente cuantitativo"
$sc.WindowStyle      = 1   # Normal window
$sc.Save()

Write-Host ""
Write-Host "Acceso directo creado:" -ForegroundColor Green
Write-Host "  $shortcutPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Doble-click al ícono del escritorio para arrancar el engine." -ForegroundColor Gray
