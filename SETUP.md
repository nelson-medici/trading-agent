# SETUP · paso a paso

Orden completo desde repo vacío hasta primer trade en paper.

## Prerequisitos humanos (una vez)

Antes de tocar código:

- [ ] Cuenta GitHub — este repo ya lo creaste
- [ ] Cuenta Supabase (supabase.com) — plan Free
- [ ] Cuenta Vercel (vercel.com) — plan Hobby
- [ ] Cuenta Oracle Cloud (oracle.com/cloud/free) — Always Free Tier
- [ ] Cuenta Binance con KYC completo + 2FA activo
- [ ] Cuenta Telegram + bot creado vía @BotFather
- [ ] Cuenta Anthropic Console (console.anthropic.com) para API key
- [ ] Cuenta Groq (console.groq.com) para fallback LLM
- [ ] Cuenta Alpha Vantage (alphavantage.co) para noticias

Tiempo estimado: 60-90 min (mayormente KYC de Binance).

---

## Paso 1 · Supabase (30 min)

### 1.1 Crear proyecto
1. supabase.com → New project
2. Nombre: `trading-agent`
3. Región: la más cercana (para AR: `sa-east-1` San Pablo)
4. Password de la DB: guardar en 1Password o similar
5. Esperar ~2 min a que provisione

### 1.2 Correr migraciones
En Supabase Dashboard → SQL Editor:

1. Abrir `supabase/migrations/001_schema.sql` de este repo
2. Copiar TODO el contenido al SQL Editor
3. Run
4. Repetir con `002_rls.sql`
5. Repetir con `003_functions.sql`

### 1.3 Configurar Auth
1. Authentication → Providers → habilitar Email
2. Authentication → URL Configuration:
   - Site URL: `http://localhost:3000` (por ahora)
   - Después del deploy a Vercel: cambiar por la URL de Vercel

### 1.4 Anotar credenciales
En Project Settings → API:
- `Project URL` → `SUPABASE_URL`
- `anon public` key → `SUPABASE_ANON_KEY`
- `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY` (⚠️ nunca exponer al frontend)

### 1.5 Crear tu usuario
Authentication → Users → Add user → Create new user
- Email + password
- Después vas a loguearte con estos en el portal

---

## Paso 2 · Portal en Vercel (20 min)

### 2.1 Deploy inicial
1. Instalar dependencias localmente:
   ```bash
   cd portal
   npm install
   ```
2. Setup env local:
   ```bash
   cp .env.example .env.local
   ```
3. Editar `.env.local` con las credenciales de Supabase
4. Probar local:
   ```bash
   npm run dev
   ```
5. Abrir http://localhost:3000, loguearte con el user que creaste

### 2.2 Deploy a Vercel
1. vercel.com → Add New → Project
2. Importar el repo `trading-agent`
3. Root Directory: `portal`
4. Framework: Next.js (autodetectado)
5. Environment Variables: pegar las mismas del `.env.local`
6. Deploy
7. Anotar la URL (algo tipo `trading-agent-xyz.vercel.app`)
8. En Supabase → Auth → URL Config: agregar esa URL a Site URL

Ya tenés el portal accesible desde cualquier dispositivo.

---

## Paso 3 · VM en Oracle Cloud (45 min)

### 3.1 Crear VM
1. Oracle Cloud → Compute → Instances → Create
2. Shape: **VM.Standard.A1.Flex** (Always Free ARM)
3. 4 OCPUs, 24GB RAM (el máximo gratis)
4. Image: **Ubuntu 22.04**
5. Networking: Assign public IPv4
6. SSH keys: generar par o subir tu public key
7. Create → esperar ~3 min

### 3.2 Configurar firewall
En VCN → Security Lists → Default:
- Ingress: SSH (22) ya está
- Ingress: agregar 8000 TCP (para health endpoint) sólo desde tu IP
- Ingress: agregar 8501 TCP (dashboard local, opcional)

### 3.3 SSH y setup del engine
```bash
ssh ubuntu@<IP_PUBLICA>

# Instalar Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker

# Python 3.11
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y python3.11 python3.11-venv git

# Clonar el repo
git clone https://github.com/nelson-medici/trading-agent.git
cd trading-agent/engine

# Copiar env
cp .env.example .env
nano .env    # completar con TODAS las credenciales
```

### 3.4 Bootstrap
```bash
chmod +x scripts/bootstrap.sh
./scripts/bootstrap.sh
```

El script:
- Instala Poetry y dependencias
- Descarga histórico de OHLCV (~2 años, ~15 min)
- Corre tests unitarios
- Verifica conectividad con Supabase, Binance, LLM, Telegram
- Instala servicios systemd
- Deja el engine corriendo en modo dev (paper trading)

### 3.5 Verificar
```bash
systemctl status trading-engine
journalctl -u trading-engine -f
```

Deberías ver logs de ingesta y scoring. En el portal, la vista Overview debería empezar a poblar.

---

## Paso 4 · Primer día en modo dev

Sistema en modo dev = paper trading interno, sin tocar Binance ni siquiera testnet.

- Portal accesible desde tu teléfono
- Telegram bot recibe alertas
- Scoring corre cada hora
- No hay órdenes reales

Dejalo así **al menos 7 días**. Verificar que:
- No hay errores en logs
- Los scores son razonables (no todos 0, no todos 100)
- El portal se actualiza en tiempo real
- Podés cambiar configuración desde el portal y el engine la lee

---

## Paso 5 · Paso a Binance Testnet

Cuando confíes que el dev mode funciona:

1. Crear API keys en Binance Testnet: https://testnet.binance.vision/
2. Portal → Configuración → Ejecución → Broker: `binance_testnet`
3. Portal → Configuración → Secrets: pegar keys de testnet
4. Reiniciar engine: `sudo systemctl restart trading-engine`

Dejarlo otras 2-3 semanas. Ya hay órdenes reales contra el testnet.

---

## Paso 6 · Gate humano paper → live

Cuando cumplas:
- 21 días en testnet sin errores
- ≥10 trades ejecutados
- Métricas del reporte semanal razonables

Ejecutá el evaluador:
```bash
cd ~/trading-agent/engine
python -m src.cli.main eval-paper-phase
```

Si pasa, seguí runbook 03. Si no pasa, revisar qué falla y esperar otra semana.

---

## Paso 7 · Primer trade real

Solo después de pasar el gate:

1. Crear API keys en Binance **real** (permisos: Read + Spot Trading; Withdraw OFF; IP whitelist con la IP de la VM)
2. Fondear Binance con USD 200 vía P2P
3. Portal → Configuración → Ejecución → Broker: `binance`
4. Portal → Configuración → Ejecución → `confirmation_mode`: ON
5. Restart engine

Los siguientes 30-50 trades requieren tu confirmación por Telegram (/ok o /no).

Cuando la concordancia humano-sistema sea >85%, desactivás `confirmation_mode` y el sistema opera solo.

---

## Troubleshooting

Ver [docs/runbooks/](./docs/runbooks/) — cada archivo es un procedimiento paso a paso.
