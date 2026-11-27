# Trading Agent

Sistema cuantitativo autónomo de trading en cripto. Disciplinado, basado en datos, con gestión de riesgo estricta.

## Filosofía

- **Retorno ajustado por riesgo**, no ganancias absolutas
- **Preservación de capital** antes que rentabilidad
- **Cuando la certeza es baja, no operar es una decisión válida**
- Todas las decisiones son deterministas y auditables
- La IA enriquece features; no toma decisiones que muevan plata

## Arquitectura

```
┌──────────────────────────────────────────┐
│  Portal (Next.js on Vercel)              │
│  Dashboard + Config + Control            │
└────────────────┬─────────────────────────┘
                 │ HTTPS
                 ▼
┌──────────────────────────────────────────┐
│  Supabase                                │
│  Postgres + Auth + Realtime + REST       │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│  Engine (Python on Oracle Cloud VM)      │
│  Ingesta · Scoring · Risk · Ejecución    │
└────────────────┬─────────────────────────┘
                 │
                 ▼
              Binance API
```

## Estado del proyecto

Versión inicial 0.1.0 — MVP en fase de setup.

## Setup

Ver [SETUP.md](./SETUP.md) para instrucciones paso a paso.

Orden mínimo:
1. Setup de Supabase (schema + auth)
2. Deploy del Portal a Vercel
3. Provision de la VM en Oracle Cloud Free Tier
4. Deploy del Engine y bootstrap

## Componentes

| Path | Rol |
|------|-----|
| `portal/` | Next.js 14 · React · Tailwind · shadcn/ui |
| `engine/` | Python 3.11 · asyncio · CCXT · APScheduler |
| `supabase/` | Migraciones SQL · RLS · seeds |
| `docs/` | Runbooks operativos |
| `.github/` | CI: tests y linting |

## Configuración inicial (defaults)

- **Capital objetivo:** USD 200
- **Universo:** BTC/USDT, ETH/USDT
- **Broker:** Binance Spot (arranca en paper mode)
- **Modo:** Solo long, sin apalancamiento, sin shorts
- **LLM:** Claude Haiku (sentimiento) + Claude Sonnet (narrativa)
- **Timezone:** UTC en logs y schedules; portal muestra local

## Fases del proyecto

Ver [docs/runbooks/00-lifecycle.md](./docs/runbooks/00-lifecycle.md).

Fase actual: **0 — Setup**.

## Licencia

Uso personal. No es asesoría financiera.
