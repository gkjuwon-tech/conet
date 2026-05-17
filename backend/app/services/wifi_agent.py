from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.config import get_settings
from app.utils.time import utcnow


@dataclass(slots=True)
class AgentMessage:
    type: str
    payload: dict[str, Any]
    issued_at: datetime
    nonce: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "payload": self.payload,
            "issued_at": self.issued_at.isoformat(),
            "nonce": self.nonce,
        }


def sign_message(message: AgentMessage, secret: str) -> str:
    body = json.dumps(message.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def verify_message(message: AgentMessage, signature: str, secret: str) -> bool:
    expected = sign_message(message, secret)
    return hmac.compare_digest(expected, signature)


def detect_idle_capacity(telemetry: dict[str, float], policy: dict[str, Any]) -> dict[str, float]:
    """Compute the share of CPU/GPU/network the agent may borrow given policy."""
    settings = get_settings()  # noqa: F841 - reserved for future global limits

    max_cpu = float(policy.get("max_cpu_pct", 10))
    max_gpu = float(policy.get("max_gpu_pct", 10))
    max_bw = float(policy.get("max_bandwidth_mbps", 2.0))
    night_only = bool(policy.get("night_only", False))
    blackout_hours = set(int(h) for h in policy.get("blackout_hours", []))

    hour = utcnow().hour
    if hour in blackout_hours:
        return {"cpu_pct": 0, "gpu_pct": 0, "bandwidth_mbps": 0, "reason": 0}
    if night_only and not (0 <= hour <= 6):
        return {"cpu_pct": 0, "gpu_pct": 0, "bandwidth_mbps": 0, "reason": 0}

    free_cpu = max(0.0, 100.0 - telemetry.get("cpu_usage_pct", 0))
    free_gpu = max(0.0, 100.0 - telemetry.get("gpu_usage_pct", 0))
    free_bw = max(0.0, telemetry.get("free_bandwidth_mbps", 0))

    return {
        "cpu_pct": min(max_cpu, free_cpu * 0.9),
        "gpu_pct": min(max_gpu, free_gpu * 0.9),
        "bandwidth_mbps": min(max_bw, free_bw * 0.5),
    }


def fingerprint_lan(public_ip: str | None, gateway_mac: str | None) -> str | None:
    if not public_ip and not gateway_mac:
        return None
    raw = f"{public_ip or ''}|{gateway_mac or ''}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:48]


def estimate_attainable_h100eq(idle_capacity: dict[str, float], device_h100eq: float) -> float:
    cpu_share = idle_capacity.get("cpu_pct", 0) / 100.0
    gpu_share = idle_capacity.get("gpu_pct", 0) / 100.0
    return round(device_h100eq * (0.4 * cpu_share + 0.6 * gpu_share), 6)
