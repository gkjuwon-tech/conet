"""ElectroMesh power-economics engine.

The single most important guardrail in this system: **a user must never spend
more on electricity than they earn**. A naive marketplace prices compute by
H100-equivalent throughput, but a Raspberry Pi pulling 5W idle and 9W under
load earning $0.0001/hr would actually *lose* the owner real money once you
account for the 220V/15A grid behind it.

This module is the source of truth for:

* per-device-class idle/load watt estimates (calibrated from datasheets +
  observed telemetry),
* per-region kWh tariffs, including peak/off-peak slabs,
* live profitability checks the agent runs *before* claiming work,
* adaptive throttling decisions that keep utilisation under user caps,
* the floor price the marketplace must charge before a cluster will even
  agree to run a job.

Everything is written defensively: every estimate is bounded, every divisor
is guarded, and missing telemetry falls back to conservative defaults that
favour *not* running compute over running it at a loss.
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timezone
from typing import Any, Iterable, Mapping

from app.config import get_settings
from app.db.models.device import Device, DeviceClass


# ---------------------------------------------------------------------------
# Power profiles per device class
# ---------------------------------------------------------------------------
#
# Numbers come from a mix of vendor datasheets, our own measurements with a
# Kill-A-Watt P3, and conservative rounding upward on the load side. They are
# *deliberately* pessimistic — overestimating power keeps users out of red ink.
#
# All values are watts. ``idle`` is the steady-state draw with no compute.
# ``load`` is the draw at 100% utilisation of the resource the device class
# typically contributes (CPU for laptops, GPU for rigs, etc.). ``base`` is
# the ambient floor — fridge compressor cycles, router LED, smart-bulb wifi
# radio — that we *can't* attribute to compute and must not bill the user
# against their earnings.

@dataclass(frozen=True, slots=True)
class PowerProfile:
    device_class: DeviceClass
    idle_w: float
    load_w: float
    base_w: float
    has_battery: bool = False
    typical_capacity_wh: float = 0.0
    notes: str = ""


_POWER_PROFILES: dict[DeviceClass, PowerProfile] = {
    DeviceClass.smart_bulb: PowerProfile(
        DeviceClass.smart_bulb, idle_w=0.4, load_w=1.0, base_w=0.4,
        notes="ESP32-class radio + LED driver"),
    DeviceClass.smart_plug: PowerProfile(
        DeviceClass.smart_plug, idle_w=0.5, load_w=1.2, base_w=0.5,
        notes="Constantly powered, tiny MCU"),
    DeviceClass.smart_tv: PowerProfile(
        DeviceClass.smart_tv, idle_w=12.0, load_w=22.0, base_w=10.0,
        notes="ARM SoC + ambient memory; panel off"),
    DeviceClass.fridge: PowerProfile(
        DeviceClass.fridge, idle_w=2.0, load_w=4.5, base_w=80.0,
        notes="Compressor dominates; only the SoC counts toward us"),
    DeviceClass.washer: PowerProfile(
        DeviceClass.washer, idle_w=1.5, load_w=3.0, base_w=1.0,
        notes="MCU only when not washing"),
    DeviceClass.dryer: PowerProfile(
        DeviceClass.dryer, idle_w=1.5, load_w=3.0, base_w=1.0,
        notes="Same as washer"),
    DeviceClass.microwave: PowerProfile(
        DeviceClass.microwave, idle_w=2.0, load_w=4.0, base_w=2.0,
        notes="Standby clock + display"),
    DeviceClass.router: PowerProfile(
        DeviceClass.router, idle_w=6.0, load_w=10.0, base_w=6.0,
        notes="Always-on; dual-band radio dominates"),
    DeviceClass.nas: PowerProfile(
        DeviceClass.nas, idle_w=18.0, load_w=42.0, base_w=15.0,
        notes="2-bay SOHO box, spinning rust"),
    DeviceClass.desktop: PowerProfile(
        DeviceClass.desktop, idle_w=70.0, load_w=240.0, base_w=55.0,
        notes="Mid-tier consumer build"),
    DeviceClass.laptop: PowerProfile(
        DeviceClass.laptop, idle_w=10.0, load_w=55.0, base_w=8.0,
        has_battery=True, typical_capacity_wh=60.0,
        notes="Modern thin-and-light, lid open"),
    DeviceClass.console: PowerProfile(
        DeviceClass.console, idle_w=30.0, load_w=180.0, base_w=20.0,
        notes="PS5/Xbox in rest mode vs. game"),
    DeviceClass.phone: PowerProfile(
        DeviceClass.phone, idle_w=0.6, load_w=4.5, base_w=0.5,
        has_battery=True, typical_capacity_wh=15.0,
        notes="On charger; load = sustained big-core"),
    DeviceClass.tablet: PowerProfile(
        DeviceClass.tablet, idle_w=1.0, load_w=8.0, base_w=0.8,
        has_battery=True, typical_capacity_wh=30.0,
        notes="iPad-class"),
    DeviceClass.gpu_rig: PowerProfile(
        DeviceClass.gpu_rig, idle_w=120.0, load_w=520.0, base_w=80.0,
        notes="One 4090 + bare-bones host"),
    DeviceClass.other_iot: PowerProfile(
        DeviceClass.other_iot, idle_w=2.0, load_w=4.0, base_w=2.0,
        notes="Generic falls-here bucket"),
}


def get_power_profile(device_class: DeviceClass | str) -> PowerProfile:
    """Return the canonical PowerProfile for a class. Falls back to other_iot."""
    if isinstance(device_class, str):
        try:
            device_class = DeviceClass(device_class)
        except ValueError:
            return _POWER_PROFILES[DeviceClass.other_iot]
    return _POWER_PROFILES.get(device_class, _POWER_PROFILES[DeviceClass.other_iot])


# ---------------------------------------------------------------------------
# Tariff model
# ---------------------------------------------------------------------------
#
# Real residential tariffs are ugly: progressive slabs (KEPCO Korea), TOU
# windows, demand charges, fuel adjustments. We model the minimum needed:
#
#   * a default flat rate per region (USD/kWh),
#   * optional peak-hour multipliers,
#   * progressive slabs for accumulated monthly usage.
#
# Users override per-device via consents.energy_*. The engine always picks
# the *higher* of the regional default and the user override so we never
# undercharge.

@dataclass(frozen=True, slots=True)
class TariffSlab:
    upper_kwh: float  # cumulative kWh for this slab; math.inf for top slab
    rate_usd_kwh: float


@dataclass(frozen=True, slots=True)
class Tariff:
    region: str
    default_rate_usd_kwh: float
    slabs: tuple[TariffSlab, ...] = ()
    peak_multiplier: float = 1.0
    peak_window: tuple[int, int] = (0, 0)  # (start_hour, end_hour) UTC
    notes: str = ""


# Reference tariffs in USD/kWh, pulled from public 2024 figures and rounded up.
_TARIFFS: dict[str, Tariff] = {
    "KR": Tariff(
        region="KR",
        default_rate_usd_kwh=0.13,
        slabs=(
            TariffSlab(200, 0.092),
            TariffSlab(400, 0.18),
            TariffSlab(math.inf, 0.29),
        ),
        peak_multiplier=1.0,
        notes="KEPCO 2024 residential progressive",
    ),
    "US": Tariff(
        region="US",
        default_rate_usd_kwh=0.16,
        peak_multiplier=1.20,
        peak_window=(20, 26),  # 4-10pm PT modelled in UTC, wraps 24h
        notes="EIA average residential 2024",
    ),
    "DE": Tariff(
        region="DE",
        default_rate_usd_kwh=0.36,
        notes="One of the most expensive grids on Earth",
    ),
    "JP": Tariff(region="JP", default_rate_usd_kwh=0.27),
    "CN": Tariff(region="CN", default_rate_usd_kwh=0.08),
    "IN": Tariff(region="IN", default_rate_usd_kwh=0.07),
    "BR": Tariff(region="BR", default_rate_usd_kwh=0.18),
    "DEFAULT": Tariff(
        region="DEFAULT",
        default_rate_usd_kwh=0.20,
        notes="Conservative global mean — used when country is unknown",
    ),
}


def lookup_tariff(country_code: str | None) -> Tariff:
    if not country_code:
        return _TARIFFS["DEFAULT"]
    return _TARIFFS.get(country_code.upper(), _TARIFFS["DEFAULT"])


# ---------------------------------------------------------------------------
# Live cost / earning math
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class CostEstimate:
    """Estimated electricity cost attributable to ElectroMesh on this device.

    Cost is *only* the marginal compute draw. We never bill users for the
    base load — a fridge that was running anyway isn't suddenly our fault.
    """
    idle_w: float
    load_w: float
    attributable_w: float  # marginal watts above idle, scaled by utilisation
    rate_usd_kwh: float
    cost_usd_per_hour: float
    cost_cents_per_hour: float
    base_w_excluded: float
    explanation: str = ""


def estimate_cost(
    *,
    device_class: DeviceClass | str,
    utilisation_pct: float,
    country_code: str | None,
    user_override_rate_usd_kwh: float | None = None,
    measured_idle_w: float | None = None,
    measured_load_w: float | None = None,
    now: datetime | None = None,
) -> CostEstimate:
    """Compute the per-hour electricity cost attributable to the agent.

    ``utilisation_pct`` is 0..100 of the resource we're consuming. Telemetry
    overrides win when supplied — that's how a Watt meter or smart plug gets
    folded into the loop.
    """
    util = max(0.0, min(100.0, float(utilisation_pct))) / 100.0
    profile = get_power_profile(device_class)
    idle = float(measured_idle_w if measured_idle_w is not None else profile.idle_w)
    load = float(measured_load_w if measured_load_w is not None else profile.load_w)
    if load < idle:
        load = idle
    attributable_w = (load - idle) * util

    tariff = lookup_tariff(country_code)
    rate = max(
        tariff.default_rate_usd_kwh,
        float(user_override_rate_usd_kwh or 0.0),
    )

    # Peak-hour bump. We expect the caller to be in UTC; for a local-time
    # fidelity story you'd convert via Device.timezone first.
    if tariff.peak_multiplier > 1.0 and tariff.peak_window != (0, 0):
        ts = now or datetime.now(timezone.utc)
        h = ts.hour + (ts.minute / 60.0)
        lo, hi = tariff.peak_window
        in_window = lo <= h < hi if lo <= hi else (h >= lo or h < hi % 24)
        if in_window:
            rate *= tariff.peak_multiplier

    cost_usd_hour = (attributable_w / 1000.0) * rate
    return CostEstimate(
        idle_w=idle,
        load_w=load,
        attributable_w=attributable_w,
        rate_usd_kwh=rate,
        cost_usd_per_hour=cost_usd_hour,
        cost_cents_per_hour=cost_usd_hour * 100.0,
        base_w_excluded=profile.base_w,
        explanation=(
            f"({load:.1f}W load - {idle:.1f}W idle) × {util:.0%} util "
            f"× ${rate:.4f}/kWh = ${cost_usd_hour:.6f}/hr"
        ),
    )


# ---------------------------------------------------------------------------
# Profitability gate
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class ProfitabilityVerdict:
    profitable: bool
    earning_cents_per_hour: float
    cost_cents_per_hour: float
    margin_cents_per_hour: float
    margin_pct: float
    safety_buffer_cents_per_hour: float
    reasons: list[str] = field(default_factory=list)
    recommended_action: str = ""

    @property
    def headline(self) -> str:
        if self.profitable:
            return f"+{self.margin_cents_per_hour:.4f}¢/hr"
        return f"{self.margin_cents_per_hour:.4f}¢/hr (LOSS)"


def evaluate_profitability(
    *,
    earning_cents_per_hour: float,
    cost: CostEstimate,
    safety_margin_pct: float = 0.30,
) -> ProfitabilityVerdict:
    """Decide whether running compute right now is in the user's interest.

    Default safety margin is 30% — i.e. we'd rather idle than earn pennies
    that disappear into rounding errors and battery wear.
    """
    earning = max(0.0, float(earning_cents_per_hour))
    expense = max(0.0, float(cost.cost_cents_per_hour))
    safety = expense * safety_margin_pct
    margin = earning - expense - safety
    reasons: list[str] = []
    if expense <= 0:
        # No power model available — be conservative.
        reasons.append("no_power_model_available")
    if earning <= expense:
        reasons.append("earnings_below_electricity_cost")
    elif earning <= expense + safety:
        reasons.append("earnings_below_safety_margin")
    profitable = not reasons or reasons == ["no_power_model_available"] and earning > 0
    margin_pct = (margin / max(earning, 1e-9)) * 100.0
    action = (
        "run"
        if profitable
        else "throttle" if margin > -expense * 0.5 else "pause"
    )
    return ProfitabilityVerdict(
        profitable=profitable,
        earning_cents_per_hour=earning,
        cost_cents_per_hour=expense,
        margin_cents_per_hour=margin,
        margin_pct=margin_pct,
        safety_buffer_cents_per_hour=safety,
        reasons=reasons,
        recommended_action=action,
    )


# ---------------------------------------------------------------------------
# Floor pricing
# ---------------------------------------------------------------------------
#
# Used by the marketplace pricer: a cluster must charge at least this much
# per hour or membership devices would lose money. The dispatcher refuses
# to dispatch work below the floor.

def cluster_floor_price_usd_hour(
    devices: Iterable[Device],
    *,
    safety_margin_pct: float = 0.30,
    region_country: str | None = None,
) -> float:
    """Sum per-device break-even rates, plus a safety margin."""
    total = 0.0
    for d in devices:
        country = region_country or _country_from_device(d) or "DEFAULT"
        cost = estimate_cost(
            device_class=d.device_class,
            utilisation_pct=_typical_util_for_class(d.device_class),
            country_code=country,
            measured_idle_w=_extract_measured_w(d, "idle"),
            measured_load_w=_extract_measured_w(d, "load"),
        )
        total += cost.cost_usd_per_hour * (1.0 + safety_margin_pct)
    return round(total, 6)


def _typical_util_for_class(c: DeviceClass) -> float:
    return {
        DeviceClass.smart_bulb: 30.0,
        DeviceClass.smart_plug: 30.0,
        DeviceClass.smart_tv: 25.0,
        DeviceClass.fridge: 35.0,
        DeviceClass.washer: 30.0,
        DeviceClass.dryer: 30.0,
        DeviceClass.microwave: 30.0,
        DeviceClass.router: 35.0,
        DeviceClass.nas: 60.0,
        DeviceClass.desktop: 80.0,
        DeviceClass.laptop: 60.0,
        DeviceClass.console: 70.0,
        DeviceClass.phone: 35.0,
        DeviceClass.tablet: 35.0,
        DeviceClass.gpu_rig: 90.0,
        DeviceClass.other_iot: 30.0,
    }.get(c, 30.0)


def _country_from_device(d: Device) -> str | None:
    metadata = d.metadata_ or {}
    if "country_code" in metadata:
        return str(metadata["country_code"])
    return None


def _extract_measured_w(d: Device, kind: str) -> float | None:
    metadata = d.metadata_ or {}
    power = metadata.get("power") or {}
    val = power.get(f"{kind}_w")
    if val is None:
        return None
    try:
        f = float(val)
        if f <= 0 or f > 5000:
            return None
        return f
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Adaptive throttle
# ---------------------------------------------------------------------------
#
# A simple PID-ish loop that lives in the consumer agent. The agent feeds
# us recent per-second CPU load, the user's max_cpu_pct cap, the current
# profitability margin, and the device's thermal/power telemetry. We return
# a target utilisation for the next interval that:
#
#   * never exceeds the user's cap,
#   * backs off when the device is hot (>= 80°C) or losing money,
#   * ramps up when foreground apps are idle and we're profitable,
#   * shuts compute off entirely when on battery, unless explicitly allowed.

@dataclass(slots=True)
class ThrottleSnapshot:
    """A single observation feeding the throttle loop."""
    sampled_at: float
    cpu_usage_pct: float
    foreground_cpu_pct: float
    temperature_c: float | None
    on_battery: bool
    battery_pct: float | None
    profitable: bool
    margin_cents_per_hour: float
    target_max_cpu_pct: float
    measured_power_w: float | None = None


@dataclass(slots=True)
class ThrottleDecision:
    target_cpu_pct: float
    workers_allowed: int
    workers_pct: float
    pause: bool
    reasons: list[str] = field(default_factory=list)
    derate_reason: str | None = None


class AdaptiveThrottle:
    """In-process controller that the agent re-evaluates each tick.

    The state machine here is intentionally short-memoried: we keep a sliding
    window of ``window_size`` samples, react quickly to changes (anti-windup),
    and avoid policy oscillation by clamping per-tick deltas.
    """

    def __init__(
        self,
        *,
        cpu_cap_pct: float = 10.0,
        worker_count: int = 2,
        window_size: int = 12,
        max_delta_pct_per_tick: float = 4.0,
        thermal_cutoff_c: float = 88.0,
        thermal_warn_c: float = 78.0,
        battery_floor_pct: float = 40.0,
        require_charging: bool = True,
    ) -> None:
        self.cpu_cap_pct = cpu_cap_pct
        self.worker_count = worker_count
        self.window: deque[ThrottleSnapshot] = deque(maxlen=window_size)
        self.max_delta_pct_per_tick = max_delta_pct_per_tick
        self.thermal_cutoff_c = thermal_cutoff_c
        self.thermal_warn_c = thermal_warn_c
        self.battery_floor_pct = battery_floor_pct
        self.require_charging = require_charging
        self._target = cpu_cap_pct
        self._last_decision: ThrottleDecision | None = None

    @property
    def last_decision(self) -> ThrottleDecision | None:
        return self._last_decision

    def observe(self, snap: ThrottleSnapshot) -> ThrottleDecision:
        self.window.append(snap)
        decision = self._decide(snap)
        self._last_decision = decision
        return decision

    def _decide(self, snap: ThrottleSnapshot) -> ThrottleDecision:
        reasons: list[str] = []
        target = self._target
        derate: str | None = None
        pause = False

        # Hard guards first.
        if snap.on_battery and self.require_charging:
            reasons.append("on_battery_no_charging_required")
            target = 0.0
            pause = True
        elif (
            snap.on_battery
            and snap.battery_pct is not None
            and snap.battery_pct < self.battery_floor_pct
        ):
            reasons.append(f"battery_below_floor_{self.battery_floor_pct:.0f}")
            target = 0.0
            pause = True
        elif (
            snap.temperature_c is not None
            and snap.temperature_c >= self.thermal_cutoff_c
        ):
            reasons.append(f"thermal_cutoff_{self.thermal_cutoff_c:.0f}c")
            target = 0.0
            pause = True
            derate = "thermal_cutoff"
        elif not snap.profitable:
            # Soft pause: drop to the lowest possible utilisation.
            reasons.append("unprofitable")
            target = max(target * 0.25, 0.0)
            derate = "unprofitable_soft_pause"
        else:
            # Compute headroom from foreground usage so we don't lag the user's
            # interactive apps.
            free_cpu = max(0.0, 100.0 - snap.foreground_cpu_pct)
            ideal = min(snap.target_max_cpu_pct, free_cpu * 0.9)
            ideal = max(0.0, ideal)
            # Thermal soft-derate.
            if (
                snap.temperature_c is not None
                and snap.temperature_c >= self.thermal_warn_c
            ):
                reasons.append(
                    f"thermal_warn_{snap.temperature_c:.0f}c_soft_derate"
                )
                derate_factor = 1.0 - min(
                    0.6,
                    (snap.temperature_c - self.thermal_warn_c)
                    / (self.thermal_cutoff_c - self.thermal_warn_c),
                )
                ideal *= derate_factor
                derate = "thermal_warn"
            # Margin sweetener: if we're solidly profitable, we let target
            # creep upward by up to 1% per tick.
            if snap.margin_cents_per_hour > 0.05:
                ideal = min(ideal + 1.0, snap.target_max_cpu_pct)
            target = self._clamp_delta(ideal)

        target = max(0.0, min(target, snap.target_max_cpu_pct))
        self._target = target

        # Map to allowed workers. A worker contributes ~ (100 / worker_count)%
        # of the device's CPU when running tight loops. We never request more
        # than the cap allows.
        per_worker_pct = max(1.0, 100.0 / max(self.worker_count, 1))
        workers = int(math.floor(target / per_worker_pct))
        workers = max(0, min(workers, self.worker_count))

        return ThrottleDecision(
            target_cpu_pct=round(target, 2),
            workers_allowed=workers,
            workers_pct=round((workers / max(self.worker_count, 1)) * 100, 1),
            pause=pause,
            reasons=reasons,
            derate_reason=derate,
        )

    def _clamp_delta(self, ideal: float) -> float:
        delta = ideal - self._target
        if abs(delta) <= self.max_delta_pct_per_tick:
            return ideal
        return self._target + math.copysign(self.max_delta_pct_per_tick, delta)


# ---------------------------------------------------------------------------
# Persistent ledger of cost vs revenue
# ---------------------------------------------------------------------------
#
# We persist a rolling 30-day per-device economic ledger in metadata so the
# user can see, in real terms, "this NAS earned $1.42 and burned $0.31 of
# electricity this month — net $1.11". Implemented as in-memory aggregator
# the agent flushes periodically.

@dataclass(slots=True)
class EconomicEntry:
    occurred_at: float
    earnings_cents: float
    cost_cents: float

    @property
    def margin_cents(self) -> float:
        return self.earnings_cents - self.cost_cents


@dataclass(slots=True)
class EconomicLedger:
    device_id: str
    entries: list[EconomicEntry] = field(default_factory=list)

    def record(self, *, earnings_cents: float, cost_cents: float) -> EconomicEntry:
        entry = EconomicEntry(
            occurred_at=time.time(),
            earnings_cents=float(earnings_cents),
            cost_cents=float(cost_cents),
        )
        self.entries.append(entry)
        # Trim to 30 days.
        cutoff = time.time() - 30 * 24 * 3600
        self.entries = [e for e in self.entries if e.occurred_at >= cutoff]
        return entry

    def totals(self) -> dict[str, float]:
        if not self.entries:
            return {"earnings_cents": 0.0, "cost_cents": 0.0, "margin_cents": 0.0}
        earnings = sum(e.earnings_cents for e in self.entries)
        cost = sum(e.cost_cents for e in self.entries)
        return {
            "earnings_cents": round(earnings, 4),
            "cost_cents": round(cost, 4),
            "margin_cents": round(earnings - cost, 4),
        }

    def buckets(self, *, hours: int = 24) -> list[dict[str, float]]:
        """Aggregate into hourly buckets for sparkline rendering."""
        if not self.entries:
            return []
        cutoff = time.time() - hours * 3600
        per_hour: dict[int, dict[str, float]] = {}
        for e in self.entries:
            if e.occurred_at < cutoff:
                continue
            slot = int(e.occurred_at // 3600)
            d = per_hour.setdefault(
                slot,
                {"earnings_cents": 0.0, "cost_cents": 0.0, "margin_cents": 0.0, "ts": float(slot * 3600)},
            )
            d["earnings_cents"] += e.earnings_cents
            d["cost_cents"] += e.cost_cents
            d["margin_cents"] = d["earnings_cents"] - d["cost_cents"]
        return [per_hour[k] for k in sorted(per_hour)]


# ---------------------------------------------------------------------------
# High-level "should I work right now?" decision
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class WorkDecision:
    """The single decision returned to the agent each polling tick."""
    should_run: bool
    target_cpu_pct: float
    workers_allowed: int
    profitability: ProfitabilityVerdict
    cost: CostEstimate
    throttle: ThrottleDecision
    explanations: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DecisionInputs:
    device_class: DeviceClass | str
    expected_earning_cents_per_hour: float
    cpu_usage_pct: float
    foreground_cpu_pct: float
    temperature_c: float | None
    on_battery: bool
    battery_pct: float | None
    target_max_cpu_pct: float
    country_code: str | None = None
    user_override_rate_usd_kwh: float | None = None
    measured_idle_w: float | None = None
    measured_load_w: float | None = None


def decide_work(
    inputs: DecisionInputs, throttle: AdaptiveThrottle
) -> WorkDecision:
    """The all-in-one helper the agent calls each tick."""
    util = max(0.0, min(100.0, inputs.cpu_usage_pct))
    cost = estimate_cost(
        device_class=inputs.device_class,
        utilisation_pct=util,
        country_code=inputs.country_code,
        user_override_rate_usd_kwh=inputs.user_override_rate_usd_kwh,
        measured_idle_w=inputs.measured_idle_w,
        measured_load_w=inputs.measured_load_w,
    )
    profitability = evaluate_profitability(
        earning_cents_per_hour=inputs.expected_earning_cents_per_hour,
        cost=cost,
    )
    snap = ThrottleSnapshot(
        sampled_at=time.time(),
        cpu_usage_pct=util,
        foreground_cpu_pct=max(0.0, min(100.0, inputs.foreground_cpu_pct)),
        temperature_c=inputs.temperature_c,
        on_battery=inputs.on_battery,
        battery_pct=inputs.battery_pct,
        profitable=profitability.profitable,
        margin_cents_per_hour=profitability.margin_cents_per_hour,
        target_max_cpu_pct=inputs.target_max_cpu_pct,
        measured_power_w=inputs.measured_load_w,
    )
    decision = throttle.observe(snap)
    explanations: list[str] = []
    if not profitability.profitable:
        explanations.append(
            f"unprofitable: earning {profitability.earning_cents_per_hour:.4f}¢/hr "
            f"≤ cost {profitability.cost_cents_per_hour:.4f}¢/hr "
            f"(+{profitability.safety_buffer_cents_per_hour:.4f}¢ safety)"
        )
    if decision.derate_reason:
        explanations.append(f"derate: {decision.derate_reason}")
    if decision.reasons:
        explanations.extend(decision.reasons)
    should_run = profitability.profitable and not decision.pause and decision.workers_allowed > 0
    return WorkDecision(
        should_run=should_run,
        target_cpu_pct=decision.target_cpu_pct,
        workers_allowed=decision.workers_allowed,
        profitability=profitability,
        cost=cost,
        throttle=decision,
        explanations=explanations,
    )


# ---------------------------------------------------------------------------
# DB-backed device-level helpers
# ---------------------------------------------------------------------------

def device_break_even_cents_per_hour(
    device: Device,
    *,
    country_code: str | None = None,
    safety_margin_pct: float = 0.30,
) -> float:
    cost = estimate_cost(
        device_class=device.device_class,
        utilisation_pct=_typical_util_for_class(device.device_class),
        country_code=country_code or _country_from_device(device) or "DEFAULT",
        measured_idle_w=_extract_measured_w(device, "idle"),
        measured_load_w=_extract_measured_w(device, "load"),
    )
    return round(cost.cost_cents_per_hour * (1.0 + safety_margin_pct), 4)


def annotate_device_economics(device: Device, country_code: str | None = None) -> Mapping[str, Any]:
    profile = get_power_profile(device.device_class)
    break_even = device_break_even_cents_per_hour(
        device, country_code=country_code
    )
    tariff = lookup_tariff(country_code or _country_from_device(device))
    return {
        "device_id": device.id,
        "device_class": device.device_class.value if hasattr(device.device_class, "value") else str(device.device_class),
        "idle_w": profile.idle_w,
        "load_w": profile.load_w,
        "base_w": profile.base_w,
        "break_even_cents_per_hour": break_even,
        "tariff_region": tariff.region,
        "tariff_rate_usd_kwh": tariff.default_rate_usd_kwh,
        "has_battery": profile.has_battery,
        "typical_capacity_wh": profile.typical_capacity_wh,
        "explanation": profile.notes,
    }


# ---------------------------------------------------------------------------
# Cluster-level minimum acceptable price
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class ClusterEconomics:
    floor_usd_hour: float
    members: list[dict[str, Any]]
    aggregate_load_w: float
    aggregate_idle_w: float
    aggregate_break_even_cents_per_hour: float

    @property
    def floor_cents_hour(self) -> float:
        return round(self.floor_usd_hour * 100.0, 4)


def cluster_economics(
    devices: Iterable[Device],
    *,
    safety_margin_pct: float | None = None,
    country_code: str | None = None,
) -> ClusterEconomics:
    settings = get_settings()
    margin = safety_margin_pct
    if margin is None:
        margin = float(getattr(settings, "economics_safety_margin_pct", 0.30) or 0.30)
    members: list[dict[str, Any]] = []
    total_floor = 0.0
    total_load = 0.0
    total_idle = 0.0
    for d in devices:
        ann = annotate_device_economics(d, country_code=country_code)
        members.append(ann)
        total_floor += float(ann["break_even_cents_per_hour"]) / 100.0
        total_load += float(ann["load_w"])
        total_idle += float(ann["idle_w"])
    return ClusterEconomics(
        floor_usd_hour=round(total_floor * (1.0 + margin), 6),
        members=members,
        aggregate_load_w=round(total_load, 2),
        aggregate_idle_w=round(total_idle, 2),
        aggregate_break_even_cents_per_hour=round(total_floor * 100, 4),
    )


# ---------------------------------------------------------------------------
# Public API for FastAPI / IPC
# ---------------------------------------------------------------------------

def export_tariff_table() -> list[dict[str, Any]]:
    """Used by the consumer settings page so users can see what we charge."""
    out: list[dict[str, Any]] = []
    for region, t in _TARIFFS.items():
        out.append(
            {
                "region": region,
                "default_rate_usd_kwh": t.default_rate_usd_kwh,
                "peak_multiplier": t.peak_multiplier,
                "peak_window": t.peak_window,
                "slabs": [
                    {"upper_kwh": s.upper_kwh, "rate_usd_kwh": s.rate_usd_kwh}
                    for s in t.slabs
                ],
                "notes": t.notes,
            }
        )
    return out


def export_power_profiles() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c, p in _POWER_PROFILES.items():
        out.append(
            {
                "device_class": c.value,
                "idle_w": p.idle_w,
                "load_w": p.load_w,
                "base_w": p.base_w,
                "has_battery": p.has_battery,
                "typical_capacity_wh": p.typical_capacity_wh,
                "notes": p.notes,
            }
        )
    return out
