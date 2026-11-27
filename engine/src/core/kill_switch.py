"""
Kill switch: detiene toda operación nueva.

Triggers:
- Manual (comando /kill por Telegram o botón en portal)
- Automático (drawdown > 12%, errores broker consecutivos, etc.)

Al activarse:
- No se abren nuevas posiciones
- Las existentes siguen sus stops/targets
- Alerta CRITICAL a Telegram
- Requiere intervención humana para reanudar
"""
from datetime import datetime
from typing import Optional
import structlog
from src.core.db import get_db

log = structlog.get_logger()


class KillSwitch:
    def __init__(self):
        self.db = get_db()
        self._cached_active: Optional[bool] = None

    async def is_active(self, refresh: bool = False) -> bool:
        if self._cached_active is not None and not refresh:
            return self._cached_active
        result = await self.db.select("kill_switch", ["active"], {"id": 1})
        active = result[0]["active"] if result else False
        self._cached_active = active
        return active

    async def activate(self, reason: str, activated_by: Optional[str] = None) -> None:
        if await self.is_active(refresh=True):
            log.warning("kill_switch_already_active")
            return

        await self.db.update(
            "kill_switch",
            {
                "active": True,
                "activated_at": datetime.utcnow().isoformat(),
                "activated_reason": reason,
                "activated_by": activated_by,
            },
            {"id": 1},
        )
        self._cached_active = True

        # Alert crítica
        await self.db.insert("alerts", {
            "level": "critical",
            "category": "system",
            "title": "Kill switch ACTIVATED",
            "message": reason,
            "metadata": {"reason": reason},
        })

        log.critical("kill_switch_activated", reason=reason)

    async def deactivate(self, deactivated_by: Optional[str] = None) -> None:
        if not await self.is_active(refresh=True):
            return

        await self.db.update(
            "kill_switch",
            {
                "active": False,
                "deactivated_at": datetime.utcnow().isoformat(),
                "deactivated_by": deactivated_by,
            },
            {"id": 1},
        )
        self._cached_active = False

        await self.db.insert("alerts", {
            "level": "info",
            "category": "system",
            "title": "Kill switch DEACTIVATED",
            "message": f"Reanudado por usuario",
        })

        log.info("kill_switch_deactivated")


_ks_instance: Optional[KillSwitch] = None


def get_kill_switch() -> KillSwitch:
    global _ks_instance
    if _ks_instance is None:
        _ks_instance = KillSwitch()
    return _ks_instance
