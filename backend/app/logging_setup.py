from __future__ import annotations

import logging
import sys
from typing import Any

try:
    import structlog
    _HAS_STRUCTLOG = True
except ImportError:
    # Host-side scripts (host_full_mitm etc.) may import services
    # without the full backend dependency tree.  Fall back to stdlib.
    structlog = None  # type: ignore[assignment]
    _HAS_STRUCTLOG = False

try:
    from app.config import get_settings
    _HAS_CONFIG = True
except Exception:
    get_settings = None  # type: ignore[assignment]
    _HAS_CONFIG = False


class _StdlibShim:
    """Minimal structlog-shaped facade backed by stdlib logging.

    Service modules call ``log.info("event.name", key=val, ...)``.  The
    shim formats those kwargs into a readable message.
    """
    def __init__(self, name: str | None = None):
        self._log = logging.getLogger(name or "electromesh")
        if not self._log.handlers:
            h = logging.StreamHandler(sys.stdout)
            h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s"))
            self._log.addHandler(h)
            self._log.setLevel(logging.INFO)

    def _fmt(self, msg: str, kv: dict[str, Any]) -> str:
        if not kv: return msg
        return msg + " " + " ".join(f"{k}={v}" for k, v in kv.items())

    def debug(self, msg: str, **kw: Any) -> None: self._log.debug(self._fmt(msg, kw))
    def info(self, msg: str, **kw: Any) -> None:  self._log.info(self._fmt(msg, kw))
    def warning(self, msg: str, **kw: Any) -> None: self._log.warning(self._fmt(msg, kw))
    def error(self, msg: str, **kw: Any) -> None: self._log.error(self._fmt(msg, kw))


def configure_logging() -> None:
    if not _HAS_STRUCTLOG or not _HAS_CONFIG:
        # In stripped-down host environments just leave stdlib defaults.
        logging.basicConfig(format="%(message)s", stream=sys.stdout, level=logging.INFO)
        return
    settings = get_settings()
    level = getattr(logging, settings.log_level)

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )

    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.EventRenamer("msg"),
    ]

    if settings.is_prod:
        shared_processors.append(structlog.processors.dict_tracebacks)
        shared_processors.append(structlog.processors.JSONRenderer())
    else:
        shared_processors.append(structlog.dev.ConsoleRenderer(colors=True))

    structlog.configure(
        processors=shared_processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )

    for noisy in ("uvicorn.access", "sqlalchemy.engine.Engine"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str | None = None):  # type: ignore[no-untyped-def]
    if _HAS_STRUCTLOG:
        return structlog.get_logger(name)  # type: ignore[union-attr]
    return _StdlibShim(name)
