"""Stripe-backed enterprise billing endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Header, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise
from app.config import get_settings
from app.db.models.billing import EnterpriseChargeEvent, EnterpriseInvoice
from app.db.session import get_session
from app.services.stripe_billing import StripeBilling


router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/balance")
async def balance(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> dict:
    billing = StripeBilling()
    snap = await billing.balance(session, enterprise=principal.enterprise)
    return {
        "enterprise_id": snap.enterprise_id,
        "credit_balance_cents": snap.credit_balance_cents,
        "monthly_spend_cents": snap.monthly_spend_cents,
        "spend_cap_cents": snap.spend_cap_cents,
        "held_cents": snap.held_cents,
        "last_topup_at": snap.last_topup_at.isoformat() if snap.last_topup_at else None,
        "last_charge_at": snap.last_charge_at.isoformat() if snap.last_charge_at else None,
    }


@router.post("/topup", status_code=status.HTTP_201_CREATED)
async def topup(
    payload: dict = Body(...),
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> dict:
    billing = StripeBilling()
    amount_cents = int(payload.get("amount_cents", 0))
    description = payload.get("description")
    out = await billing.create_topup(
        session,
        enterprise=principal.enterprise,
        amount_cents=amount_cents,
        description=description,
    )
    return {
        "invoice_id": out.invoice_id,
        "payment_intent_id": out.payment_intent_id,
        "client_secret": out.client_secret,
        "publishable_key": out.publishable_key,
        "amount_cents": out.amount_cents,
        "currency": out.currency,
        "status": out.status,
        "stripe_enabled": bool(get_settings().stripe_secret_key.get_secret_value()),
    }


@router.post("/topup/{invoice_id}/dev-confirm")
async def dev_confirm(
    invoice_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Local-only: marks an invoice paid without going through Stripe.

    Returns 409 once a real Stripe key is configured.
    """
    billing = StripeBilling()
    invoice = await billing.confirm_dev_topup(session, invoice_id=invoice_id)
    return {"ok": True, "invoice_id": invoice.id, "status": invoice.status.value}


@router.post("/webhook/stripe")
async def webhook(
    request: Request,
    stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    session: AsyncSession = Depends(get_session),
) -> dict:
    body = await request.body()
    billing = StripeBilling()
    return await billing.handle_webhook(
        session, payload=body, signature=stripe_signature
    )


@router.get("/invoices")
async def invoices(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
    limit: int = 50,
) -> list[dict]:
    rows = list(
        (
            await session.execute(
                select(EnterpriseInvoice)
                .where(EnterpriseInvoice.enterprise_id == principal.enterprise.id)
                .order_by(EnterpriseInvoice.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        {
            "id": r.id,
            "kind": r.kind.value,
            "status": r.status.value,
            "amount_cents": r.amount_cents,
            "currency": r.currency,
            "description": r.description,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "paid_at": r.paid_at.isoformat() if r.paid_at else None,
            "failed_at": r.failed_at.isoformat() if r.failed_at else None,
            "failure_reason": r.failure_reason,
            "stripe_payment_intent_id": r.stripe_payment_intent_id,
        }
        for r in rows
    ]


@router.get("/charges")
async def charges(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
    limit: int = 100,
) -> list[dict]:
    rows = list(
        (
            await session.execute(
                select(EnterpriseChargeEvent)
                .where(EnterpriseChargeEvent.enterprise_id == principal.enterprise.id)
                .order_by(EnterpriseChargeEvent.occurred_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        {
            "id": r.id,
            "reason": r.reason.value,
            "amount_cents": r.amount_cents,
            "job_id": r.job_id,
            "shell_session_id": r.shell_session_id,
            "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
            "description": r.description,
            "is_finalized": r.is_finalized,
        }
        for r in rows
    ]
