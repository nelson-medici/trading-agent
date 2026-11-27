# Runbook 03 · Paper Gate Review

Tiempo: 30 min. Crítico.

## Pre-requisitos
- ≥21 días en paper (testnet)
- ≥10 trades ejecutados
- Sin errores críticos últimas 72h

## Pasos

1. Ejecutar evaluador:
   ```bash
   cd /opt/trading-agent/engine
   poetry run python -m src.cli.main eval-paper-phase
   ```
2. Revisar cualitativamente los últimos 10 trades:
   - Justificaciones tienen sentido
   - Entradas en condiciones que vos aprobarías
3. Si pasa:
   - Portal → Config → Ejecución → Broker: `binance`, Confirmation mode: ON
   - Bajar risk_per_trade a 0.5% temporalmente
   - Restart engine
4. Si no pasa: otra semana en paper, identificar qué falla
