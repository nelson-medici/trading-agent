"""
Análisis de sentimiento con LLM.
Toma noticias y retorna JSON estructurado con sentiment, materiality, etc.

Soporta dos providers:
- "groq" (default, gratis) → Llama 3.3 70B
- "anthropic" → Claude Haiku

Se configura en Supabase config.llm.sentiment
"""
import json
import asyncio
import structlog
from src.core.config import get_env

log = structlog.get_logger()

PROMPT_TEMPLATE = """Analizá la siguiente noticia sobre {symbol}. Devolvé SOLO JSON válido, sin texto adicional:
{{
  "sentiment": <float -1 a 1>,
  "materiality": <float 0 a 1, qué tan probable es que mueva el precio>,
  "horizon": "intraday" | "days" | "weeks" | "months",
  "themes": [<máx 3 strings>],
  "is_rumor": <bool>,
  "summary": "<máx 200 caracteres>"
}}

No inventes datos. Si la noticia es ambigua, materiality baja.

Noticia:
{text}"""


class SentimentAnalyzer:
    """
    provider: "groq" o "anthropic"
    model: nombre del modelo según provider
      - groq: "llama-3.3-70b-versatile" (default) o "llama-3.1-8b-instant" (más rápido)
      - anthropic: "claude-haiku-4-5"
    """

    def __init__(
        self,
        provider: str = "groq",
        model: str | None = None,
    ):
        env = get_env()
        self.provider = provider.lower()

        if self.provider == "groq":
            from groq import AsyncGroq
            self.client = AsyncGroq(api_key=env.groq_api_key)
            self.model = model or "llama-3.3-70b-versatile"
        elif self.provider == "anthropic":
            from anthropic import AsyncAnthropic
            self.client = AsyncAnthropic(api_key=env.anthropic_api_key)
            self.model = model or "claude-haiku-4-5"
        else:
            raise ValueError(f"Unsupported LLM provider: {provider}")

    async def analyze(self, symbol: str, text: str) -> dict:
        prompt = PROMPT_TEMPLATE.format(symbol=symbol, text=text[:2000])

        try:
            if self.provider == "groq":
                response = await self.client.chat.completions.create(
                    model=self.model,
                    max_tokens=512,
                    temperature=0.0,
                    messages=[{"role": "user", "content": prompt}],
                    response_format={"type": "json_object"},
                )
                content = response.choices[0].message.content.strip()
            else:
                response = await self.client.messages.create(
                    model=self.model,
                    max_tokens=512,
                    temperature=0.0,
                    messages=[{"role": "user", "content": prompt}],
                )
                content = response.content[0].text.strip()

            if content.startswith("```"):
                content = content.split("```")[1]
                if content.startswith("json"):
                    content = content[4:]

            data = json.loads(content)
            return {
                "sentiment": float(data.get("sentiment", 0)),
                "materiality": float(data.get("materiality", 0)),
                "horizon": data.get("horizon", "days"),
                "themes": data.get("themes", [])[:3],
                "is_rumor": bool(data.get("is_rumor", False)),
                "summary": data.get("summary", "")[:200],
            }
        except json.JSONDecodeError as e:
            log.warning("sentiment_json_parse_failed", error=str(e))
            return {}
        except Exception as e:
            log.error("sentiment_llm_failed", error=str(e), provider=self.provider)
            return {}

    async def batch_analyze(self, items: list[tuple[str, str]]) -> list[dict]:
        results = await asyncio.gather(
            *[self.analyze(sym, txt) for sym, txt in items],
            return_exceptions=True,
        )
        return [r if isinstance(r, dict) else {} for r in results]
