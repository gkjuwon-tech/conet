"""AdminGateway — centralized device approval orchestration.

The user signs into vendor cloud accounts (Google / Apple / LG / Samsung)
ONCE on their laptop.  All discovered LAN devices then queue up here
for unified one-click bootstrap.  The gateway picks the lightest legal
path per device:

  *  LG TV       -> SSAP register + cached client-key (1st remote OK only)
  *  Chromecast  -> Google Cast / DIAL with account OAuth
  *  Roku        -> ECP API (open standard, no auth)
  *  Sony BRAVIA -> ADB tcpip (one-time enable in TV settings, then 0-tap)
  *  Phones      -> Captive portal autopopup (OS-standard 1-tap)
  *  IoT clouds  -> Vendor OAuth (Hue, Sonos, Tuya, SmartThings, ThinQ)

We never bypass firmware.  We use what the vendor already exposes, and
route every approval prompt that *would* normally appear on a remote
control or a phone notification to a single dashboard on the laptop.
"""
from app.services.admin_gateway.gateway import (
    AdminGateway,
    ApprovalResult,
    ApprovalStatus,
    PendingApproval,
    get_admin_gateway,
)

__all__ = [
    "AdminGateway",
    "ApprovalResult",
    "ApprovalStatus",
    "PendingApproval",
    "get_admin_gateway",
]
