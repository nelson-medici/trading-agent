"""
Logging estructurado con:
- JSON output para máquinas
- Console-friendly para dev
- Hash chain opcional para logs críticos (auditoría)
"""
import hashlib
import json
import logging
import sys
from pathlib import Path
from typing import Any
import structlog


def configure_logging(level: str = "INFO", json_output: bool = False) -> None:
    """Configura structlog. Llamar una vez al startup."""

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, level.upper(), logging.INFO),
    )

    processors: list[Any] = [
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if json_output:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer(colors=True))

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


class HashChainLogger:
    """
    Log append-only con hash encadenado.
    Cada entry incluye el hash del anterior.
    Detecta modificaciones retroactivas.

    Uso: para audit log de decisiones críticas.
    """

    def __init__(self, log_path: Path):
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._last_hash = self._read_last_hash()

    def _read_last_hash(self) -> str:
        if not self.log_path.exists():
            return "0" * 64
        with open(self.log_path, "rb") as f:
            try:
                f.seek(-2048, 2)
            except OSError:
                f.seek(0)
            last_lines = f.read().decode("utf-8", errors="ignore").splitlines()
        for line in reversed(last_lines):
            try:
                entry = json.loads(line)
                return entry.get("hash", "0" * 64)
            except (json.JSONDecodeError, KeyError):
                continue
        return "0" * 64

    def append(self, event_type: str, data: dict) -> str:
        entry = {
            "event_type": event_type,
            "data": data,
            "prev_hash": self._last_hash,
        }
        from datetime import datetime
        entry["timestamp"] = datetime.utcnow().isoformat() + "Z"

        payload = json.dumps(entry, sort_keys=True).encode("utf-8")
        h = hashlib.sha256(payload).hexdigest()
        entry["hash"] = h

        with open(self.log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

        self._last_hash = h
        return h

    def verify(self) -> tuple[bool, int]:
        """
        Recorre el log completo verificando hashes.
        Retorna (ok, número_de_entries).
        """
        if not self.log_path.exists():
            return True, 0

        prev_hash = "0" * 64
        count = 0

        with open(self.log_path) as f:
            for line in f:
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("prev_hash") != prev_hash:
                    return False, count
                stored_hash = entry.pop("hash")
                recomputed = hashlib.sha256(
                    json.dumps(entry, sort_keys=True).encode("utf-8")
                ).hexdigest()
                if recomputed != stored_hash:
                    return False, count
                prev_hash = stored_hash
                count += 1

        return True, count
