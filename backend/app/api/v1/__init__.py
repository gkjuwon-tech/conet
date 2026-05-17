from fastapi import APIRouter

from app.api.v1 import (
    admin,
    agent,
    billing,
    claim,
    clusters,
    devices,
    economics,
    enterprise,
    jobs,
    lan_claims,
    marketplace,
    payouts,
    shell,
    users,
)

api_router = APIRouter(prefix="/v1")
api_router.include_router(users.router)
api_router.include_router(devices.router)
api_router.include_router(clusters.router)
api_router.include_router(jobs.router)
api_router.include_router(marketplace.router)
api_router.include_router(payouts.router)
api_router.include_router(enterprise.router)
api_router.include_router(admin.router)
api_router.include_router(agent.router)
api_router.include_router(lan_claims.router)
api_router.include_router(billing.router)
api_router.include_router(economics.router)
api_router.include_router(shell.router)
api_router.include_router(claim.router)
