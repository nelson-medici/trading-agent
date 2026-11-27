# Runbook 04 · Primeras órdenes reales

Tiempo: 1 min por op. Crítico.

## Formato de mensaje Telegram
```
DECISION d_abc123
BTC/USDT BUY @ ~67400
Score: 81 | Stop: 65100 | Target: 73800
Risk: $2.00 (1% equity)
Notional: $28.00
Justification: ...
Reply /ok d_abc123 or /no d_abc123
Timeout: 10 min
```

## Tu trabajo
1. Leer justificación
2. Mirar score y riesgos
3. Comparar con tu instinto
4. /ok si coincide razonablemente, /no si no
5. Si no respondés en 10 min → sistema descarta (failsafe)

## Cuándo decir /no
- Justificación no clara
- Riesgos parecen mayores
- Sabés algo que el sistema no ve

## Pasaje a auto
Después de 30-50 ops con concordancia >85%:
- Config → Confirmation mode: OFF
- Restart engine
