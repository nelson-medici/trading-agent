"""
Análisis de sentimiento con LLM.
Toma noticias y retorna JSON estructurado con sentiment, materiality, etc.
"""
import json
import asyncio
from anthropic import AsyncAnthropic
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
    def __init__(self, model: str = "claude-haiku-4-5"):
        env = get_env()
        self.client = AsyncAnthropic(api_key=env.anthropic_api_key)
        self.model = model

    async def analyze(self, symbol: str, text: str) -> dict:
        prompt = PROMPT_TEMPLATE.format(symbol=symbol, text=text[:2000])
        try:
            response = await self.client.messages.create(
                model=self.model,
                max_tokens=512,
                temperature=0.0,
                messages=[{"role": "user", "content": prompt}],
            )
            content = response.content[0].text.strip()
            # Sacar posibles code fences
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
            log.error("sentiment_llm_failed", error=str(e))
            return {}

    async def batch_analyze(self, items: list[tuple[str, str]]) -> list[dict]:
        results = await asyncio.gather(
            *[self.analyze(sym, txt) for sym, txt in items],
            return_exceptions=True,
        )
        return [r if isinstance(r, dict) else {} for r in results]
