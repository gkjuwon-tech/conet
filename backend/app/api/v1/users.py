from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.auth.jwt import mint_token
from app.auth.passwords import hash_password, verify_password
from app.db.models import Device, User, Wallet
from app.db.models.device import DeviceStatus
from app.db.models.user import UserStatus
from app.db.session import get_session, transactional
from app.exceptions import AuthError, ConflictError, NotFoundError
from app.services.oauth import get_oauth_service
from app.schemas.user import (
    TokenPair,
    UserCreate,
    UserDashboard,
    UserLogin,
    UserPublic,
    UserUpdate,
    WalletSummary,
)
from app.services.settlement import estimate_user_24h_earnings
from app.utils.ids import new_ulid, short_token
from app.utils.time import utcnow

router = APIRouter(prefix="/users", tags=["users"])


@router.post("/register", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def register_user(
    payload: UserCreate, session: AsyncSession = Depends(get_session)
) -> UserPublic:
    async with transactional(session):
        existing = await session.execute(select(User).where(User.email == str(payload.email)))
        if existing.scalar_one_or_none() is not None:
            raise ConflictError("email already registered").as_http()

        user = User(
            id=new_ulid(),
            email=str(payload.email),
            display_name=payload.display_name,
            password_hash=hash_password(payload.password.get_secret_value()),
            status=UserStatus.active,
            country_code=payload.country_code,
            timezone=payload.timezone,
            locale=payload.locale,
            accepted_tos_at=utcnow(),
            accepted_tos_version=payload.accepted_tos_version,
            referral_code=short_token(6),
            referred_by=payload.referral_code,
        )
        session.add(user)
        await session.flush()

        wallet = Wallet(id=new_ulid(), user_id=user.id)
        session.add(wallet)

    return UserPublic.model_validate(user)


@router.post("/login", response_model=TokenPair)
async def login(
    payload: UserLogin, session: AsyncSession = Depends(get_session)
) -> TokenPair:
    user = (await session.execute(
        select(User).where(User.email == str(payload.email))
    )).scalar_one_or_none()
    if user is None or not verify_password(payload.password.get_secret_value(), user.password_hash):
        raise AuthError("invalid credentials").as_http()
    if user.status not in (UserStatus.active, UserStatus.pending):
        raise AuthError("account not active").as_http()

    access, exp = mint_token(sub=user.id, kind="user", scope=["user.*"])
    refresh, _ = mint_token(sub=user.id, kind="user", scope=["refresh"], ttl_seconds=60 * 60 * 24 * 14)
    return TokenPair(access_token=access, refresh_token=refresh, expires_in=exp)


@router.get("/me", response_model=UserPublic)
async def me(principal: Principal = Depends(require_user)) -> UserPublic:
    return UserPublic.model_validate(principal.user)


@router.patch("/me", response_model=UserPublic)
async def update_me(
    payload: UserUpdate,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> UserPublic:
    async with transactional(session):
        user = await session.get(User, principal.user.id, with_for_update=True)
        if user is None:
            raise NotFoundError("user not found").as_http()
        if payload.display_name is not None:
            user.display_name = payload.display_name
        if payload.country_code is not None:
            user.country_code = payload.country_code
        if payload.timezone is not None:
            user.timezone = payload.timezone
        if payload.locale is not None:
            user.locale = payload.locale
        if payload.payout_method is not None:
            user.payout_method = payload.payout_method
        if payload.settings is not None:
            user.settings = {**(user.settings or {}), **payload.settings}
    return UserPublic.model_validate(user)


@router.get("/me/dashboard", response_model=UserDashboard)
async def dashboard(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> UserDashboard:
    user = principal.user
    wallet = (await session.execute(
        select(Wallet).where(Wallet.user_id == user.id)
    )).scalar_one_or_none()
    if wallet is None:
        wallet = Wallet(id=new_ulid(), user_id=user.id)
        session.add(wallet)
        await session.commit()

    online_stmt = select(func.count(Device.id)).where(
        Device.owner_id == user.id,
        Device.status.in_((DeviceStatus.idle, DeviceStatus.leased, DeviceStatus.benchmarking)),
    )
    total_stmt = select(func.count(Device.id)).where(Device.owner_id == user.id)
    online = int((await session.execute(online_stmt)).scalar_one() or 0)
    total = int((await session.execute(total_stmt)).scalar_one() or 0)

    earnings_24h = await estimate_user_24h_earnings(session, user.id)

    return UserDashboard(
        user=UserPublic.model_validate(user),
        wallet=WalletSummary(
            available_cents=wallet.available_cents,
            pending_cents=wallet.pending_cents,
            held_cents=wallet.held_cents,
            lifetime_earned_cents=wallet.lifetime_earned_cents,
            lifetime_paid_cents=wallet.lifetime_paid_cents,
            last_activity_at=wallet.last_activity_at,
        ),
        devices_online=online,
        devices_total=total,
        last_24h_earnings_cents=earnings_24h,
        pending_payout_cents=wallet.held_cents,
    )


# ───────────────────────────────────────────────────────────────────────────
# OAuth (Google / Apple) — production-grade with a graceful dev-stub.
# ───────────────────────────────────────────────────────────────────────────
@router.get("/oauth/providers")
async def oauth_providers() -> dict:
    """Public — desktop & web both call this to know which buttons to show."""
    return {"providers": get_oauth_service().list_providers()}


@router.post("/oauth/{provider}/start")
async def oauth_start(
    provider: str,
    request: Request,
) -> dict:
    """
    Returns the provider's authorize_url. The renderer (Electron BrowserWindow,
    or a web tab) navigates the user to it.
    """
    base_url = str(request.base_url).rstrip("/")
    return get_oauth_service().start(provider_key=provider, default_base_url=base_url)


@router.get("/oauth/{provider}/callback", response_class=HTMLResponse)
async def oauth_callback(
    provider: str,
    request: Request,
    code: str = Query(...),
    state: str = Query(...),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    """
    The provider redirects here. We exchange the code, mint our JWT, and
    return a tiny HTML page that posts the tokens back to the parent window
    (for desktop) or redirects to /onboarding with a one-shot fragment.
    """
    base_url = str(request.base_url).rstrip("/")
    try:
        result = await get_oauth_service().callback(
            session,
            provider_key=provider,
            code=code,
            state=state,
            default_base_url=base_url,
        )
    except AuthError as e:
        return HTMLResponse(
            f"<h1>Sign-in failed</h1><pre>{e.message}</pre>",
            status_code=401,
        )

    # Pop a tiny page that the Electron main process scrapes via a
    # webRequest listener. Same code also works in pure web flow because
    # window.opener.postMessage will land in the parent tab.
    payload = (
        f"window.opener && window.opener.postMessage("
        f"{{type:'em-oauth',ok:true,result:{__quote(result)}}},'*');"
        f"window.close();"
    )
    return HTMLResponse(
        f"<!doctype html><meta charset=utf-8>"
        f"<title>ElectroMesh — sign-in complete</title>"
        f"<body style=\"font-family:system-ui;text-align:center;padding:40px;color:#1c1917\">"
        f"<h2 style=\"font-weight:600\">You're signed in. You can close this window.</h2>"
        f"<script>{payload}</script>"
        f"<noscript>"
        f"<a href=\"em-oauth://callback?token={result['access_token']}\">Continue to app</a>"
        f"</noscript>"
        f"</body>"
    )


@router.post("/oauth/{provider}/dev-login", response_model=TokenPair)
async def oauth_dev_login(
    provider: str,
    session: AsyncSession = Depends(get_session),
) -> TokenPair:
    """
    Dev-only: creates / finds a deterministic OAuth user without touching the
    provider. Disabled when EM_OAUTH_DISABLE_DEV_STUB=1.
    """
    result = await get_oauth_service().dev_login(session, provider_key=provider)
    return TokenPair(
        access_token=result["access_token"],
        refresh_token=result["refresh_token"],
        expires_in=result["expires_in"],
    )


def __quote(obj) -> str:
    """JSON-encode for inline JS — paranoid mini version."""
    import json
    return json.dumps(obj).replace("</", "<\\/")
