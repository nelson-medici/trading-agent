# Runbook 06 · Broker Outage

## Detección
- Telegram: "broker errors threshold reached"
- Portal: broker status en rojo
- Reconciliación fallando

## Pasos
1. binance.com/en/support/announcement — ¿hay incident?
2. `curl https://api.binance.com/api/v3/ping`
3. Si Binance: esperar, no hacer nada. Kill switch se auto-activa a los 5 errores
4. Si es local (IP/key):
   - Verificar IP whitelist (¿cambió IP de la VM?)
   - Verificar API key no expiró
   - Verificar cuenta no restringida

## Mientras tanto
- Posiciones tienen stops del lado del broker
- No abrimos nuevas
- Logs siguen

## Recuperación
```bash
poetry run python -m src.cli.main resume  # si el kill fue por broker
sudo systemctl restart trading-engine
```
