# Runbook 05 · Kill Switch Recovery

Crítico.

## Causas
- DD total >12% (automático)
- 5 errores broker consecutivos
- Reconciliación fallida >1h
- Activación manual

## Pasos
1. NO desactivar inmediatamente
2. `journalctl -u trading-engine --since "24 hours ago" | grep -E "ERROR|CRITICAL"`
3. Revisar tabla `decisions` últimas 48h
4. Revisar `alerts` últimos días
5. Diagnóstico:
   - Régimen: ajustar pesos, NO resetear DD aún
   - Bug: fix + test + deploy
   - Estrategia: parar, volver a backtest
6. Después de fix:
   - Portal → Control → Reanudar (con confirmación)
   - O CLI: `poetry run python -m src.cli.main resume`
7. Postmortem en Notion
