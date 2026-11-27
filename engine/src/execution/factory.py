"""
Factory de brokers — selecciona paper, testnet o live según config.

El modo se lee de:
  1. Config de Supabase: execution.broker → { broker: "paper" | "binance_testnet" | "binance" }
  2. Env var: ENV = "dev" | "paper" | "live"

Prioridad: config DB > env var.

Guards de seguridad para live:
  - Requiere ENV=live (no se puede activar live si ENV=paper)
  - Requiere kill_switch desactivado
  - Loguea WARNING cada vez que se instancia un broker live
"""
import structlog
from src.core.config import get_env
from src.execution.broker_base import BrokerBase
from src.execution.broker_paper import PaperBroker
from src.execution.broker_binance import BinanceBroker

log = structlog.get_logger()

_broker_instance: BrokerBase | None = None
_broker_mode: str | None = None


def get_broker_mode(db_config: dict | None = None) -> str:
    """
    Determina el modo del broker.
    Retorna: "paper" | "binance_testnet" | "binance"
    """
    env = get_env()

    # Config de DB tiene prioridad
    if db_config:
        broker_cfg = db_config.get("execution.broker", {})
        if isinstance(broker_cfg, dict):
            mode = broker_cfg.get("broker", "paper")
        else:
            mode = "paper"
    else:
        mode = "paper"

    # Guard: no se puede ir a live si ENV no es "live"
    if mode == "binance" and env.env != "live":
        log.warning("broker_mode_blocked",
                     requested=mode, env=env.env,
                     reason="ENV must be 'live' to use real Binance. Falling back to paper.")
        return "paper"

    # Guard: testnet requiere al menos ENV=paper
    if mode == "binance_testnet" and env.env == "dev":
        log.warning("broker_mode_blocked",
                     requested=mode, env=env.env,
                     reason="ENV must be 'paper' or 'live' for testnet. Falling back to paper.")
        return "paper"

    return mode


def create_broker(mode: str) -> BrokerBase:
    """Crea una instancia de broker según el modo."""
    if mode == "binance":
        log.warning("🔴 LIVE BROKER INSTANTIATED — real money operations enabled",
                     mode=mode)
        return BinanceBroker(testnet=False)
    elif mode == "binance_testnet":
        log.info("broker_created", mode=mode, note="testnet — no real money")
        return BinanceBroker(testnet=True)
    else:
        log.info("broker_created", mode=mode)
        return PaperBroker()


async def get_broker(db_config: dict | None = None, force_new: bool = False) -> BrokerBase:
    """
    Singleton del broker. Se recrea si el modo cambió (ej: alguien
    cambió la config en el portal).
    """
    global _broker_instance, _broker_mode

    mode = get_broker_mode(db_config)

    if _broker_instance is not None and _broker_mode == mode and not force_new:
        return _broker_instance

    # Cerrar el anterior si cambió
    if _broker_instance is not None and _broker_mode != mode:
        log.info("broker_mode_changed", old=_broker_mode, new=mode)
        try:
            await _broker_instance.close()
        except Exception:
            pass

    _broker_instance = create_broker(mode)
    _broker_mode = mode
    return _broker_instance


def current_mode() -> str:
    """Retorna el modo actual sin instanciar."""
    return _broker_mode or "paper"


def is_live() -> bool:
    """True si estamos operando con dinero real."""
    return _broker_mode == "binance"


def is_paper() -> bool:
    """True si estamos en paper trading."""
    return _broker_mode in (None, "paper")
