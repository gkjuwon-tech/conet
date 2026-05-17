from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
import stripe

from app.config import get_settings
from app.logging_setup import get_logger


log = get_logger("billing.stripe")


@dataclass(slots=True)
class TransferResult:
    external_id: str
    status: str
    raw: dict[str, Any]


class StripeAdapter:
    def __init__(self) -> None:
        self.settings = get_settings()
        secret = self.settings.stripe_secret_key.get_secret_value()
        if secret:
            stripe.api_key = secret
        self._enabled = bool(secret)

    async def ensure_customer(self, *, enterprise_id: str, email: str, name: str) -> str:
        if not self._enabled:
            return f"cus_test_{enterprise_id[:12]}"
        customer = await _to_thread(
            stripe.Customer.create,
            email=email,
            name=name,
            metadata={"enterprise_id": enterprise_id},
        )
        return customer["id"]

    async def charge_enterprise(
        self,
        *,
        stripe_customer_id: str,
        amount_cents: int,
        description: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        if not self._enabled:
            log.warning("stripe.disabled.charge_skipped", customer=stripe_customer_id, cents=amount_cents)
            return {"id": f"pi_test_{idempotency_key}", "status": "succeeded", "amount": amount_cents}
        intent = await _to_thread(
            stripe.PaymentIntent.create,
            amount=amount_cents,
            currency="usd",
            customer=stripe_customer_id,
            description=description,
            confirm=True,
            off_session=True,
            idempotency_key=idempotency_key,
        )
        return intent  # type: ignore[return-value]

    async def transfer_to_user(
        self,
        *,
        stripe_account_id: str,
        amount_cents: int,
        description: str,
        idempotency_key: str,
    ) -> TransferResult:
        if not self._enabled or not stripe_account_id.startswith(self.settings.stripe_payout_account_prefix):
            log.warning("stripe.disabled.transfer_skipped", to=stripe_account_id, cents=amount_cents)
            return TransferResult(
                external_id=f"tr_test_{idempotency_key}",
                status="succeeded",
                raw={"amount": amount_cents, "destination": stripe_account_id},
            )
        transfer = await _to_thread(
            stripe.Transfer.create,
            amount=amount_cents,
            currency="usd",
            destination=stripe_account_id,
            description=description,
            idempotency_key=idempotency_key,
        )
        return TransferResult(
            external_id=transfer["id"],
            status=transfer.get("status", "succeeded"),
            raw=dict(transfer),
        )

    async def webhook_event(self, payload: bytes, signature: str) -> dict[str, Any]:
        secret = self.settings.stripe_webhook_secret.get_secret_value()
        if not self._enabled or not secret:
            return {"type": "skipped", "data": {}}
        event = await _to_thread(
            stripe.Webhook.construct_event, payload, signature, secret
        )
        return event  # type: ignore[return-value]


async def _to_thread(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
    import anyio

    return await anyio.to_thread.run_sync(lambda: fn(*args, **kwargs))


class HttpFallback:
    """Last-resort generic HTTP processor (e.g. for crypto payouts)."""

    def __init__(self, base_url: str, token: str) -> None:
        self._client = httpx.AsyncClient(base_url=base_url, timeout=20.0, headers={"Authorization": f"Bearer {token}"})

    async def transfer(self, *, recipient: str, amount_cents: int, memo: str) -> dict[str, Any]:
        resp = await self._client.post(
            "/transfer",
            json={"recipient": recipient, "amount_cents": amount_cents, "memo": memo},
        )
        resp.raise_for_status()
        return resp.json()

    async def aclose(self) -> None:
        await self._client.aclose()
