# Engine

Trading engine: workers Python asincrónicos que ingieren datos, calculan features, puntúan activos, deciden y ejecutan.

## Setup rápido

```bash
# 1. Instalar Poetry (si no lo tenés)
curl -sSL https://install.python-poetry.org | python3.11 -

# 2. Instalar deps
poetry install

# 3. Configurar env
cp .env.example .env
nano .env    # completar credenciales

# 4. Test de conectividad
poetry run python -m src.cli.main check-connections

# 5. Bootstrap completo
./scripts/bootstrap.sh
```

## Estructura

```
src/
├── core/          # config, db, logging, kill_switch, clock
├── data/          # ingesta OHLCV, noticias, macro
├── features/      # técnicas, sentimiento, régimen
├── scoring/       # scoring, confidence, state machine
├── portfolio/     # construction, allocation, correlation
├── risk/          # gate, stops, sizing, drawdown
├── execution/     # broker adapters, order manager, reconciler
├── monitoring/    # watchers, health
├── review/        # daily, weekly, LLM narrator
├── alerts/        # Telegram
├── orchestrator/  # scheduler, jobs, confirmation
└── cli/           # CLI: check-connections, backfill, eval-paper-phase, ...
```

## Ejecución

Modo desarrollo (foreground):
```bash
poetry run python -m src.cli.main run
```

Como servicio systemd:
```bash
sudo systemctl start trading-engine
sudo journalctl -u trading-engine -f
```

## Testing

```bash
poetry run pytest tests/unit -v
poetry run pytest tests/integration -v
poetry run pytest tests/property -v
poetry run pytest tests/chaos -v
```

## Comandos CLI útiles

```bash
python -m src.cli.main check-connections   # verificar APIs
python -m src.cli.main backfill --days 730 # cargar 2 años de OHLCV
python -m src.cli.main score               # correr scoring manual (dry-run)
python -m src.cli.main eval-paper-phase    # gate paper → live
python -m src.cli.main kill                # activar kill switch
python -m src.cli.main resume              # desactivar
python -m src.cli.main telegram-test       # ping al bot
```

Ver [../docs/runbooks/](../docs/runbooks/) para procedimientos operativos.
