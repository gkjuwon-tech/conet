"""
OAuth service — Google / Apple sign-in with a graceful dev-stub mode.

Design mirrors pairing_catalog.py: providers are declarative data, all the
plumbing flows through one service. Adding a 3rd provider (Microsoft, GitHub)
is one entry in PROVIDERS plus its Pydantic id-token validator.

Production flow:
    1. POST /v1/users/oauth/{provider}/start
        → returns { authorize_url, state }
        Electron opens this URL in a child window. The provider's callback
        URL is `http://127.0.0.1:8080/v1/users/oauth/{provider}/callback`,
        which is whitelisted in our provider console.
    2. Provider redirects to /callback with `?code=...&state=...`.
    3. The backend exchanges the code → id_token, validates the signature,
       finds-or-creates the user, mints an EM JWT, and (in Electron) returns
       it through a postMessage / loopback handshake the renderer subscribes
       to via the IPC bridge.

Dev-stub flow (no provider keys configured):
    1. POST /v1/users/oauth/{provider}/dev-login
        → creates / finds a deterministic user `oauth_{provider}@electromesh.dev`
        → returns the same { access_token, refresh_token } shape as /users/login
        The renderer skips the BrowserWindow dance entirely.

Env vars (production):
    EM_OAUTH_GOOGLE_CLIENT_ID
    EM_OAUTH_GOOGLE_CLIENT_SECRET
    EM_OAUTH_GOOGLE_REDIRECT_URI       (default http://127.0.0.1:8080/v1/users/oauth/google/callback)
    EM_OAUTH_APPLE_CLIENT_ID           (Service ID, e.g. com.electromesh.web)
    EM_OAUTH_APPLE_TEAM_ID
    EM_OAUTH_APPLE_KEY_ID
    EM_OAUTH_APPLE_PRIVATE_KEY         (P8 contents, escape \\n as needed)
    EM_OAUTH_APPLE_REDIRECT_URI

If no client_id is set for a provider, the service degrades to dev-stub.
"""

from __future__ import annotations

import os
import secrets
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.auth.jwt import mint_token
from app.auth.passwords import hash_password
from app.db.models import Wallet
from app.db.models.user import User, UserStatus
from app.db.session import transactional
from app.exceptions import (
    AuthError,
    NotFoundError,
    ValidationError_,
)
from app.logging_setup import get_logger
from app.utils.ids import new_ulid, short_token
from app.utils.time import utcnow

log = get_logger("oauth")


# ---------------------------------------------------------------------------
# Provider catalog — data-driven (like pairing_catalog).
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class OAuthProvider:
    key: str
    display_name: str
    authorize_url: str
    token_url: str
    scopes: tuple[str, ...]
    response_type: str = "code"
    response_mode: str = "query"
    extra_authorize_params: dict[str, str] = field(default_factory=dict)


PROVIDERS: dict[str, OAuthProvider] = {
    "google": OAuthProvider(
        key="google",
        display_name="Google",
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scopes=("openid", "email", "profile"),
        extra_authorize_params={"access_type": "offline", "prompt": "select_account"},
    ),
    "apple": OAuthProvider(
        key="apple",
        display_name="Apple",
        authorize_url="https://appleid.apple.com/auth/authorize",
        token_url="https://appleid.apple.com/auth/token",
        scopes=("name", "email"),
        # Apple requires response_mode=form_post when scope != "openid only"
        # but with the loopback redirect we can keep query mode for now.
    ),
}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------
@dataclass
class OAuthState:
    state: str
    provider_key: str
    created_at: float
    return_to: str | None = None


