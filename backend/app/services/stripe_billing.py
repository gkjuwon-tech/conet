"""Stripe-backed enterprise billing service.

Two write paths:

1. **Top-up** — enterprise initiates a PaymentIntent, gets a client secret,
   confirms in-app via Stripe Elements / Mobile SDK. Webhook ``payment_intent.
   succeeded`` is the *single* place we credit ``Enterprise.credit_balance_cents``.
2. **Job pre-debit** — when a job is submitted we *hold* its max budget on the
   credit balance. On settlement we replace that hold with the actual spend
   (which is usually less). The hold is released atomically.

We do NOT credit users from this. User payouts come from a separate Stripe
Connect transfer flow (``billing.payouts``). This module is just the inbound
side.

The module is safe to import without a Stripe key: every method that requires
the live API checks ``self._enabled`` first and either returns a stub or
raises a clear error. That lets the rest of the backend boot in dev without
secrets.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import stripe
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.billing import (
    ChargeReason,
    EnterpriseChargeEvent,
    EnterpriseInvoice,
    InvoiceKind,
    InvoiceStatus,
)
from app.db.models.enterprise import Enterprise
from app.db.session import transactional
from app.exceptions import ConflictError, NotFoundError, PricingError
from app.logging_setup import get_logger
from app.utils.ids import new_ulid
from app.utils.time import utcnow


log = get_logger("billing.stripe")


@dataclass(slots=True)
class TopupCreated:
    invoice_id: str
    payment_intent_id: str | None
    client_secret: str | None
    publishable_key: str
    amount_cents: int
    currency: str
    status: str


@dataclass(slots=True)
class BalanceSnapshot:
    enterprise_id: str
    credit_balance_cents: int
    monthly_spend_cents: int
    spend_cap_cents: int | None
    held_cents: int
    last_topup_at: datetime | None
    last_charge_at: datetime | None


class StripeBilling:
    def __init__(self) -> None:
        self.settings = get_settings()
        secret = self.settings.stripe_secret_key.get_secret_value()
        if secret:
            stripe.api_key = secret
        self._enabled = bool(secret)
        self._publishable = self.settings.stripe_publishable_key.get_secret_value() or ""

    # ------------------------------------------------------------------
    # Top-up
    # ------------------------------------------------------------------
    async def create_topup(
        self,
        session: AsyncSession,
        *,
        enterprise: Enterprise,
        amount_cents: int,
        description: str | None = None,
        initiated_by_user_id: str | None = None,
    ) -> TopupCreated:
        if amount_cents < self.settings.stripe_topup_min_cents:
            raise PricingError(
                f"top-up below minimum {self.settings.stripe_topup_min_cents} cents"
            )
        if amount_cents > self.settings.stripe_topup_max_cents:
            raise PricingError(
                f"top-up above maximum {self.settings.stripe_topup_max_cents} cents"
            )

        invoice = EnterpriseInvoice(
            id=new_ulid(),
            enterprise_id=enterprise.id,
            kind=InvoiceKind.topup,
            status=InvoiceStatus.pending,
            amount_cents=amount_cents,
            currency=self.settings.stripe_currency.upper(),
            description=description or f"ElectroMesh credit top-up",
            initiated_by_user_id=initiated_by_user_id,
        )

        if self._enabled:
            customer_id = enterprise.stripe_customer_id
            if not customer_id:
                customer = await _to_thread(
                    stripe.Customer.create,
                    name=enterprise.name,
                    email=enterprise.contact_email,
                    metadata={"enterprise_id": enterprise.id},
                )
                customer_id = customer["id"]
                enterprise.stripe_customer_id = customer_id

            pi = await _to_thread(
                stripe.PaymentIntent.create,
                amount=amount_cents,
                currency=self.settings.stripe_currency,
                customer=customer_id,
                description=description or f"ElectroMesh top-up for {enterprise.slug}",
                automatic_payment_methods={"enabled": True},
                metadata={
                    "enterprise_id": enterprise.id,
                    "invoice_id": invoice.id,
                    "kind": "topup",
                },
            )
            invoice.stripe_payment_intent_id = pi["id"]
            invoice.stripe_client_secret = pi["client_secret"]
            invoice.stripe_customer_id = customer_id
            invoice.stripe_status = pi.get("status")
        else:
            # Dev fallback — pretend everything works, surface a sentinel
            # client_secret the front-end recognises and immediately credits.
            invoice.stripe_payment_intent_id = f"pi_dev_{invoice.id}"
            invoice.stripe_client_secret = f"dev-secret-{invoice.id}"
            invoice.stripe_status = "requires_payment_method"

        async with transactional(session):
            session.add(invoice)

        log.info(
            "billing.topup.created",
            enterprise_id=enterprise.id,
            invoice_id=invoice.id,
            amount_cents=amount_cents,
            stripe_enabled=self._enabled,
        )

        return TopupCreated(
            invoice_id=invoice.id,
            payment_intent_id=invoice.stripe_payment_intent_id,
            client_secret=invoice.stripe_client_secret,
            publishable_key=self._publishable,
            amount_cents=amount_cents,
            currency=invoice.currency,
            status=invoice.status.value,
        )

    async def confirm_dev_topup(
        self, session: AsyncSession, *, invoice_id: str
    ) -> EnterpriseInvoice:
        """Local-only helper that simulates a successful payment when no
        Stripe key is configured. Production callers go through the webhook.
        """
        if self._enabled:
            raise ConflictError(
                "dev confirm called while real Stripe is configured — use the webhook"
            )
        return await self._mark_paid(session, invoice_id=invoice_id, charge_id=None)

    async def handle_webhook(
        self, session: AsyncSession, *, payload: bytes, signature: str
    ) -> dict[str, Any]:
        secret = self.settings.stripe_webhook_secret.get_secret_value()
        if not self._enabled or not secret:
            return {"ok": False, "reason": "stripe_disabled"}

        event = await _to_thread(
            stripe.Webhook.construct_event, payload, signature, secret
        )
        kind = event.get("type") or "unknown"
        log.info("billing.webhook", event_type=kind, event_id=event.get("id"))

        if kind == "payment_intent.succeeded":
            data = event["data"]["object"]
            invoice_id = (data.get("metadata") or {}).get("invoice_id")
            charge_id = (data.get("latest_charge") or "")
            if invoice_id:
                await self._mark_paid(
                    session, invoice_id=invoice_id, charge_id=charge_id or None
                )
            return {"ok": True, "type": kind}
        if kind == "payment_intent.payment_failed":
            data = event["data"]["object"]
            invoice_id = (data.get("metadata") or {}).get("invoice_id")
            if invoice_id:
                reason = (data.get("last_payment_error") or {}).get("message")
                await self._mark_failed(session, invoice_id=invoice_id, reason=reason or "")
            return {"ok": True, "type": kind}
        if kind == "charge.refunded":
            data = event["data"]["object"]
            pi_id = data.get("payment_intent")
            if pi_id:
                await self._mark_refunded(session, payment_intent_id=pi_id)
            return {"ok": True, "type": kind}

        return {"ok": True, "type": kind, "ignored": True}

    async def _mark_paid(
        self,
        session: AsyncSession,
        *,
        invoice_id: str,
        charge_id: str | None,
    ) -> EnterpriseInvoice:
        async with transactional(session):
            invoice = await session.get(
                EnterpriseInvoice, invoice_id, with_for_update=True
            )
            if invoice is None:
                raise NotFoundError("invoice not found")
            if invoice.status == InvoiceStatus.succeeded:
                return invoice
            invoice.status = InvoiceStatus.succeeded
            invoice.paid_at = utcnow()
            if charge_id:
                invoice.stripe_charge_id = charge_id

            enterprise = await session.get(
                Enterprise, invoice.enterprise_id, with_for_update=True
            )
            if enterprise is None:
                raise NotFoundError("enterprise gone")
            enterprise.credit_balance_cents += invoice.amount_cents

            session.add(
                EnterpriseChargeEvent(
                    id=new_ulid(),
                    enterprise_id=enterprise.id,
                    reason=ChargeReason.adjustment,
                    amount_cents=invoice.amount_cents,
                    occurred_at=utcnow(),
                    description=f"top-up {invoice.id} credited",
                    metadata_={"invoice_id": invoice.id},
                )
            )
        log.info(
            "billing.topup.paid",
            invoice_id=invoice.id,
            enterprise_id=invoice.enterprise_id,
            amount_cents=invoice.amount_cents,
        )
        return invoice

    async def _mark_failed(
        self,
        session: AsyncSession,
        *,
        invoice_id: str,
        reason: str,
    ) -> EnterpriseInvoice:
        async with transactional(session):
            invoice = await session.get(
                EnterpriseInvoice, invoice_id, with_for_update=True
            )
            if invoice is None:
                raise NotFoundError("invoice not found")
            invoice.status = InvoiceStatus.failed
            invoice.failed_at = utcnow()
            invoice.failure_reason = reason[:500] if reason else "unknown"
        return invoice

    async def _mark_refunded(
        self, session: AsyncSession, *, payment_intent_id: str
    ) -> EnterpriseInvoice | None:
        async with transactional(session):
            invoice = (
                await session.execute(
                    select(EnterpriseInvoice).where(
                        EnterpriseInvoice.stripe_payment_intent_id == payment_intent_id
                    )
                )
            ).scalar_one_or_none()
            if invoice is None:
                return None
            invoice.status = InvoiceStatus.refunded
            enterprise = await session.get(
                Enterprise, invoice.enterprise_id, with_for_update=True
            )
            if enterprise is not None:
                enterprise.credit_balance_cents = max(
                    0, enterprise.credit_balance_cents - invoice.amount_cents
                )
                session.add(
                    EnterpriseChargeEvent(
                        id=new_ulid(),
                        enterprise_id=enterprise.id,
                        reason=ChargeReason.adjustment,
                        amount_cents=-invoice.amount_cents,
                        occurred_at=utcnow(),
                        description=f"refund of invoice {invoice.id}",
                        metadata_={"invoice_id": invoice.id},
                    )
                )
            return invoice

    # ------------------------------------------------------------------
    # Job pre-debit / settlement
    # ------------------------------------------------------------------
    async def hold_for_job(
        self,
        session: AsyncSession,
        *,
        enterprise_id: str,
        job_id: str,
        max_cents: int,
    ) -> EnterpriseChargeEvent:
        async with transactional(session):
            enterprise = await session.get(
                Enterprise, enterprise_id, with_for_update=True
            )
            if enterprise is None:
                raise NotFoundError("enterprise not found")
            if enterprise.credit_balance_cents < max_cents:
                raise PricingError(
                    "insufficient credit balance — top up before submitting",
                    detail={
                        "balance_cents": enterprise.credit_balance_cents,
                        "required_cents": max_cents,
                    },
                )
            enterprise.credit_balance_cents -= max_cents
            event = EnterpriseChargeEvent(
                id=new_ulid(),
                enterprise_id=enterprise_id,
                reason=ChargeReason.job_authorization_hold,
                amount_cents=-max_cents,
                job_id=job_id,
                occurred_at=utcnow(),
                description=f"hold {max_cents}c for job {job_id}",
                is_finalized=False,
            )
            session.add(event)
            log.info(
                "billing.hold",
                enterprise_id=enterprise_id,
                job_id=job_id,
                cents=max_cents,
                remaining_cents=enterprise.credit_balance_cents,
            )
            return event

    async def settle_job(
        self,
        session: AsyncSession,
        *,
        enterprise_id: str,
        job_id: str,
        spent_cents: int,
    ) -> dict[str, Any]:
        """Replace the prior hold with the actual spend. Difference is refunded."""
        async with transactional(session):
            enterprise = await session.get(
                Enterprise, enterprise_id, with_for_update=True
            )
            if enterprise is None:
                raise NotFoundError("enterprise not found")
            holds = list(
                (
                    await session.execute(
                        select(EnterpriseChargeEvent).where(
                            EnterpriseChargeEvent.enterprise_id == enterprise_id,
                            EnterpriseChargeEvent.job_id == job_id,
                            EnterpriseChargeEvent.reason
                            == ChargeReason.job_authorization_hold,
                            EnterpriseChargeEvent.is_finalized.is_(False),
                        )
                    )
                ).scalars()
            )
            held_cents = sum(-h.amount_cents for h in holds)
            for h in holds:
                h.is_finalized = True

            # Refund difference back to balance.
            refund = max(0, held_cents - spent_cents)
            if refund:
                enterprise.credit_balance_cents += refund
                session.add(
                    EnterpriseChargeEvent(
                        id=new_ulid(),
                        enterprise_id=enterprise_id,
                        reason=ChargeReason.job_authorization_release,
                        amount_cents=refund,
                        job_id=job_id,
                        occurred_at=utcnow(),
                        description=f"unused hold released for job {job_id}",
                    )
                )
            # Track the actual settlement.
            session.add(
                EnterpriseChargeEvent(
                    id=new_ulid(),
                    enterprise_id=enterprise_id,
                    reason=ChargeReason.job_settlement,
                    amount_cents=-spent_cents,
                    job_id=job_id,
                    occurred_at=utcnow(),
                    description=f"job {job_id} settled at {spent_cents}c",
                )
            )
            enterprise.monthly_spend_cents += spent_cents

            log.info(
                "billing.settled",
                enterprise_id=enterprise_id,
                job_id=job_id,
                held_cents=held_cents,
                spent_cents=spent_cents,
                refund_cents=refund,
                remaining_balance_cents=enterprise.credit_balance_cents,
            )
            return {
                "held_cents": held_cents,
                "spent_cents": spent_cents,
                "refund_cents": refund,
                "balance_cents": enterprise.credit_balance_cents,
            }

    async def release_hold(
        self,
        session: AsyncSession,
        *,
        enterprise_id: str,
        job_id: str,
        reason: str = "job cancelled",
    ) -> int:
        async with transactional(session):
            enterprise = await session.get(
                Enterprise, enterprise_id, with_for_update=True
            )
            if enterprise is None:
                raise NotFoundError("enterprise not found")
            holds = list(
                (
                    await session.execute(
                        select(EnterpriseChargeEvent).where(
                            EnterpriseChargeEvent.enterprise_id == enterprise_id,
                            EnterpriseChargeEvent.job_id == job_id,
                            EnterpriseChargeEvent.reason
                            == ChargeReason.job_authorization_hold,
                            EnterpriseChargeEvent.is_finalized.is_(False),
                        )
                    )
                ).scalars()
            )
            held_cents = sum(-h.amount_cents for h in holds)
            for h in holds:
                h.is_finalized = True
            if held_cents:
                enterprise.credit_balance_cents += held_cents
                session.add(
                    EnterpriseChargeEvent(
                        id=new_ulid(),
                        enterprise_id=enterprise_id,
                        reason=ChargeReason.job_authorization_release,
                        amount_cents=held_cents,
                        job_id=job_id,
                        occurred_at=utcnow(),
                        description=reason,
                    )
                )
            return held_cents

    async def balance(
        self, session: AsyncSession, *, enterprise: Enterprise
    ) -> BalanceSnapshot:
        held_rows = list(
            (
                await session.execute(
                    select(EnterpriseChargeEvent).where(
                        EnterpriseChargeEvent.enterprise_id == enterprise.id,
                        EnterpriseChargeEvent.reason
                        == ChargeReason.job_authorization_hold,
                        EnterpriseChargeEvent.is_finalized.is_(False),
                    )
                )
            ).scalars()
        )
        held_cents = sum(-h.amount_cents for h in held_rows)
        last_topup = (
            await session.execute(
                select(EnterpriseInvoice)
                .where(
                    EnterpriseInvoice.enterprise_id == enterprise.id,
                    EnterpriseInvoice.status == InvoiceStatus.succeeded,
                )
                .order_by(EnterpriseInvoice.paid_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        last_charge = (
            await session.execute(
                select(EnterpriseChargeEvent)
                .where(EnterpriseChargeEvent.enterprise_id == enterprise.id)
                .order_by(EnterpriseChargeEvent.occurred_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        return BalanceSnapshot(
            enterprise_id=enterprise.id,
            credit_balance_cents=enterprise.credit_balance_cents,
            monthly_spend_cents=enterprise.monthly_spend_cents,
            spend_cap_cents=enterprise.spend_cap_cents,
            held_cents=held_cents,
            last_topup_at=last_topup.paid_at if last_topup else None,
            last_charge_at=last_charge.occurred_at if last_charge else None,
        )


async def _to_thread(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
    """Run a synchronous Stripe call on a worker thread."""
    return await asyncio.to_thread(lambda: fn(*args, **kwargs))
