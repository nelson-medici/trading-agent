#!/usr/bin/env bash
# Bootstrap del engine en la VM.
set -euo pipefail

echo "==> Trading agent engine bootstrap"

if [ ! -f .env ]; then
    echo "ERROR: .env no existe. Copiá .env.example y completá con tus credenciales."
    exit 1
fi

# 1. Poetry
if ! command -v poetry >/dev/null; then
    curl -sSL https://install.python-poetry.org | python3.11 -
    export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> Instalando dependencias..."
poetry install

# 2. Verificar conectividad
echo "==> Verificando conexiones..."
poetry run python -m src.cli.main check-connections

# 3. Backfill de histórico
echo "==> Backfill 2 años de OHLCV (puede tardar ~10 min)..."
poetry run python -m src.cli.main backfill --days 730

# 4. Tests
echo "==> Corriendo tests..."
poetry run pytest tests/unit -v

# 5. Systemd service
if [ -w /etc/systemd/system ]; then
    echo "==> Instalando systemd service..."
    sudo tee /etc/systemd/system/trading-engine.service > /dev/null <<SEOF
[Unit]
Description=Trading Agent Engine
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which poetry) run python -m src.cli.main run
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SEOF
    sudo systemctl daemon-reload
    sudo systemctl enable trading-engine
    sudo systemctl start trading-engine
    echo "==> Engine iniciado. Ver logs con: journalctl -u trading-engine -f"
else
    echo "==> Sin permisos para systemd. Correr manual: poetry run python -m src.cli.main run"
fi

# 6. Test Telegram
poetry run python -m src.cli.main telegram-test

echo ""
echo "==> Bootstrap completado."
