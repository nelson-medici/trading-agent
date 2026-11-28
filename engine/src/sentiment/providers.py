"""
Implementaciones concretas del SentimentProvider.

Cada una produce SentimentSignal con el mismo formato.
El engine usa la que esté configurada.
"""
from .provider import SentimentProvider, SentimentSignal
import structlog

log = structlog.get_logger()


# ------------------------------------------------------------------
# 1. MANUAL — lee señales insertadas manualmente (desde el portal,
#    conversaciones con Claude, o cualquier fuente externa)
# ------------------------------------------------------------------

class ManualProvider(SentimentProvider):
    """
    No genera señales — solo lee las que ya están en la DB.
    Las señales se insertan desde:
    - Portal (UI de sentimiento)
    - Conversaciones con Claude (copy-paste)
    - API directa a Supabase
    """

    async def fetch_signals(self, symbols: list[str]) -> list[SentimentSignal]:
        return []  # No genera — solo lee de la DB

    def name(self) -> str:
        return "manual"


# ------------------------------------------------------------------
# 2. NULL — no hace nada (default cuando no hay provider configurado)
# ------------------------------------------------------------------

class NullProvider(SentimentProvider):
    """Provider vacío — retorna siempre neutral."""

    async def fetch_signals(self, symbols: list[str]) -> list[SentimentSignal]:
        return []

    def name(self) -> str:
        return "null"


# ------------------------------------------------------------------
# 3. LLM API — llama a un LLM para analizar noticias
# ------------------------------------------------------------------

class LLMProvider(SentimentProvider):
    """
    Llama a un LLM (Groq, OpenAI, Anthropic) para analizar sentimiento.

    Configuración via env vars:
      SENTIMENT_LLM_PROVIDER=groq|openai|anthropic
      SENTIMENT_LLM_API_KEY=...
      SENTIMENT_LLM_MODEL=llama-3.3-70b-versatile (default)

    El LLM recibe un prompt con noticias recientes y devuelve
    un JSON con score, impact, modifier y event.
    """

    def __init__(self):
        import os
        self.provider = os.getenv("SENTIMENT_LLM_PROVIDER", "groq")
        self.api_key = os.getenv("SENTIMENT_LLM_API_KEY", os.getenv("GROQ_API_KEY", ""))
        self.model = os.getenv("SENTIMENT_LLM_MODEL", "llama-3.3-70b-versatile")

    async def fetch_signals(self, symbols: list[str]) -> list[SentimentSignal]:
        if not self.api_key:
            log.warning("llm_provider_no_api_key")
            return []

        signals = []
        for symbol in symbols[:5]:  # limit to avoid rate limits
            try:
                signal = await self._analyze_symbol(symbol)
                if signal:
                    signals.append(signal)
            except Exception as e:
                log.error("llm_sentiment_error", symbol=symbol, error=str(e))

        return signals

    async def _analyze_symbol(self, symbol: str) -> SentimentSignal | None:
        """Llama al LLM para analizar sentimiento de un símbolo."""
        import json

        prompt = f"""Analiza el sentimiento actual del mercado para {symbol}.

Responde SOLO con un JSON válido (sin markdown, sin texto extra):
{{
  "score": <float -1.0 a 1.0>,
  "impact": "<critical|high|moderate|low>",
  "modifier": <int -100 a 100>,
  "event": "<descripción breve del evento/contexto actual>",
  "reasoning": "<1 línea de justificación>"
}}

Reglas:
- score: -1.0 = extremo bearish, 0 = neutral, 1.0 = extremo bullish
- impact: critical solo para eventos que pueden mover el precio >5%
- modifier: cuánto ajustar la decisión (-100 = no operar, +100 = máxima convicción)
- Si no hay noticias relevantes, responder con score 0, impact "low", modifier 0
"""

        if self.provider == "groq":
            response = await self._call_groq(prompt)
        else:
            log.warning("llm_provider_not_supported", provider=self.provider)
            return None

        if not response:
            return None

        try:
            data = json.loads(response)
            return SentimentSignal(
                symbol=symbol,
                score=float(data.get("score", 0)),
                impact=data.get("impact", "low"),
                modifier=int(data.get("modifier", 0)),
                source="llm_api",
                event=data.get("event", "LLM analysis"),
                metadata={"model": self.model, "reasoning": data.get("reasoning", "")},
                ttl_hours=4,  # LLM signals expire faster
            )
        except (json.JSONDecodeError, ValueError) as e:
            log.error("llm_parse_error", raw=response[:200], error=str(e))
            return None

    async def _call_groq(self, prompt: str) -> str | None:
        """Llama a Groq API."""
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.3,
                        "max_tokens": 200,
                    },
                    timeout=15,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
                else:
                    log.error("groq_api_error", status=resp.status_code, body=resp.text[:200])
                    return None
        except Exception as e:
            log.error("groq_call_failed", error=str(e))
            return None

    def name(self) -> str:
        return f"llm_{self.provider}"


# ------------------------------------------------------------------
# FACTORY: obtener el provider configurado
# ------------------------------------------------------------------

def get_sentiment_provider() -> SentimentProvider:
    """
    Retorna el provider de sentimiento configurado.

    Configuración via env var SENTIMENT_PROVIDER:
      - "manual" (default): solo lee de la DB
      - "llm": usa LLM API
      - "null": no hace nada

    Futuras implementaciones:
      - "script": RSS feeds + reglas estáticas
      - "custom_model": modelo propio
    """
    import os
    provider_name = os.getenv("SENTIMENT_PROVIDER", "manual")

    if provider_name == "llm":
        return LLMProvider()
    elif provider_name == "manual":
        return ManualProvider()
    else:
        return NullProvider()
