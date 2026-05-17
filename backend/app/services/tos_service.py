"""
ElectroMesh Terms of Service (ToS) gate — "약관 동의 없으면 니 기기 못 건드린다."

Before the aggressive claim engine touches ANYTHING on the user's LAN, the
user must read and accept a plain-language agreement that explains exactly
what ElectroMesh does:

    1. FakeDNS — intercept DNS queries so devices land on our captive portal
    2. ADB shell — push agents to Android-based devices over the local network
    3. SSH — install daemons on routers and NAS boxes
    4. Local API probing — talk to SmartThings / ThinQ / Hue bridges
    5. Network scanning — ARP, mDNS, SSDP, port scanning

The ToS gate is stored in-memory (per-process) and also persisted as a flag
on the User DB row's metadata. If the user hasn't accepted, every /v1/claim/*
endpoint (except /v1/claim/tos/*) returns 403.

TOS_VERSION is bumped when we add new attack vectors. Users who accepted an
older version must re-accept.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.db.session import transactional
from app.logging_setup import get_logger

log = get_logger("tos")

# Bump this when new attack vectors are added.
TOS_VERSION = "4.0.0"

# The actual agreement text served to the frontend.
TOS_CONTENT = {
    "version": TOS_VERSION,
    "title": "ElectroMesh 기기 점유 서비스 이용 약관",
    "subtitle": "Device Claim Service Terms of Use",
    "last_updated": "2026-05-11",
    "sections": [
        {
            "heading": "사용되는 기술 (Technologies Used)",
            "items": [
                {
                    "tech": "FakeDNS (DNS Spoofing)",
                    "icon": "🌐",
                    "description_ko": "로컬 네트워크 내 DNS 응답을 리디렉트하여 기기의 브라우저를 ElectroMesh 에이전트 페이지로 유도합니다.",
                    "description_en": "Redirects DNS responses on your local network to guide device browsers to the ElectroMesh agent page.",
                },
                {
                    "tech": "ADB (Android Debug Bridge)",
                    "icon": "📱",
                    "description_ko": "Android 기반 기기(TV, 셋톱박스 등)에 에이전트를 원격 설치합니다.",
                    "description_en": "Remotely installs the agent on Android-based devices (TVs, set-top boxes, etc.).",
                },
                {
                    "tech": "SSH Remote Access",
                    "icon": "🔑",
                    "description_ko": "라우터, NAS 등 SSH 접근 가능한 기기에 에이전트 데몬을 설치합니다.",
                    "description_en": "Installs agent daemons on SSH-accessible devices like routers and NAS boxes.",
                },
                {
                    "tech": "Local API Probing",
                    "icon": "🔌",
                    "description_ko": "IoT 기기의 제조사 로컬 API(SmartThings, ThinQ, Hue 등)를 통해 유휴 자원을 활용합니다.",
                    "description_en": "Utilizes idle resources through manufacturer local APIs (SmartThings, ThinQ, Hue, etc.).",
                },
                {
                    "tech": "Network Scanning",
                    "icon": "📡",
                    "description_ko": "ARP, mDNS, SSDP, 포트 스캔을 통해 로컬 네트워크 내 기기를 탐지합니다.",
                    "description_en": "Detects devices on your local network via ARP, mDNS, SSDP, and port scanning.",
                },
                {
                    "tech": "Aggressive Mode — ARP Gateway Impersonation",
                    "icon": "⚔️",
                    "description_ko": "본 PC가 본인 공유기인 척하는 ARP 패킷을 브로드캐스트하여, 본인 LAN의 모든 기기가 DNS·HTTP 트래픽을 본 PC로 보내도록 유도합니다. 공유기 설정 변경 없이도 캡티브 포탈을 강제할 수 있게 해주는 핵심 기술입니다. 본 PC가 꺼지면 트래픽은 즉시 정상화됩니다.",
                    "description_en": "Broadcasts gratuitous ARP frames so this PC appears to be your router, redirecting all DNS/HTTP traffic from devices on your LAN to this PC. Enables captive-portal enforcement without touching router settings. Reverts instantly when this PC stops.",
                },
                {
                    "tech": "Aggressive Mode — Rogue DHCP Race",
                    "icon": "🏁",
                    "description_ko": "본인 LAN에서 새로 와이파이에 붙는 기기(주로 폰)가 DHCP 요청을 보낼 때, 본 PC가 진짜 공유기보다 먼저 응답하여 본 PC를 DNS 서버로 지정합니다. 기존 lease 갱신 시점에만 발동하며 IP 자체는 공유기 풀과 동일하게 할당됩니다.",
                    "description_en": "When a device (mostly phones) joins WiFi and sends DHCPDISCOVER, this PC races the real router's DHCPOFFER and assigns itself as the DNS server. Triggers only on lease renewal; IP allocation matches the router's pool.",
                },
                {
                    "tech": "Aggressive Mode — IPv6 RA DNS Injection",
                    "icon": "🛰️",
                    "description_ko": "ICMPv6 Router Advertisement에 RDNSS 옵션을 실어 송출, 모든 IPv6 지원 기기가 본 PC를 IPv6 DNS 서버로 등록하게 합니다. 현대 스마트폰/TV 99%가 IPv6 SLAAC를 켜둔 채라서 이 경로가 가장 조용히 동작합니다.",
                    "description_en": "Sends ICMPv6 Router Advertisements with the RDNSS option, causing all IPv6-capable devices to register this PC as an IPv6 DNS server. 99% of modern phones/TVs have IPv6 SLAAC on by default — this path is the quietest.",
                },
            ],
        },
        {
            "heading": "동의 사항 (Agreements)",
            "items_text": [
                "위 기술이 적용되는 모든 기기는 본인 소유이거나 동거 가족 등 소유주의 명시적 허락을 받은 기기임을 확인합니다. / I confirm that all affected devices are mine, or that I have explicit permission from the owner (e.g. household members).",
                "본 LAN은 본인이 정당히 사용 권한을 가진 사적 네트워크이며 (집/사무실), 공용 WiFi(스타벅스, 호텔, 공항 등)가 아님을 확인합니다. / I confirm this LAN is a private network I am authorized to use (home/office), not a public WiFi network (cafés, hotels, airports, etc.).",
                "Aggressive Mode (ARP / DHCP / IPv6 RA) 활성화 시 본 LAN의 모든 기기 트래픽이 일시적으로 본 PC를 거치며, 본인은 그 결과(예: 가족 기기의 일시적 DNS 지연)에 대한 책임을 진다는 점에 동의합니다. / When Aggressive Mode is active, all device traffic on this LAN transiently routes through this PC, and I accept responsibility for the consequences (e.g. brief DNS hiccups on family devices).",
                "기기의 주요 기능(TV 시청, 냉장 등)에는 영향을 주지 않습니다. / Primary device functions are not affected.",
                "언제든지 개별 기기의 점유를 해제할 수 있으며, 본 PC를 끄면 모든 LAN 조작이 30초 내 자연 복구됩니다. / You can release any device at any time; shutting down this PC reverts all LAN manipulation within 30 seconds.",
                "수집되는 데이터: 기기 타입, CPU 사용률, 네트워크 상태 (개인정보 없음). / Data collected: device type, CPU usage, network status (no personal data).",
                "이 서비스는 제3자 기기에 대한 무단 접근을 위한 것이 아닙니다. 공용 WiFi에서의 Aggressive Mode 사용은 약관 위반이며 즉시 계정 정지됩니다. / This service is not intended for unauthorized access. Using Aggressive Mode on public WiFi is a ToS violation and triggers immediate account suspension.",
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
