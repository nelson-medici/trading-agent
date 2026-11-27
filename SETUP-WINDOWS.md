# SETUP · Windows (notebook local)

Guía específica para correr el engine en tu notebook Windows.
Portal (Vercel) y DB (Supabase) siguen en la nube.

## Pre-requisitos a instalar (una vez)

### 1. Python 3.11

Descargar: https://www.python.org/downloads/release/python-3119/
Archivo: "Windows installer (64-bit)"

Durante la instalación:
- ☑ **Add Python 3.11 to PATH** (crítico)
- ☑ Install for all users
- Click "Install Now"

Verificar en PowerShell:
```powershell
python --version
# Python 3.11.9
```

### 2. Git

Descargar: https://git-scm.com/download/win

Durante la instalación, dejar defaults salvo:
- Default editor: "Visual Studio Code" (si lo tenés) o Notepad++
- PATH: "Git from the command line and also from 3rd-party software"

Verificar:
```powershell
git --version
```

### 3. Poetry

En PowerShell:
```powershell
(Invoke-WebRequest -Uri https://install.python-poetry.org -UseBasicParsing).Content | python -
```

Agregar al PATH:
```powershell
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$env:APPDATA\Python\Scripts", "User")
```

**Cerrar y abrir PowerShell de nuevo.** Verificar:
```powershell
poetry --version
```

### 4. Node.js 20 (para el portal si lo corrés local)

Descargar: https://nodejs.org (LTS 20.x)

### 5. VS Code (opcional pero recomendado)

https://code.visualstudio.com

Extensiones: Python, Pylance, GitLens

---

## Paso 1 · Clonar el repo

```powershell
cd $env:USERPROFILE
mkdir dev -ErrorAction SilentlyContinue
cd dev
git clone https://github.com/nelson-medici/trading-agent.git
cd trading-agent
```

---

## Paso 2 · Supabase (idéntico a SETUP.md)

Ver el SETUP.md principal, Paso 1. Sin cambios.

---

## Paso 3 · Vercel (idéntico a SETUP.md)

Ver el SETUP.md principal, Paso 2. Sin cambios.

---

## Paso 4 · Engine en tu notebook

### 4.1 Configurar entorno

```powershell
cd engine
copy .env.example .env
notepad .env
```

Completar con todas las credenciales (Supabase, Binance keys cuando toque, Anthropic, Telegram).

### 4.2 Instalar dependencias

```powershell
poetry install
```

Esto tarda 3-5 min la primera vez.

### 4.3 Verificar conectividad

```powershell
poetry run python -m src.cli.main check-connections
```

Debería mostrar OK para: Supabase, Binance, Anthropic, Telegram.

### 4.4 Backfill histórico

```powershell
poetry run python -m src.cli.main backfill --days 730
```

Tarda ~10 min.

### 4.5 Correr tests

```powershell
poetry run pytest tests/unit -v
```

### 4.6 Arrancar el engine manual (para probar)

```powershell
poetry run python -m src.cli.main run
```

Dejalo corriendo. Verás logs en la consola. Ctrl+C para parar.

---

## Paso 5 · Configurar Windows para que no se suspenda

El engine necesita que la notebook esté despierta mientras tenés posiciones abiertas.

### 5.1 Plan de energía

1. Win+R → `powercfg.cpl` → Enter
2. "Elegir qué hace cerrar la tapa"
3. Cuando esté **conectado a la corriente**:
   - "Al cerrar la tapa": **No hacer nada**
   - "Suspender el equipo tras": **Nunca**
   - "Apagar la pantalla tras": 10 minutos (OK apagar pantalla, no suspender)

### 5.2 Permitir despertar la notebook por red (opcional)

Si querés poder "despertar" la notebook remoto desde otro dispositivo si se durmió:
- Administrador de dispositivos → Adaptador de red → Propiedades → Administración de energía
- ☑ "Permitir que este dispositivo reactive el equipo"

---

## Paso 6 · Arrancar engine como servicio al bootear

Para que arranque solo cuando prendés la notebook.

### Opción A — Task Scheduler (más simple)

1. Win+R → `taskschd.msc`
2. Crear tarea básica:
   - Nombre: **Trading Agent Engine**
   - Desencadenador: **Al iniciar sesión**
   - Acción: **Iniciar un programa**
   - Programa: `powershell.exe`
   - Argumentos: `-ExecutionPolicy Bypass -File "C:\Users\TU_USUARIO\dev\trading-agent\engine\scripts\start-engine.ps1"`
   - Iniciar en: `C:\Users\TU_USUARIO\dev\trading-agent\engine`

3. Propiedades avanzadas:
   - ☑ Ejecutar con los privilegios más altos
   - ☑ Configurar para Windows 10