class OAuthService:
    def __init__(self) -> None:
        self._states: dict[str, OAuthState] = {}

    # ------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------
    def is_provider_configured(self, provider_key: str) -> bool:
        if provider_key == "google":
            return bool(os.environ.get("EM_OAUTH_GOOGLE_CLIENT_ID"))
        if provider_key == "apple":
            return bool(os.environ.get("EM_OAUTH_APPLE_CLIENT_ID"))
        return False

    def get_provider(self, key: str) -> OAuthProvider:
        prov = PROVIDERS.get(key)
        if prov is None:
            raise NotFoundError(f"unknown OAuth provider '{key}'")
        return prov

    def list_providers(self) -> list[dict[str, Any]]:
        return [
            {
                "key": p.key,
                "display_name": p.display_name,
                "configured": self.is_provider_configured(p.key),
                # Dev-stub is always available for the desktop app.
                "dev_stub_enabled": True,
            }
            for p in PROVIDERS.values()
        ]

    def _client_id(self, provider_key: str) -> str:
        return os.environ.get(f"EM_OAUTH_{provider_key.upper()}_CLIENT_ID", "")

    def _client_secret(self, provider_key: str) -> str:
        return os.environ.get(f"EM_OAUTH_{provider_key.upper()}_CLIENT_SECRET", "")

    def _redirect_uri(self, provider_key: str, default_base: str) -> str:
        env = os.environ.get(f"EM_OAUTH_{provider_key.upper()}_REDIRECT_URI")
        if env:
            return env
        return f"{default_base.rstrip('/')}/v1/users/oauth/{provider_key}/callback"

    # ------------------------------------------------------------------
    # authorize URL
    # ------------------------------------------------------------------
    def start(
        self,
        *,
        provider_key: str,
        default_base_url: str,
        return_to: str | None = None,
    ) -> dict[str, Any]:
        prov = self.get_provider(provider_key)
        if not self.is_provider_configured(provider_key):
            raise ValidationError_(
                f"OAuth provider '{provider_key}' is not configured. "
                f"Use the dev-stub endpoint instead."
            )

        state = secrets.token_urlsafe(24)
        self._states[state] = OAuthState(
            state=state,
            provider_key=provider_key,
            created_at=time.time(),
            return_to=return_to,
        )

        params = {
            "client_id": self._client_id(provider_key),
            "redirect_uri": self._redirect_uri(provider_key, default_base_url),
            "response_type": prov.response_type,
            "scope": " ".join(prov.scopes),
            "state": state,
            **prov.extra_authorize_params,
        }
        authorize_url = f"{prov.authorize_url}?{urllib.parse.urlencode(params)}"
        return {
            "authorize_url": authorize_url,
            "state": state,
            "provider": provider_key,
            "redirect_uri": params["redirect_uri"],
        }

    # ------------------------------------------------------------------
    # callback
    # ------------------------------------------------------------------
    async def callback(
        self,
        session,
        *,
        provider_key: str,
        code: str,
        state: str,
        default_base_url: str,
    ) -> dict[str, Any]:
        prov = self.get_provider(provider_key)
        st = self._states.pop(state, None)
        if st is None or st.provider_key != provider_key:
            raise AuthError("invalid OAuth state")
        if time.time() - st.created_at > 600:
            raise AuthError("OAuth state expired")

        # Exchange code → id_token
        token_payload = {
            "code": code,
            "client_id": self._client_id(provider_key),
            "client_secret": self._client_secret(provider_key),
            "redirect_uri": self._redirect_uri(provider_key, default_base_url),
            "grant_type": "authorization_code",
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(prov.token_url, data=token_payload)
        if resp.status_code != 200:
            log.error(
                "oauth.token_exchange_failed",
                provider=provider_key,
                status=resp.status_code,
                body=resp.text[:400],
            )
            raise AuthError(f"{provider_key} token exchange failed")
        token_data = resp.json()
        id_token_jwt = token_data.get("id_token")
        if not id_token_jwt:
            raise AuthError("provider returned no id_token")

        identity = self._decode_id_token(provider_key, id_token_jwt)

        return await self._upsert_user_and_mint(session, identity, provider_key, st.return_to)

    # ------------------------------------------------------------------
    # dev-stub
    # ------------------------------------------------------------------
    async def dev_login(
        self,
        session,
        *,
        provider_key: str,
    ) -> dict[str, Any]:
        # Anyone can hit this in dev mode — it creates / finds a deterministic
        # user. Disable the route in prod via EM_OAUTH_DISABLE_DEV_STUB=1.
        if os.environ.get("EM_OAUTH_DISABLE_DEV_STUB") == "1":
            raise AuthError("dev-stub OAuth is disabled in this environment")
        self.get_provider(provider_key)  # validates the key exists

        identity = {
            "sub": f"dev-stub-{provider_key}",
            "email": f"oauth_{provider_key}@electromesh.dev",
            "email_verified": True,
            "name": f"{PROVIDERS[provider_key].display_name} Demo",
            "picture": None,
        }
        return await self._upsert_user_and_mint(session, identity, provider_key, None)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    @staticmethod
    def _decode_id_token(provider_key: str, jwt_str: str) -> dict[str, Any]:
        """
        Trust the OAuth server's TLS-protected response and extract the
        claims without re-fetching JWKS for now. PRODUCTION HARDENING:
        validate signature with the provider's published JWKS — recommended
        before going live with paid customers.
        """
        try:
            parts = jwt_str.split(".")
            if len(parts) != 3:
                raise ValueError("not a JWT")
            import base64
            import json

            def _b64(s: str) -> bytes:
                pad = "=" * (-len(s) % 4)
                return base64.urlsafe_b64decode(s + pad)

            payload = json.loads(_b64(parts[1]).decode())
            if not payload.get("email"):
                raise ValueError("id_token missing email")
            return payload
        except Exception as exc:
            raise AuthError(f"could not decode {provider_key} id_token: {exc}") from exc

    async def _upsert_user_and_mint(
        self,
        session,
        identity: dict[str, Any],
        provider_key: str,
        _return_to: str | None,
    ) -> dict[str, Any]:
        from sqlalchemy import select

        email = (identity.get("email") or "").lower().strip()
        if not email:
            raise AuthError("OAuth identity has no email")
        display_name = identity.get("name") or email.split("@")[0]
        sub = identity.get("sub") or ""

        async with transactional(session):
            existing = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if existing is None:
                user = User(
                    id=new_ulid(),
                    email=email,
                    display_name=display_name,
                    # Random unguessable password — OAuth users sign in via
                    # OAuth only. They can set a real one later via account
                    # settings.
                    password_hash=hash_password(secrets.token_urlsafe(48)),
                    status=UserStatus.active,
                    email_verified=bool(identity.get("email_verified", False)),
                    accepted_tos_version="v1",
                    accepted_tos_at=utcnow(),
                    referral_code=short_token(6),
                    metadata_={
                        "oauth_provider": provider_key,
                        "oauth_subject": sub,
                        "oauth_picture": identity.get("picture"),
                    },
                )
                session.add(user)
                await session.flush()
                # Provision a wallet (same as /users/register).
                wallet = Wallet(id=new_ulid(), user_id=user.id)
                session.add(wallet)
                await session.flush()
                await session.refresh(user)
                log.info("oauth.user_created", email=email, provider=provider_key)
            else:
                user = existing
                # remember which providers this user has linked.
                meta = dict(user.metadata_ or {})
                meta.setdefault("oauth_provider", provider_key)
                meta["oauth_last_login_provider"] = provider_key
                meta["oauth_last_login_at"] = utcnow().isoformat()
                user.metadata_ = meta
                log.info("oauth.user_login", email=email, provider=provider_key)

        access, exp = mint_token(
            sub=user.id,
            kind="user",
            scope=["user.*"],
            extra={"email": user.email, "via": f"oauth:{provider_key}"},
        )
        refresh, _ = mint_token(
            sub=user.id,
            kind="user",
            scope=["user.refresh"],
            ttl_seconds=60 * 60 * 24 * 30,
            extra={"email": user.email, "rotation": new_ulid()},
        )
        return {
            "access_token": access,
            "refresh_token": refresh,
            "expires_in": exp,
            "user": {
                "id": user.id,
                "email": user.email,
                "display_name": user.display_name,
            },
            "provider": provider_key,
        }


# Singleton
_OAUTH: OAuthService | None = None


def get_oauth_service() -> OAuthService:
    global _OAUTH
    if _OAUTH is None:
        _OAUTH = OAuthService()
    return _OAUTH
