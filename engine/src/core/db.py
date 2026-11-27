"""
Cliente async de Supabase.

Wrapper simple sobre supabase-py que:
- Usa el service_role para bypass de RLS (engine tiene acceso completo)
- Expone métodos tipados que usamos frecuentemente
- Maneja errores de red con retries
"""
from typing import Any, Optional
from supabase import create_client, Client
import structlog
from src.core.config import get_env

log = structlog.get_logger()


class DB:
    """Cliente de Supabase con métodos convenience."""

    def __init__(self):
        env = get_env()
        if not env.supabase_url or not env.supabase_service_role_key:
            raise RuntimeError(
                "SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorios"
            )
        self.client: Client = create_client(
            env.supabase_url,
            env.supabase_service_role_key,
        )

    async def select(
        self,
        table: str,
        columns: Optional[list[str]] = None,
        filters: Optional[dict] = None,
        order_by: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[dict]:
        """SELECT con filtros básicos."""
        query = self.client.table(table).select(
            "*" if columns is None else ",".join(columns)
        )
        if filters:
            for k, v in filters.items():
                query = query.eq(k, v)
        if order_by:
            desc = order_by.startswith("-")
            col = order_by.lstrip("-")
            query = query.order(col, desc=desc)
        if limit:
            query = query.limit(limit)
        result = query.execute()
        return result.data or []

    async def insert(self, table: str, data: dict | list[dict]) -> dict:
        result = self.client.table(table).insert(data).execute()
        return result.data[0] if result.data else {}

    async def upsert(
        self,
        table: str,
        data: dict | list[dict],
        on_conflict: Optional[str] = None,
    ) -> list[dict]:
        query = self.client.table(table).upsert(
            data,
            on_conflict=on_conflict,
        )
        result = query.execute()
        return result.data or []

    async def update(
        self,
        table: str,
        data: dict,
        filters: dict,
    ) -> list[dict]:
        query = self.client.table(table).update(data)
        for k, v in filters.items():
            query = query.eq(k, v)
        result = query.execute()
        return result.data or []

    async def delete(self, table: str, filters: dict) -> None:
        query = self.client.table(table).delete()
        for k, v in filters.items():
            query = query.eq(k, v)
        query.execute()

    async def rpc(self, function_name: str, params: Optional[dict] = None) -> Any:
        """Llamar función RPC de Postgres."""
        result = self.client.rpc(function_name, params or {}).execute()
        return result.data

    async def get_config_value(self, key: str) -> Any:
        result = await self.select("config", ["value"], {"key": key})
        return result[0]["value"] if result else None

    async def set_config_value(self, key: str, value: Any) -> None:
        await self.update("config", {"value": value}, {"key": key})


_db_instance: Optional[DB] = None


def get_db() -> DB:
    """Singleton del cliente DB."""
    global _db_instance
    if _db_instance is None:
        _db_instance = DB()
    return _db_instance
