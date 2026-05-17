from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

_settings = get_settings()

engine = create_async_engine(
    str(_settings.database_url),
    pool_size=_settings.database_pool_size,
    max_overflow=_settings.database_max_overflow,
    pool_recycle=_settings.database_pool_recycle,
    pool_pre_ping=True,
    future=True,
)

SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    autoflush=False,
)

sync_engine = create_engine(
    _settings.db_sync_url,
    pool_pre_ping=True,
    future=True,
)
SyncSessionLocal: sessionmaker[Session] = sessionmaker(
    bind=sync_engine,
    expire_on_commit=False,
    autoflush=False,
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


@contextmanager
def sync_session_scope() -> Iterator[Session]:
    session = SyncSessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


class transactional:
    """Always-commits/rollbacks unit-of-work scope.

    SA 2.0 async sessions autobegin on the first statement, so a "did I open
    it?" check used to skip commit when an upstream SELECT had already opened
    the tx. We just always commit on success, rollback on failure — matching
    the typical request-scoped session pattern.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def __aenter__(self) -> AsyncSession:
        if not self._session.in_transaction():
            await self._session.begin()
        return self._session

    async def __aexit__(self, exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
        if exc:
            await self._session.rollback()
        else:
            await self._session.commit()
