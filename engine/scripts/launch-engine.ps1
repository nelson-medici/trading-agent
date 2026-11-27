# launch-engine.ps1
# Wrapper amigable para lanzar el engine desde el acceso directo del escritorio.
# - Muestra un banner con el estado del repo
# - Hace git pull para traer cambios recientes
# - Levanta el scheduler con logging
# - Deja la ventana abierta si falla, para poder leer el error

$ErrorActionPreference = "Continue"

$Host.UI.RawUI.WindowTitle = "Quant.Agent · Engine"

# Colores ANSI (PowerShell 7+; en 5.1 se ignoran)
function Banner($text, $color = "Green") {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor DarkGray
    Write-Host "  $text" -ForegroundColor $color
    Write-Host "============================================================" -ForegroundColor DarkGray
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$engineRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Banner "QUANT.AGENT :: ENGINE"
Write-Host "  Repo:   $repoRoot"
Write-Host "  Engine: $engineRoot"
Write-Host ""

# 1) Pull de cambios
Set-Location $repoRoot
Write-Host "[1/3] git pull..." -ForegroundColor Cyan
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
    Write-Host "  (!) git pull falló; continuando con la versión local" -ForegroundColor Yellow
}

# 2) Instalar dependencias si cambió pyproject
Set-Location $engineRoot
Write-Host ""
Write-Host "[2/3] poetry install (solo si hay cambios)..." -ForegroundColor Cyan
poetry install --no-interaction --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "  (!) poetry install falló" -ForegroundColor Red
    Read-Host "Presioná Enter para salir"
    exit 1
}

# 3) Arrancar engine
Write-Host ""
Write-Host "[3/3] Iniciando scheduler..." -ForegroundColor Cyan
Write-Host "      (Ctrl+C para frenar · los logs van a engine\logs\)" -ForegroundColor DarkGray
Write-Host ""

& (Join-Path $PSScriptRoot "start-engine.ps1")

# Si el engine terminó, dejamos la ventana abierta para leer el error
Write-Host ""
Write-Host "El engine terminó." -ForegroundColor Yellow
Read-Host "Presioná Enter para cerrar la ventana"
