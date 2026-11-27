"""Broker Binance real via CCXT."""
import ccxt.async_support as ccxt
from typing import Optional
import structlog
from src.core.config import get_env
from src.execution.broker_base import BrokerBase

log = structlog.get_logger()


class BinanceBroker(BrokerBase):
    def __init__(self, testnet: bool = False):
        env = get_env()
        opts = {"enableRateLimit": True}
        if testnet:
            opts["apiKey"] = env.binance_testnet_api_key
            opts["secret"] = env.binance_testnet_api_secret
        else:
            opts["apiKey"] = env.binance_api_key
            opts["secret"] = env.binance_api_secret
        self.exchange = ccxt.binance(opts)
        if testnet:
            self.exchange.set_sandbox_mode(True)

    async def place_order(
        self,
        *,
        client_order_id: str,
        symbol: str,
        side: str,
        size: float,
        limit_price: Optional[float] = None,
    ) -> dict:
        try:
            params = {"clientOrderId": client_order_id[:36]}
            order_type = "limit" if limit_price else "market"
            if limit_price:
                order = await self.exchange.create_limit_order(
                    symbol, side.lower(), size, limit_price, params=params,
                )
            else:
                order = await self.exchange.create_market_order(
                    symbol, side.lower(), size, params=params,
                )
            return {
                "broker_id": order["id"],
                "client_order_id": order.get("clientOrderId"),
                "state": self._map_state(order["status"]),
                "filled_units": order["filled"],
                "avg_fill_price": order.get("average"),
                "commission": order.get("fee", {}).get("cost", 0),
            }
        except Exception as e:
            log.error("binance_order_failed", error=str(e))
            return {"state": "FAILED", "error": str(e)}

    async def get_order_state(self, broker_order_id: str) -> dict:
        order = await self.exchange.fetch_order(broker_order_id)
        return {
            "state": self._map_state(order["status"]),
            "filled_units": order["filled"],
            "avg_fill_price": order.get("average"),
        }

    async def cancel_order(self, broker_order_id: str) -> dict:
        return await self.exchange.cancel_order(broker_order_id)

    async def get_balance(self) -> dict:
        balance = await self.exchange.fetch_balance()
        return {
            "cash_usd": balance.get("USDT", {}).get("free", 0),
            "holdings": {
                k: v["free"]
                for k, v in balance.get("total", {}).items()
                if v and v > 0 and k != "USDT"
            },
        }

    async def close(self) -> None:
        await self.exchange.close()

    def _map_state(self, ccxt_status: str) -> str:
        mapping = {
            "open": "SUBMITTED",
            "closed": "FILLED",
            "canceled": "CANCELED",
            "expired": "CANCELED",
            "rejected": "REJECTED",
        }
        return mapping.get(ccxt_status, "UNKNOWN")
