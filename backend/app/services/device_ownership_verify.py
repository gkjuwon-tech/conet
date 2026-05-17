"""Device ownership verification — proof-of-control before LAN claim.

A user must demonstrate ownership of a discovered device before the claim
service will pair it. Two methods supported today:

  * ``pin_display``  — server picks a 6-digit PIN, device renders it on its
                       own screen (TV/speaker/etc), user types it back.
  * ``mac_serial``   — user reads the MAC (and optional serial) from the
                       device's own settings UI; we compare against the
                       MAC the scanner saw on the wire.

On success we stamp ``(user_id, device_ip)`` into a short-lived ``_verified``
table; the claim service refuses to proceed without that stamp.

State is in-memory because both the challenge and the verification window
are seconds-to-minutes; if the process restarts the user just re-verifies.
A future iteration can move this to Redis when claims need to survive
across worker processes.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from app.utils.logger import get_logger

log = get_logger("ownership_verify")

# How long a successful verification is honored before the user must redo it.
VERIFICATION_TTL_SECONDS = 600  # 10 min
CHALLENGE_TTL_SECONDS = 300     # 5 min


@dataclass(frozen=True)
class OwnershipChallenge:
    device_ip: str
    challenge_id: str
    challenge_type: str  # "pin_display" | "mac_serial"
    pin: str | None = None
    expected_mac: str | None = None
    expected_serial: str | None = None
    created_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + CHALLENGE_TTL_SECONDS)

    def is_expired(self) -> bool:
        return time.time() > self.expires_at


def _normalize_mac(mac: str) -> str:
    return mac.upper().replace(":", "").replace("-", "").replace(".", "").strip()


class OwnershipVerificationService:
    """Enforces ownership challenges and remembers who passed them."""

    def __init__(self) -> None:
        self._challenges: dict[str, OwnershipChallenge] = {}          # ip → challenge
        self._verified: dict[tuple[str, str], float] = {}             # (user_id, ip) → expires_at

    # ── PIN flow ──────────────────────────────────────────────────────

    async def start_pin_challenge(self, device_ip: str) -> OwnershipChallenge:
        pin = f"{secrets.randbelow(1_000_000):06d}"
        challenge = OwnershipChallenge(
            device_ip=device_ip,
            challenge_id=secrets.token_urlsafe(16),
            challenge_type="pin_display",
            pin=pin,
        )
        self._challenges[device_ip] = challenge
        log.info("ownership.pin_challenge_created", ip=device_ip, id=challenge.challenge_id)
        return challenge

    async def verify_pin(self, user_id: str, device_ip: str, user_pin: str) -> tuple[bool, str]:
        challenge = self._challenges.get(device_ip)
        if challenge is None:
            return False, "No active challenge. Start a new PIN challenge first."
        if challenge.is_expired():
            del self._challenges[device_ip]
            return False, "Challenge expired. Please start a new one."
        if challenge.pin is None:
            return False, "This challenge does not use PIN verification."

        if user_pin.strip() != challenge.pin:
            log.warning("ownership.pin_mismatch", ip=device_ip, user_id=user_id)
            # never leak the expected PIN in the response — that would defeat the brute-force barrier
            return False, "PIN does not match what the device displayed."

        del self._challenges[device_ip]
        self._mark_verified(user_id, device_ip)
        log.info("ownership.pin_verified", ip=device_ip, user_id=user_id)
        return True, f"Ownership of {device_ip} verified."

    # ── MAC / serial flow ─────────────────────────────────────────────

    async def start_mac_serial_challenge(
        self, device_ip: str, *, expected_mac: str, expected_serial: str | None = None
    ) -> OwnershipChallenge:
        challenge = OwnershipChallenge(
            device_ip=device_ip,
            challenge_id=secrets.token_urlsafe(16),
            challenge_type="mac_serial",
            expected_mac=expected_mac,
            expected_serial=expected_serial,
        )
        self._challenges[device_ip] = challenge
        log.info("ownership.mac_challenge_created", ip=device_ip, id=challenge.challenge_id)
        return challenge

    async def verify_mac_serial(
        self,
        user_id: str,
        device_ip: str,
        user_mac: str,
        user_serial: str | None = None,
    ) -> tuple[bool, str]:
        challenge = self._challenges.get(device_ip)
        if challenge is None:
            return False, "No active challenge. Start a MAC challenge first."
        if challenge.is_expired():
            del self._challenges[device_ip]
            return False, "Challenge expired. Please start a new one."
        if challenge.challenge_type != "mac_serial":
            return False, "This challenge does not use MAC/serial verification."

        if _normalize_mac(user_mac) != _normalize_mac(challenge.expected_mac or ""):
            log.warning("ownership.mac_mismatch", ip=device_ip, user_id=user_id)
            return False, "MAC address does not match what we saw on the wire."

        if challenge.expected_serial:
            if not user_serial or user_serial.strip().upper() != challenge.expected_serial.upper():
                return False, "Serial number does not match."

        del self._challenges[device_ip]
        self._mark_verified(user_id, device_ip)
        log.info("ownership.mac_verified", ip=device_ip, user_id=user_id)
        return True, f"Ownership of {device_ip} verified."

    # ── enforcement gate (claim service calls this) ────────────────────

    def is_verified(self, user_id: str, device_ip: str) -> bool:
        """Return True if this user proved ownership of this IP recently."""
        key = (user_id, device_ip)
        expiry = self._verified.get(key)
        if expiry is None:
            return False
        if time.time() > expiry:
            del self._verified[key]
            return False
        return True

    def consume_verification(self, user_id: str, device_ip: str) -> bool:
        """Like ``is_verified`` but single-use — burns the token on success.

        Used by the claim service so a single PIN entry can't be replayed to
        claim the device multiple times.
        """
        if not self.is_verified(user_id, device_ip):
            return False
        self._verified.pop((user_id, device_ip), None)
        return True

    def _mark_verified(self, user_id: str, device_ip: str) -> None:
        self._verified[(user_id, device_ip)] = time.time() + VERIFICATION_TTL_SECONDS

    # ── inspection ─────────────────────────────────────────────────────

    def get_challenge_status(self, device_ip: str) -> dict[str, Any] | None:
        challenge = self._challenges.get(device_ip)
        if challenge is None:
            return None
        if challenge.is_expired():
            del self._challenges[device_ip]
            return None
        return {
            "challenge_id": challenge.challenge_id,
            "challenge_type": challenge.challenge_type,
            "expires_in": int(challenge.expires_at - time.time()),
            "requires_mac": challenge.expected_mac is not None,
            "requires_serial": challenge.expected_serial is not None,
        }


_ownership_verify_service: OwnershipVerificationService | None = None


def get_ownership_verify_service() -> OwnershipVerificationService:
    global _ownership_verify_service
    if _ownership_verify_service is None:
        _ownership_verify_service = OwnershipVerificationService()
    return _ownership_verify_service
