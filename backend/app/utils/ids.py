from __future__ import annotations

import secrets
import time
import uuid

import ulid


def new_uuid() -> str:
    return str(uuid.uuid4())


def new_ulid() -> str:
    return ulid.new().str


def short_token(byte_len: int = 18) -> str:
    return secrets.token_urlsafe(byte_len)


def device_handle() -> str:
    return f"dev_{ulid.new().str}"


def cluster_handle() -> str:
    return f"clu_{ulid.new().str}"


def job_handle() -> str:
    return f"job_{ulid.new().str}"


def workunit_handle() -> str:
    return f"wu_{ulid.new().str}"


def payout_handle() -> str:
    return f"po_{ulid.new().str}"


def now_ms() -> int:
    return int(time.time() * 1000)
