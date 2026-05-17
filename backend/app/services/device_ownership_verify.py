"""
Device Ownership Verification Service

SECURITY-CRITICAL: Prevents claiming devices that belong to others.
Users MUST verify they own/control a device before it can be paired.

Supported verification methods (in order of strength):
1. PIN Challenge-Response (device must support display output)
   - Server generates 6-digit PIN
   - Device displays PIN (via API endpoint, HTML page, or console)
   - User enters PIN in console to prove physical/network access

2. MAC Address + Serial Number Validation
   - User provides expected MAC/serial from device settings
   - Must match discovered fingerprint exactly
   - Prevents spoofing via ARP/DHCP

3. Challenge via Vendor-Specific API
   - Device-specific endpoints (SSAP, webOS, Bravia, etc.)
   - Sends challenge request to device
   - Requires device response to confirm ownership

4. Physical Proximity (future)
   - BLE/Bluetooth handshake (device within range)
   - QR code scan (physical proximity to display)
   - NFC tap (physical interaction)
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Device
from app.utils.logger import get_logger

log = get_logger("ownership_verify")


@dataclass(frozen=True)
class OwnershipChallenge:
    """A single ownership verification challenge for a device."""
    device_ip: str
    challenge_id: str
    challenge_type: str  # "pin_display", "mac_serial", "api_challenge", "ble_proximity"
    pin: str | None = None  # 6-digit PIN for pin_display
    expected_mac: str | None = None  # Expected MAC for mac_serial
    expected_serial: str | None = None  # Expected serial for mac_serial
    created_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + 300)  # 5 min

    def is_expired(self) -> bool:
        return time.time() > self.expires_at


class OwnershipVerificationService:
    """Enforce device ownership verification before allowing claims."""

    def __init__(self) -> None:
        # In-memory challenge store (ip → challenge)
        # Production would use Redis or database
        self._challenges: dict[str, OwnershipChallenge] = {}

    async def start_pin_challenge(self, device_ip: str) -> OwnershipChallenge:
        """Generate a PIN challenge for the device to display.

        The device must show this PIN to the user via:
        - Web UI endpoint (http://device-ip/ownership-challenge)
        - Display output (TV screen, speaker app, etc.)
        - Terminal/SSH session

        User then enters the PIN in the console to prove they can see the device.
        """
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

    async def start_mac_serial_challenge(
        self, device_ip: str, expected_mac: str, expected_serial: str | None = None
    ) -> OwnershipChallenge:
        """Challenge user to provide MAC address (and optionally serial) from their device.

        User provides these details to prove they have physical/administrative access
        to the device's settings.
        """
        challenge = OwnershipChallenge(
            device_ip=device_ip,
            challenge_id=secrets.token_urlsafe(16),
            challenge_type="mac_serial",
            expected_mac=expected_mac,
            expected_serial=expected_serial,
        )
        self._challenges[device_ip] = challenge
        log.info("ownership.mac_serial_challenge_created", ip=device_ip, id=challenge.challenge_id)
        return challenge

    async def verify_pin(self, device_ip: str, user_pin: str) -> tuple[bool, str]:
        """Verify the PIN the user entered matches the device's PIN.

        Returns (success, message).
        """
        challenge = self._challenges.get(device_ip)

        if challenge is None:
            return False, "No active challenge for this device. Start a new challenge first."

        if challenge.is_expired():
            del self._challenges[device_ip]
            return False, "Challenge expired. Please start a new challenge."

        if challenge.pin is None:
            return False, "This challenge does not use PIN verification."

        if user_pin.strip() == challenge.pin:
            # Success — remove challenge
            del self._challenges[device_ip]
            log.info("ownership.pin_verified", ip=device_ip)
            return True, f"PIN verified! Device {device_ip} is now verified as owned by you."

        return False, f"PIN mismatch. Expected {challenge.pin}, got {user_pin.strip()}."

    async def verify_mac_serial(
        self, device_ip: str, user_mac: str, user_serial: str | None = None
    ) -> tuple[bool, str]:
        """Verify the MAC (and optionally serial) the user provided matches the device's.

        User should have retrieved these from the device's physical label or network settings.
        """
        challenge = self._challenges.get(device_ip)

        if challenge is None:
            return False, "No active challenge for this device. Start a new challenge first."

        if challenge.is_expired():
            del self._challenges[device_ip]
            return False, "Challenge expired. Please start a new challenge."

        if challenge.challenge_type != "mac_serial":
            return False, "This challenge does not use MAC/serial verification."

        # Normalize MAC address (remove colons/hyphens)
        normalized_user_mac = user_mac.upper().replace(":", "").replace("-", "")
        normalized_expected_mac = (challenge.expected_mac or "").upper().replace(":", "").replace("-", "")

        if normalized_user_mac != normalized_expected_mac:
            return False, f"MAC address mismatch. Please check your device's MAC address."

        if challenge.expected_serial:
            if user_serial and user_serial.upper() != challenge.expected_serial.upper():
                return False, f"Serial number mismatch. Please check your device's serial."

        # Success
        del self._challenges[device_ip]
        log.info("ownership.mac_serial_verified", ip=device_ip)
        return True, f"Device {device_ip} verified as owned by you."

    def get_challenge_status(self, device_ip: str) -> dict[str, Any] | None:
        """Get the current challenge status for a device."""
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
            "pin": challenge.pin if challenge.challenge_type == "pin_display" else None,
            "requires_mac": challenge.expected_mac is not None,
            "requires_serial": challenge.expected_serial is not None,
        }


# Singleton instance
_ownership_verify_service: OwnershipVerificationService | None = None


def get_ownership_verify_service() -> OwnershipVerificationService:
    global _ownership_verify_service
    if _ownership_verify_service is None:
        _ownership_verify_service = OwnershipVerificationService()
    return _ownership_verify_service