### Opción B — NSSM (servicio Windows real)

Para correr como servicio aunque no haya sesión abierta:

```powershell
# Descargar NSSM
Invoke-WebRequest https://nssm.cc/release/nssm-2.24.zip -OutFile $env:TEMP\nssm.zip
Expand-Archive $env:TEMP\nssm.zip -DestinationPath $env:TEMP\nssm
Copy-Item $env:TEMP\nssm\nssm-2.24\win64\nssm.exe C:\Windows\System32\

# Instalar como servicio (PowerShell como admin)
nssm install TradingAgent "C:\Users\TU_USUARIO\AppData\Roaming\Python\Scripts\poetry.exe" "run python -m src.cli.main run"
nssm set TradingAgent AppDirectory "C:\Users\TU_USUARIO\dev\trading-agent\engine"
nssm set TradingAgent AppStdout "C:\Users\TU_USUARIO\dev\trading-agent\engine\logs\stdout.log"
nssm set TradingAgent AppStderr "C:\Users\TU_USUARIO\dev\trading-agent\engine\logs\stderr.log"
nssm start TradingAgent
```

Controles:
```powershell
nssm status TradingAgent
nssm restart TradingAgent
nssm stop TradingAgent
```

---

## Paso 7 · Ver logs

### Si usás Task Scheduler
Los logs van a la consola que se abre. No muy prácticos.
Mejorá creando `scripts/start-engine.ps1`:

```powershell
cd C:\Users\TU_USUARIO\dev\trading-agent\engine
poetry run python -m src.cli.main run *>&1 | Tee-Object -FilePath "logs\engine-$(Get-Date -Format 'yyyy-MM-dd').log" -Append
```

### Si usás NSSM
Logs en `C:\Users\TU_USUARIO\dev\trading-agent\engine\logs\`

Para ver en tiempo real:
```powershell
Get-Content -Path "logs\stdout.log" -Wait -Tail 50
```

---

## Paso 8 · Primer día en dev

- El engine debería estar corriendo
- Abrir el portal (https://tu-proyecto.vercel.app) desde el celular
- Login con el user de Supabase
- Verificar que Overview se actualiza con heartbeats cada minuto
- Si usás Telegram, deberías recibir el mensaje "check-connections OK"

Dejarlo 7 días en dev mode. No hay órdenes, solo observación.

---

## Comandos útiles del día a día

```powershell
# Ir al proyecto
cd $env:USERPROFILE\dev\trading-agent\engine

# Ver logs del engine (si usás NSSM)
Get-Content -Path "logs\stdout.log" -Wait -Tail 50

# Reiniciar engine
nssm restart TradingAgent
# o si usás Task Scheduler
Stop-Process -Name python -Force; Start-ScheduledTask -TaskName "Trading Agent Engine"

# Activar/desactivar kill switch
poetry run python -m src.cli.main kill
poetry run python -m src.cli.main resume

# Test de Telegram
poetry run python -m src.cli.main telegram-test

# Actualizar código del repo
git pull
poetry install  # si hubo cambios de deps
nssm restart TradingAgent
```

---

## Qué hacer cuando apagás la notebook

**Caso 1 — Aún en dev/paper**: nada, se apaga el engine, mañana lo prendés.

**Caso 2 — Con trades reales abiertos**: 
- Los stops están del lado de Binance, así que si el precio pega el stop se ejecutan igual
- Pero si el score baja o aparece una rotación mientras la notebook está apagada, el sistema no reacciona
- Solución: cerrar posiciones manualmente antes de apagar por mucho tiempo (vacaciones, viaje)
- O migrar a Oracle Cloud cuando llegues a esa fase

---

## Troubleshooting Windows típico

### "poetry no se reconoce como comando"
PATH no se actualizó. Cerrar PowerShell, abrir nuevo. Si persiste:
```powershell
$env:Path += ";$env:APPDATA\Python\Scripts"
```

### "Python no se reconoce"
No tildaste "Add to PATH" al instalar. Reinstalar o agregar manual:
```powershell
$env:Path += ";C:\Users\TU_USUARIO\AppData\Local\Programs\Python\Python311"
```

### "ExecutionPolicy prohíbe ejecutar scripts"
En PowerShell admin:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### CCXT falla con error de SSL
Windows a veces tiene cert store desactualizado:
```powershell
poetry run pip install --upgrade certifi
```

### El engine se cae al suspender la notebook
Normal. Cuando reactivás, reiniciar el engine (automático si está como servicio NSSM).

### Firewall bloquea conexiones
Permitir Python en Windows Defender Firewall:
- Panel de control → Sistema y seguridad → Firewall → Permitir una aplicación
- Buscar python.exe y habilitar privado+público
