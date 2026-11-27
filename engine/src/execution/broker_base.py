"""Interfaz abstracta del broker."""
from abc import ABC, abstractmethod
from typing import Optional


class BrokerBase(ABC):

    @abstractmethod
    async def place_order(
        self,
        *,
        client_order_id: str,
        symbol: str,
        side: str,
        size: float,
        limit_price: Optional[float] = None,
    ) -> dict:
        ...

    @abstractmethod
    async def get_order_state(self, broker_order_id: str) -> dict:
        ...

    @abstractmethod
    async def cancel_order(self, broker_order_id: str) -> dict:
        ...

    @abstractmethod
    async def get_balance(self) -> dict:
        ...

    @abstractmethod
    async def close(self) -> None:
        ...
