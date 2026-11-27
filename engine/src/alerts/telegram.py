"""Alertas via Telegram Bot."""
import httpx
import structlog
from src.core.config import get_env

log = structlog.get_logger()


async def send_message(text: str, parse_mode: str = "Markdown") -> bool:
    env = get_env()
    if not env.telegram_bot_token or not env.telegram_chat_id:
        log.warning("telegram_not_configured")
        return False
    url = f"https://api.telegram.org/bot{env.telegram_bot_token}/sendMessage"
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            r = await client.post(url, json={
                "chat_id": env.telegram_chat_id,
                "text": text,
                "parse_mode": parse_mode,
            })
            return r.status_code == 200
        except Exception as e:
            log.error("telegram_send_failed", error=str(e))
            return False


async def alert_info(title: str, message: str) -> None:
    await send_message(f"ℹ️ *{title}*\n{message}")


async def alert_warn(title: str, message: str) -> None:
    await send_message(f"⚠️ *{title}*\n{message}")


async def alert_critical(title: str, message: str) -> None:
    await send_message(f"🚨 *{title}*\n{message}")
