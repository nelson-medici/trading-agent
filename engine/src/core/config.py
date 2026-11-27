"""
Configuración del engine.

Combina:
- Variables de entorno (secrets, endpoints)
- Config en Supabase (parámetros de estrategia, editables en vivo desde el portal)
"""
from functools import lru_cache
from typing import Any, Literal
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EnvSettings(BaseSettings):
    """Configuración que viene solo de env vars (secrets, endpoints)."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # System
    env: Literal["dev", "paper", "live"] = "dev"
    log_level: str = "INFO"
    timezone: str = "UTC"

    # Supabase
    supabase_url: str = ""
    supabase_service_role_key: str = ""

    # Binance
    binance_api_key: str = ""
    binance_api_secret: str = ""
    binance_testnet_api_key: str = ""
    binance_testnet_api_secret: str = ""

    # LLM
    anthropic_api_key: str = ""
    groq_api_key: str = ""
    openai_api_key: str = ""

    # News
    alpha_vantage_key: str = ""
    finnhub_key: str = ""

    # Telegram
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""


@lru_cache(maxsize=1)
def get_env() -> EnvSettings:
    """Singleton de configuración de env."""
    return EnvSettings()


class DBConfig:
    """
    Config leída de Supabase (tabla `config`).
    Se refresca periódicamente para permitir cambios en vivo desde el portal.
    """

    def __init__(self, db_client):
        self.db = db_client
        self._cache: dict[str, Any] = {}
        self._last_refresh = None

    async def refresh(self) -> None:
        """Recarga toda la config desde la DB."""
        result = await self.db.select("config", ["key", "value"])
        self._cache = {row["key"]: row["value"] for row in result}
        from datetime import datetime
        self._last_refresh = datetime.utcnow()

    def get(self, key: str, default: Any = None) -> Any:
        """Obtener un valor. Si no hay cache, retorna default."""
        return self._cache.get(key, default)

    # Accessors tipados con defaults sensatos
    @property
    def weights(self) -> dict:
        return self.get("strategy.weights", {
            "technical": 0.40, "fundamental": 0.20,
            "sentiment": 0.15, "risk": 0.15, "timing": 0.10,
        })

    @property
    def thresholds(self) -> dict:
        return self.get("strategy.thresholds", {
            "ignore_below": 60, "watchlist": 60,
            "candidate": 75, "aggressive": 85,
        })

    @property
    def confidence(self) -> dict:
        return self.get("strategy.confidence", {
            "required_signals": 3, "sustained_periods": 2,
        })

    @property
    def risk_limits(self) -> dict:
        return self.get("risk.limits", {
            "max_risk_per_trade_pct": 0.01,
            "max_position_pct": 0.20,
            "max_position_btc_eth_pct": 0.30,
            "max_class_exposure_pct": 0.60,
            "max_open_positions": 2,
            "min_position_size_usd": 15,
        })

    @property
    def drawdown_limits(self) -> dict:
        return self.get("risk.drawdown", {
            "daily_pause_pct": 0.05,
            "weekly_conservative_pct": 0.08,
            "total_kill_pct": 0.12,
        })

    @property
    def stops(self) -> dict:
        return self.get("risk.stops", {
            "atr_stop_multiplier": 2.0,
            "atr_target_multiplier": 4.0,
            "min_profit_to_commission_ratio": 3.0,
        })

    @property
    def broker_config(self) -> dict:
        return self.get("execution.broker", {
            "broker": "paper",
            "commission_per_side_pct": 0.001,
            "slippage_pct": 0.0005,
            "order_type": "limit",
            "limit_offset_bps": 5,
            "fill_timeout_seconds": 60,
            "max_retries": 3,
        })

    @property
    def confirmation_mode(self) -> dict:
        return self.get("execution.confirmation", {
            "mode": False, "timeout_minutes": 10,
        })

    @property
    def universe(self) -> list[str]:
        return self.get("universe.crypto", ["BTC/USDT", "ETH/USDT"])

    @property
    def excluded_keywords(self) -> list[str]:
        return self.get("universe.excluded_keywords", [
            "meme", "shib", "doge", "pepe", "inu", "moon",
        ])

    @property
    def llm_sentiment(self) -> dict:
        return self.get("llm.sentiment", {
            "provider": "anthropic",
            "model": "claude-haiku-4-5",
            "max_tokens": 512,
            "temperature": 0.0,
            "cache_enabled": True,
        })

    @property
    def llm_narrative(self) -> dict:
        return self.get("llm.narrative", {
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "max_tokens": 1024,
            "temperature": 0.2,
            "cache_enabled": False,
        })
