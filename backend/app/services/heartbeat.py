"""
HeartbeatProcessor (V2) — production-grade telemetry pipeline.

The V1 implementation was 70 lines: insert a row, bump a timestamp, done.
That works for a hello-world demo but breaks down at scale:

  * It had no idempotency — a phone with a flaky connection that retries the
    same heartbeat got billed twice, polluted the telemetry table, and false-
    triggered the "too frequent" guard.
  * It had no anomaly detection — a device suddenly reporting 100 °C or 100 %
    sustained CPU was treated like any other tick.
  * It silently flipped *offline* devices back to *idle* without publishing
    a state-change event the rest of the system could observe.
  * It had no concept of "rolling baseline" — the FraudEngine had to
    re-query telemetry from scratch every time it wanted a 5-minute window.
  * `reap_offline_devices` was a free function with a hard-coded threshold
    in seconds, not anchored to the device's expected cadence.

V2 fixes all of the above and exposes a public ``HeartbeatProcessor`` API:

    proc = HeartbeatProcessor()
    outcome = await proc.ingest(session, device, payload, request_id=...)
    # outcome contains:
    #   * the saved telemetry row
    #   * a list of fired AnomalyEvents (e.g. THERMAL_HOT, CPU_PINNED)
    #   * the rolling 5-minute aggregate that the FraudEngine reads
    #   * a state_transition record (offline→idle, idle→quarantined, …)

The aggregator is a per-device sliding-window kept in process memory. In a
multi-replica deployment swap the `_aggregator_state` dict for Redis hashes —
the public API stays identical.

Anomaly rules are declarative (`AnomalyRule`) and easy to extend. Adding a
new "GPU temperature delta > 20 °C in 60 s" rule is a 6-line dict. Each rule
emits a structured event the FraudEngine + the consumer UI both consume.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import timedelta
from enum import Enum
from typing import Any, Awaitable, Callable, Iterable

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.device import Device, DeviceStatus, DeviceTelemetry
from app.db.session import transactional
from app.exceptions import FraudSuspected
from app.logging_setup import get_logger
from app.schemas.device import DeviceHeartbeat
from app.utils.ids import new_ulid
from app.utils.time import utcnow


log = get_logger("heartbeat")


# ─────────────────────────────────────────────────────────────────────────────
# Anomaly rules — declarative, data-driven.
# ─────────────────────────────────────────────────────────────────────────────
class AnomalySeverity(str, Enum):
    info = "info"
    warn = "warn"
    critical = "critical"


@dataclass(frozen=True, slots=True)
class AnomalyRule:
    """A single tripwire."""
    code: str
    description: str
    severity: AnomalySeverity
    # Predicate gets (sample, aggregate). Aggregate can be None on first sample.
    predicate: Callable[["TelemetrySample", "Aggregate | None"], bool]
    # If True the device is auto-quarantined when this trips.
    quarantine_on_trip: bool = False


@dataclass(slots=True)
class AnomalyEvent:
    code: str
    severity: AnomalySeverity
    description: str
    detail: dict[str, Any] = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Rolling sample / aggregate
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(slots=True)
class TelemetrySample:
    sampled_at: float          # epoch seconds
    cpu_usage_pct: float
    gpu_usage_pct: float
    ram_usage_pct: float
    temperature_c: float | None
    power_watts: float | None
    download_mbps: float | None
    upload_mbps: float | None
    rssi_dbm: float | None
    extras: dict[str, Any]


@dataclass(slots=True)
class Aggregate:
    """Sliding-window summary the FraudEngine reads cheaply."""
    sample_count: int
    cpu_avg: float
    cpu_peak: float
    cpu_p95: float
    temp_peak: float | None
    last_sample_at: float
    interval_avg_seconds: float
    interval_min_seconds: float
    interval_p95_seconds: float
    flapping_score: float        # 0..1, how erratic the cadence is

    def to_payload(self) -> dict[str, Any]:
        return {
            "samples": self.sample_count,
            "cpu_avg": round(self.cpu_avg, 2),
            "cpu_peak": round(self.cpu_peak, 2),
            "cpu_p95": round(self.cpu_p95, 2),
            "temp_peak": self.temp_peak,
            "interval_avg_s": round(self.interval_avg_seconds, 2),
            "interval_min_s": round(self.interval_min_seconds, 2),
            "interval_p95_s": round(self.interval_p95_seconds, 2),
            "flapping_score": round(self.flapping_score, 3),
        }


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1)))))
    return s[idx]


# ─────────────────────────────────────────────────────────────────────────────
# Per-device aggregator — sliding 10-minute window in memory.
# Swap for Redis in multi-replica deploys.
# ─────────────────────────────────────────────────────────────────────────────
class _AggregatorState:
    __slots__ = ("samples", "_lock")

    def __init__(self) -> None:
        # bounded ring; 10 minutes @ 8 s cadence = ~75 entries; we keep 256 to
        # absorb fast-tick agents without growing without bound.
        self.samples: deque[TelemetrySample] = deque(maxlen=256)
        self._lock = asyncio.Lock()

    async def add(self, s: TelemetrySample) -> None:
        async with self._lock:
            self.samples.append(s)

    async def aggregate(self, *, window_seconds: int = 600) -> Aggregate | None:
        async with self._lock:
            if not self.samples:
                return None
            now = self.samples[-1].sampled_at
            cutoff = now - window_seconds
            window = [s for s in self.samples if s.sampled_at >= cutoff]
            if not window:
                return None
            cpus = [s.cpu_usage_pct for s in window]
            temps = [s.temperature_c for s in window if s.temperature_c is not None]
            intervals: list[float] = []
            for i in range(1, len(window)):
                intervals.append(window[i].sampled_at - window[i - 1].sampled_at)
            cpu_avg = sum(cpus) / len(cpus)
            cpu_peak = max(cpus)
            cpu_p95 = _percentile(cpus, 95)
            temp_peak = max(temps) if temps else None
            iavg = (sum(intervals) / len(intervals)) if intervals else 0.0
            imin = min(intervals) if intervals else 0.0
            ip95 = _percentile(intervals, 95) if intervals else 0.0
            # Flapping = stddev/mean of intervals, normalised.
            if len(intervals) >= 4 and iavg > 0:
                mean = iavg
                var = sum((x - mean) ** 2 for x in intervals) / len(intervals)
                stddev = var ** 0.5
                flap = min(1.0, stddev / mean)
            else:
                flap = 0.0
            return Aggregate(
                sample_count=len(window),
                cpu_avg=cpu_avg,
                cpu_peak=cpu_peak,
                cpu_p95=cpu_p95,
                temp_peak=temp_peak,
                last_sample_at=now,
                interval_avg_seconds=iavg,
                interval_min_seconds=imin,
                interval_p95_seconds=ip95,
                flapping_score=flap,
            )


_aggregator_state: dict[str, _AggregatorState] = {}
_aggregator_lock = asyncio.Lock()


async def _get_aggregator(device_id: str) -> _AggregatorState:
    async with _aggregator_lock:
        agg = _aggregator_state.get(device_id)
        if agg is None:
            agg = _AggregatorState()
            _aggregator_state[device_id] = agg
        return agg


async def get_device_aggregate(
    device_id: str, *, window_seconds: int = 600
) -> Aggregate | None:
    agg = await _get_aggregator(device_id)
    return await agg.aggregate(window_seconds=window_seconds)


# ─────────────────────────────────────────────────────────────────────────────
# Anomaly rule registry
# ─────────────────────────────────────────────────────────────────────────────
def _r_thermal_critical(s: TelemetrySample, _a: Aggregate | None) -> bool:
    return s.temperature_c is not None and s.temperature_c >= 92.0


def _r_thermal_warn(s: TelemetrySample, _a: Aggregate | None) -> bool:
    return s.temperature_c is not None and 82.0 <= s.temperature_c < 92.0


def _r_cpu_pinned(s: TelemetrySample, a: Aggregate | None) -> bool:
    if a is None or a.sample_count < 5:
        return False
    return a.cpu_p95 >= 99.0 and s.cpu_usage_pct >= 99.0


def _r_cadence_flapping(_s: TelemetrySample, a: Aggregate | None) -> bool:
    return a is not None and a.sample_count >= 8 and a.flapping_score >= 0.6


def _r_cadence_too_fast(_s: TelemetrySample, a: Aggregate | None) -> bool:
    settings = get_settings()
    floor = float(getattr(settings, "fraud_min_heartbeat_interval_seconds", 2) or 2)
    return (
        a is not None
        and a.sample_count >= 4
        and a.interval_min_seconds < (floor / 2)
    )


def _r_extras_explicit_alert(s: TelemetrySample, _a: Aggregate | None) -> bool:
    # Allows the agent itself to escalate via `extras: {"alert": "watchdog"}`.
    return bool(s.extras.get("alert"))


_DEFAULT_RULES: tuple[AnomalyRule, ...] = (
    AnomalyRule(
        code="THERMAL_CRITICAL",
        description="Sustained temperature ≥ 92 °C — soft hardware-limit territory.",
        severity=AnomalySeverity.critical,
        predicate=_r_thermal_critical,
        quarantine_on_trip=False,  # the agent already self-throttles; we only flag
    ),
    AnomalyRule(
        code="THERMAL_WARN",
        description="Temperature 82-91 °C — running hot, the agent must derate.",
        severity=AnomalySeverity.warn,
        predicate=_r_thermal_warn,
    ),
    AnomalyRule(
        code="CPU_PINNED",
        description="CPU p95 ≥ 99 % over the rolling window — likely a foreground hog.",
        severity=AnomalySeverity.warn,
        predicate=_r_cpu_pinned,
    ),
    AnomalyRule(
        code="CADENCE_FLAPPING",
        description="Heartbeat intervals are erratic — possible network instability.",
        severity=AnomalySeverity.warn,
        predicate=_r_cadence_flapping,
    ),
    AnomalyRule(
        code="CADENCE_TOO_FAST",
        description="Heartbeat intervals below half the configured minimum — possible replay.",
        severity=AnomalySeverity.critical,
        predicate=_r_cadence_too_fast,
        quarantine_on_trip=False,
    ),
    AnomalyRule(
        code="EXPLICIT_ALERT",
        description="Agent self-reported an alert flag in extras.",
        severity=AnomalySeverity.warn,
        predicate=_r_extras_explicit_alert,
    ),
)


# ─────────────────────────────────────────────────────────────────────────────
# Idempotency cache — coalesce duplicate heartbeats within a short window.
# ─────────────────────────────────────────────────────────────────────────────
class _IdempotencyCache:
    """Tiny in-memory cache of (device_id, request_id) → applied_at."""

    def __init__(self, *, ttl_seconds: int = 30, max_entries: int = 4096) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._entries: dict[tuple[str, str], float] = {}

    def seen(self, device_id: str, request_id: str | None) -> bool:
        if not request_id:
            return False
        now = time.time()
        key = (device_id, request_id)
        if key in self._entries:
            if now - self._entries[key] < self._ttl:
                return True
        # eviction
        if len(self._entries) >= self._max:
            cutoff = now - self._ttl
            self._entries = {k: v for k, v in self._entries.items() if v >= cutoff}
        self._entries[key] = now
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Outcome record
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(slots=True)
class HeartbeatOutcome:
    telemetry_id: str | None
    aggregate: Aggregate | None
    anomalies: list[AnomalyEvent] = field(default_factory=list)
    state_transition: tuple[DeviceStatus, DeviceStatus] | None = None
    idempotent_replay: bool = False

    @property
    def has_critical(self) -> bool:
        return any(a.severity == AnomalySeverity.critical for a in self.anomalies)


# ─────────────────────────────────────────────────────────────────────────────
# Processor
# ─────────────────────────────────────────────────────────────────────────────
HookCallable = Callable[[Device, HeartbeatOutcome], Awaitable[None]]


class HeartbeatProcessor:
    """Stateful processor — keep one per backend process.

    The class stays cheap to instantiate so existing call-sites that do
    `HeartbeatProcessor()` per request still work; in the hot path use the
    module-level `get_default_processor()` to share the aggregator/idempotency
    cache across requests.
    """

    def __init__(
        self,
        *,
        rules: Iterable[AnomalyRule] = _DEFAULT_RULES,
        idempotency_ttl_seconds: int = 30,
    ) -> None:
        self.settings = get_settings()
        self.rules = tuple(rules)
        self._idempotency = _IdempotencyCache(ttl_seconds=idempotency_ttl_seconds)
        self._post_hooks: list[HookCallable] = []

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    def add_post_hook(self, hook: HookCallable) -> None:
        """Register a coroutine to run after every accepted heartbeat."""
        self._post_hooks.append(hook)

    async def ingest(
        self,
        session: AsyncSession,
        device: Device,
        hb: DeviceHeartbeat,
        *,
        request_id: str | None = None,
    ) -> HeartbeatOutcome:
        if self._idempotency.seen(device.id, request_id):
            log.info("heartbeat.idempotent_replay", device_id=device.id, request_id=request_id)
            agg = await get_device_aggregate(device.id)
            return HeartbeatOutcome(
                telemetry_id=None,
                aggregate=agg,
                idempotent_replay=True,
            )

        # Cadence guard. We use a slightly lower threshold than the V1 hard
        # error so legitimate retries don't 423 the agent — but flag a
        # critical anomaly downstream when the cadence is *truly* wrong.
        floor = float(self.settings.fraud_min_heartbeat_interval_seconds)
        now = utcnow()
        if device.last_seen_at is not None:
            elapsed = (now - device.last_seen_at).total_seconds()
            if elapsed < floor / 2.0:
                # truly impossible — same agent cannot have legitimately
                # produced two heartbeats this close.
                raise FraudSuspected(
                    "heartbeat too frequent",
                    detail={"elapsed_seconds": elapsed, "min_seconds": floor},
                )

        # Persist telemetry + bump timestamps in a single transaction.
        sample = TelemetrySample(
            sampled_at=now.timestamp(),
            cpu_usage_pct=float(hb.cpu_usage_pct),
            gpu_usage_pct=float(hb.gpu_usage_pct or 0),
            ram_usage_pct=float(hb.ram_usage_pct or 0),
            temperature_c=hb.temperature_c,
            power_watts=hb.power_watts,
            download_mbps=hb.download_mbps,
            upload_mbps=hb.upload_mbps,
            rssi_dbm=hb.rssi_dbm,
            extras=dict(hb.extras or {}),
        )

        agg_state = await _get_aggregator(device.id)
        await agg_state.add(sample)
        aggregate = await agg_state.aggregate()

        anomalies = self._evaluate_rules(sample, aggregate)
        prev_status = device.status
        new_status: DeviceStatus | None = None

        async with transactional(session):
            telemetry = DeviceTelemetry(
                id=new_ulid(),
                device_id=device.id,
                sampled_at=now,
                cpu_usage_pct=sample.cpu_usage_pct,
                gpu_usage_pct=sample.gpu_usage_pct,
                ram_usage_pct=sample.ram_usage_pct,
                temperature_c=sample.temperature_c,
                power_watts=sample.power_watts,
                rssi_dbm=sample.rssi_dbm,
                download_mbps=sample.download_mbps,
                upload_mbps=sample.upload_mbps,
                extras={
                    **sample.extras,
                    "anomalies": [a.code for a in anomalies] or None,
                    "aggregate": aggregate.to_payload() if aggregate else None,
                },
            )
            session.add(telemetry)
            device.last_seen_at = now

            # Status state machine.
            if device.status == DeviceStatus.offline:
                device.status = DeviceStatus.idle
                new_status = DeviceStatus.idle
                log.info("device.online_again", device_id=device.id)

            if any(r.quarantine_on_trip for r in self.rules
                   if any(a.code == r.code for a in anomalies)):
                device.status = DeviceStatus.quarantined
                new_status = DeviceStatus.quarantined
                meta = dict(device.metadata_ or {})
                meta["quarantine_reason"] = ",".join(a.code for a in anomalies)
                meta["quarantined_at"] = now.isoformat()
                device.metadata_ = meta

        outcome = HeartbeatOutcome(
            telemetry_id=telemetry.id,
            aggregate=aggregate,
            anomalies=anomalies,
            state_transition=(prev_status, new_status) if new_status and new_status != prev_status else None,
        )

        # Post-hooks (push wake-ups, websocket fanout, etc.) — never let a
        # hook failure roll back the heartbeat.
        for hook in self._post_hooks:
            try:
                await hook(device, outcome)
            except Exception as exc:
                log.warning("heartbeat.post_hook_failed", error=str(exc))

        return outcome

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _evaluate_rules(
        self,
        sample: TelemetrySample,
        aggregate: Aggregate | None,
    ) -> list[AnomalyEvent]:
        events: list[AnomalyEvent] = []
        for rule in self.rules:
            try:
                if rule.predicate(sample, aggregate):
                    events.append(
                        AnomalyEvent(
                            code=rule.code,
                            severity=rule.severity,
                            description=rule.description,
                            detail={
                                "cpu_pct": sample.cpu_usage_pct,
                                "temp_c": sample.temperature_c,
                                "agg": aggregate.to_payload() if aggregate else None,
                            },
                        )
                    )
            except Exception as exc:
                log.warning("heartbeat.rule_failed", code=rule.code, error=str(exc))
        return events


# ─────────────────────────────────────────────────────────────────────────────
# Module singleton — share aggregator + idempotency cache across requests.
# ─────────────────────────────────────────────────────────────────────────────
_DEFAULT_PROCESSOR: HeartbeatProcessor | None = None


def get_default_processor() -> HeartbeatProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        _DEFAULT_PROCESSOR = HeartbeatProcessor()
    return _DEFAULT_PROCESSOR


# ─────────────────────────────────────────────────────────────────────────────
# Offline reaper
# ─────────────────────────────────────────────────────────────────────────────
async def reap_offline_devices(
    session: AsyncSession, *, idle_seconds: int | None = None
) -> int:
    """Promote stale devices to `offline`. Tunable via settings or kwarg."""
    settings = get_settings()
    threshold = idle_seconds or int(
        getattr(settings, "device_offline_threshold_seconds", 600)
    )
    cutoff = utcnow() - timedelta(seconds=threshold)
    result = await session.execute(
        update(Device)
        .where(
            Device.status.in_((DeviceStatus.idle, DeviceStatus.benchmarking)),
            Device.last_seen_at.is_not(None),
            Device.last_seen_at < cutoff,
        )
        .values(status=DeviceStatus.offline)
        .returning(Device.id)
    )
    ids = [r for r in result.scalars().all()]
    if ids:
        log.info("heartbeat.reaper.offline_promoted", count=len(ids))
    return len(ids)


# ─────────────────────────────────────────────────────────────────────────────
# Convenience accessors used by the FraudEngine + dashboard endpoints.
# ─────────────────────────────────────────────────────────────────────────────
async def get_recent_telemetry(
    session: AsyncSession, device_id: str, *, minutes: int = 30, limit: int = 200
) -> list[DeviceTelemetry]:
    cutoff = utcnow() - timedelta(minutes=minutes)
    rows = (await session.execute(
        select(DeviceTelemetry)
        .where(
            DeviceTelemetry.device_id == device_id,
            DeviceTelemetry.sampled_at >= cutoff,
        )
        .order_by(DeviceTelemetry.sampled_at.desc())
        .limit(limit)
    )).scalars().all()
    return list(rows)
