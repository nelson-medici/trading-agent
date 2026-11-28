"""
Sentiment Provider — contrato fijo de I/O.

Cualquier implementación debe producir SentimentSignal(s) con el mismo formato.
El engine no sabe ni le importa quién genera el sentimiento:

  Fase 1: ManualProvider     → lee de la DB (cargado desde conversaciones o portal)
  Fase 2: ScriptProvider     → RSS feeds, scraping, reglas estáticas
  Fase 3: LLMProvider        → API call a Groq/OpenAI/Anthropic
  Fase 4: CustomModelProvider → modelo propio fine-tuned

Todas escriben a la tabla `sentiment_signals` con el mismo schema.
El engine lee de ahí — es un bus de datos desacoplado.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal
from datetime import datetime, timezone
import structlog

log = structlog.get_logger()


# ------------------------------------------------------------------
# Contrato de datos (INPUT/OUTPUT fijo)
# ------------------------------------------------------------------

@dataclass
class SentimentSignal:
    """Output estandarizado de cualquier provider de sentimiento."""

    symbol: str | None          # None = mercado general
    score: float                # -1.0 (bearish extremo) a +1.0 (bullish extremo)
    impact: Literal["critical", "high", "moderate", "low"]
    modifier: int               # -100 a +100 — ajuste al score contextual
    source: str                 # "manual", "conversation", "script", "llm_api", "custom_model", "feed"
    event: str                  # descripción del evento
    metadata: dict              # datos extra libres de la fuente
    ttl_hours: float = 24       # cuántas horas es válida la señal

    def to_db_row(self) -> dict:
        """Convierte a fila para Supabase."""
        return {
            "symbol": self.symbol,
            "score": self.score,
            "impact": self.impact,
            "modifier": self.modifier,
            "source": self.source,
            "event": self.event,
            "metadata": self.metadata,
            "expires_at": datetime.fromtimestamp(
                datetime.now(timezone.utc).timestamp() + self.ttl_hours * 3600,
                tz=timezone.utc,
            ).isoformat(),
            "status": "active",
            "created_by": self.source,
        }


# ------------------------------------------------------------------
# Provider ABC — el contrato que toda implementación cumple
# ------------------------------------------------------------------

class SentimentProvider(ABC):
    """Interface que todo provider de sentimiento debe implementar."""

    @abstractmethod
    async def fetch_signals(self, symbols: list[str]) -> list[SentimentSignal]:
        """
        Genera señales de sentimiento para los símbolos dados.
        Puede devolver lista vacía si no hay señales relevantes.
        """
        ...

    @abstractmethod
    def name(self) -> str:
        """Nombre del provider para logging."""
        ...


# ------------------------------------------------------------------
# Reader: lee sentimiento activo de la DB (agnóstico de la fuente)
# ------------------------------------------------------------------

async def get_active_sentiment(db, symbol: str | None = None) -> list[dict]:
    """Lee señales de sentimiento activas (no expiradas) de la DB."""
    from datetime import datetime, timezone

    filters: dict = {"status": "active"}
    if symbol:
        # Señales específicas del símbolo + señales generales (symbol IS NULL)
        rows = await db.select("sentiment_signals", filters={"status": "active"})
        if not rows:
            return []
        now = datetime.now(timezone.utc).isoformat()
        return [
            r for r in rows
            if (r.get("symbol") is None or r.get("symbol") == symbol)
            and (r.get("expires_at", "") > now)
        ]

    rows = await db.select("sentiment_signals", filters=filters)
    if not rows:
        return []

    now = datetime.now(timezone.utc).isoformat()
    return [r for r in rows if r.get("expires_at", "") > now]


def compute_sentiment_modifier(signals: list[dict]) -> tuple[int, str]:
    """
    Combina múltiples señales de sentimiento en un modifier único.

    Retorna (modifier, reason):
      modifier: -100 a +100
      reason: texto explicativo
    """
    if not signals:
        return 0, ""

    # Ponderar por impacto
    weights = {"critical": 4, "high": 2, "moderate": 1, "low": 0.5}
    weighted_sum = 0
    total_weight = 0

    for s in signals:
        w = weights.get(s.get("impact", "low"), 0.5)
        mod = int(s.get("modifier", 0))
        weighted_sum += mod * w
        total_weight += w

    if total_weight == 0:
        return 0, ""

    modifier = int(weighted_sum / total_weight)
    modifier = max(-100, min(100, modifier))

    # Resumen
    critical = [s for s in signals if s.get("impact") == "critical"]
    if critical:
        reason = f"🔴 {critical[0].get('event', '?')}"
    elif modifier > 20:
        reason = f"🟢 Sentimiento positivo ({len(signals)} señales)"
    elif modifier < -20:
        reason = f"🔴 Sentimiento negativo ({len(signals)} señales)"
    else:
        reason = f"Sentimiento neutral ({len(signals)} señales)"

    return modifier, reason
