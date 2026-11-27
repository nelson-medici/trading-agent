# Ciclo de vida del sistema

## Fases

| Fase | Estado | Duración estimada | Gate al final |
|------|--------|-------------------|---------------|
| 0 | Setup | 1 día | Servicios up |
| 1 | Dev / Read-only | 7 días | Sin errores, dashboard OK |
| 2 | Paper (Binance testnet) | 3-4 semanas | Métricas mínimas + reconciliación 99% |
| 3 | Hardening | 1 semana | Sobrevive stress tests |
| 4 | Gate humano | 1 día | Decisión: pasa a real o itera |
| 5 | Real con confirmación | 30-50 trades | Concordancia humano-sistema >85% |
| 6 | Real auto | continua | Revisión semanal |

## Objetivos por fase

**Fase 0 (Setup):** todos los servicios corriendo, conectividad verificada.

**Fase 1 (Dev):** el sistema ingiere datos, calcula features, puntúa y decide, pero NO ejecuta órdenes reales ni testnet. Solo dry-run.

**Fase 2 (Paper):** ejecuta órdenes contra Binance testnet. Se acumulan datos reales de decisiones y outcomes. Se mide performance.

**Fase 3 (Hardening):** se inducen fallos (API caída, DB desconectada, orden parcial) para verificar que el sistema los maneja.

**Fase 4 (Gate humano):** el operador revisa métricas y decide si pasa a real. Sin este gate, no hay live.

**Fase 5 (Real con confirmación):** primeras 30-50 operaciones en Binance real, cada una requiere `/ok` o `/no` por Telegram.

**Fase 6 (Auto):** el sistema opera solo dentro de límites duros. Kill switch armado, DD limits activos.

