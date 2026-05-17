"""Power-economics endpoints exposed to the consumer agent + UI."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.db.models.device import Device
from app.db.session import get_session
from app.exceptions import NotFoundError, PermissionError_
from app.services.economics import (
    annotate_device_economics,
    decide_work,
    AdaptiveThrottle,
    DecisionInputs,
    estimate_cost,
    evaluate_profitability,
    export_power_profiles,
    export_tariff_table,
)


router = APIRouter(prefix="/economics", tags=["economics"])


@router.get("/tariffs")
async def tariffs() -> list[dict]:
    return export_tariff_table()


@router.get("/power-profiles")
async def profiles() -> list[dict]:
    return export_power_profiles()


@router.get("/device/{device_id}")
async def device_econ(
    device_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    device = await session.get(Device, device_id)
    if device is None:
        raise NotFoundError("device not found").as_http()
    if device.owner_id != principal.user.id and not principal.is_admin:
        raise PermissionError_("not your device").as_http()
    user_country = (principal.user.country_code or None)
    return annotate_device_economics(device, country_code=user_country)


@router.post("/should-work")
async def should_work(
    payload: dict = Body(...),
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Stateless what-would-we-do-now check used by the agent before claim."""
    device_id = payload["device_id"]
    device = await session.get(Device, device_id)
    if device is None:
        raise NotFoundError("device not found").as_http()
    if device.owner_id != principal.user.id and not principal.is_admin:
        raise PermissionError_("not your device").as_http()

    inputs = DecisionInputs(
        device_class=device.device_class,
        expected_earning_cents_per_hour=float(
            payload.get("expected_earning_cents_per_hour", 0)
        ),
        cpu_usage_pct=float(payload.get("cpu_usage_pct", 0)),
        foreground_cpu_pct=float(payload.get("foreground_cpu_pct", 0)),
        temperature_c=payload.get("temperature_c"),
        on_battery=bool(payload.get("on_battery", False)),
        battery_pct=payload.get("battery_pct"),
        target_max_cpu_pct=float(payload.get("target_max_cpu_pct", 10.0)),
        country_code=principal.user.country_code,
        user_override_rate_usd_kwh=payload.get("user_override_rate_usd_kwh"),
        measured_idle_w=payload.get("measured_idle_w"),
        measured_load_w=payload.get("measured_load_w"),
    )
    throttle = AdaptiveThrottle(
        cpu_cap_pct=inputs.target_max_cpu_pct,
        worker_count=int(payload.get("worker_count", 2)),
    )
    decision = decide_work(inputs, throttle)
    return {
        "should_run": decision.should_run,
        "target_cpu_pct": decision.target_cpu_pct,
        "workers_allowed": decision.workers_allowed,
        "explanations": decision.explanations,
        "profitability": {
            "profitable": decision.profitability.profitable,
            "earning_cents_per_hour": decision.profitability.earning_cents_per_hour,
            "cost_cents_per_hour": decision.profitability.cost_cents_per_hour,
            "margin_cents_per_hour": decision.profitability.margin_cents_per_hour,
            "margin_pct": decision.profitability.margin_pct,
            "safety_buffer_cents_per_hour": decision.profitability.safety_buffer_cents_per_hour,
            "reasons": decision.profitability.reasons,
            "recommended_action": decision.profitability.recommended_action,
        },
        "cost": {
            "idle_w": decision.cost.idle_w,
            "load_w": decision.cost.load_w,
            "attributable_w": decision.cost.attributable_w,
            "rate_usd_kwh": decision.cost.rate_usd_kwh,
            "cost_cents_per_hour": decision.cost.cost_cents_per_hour,
            "explanation": decision.cost.explanation,
        },
        "throttle": {
            "target_cpu_pct": decision.throttle.target_cpu_pct,
            "workers_allowed": decision.throttle.workers_allowed,
            "pause": decision.throttle.pause,
            "reasons": decision.throttle.reasons,
            "derate_reason": decision.throttle.derate_reason,
        },
    }


@router.post("/cost-estimate")
async def cost_estimate(
    payload: dict = Body(...),
    _: Principal = Depends(require_user),
) -> dict:
    cost = estimate_cost(
        device_class=payload["device_class"],
        utilisation_pct=float(payload.get("utilisation_pct", 50)),
        country_code=payload.get("country_code"),
        user_override_rate_usd_kwh=payload.get("user_override_rate_usd_kwh"),
        measured_idle_w=payload.get("measured_idle_w"),
        measured_load_w=payload.get("measured_load_w"),
    )
    earning = float(payload.get("earning_cents_per_hour", 0))
    verdict = evaluate_profitability(
        earning_cents_per_hour=earning, cost=cost
    )
    return {
        "cost": {
            "idle_w": cost.idle_w,
            "load_w": cost.load_w,
            "attributable_w": cost.attributable_w,
            "rate_usd_kwh": cost.rate_usd_kwh,
            "cost_cents_per_hour": cost.cost_cents_per_hour,
            "explanation": cost.explanation,
        },
        "profitable": verdict.profitable,
        "margin_cents_per_hour": verdict.margin_cents_per_hour,
        "headline": verdict.headline,
        "reasons": verdict.reasons,
        "recommended_action": verdict.recommended_action,
    }
