"""Shared pytest fixtures for backend tests.

Integration tests use the ``db_session`` fixture, which hands them an
``AsyncSession`` against an isolated, transactional database. The schema
is created once per test session; each test runs inside a per-test
outer transaction and the session.begin()/commit() calls inside service
code become SAVEPOINTs that roll back with the outer transaction.

The DB URL is taken from ``EM_TEST_DATABASE_URL`` if set, otherwise
from the app's ``database_url`` setting with ``_test`` appended to the
database name. CI is expected to provision a Postgres next to the
runner; ``setup-postgres`` action or a docker service both work.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings
from app.db.base import Base


def _test_db_url() -> str:
    env = os.environ.get("EM_TEST_DATABASE_URL")
    if env:
        return env
    base = make_url(str(get_settings().database_url))
    db = (base.database or "electromesh") + "_test"
    return str(base.set(database=db))


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def _engine():
    """Schema is dropped + recreated per session — tests should never
    inherit state from a previous run."""
    engine = create_async_engine(_test_db_url(), future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture()
async def db_session(_engine) -> AsyncGenerator[AsyncSession, None]:
    """Per-test transactional session.

    We open an outer transaction on the connection and tell the session
    to join it as a SAVEPOINT (``create_savepoint`` mode). That way the
    service layer's own ``session.commit()`` (inside ``transactional(...)``)
    only collapses a SAVEPOINT — the outer transaction stays open and
    we roll it back on teardown.
    """
    async with _engine.connect() as conn:
        outer = await conn.begin()
        Session = async_sessionmaker(
            bind=conn,
            expire_on_commit=False,
            class_=AsyncSession,
            join_transaction_mode="create_savepoint",
        )
        async with Session() as session:
            try:
                yield session
            finally:
                await session.close()
        await outer.rollback()
