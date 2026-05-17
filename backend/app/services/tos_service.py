"""
ElectroMesh Terms of Service (ToS) gate — strict ownership consent.

Before any /v1/claim/* operation, the user must read and accept this
agreement. It explicitly states that pairing requires proving control
via a PIN / MAC challenge, and that no DNS interception, ARP
impersonation, rogue DHCP, captive portals, or any other "zero-friction"
trick is performed.

The previous v4 ToS allowed an "Aggressive Mode" that pushed traffic
through the laptop. That entire pathway has been removed from the code,
and the ToS has been rewritten in v5 to reflect the new strict model.

TOS_VERSION is bumped when the consent scope changes. Users who accepted
an older version must re-accept.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.db.session import transactional
from app.logging_setup import get_logger

log = get_logger("tos")

# Bumped to 5.0.0: aggressive / FakeDNS / DHCP-race / IPv6-RA-DNS removed.
TOS_VERSION = "5.0.0"

# The actual agreement text served to the frontend.
TOS_CONTENT = {
    "version": TOS_VERSION,
    "title": "ElectroMesh 기기 등록 서비스 이용 약관",
    "subtitle": "Device Pairing Service Terms of Use",
    "last_updated": "2026-05-17",
    "sections": [
        {
            "heading": "사용되는 기술 (Technologies Used)",
            "items": [
                {
                    "tech": "Network Discovery",
                    "icon": "📡",
                    "description_ko": "ARP, mDNS, SSDP, 포트 스캔을 통해 본인 LAN의 기기를 나열합니다. 다른 기기에 어떤 변경도 가하지 않는 수동 탐지입니다.",
                    "description_en": "Lists devices on your LAN via ARP / mDNS / SSDP / port scans. This is passive discovery only — no other device is modified in any way.",
                },
                {
                    "tech": "Ownership PIN Challenge",
                    "icon": "🔢",
                    "description_ko": "ElectroMesh 백엔드가 발급한 6자리 PIN을 기기 화면에서 직접 보고 입력해야 합니다. 화면을 볼 수 없으면 기기를 소유하지 않은 것입니다.",
                    "description_en": "A 6-digit PIN is issued by the ElectroMesh backend and must be read off the device's own screen and typed back. If you cannot see the screen, you don't own the device.",
                },
                {
                    "tech": "Ownership MAC / Serial Challenge",
                    "icon": "🆔",
                    "description_ko": "기기 설정 메뉴에 들어가야만 볼 수 있는 MAC 주소·시리얼 번호를 입력하여 물리적 접근 권한을 증명합니다.",
                    "description_en": "Type the MAC address and / or serial number printed inside the device's settings menu to prove physical / admin access to it.",
                },
                {
                    "tech": "ADB (Android Debug Bridge)",
                    "icon": "📱",
                    "description_ko": "본인이 'USB / 무선 디버깅'을 직접 켜둔 Android 기기에만 에이전트를 설치합니다.",
                    "description_en": "Installs the agent only on Android devices where you have explicitly enabled USB / wireless debugging yourself.",
                },
                {
                    "tech": "SSH Remote Access",
                    "icon": "🔑",
                    "description_ko": "본인이 SSH 자격증명을 가진 라우터·NAS 등에만 에이전트를 설치합니다.",
                    "description_en": "Installs the agent only on routers / NAS boxes where you already hold the SSH credentials.",
                },
                {
                    "tech": "Vendor Local API",
                    "icon": "🔌",
                    "description_ko": "본인이 제조사 앱에서 사전 페어링한 Local API(SmartThings, ThinQ, Hue 등)를 통해 에이전트를 등록합니다.",
                    "description_en": "Registers the agent through vendor-provided local APIs (SmartThings, ThinQ, Hue, etc.) that you have already paired in the vendor's own app.",
                },
            ],
        },
        {
            "heading": "동의 사항 (Agreements)",
            "items_text": [
                "본 서비스로 등록하는 모든 기기는 본인 소유이거나, 소유주의 명시적·서면 허락을 받은 기기임을 확인합니다. / I confirm every device I pair through this service is either mine, or I have explicit written permission from its owner.",
                "본 LAN은 본인이 정당한 사용 권한을 가진 사적 네트워크(집·사무실)이며, 공용 WiFi(학교·카페·호텔·공항 등)가 아닙니다. / This LAN is a private network I am authorized to use (home / office), not a public WiFi (school / café / hotel / airport, etc.).",
                "기기 등록 전 PIN 또는 MAC·시리얼 인증을 통과해야 하며, 그 외 어떤 자동·무인 등록 경로도 존재하지 않음을 이해합니다. / I understand pairing requires passing a PIN or MAC / serial challenge per device, and that no automatic or zero-friction enrollment path exists.",
                "타인 소유 기기(학교 TV·매장 디스플레이·공용 셋톱박스 등)에 본 서비스를 사용하는 행위는 약관 위반이며 즉시 계정 정지 및 법적 책임의 대상이 됩니다. / Using this service against devices owned by others (school TVs, retail displays, shared set-top boxes, etc.) is a ToS violation that triggers immediate account suspension and potential legal liability.",
                "수집되는 데이터: 기기 타입, CPU 사용률, 네트워크 상태 (개인정보 없음). / Data collected: device type, CPU usage, network status (no personal data).",
                "언제든지 개별 기기의 등록을 해제할 수 있으며, ElectroMesh는 등록된 기기의 핵심 기능(TV 시청·냉장 등)에 영향을 주지 않습니다. / You can release any device at any time; ElectroMesh does not affect a paired device's primary functions (watching TV, refrigeration, etc.).",
            ],
        },
    ],
}


class TosService:
    """Gate that blocks claim operations until the user has accepted the ToS."""

    def __init__(self) -> None:
        # In-memory cache: user_id → accepted version string.
        self._accepted: dict[str, str] = {}

    def get_tos_content(self) -> dict[str, Any]:
        """Return the full ToS payload for the frontend to render."""
        return TOS_CONTENT

    async def accept(
        self,
        session: AsyncSession,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        """Record that the user has accepted the current ToS version."""
        async with transactional(session):
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if user is None:
                raise ValueError("user not found")

            meta = dict(user.metadata_ or {})
            meta["tos_accepted_version"] = TOS_VERSION
            meta["tos_accepted_at"] = time.time()
            user.metadata_ = meta
            await session.flush()

        self._accepted[user_id] = TOS_VERSION
        log.info(
            "tos.accepted",
            user_id=user_id,
            version=TOS_VERSION,
        )
        return {
            "accepted": True,
            "version": TOS_VERSION,
            "accepted_at": meta["tos_accepted_at"],
        }

    async def check(
        self,
        session: AsyncSession,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        """Check if the user has accepted the current ToS version."""
        # Fast path: in-memory cache
        cached = self._accepted.get(user_id)
        if cached == TOS_VERSION:
            return {"accepted": True, "version": TOS_VERSION}

        # Slow path: DB
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if user is None:
            return {"accepted": False, "version": TOS_VERSION}

        meta = user.metadata_ or {}
        accepted_ver = meta.get("tos_accepted_version")
        if accepted_ver == TOS_VERSION:
            self._accepted[user_id] = TOS_VERSION
            return {
                "accepted": True,
                "version": TOS_VERSION,
                "accepted_at": meta.get("tos_accepted_at"),
            }

        return {
            "accepted": False,
            "version": TOS_VERSION,
            "outdated_version": accepted_ver,
        }

    def is_accepted_cached(self, user_id: str) -> bool:
        """Non-async fast check for middleware/guards."""
        return self._accepted.get(user_id) == TOS_VERSION


# Singleton
_TOS_SERVICE: TosService | None = None


def get_tos_service() -> TosService:
    global _TOS_SERVICE
    if _TOS_SERVICE is None:
        _TOS_SERVICE = TosService()
    return _TOS_SERVICE
