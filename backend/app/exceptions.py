from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status


class ElectroMeshError(Exception):
    code = "electromesh_error"
    http_status = status.HTTP_400_BAD_REQUEST

    def __init__(self, message: str, *, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}

    def as_http(self) -> HTTPException:
        return HTTPException(
            status_code=self.http_status,
            detail={"code": self.code, "message": self.message, **self.detail},
        )


class NotFoundError(ElectroMeshError):
    code = "not_found"
    http_status = status.HTTP_404_NOT_FOUND


class ValidationError_(ElectroMeshError):
    code = "validation_failed"
    http_status = status.HTTP_422_UNPROCESSABLE_ENTITY


class ConflictError(ElectroMeshError):
    code = "conflict"
    http_status = status.HTTP_409_CONFLICT


class AuthError(ElectroMeshError):
    code = "auth_failed"
    http_status = status.HTTP_401_UNAUTHORIZED


class PermissionError_(ElectroMeshError):
    code = "permission_denied"
    http_status = status.HTTP_403_FORBIDDEN


class IsolationViolation(ElectroMeshError):
    code = "isolation_violation"
    http_status = status.HTTP_422_UNPROCESSABLE_ENTITY


class FraudSuspected(ElectroMeshError):
    code = "fraud_suspected"
    http_status = status.HTTP_423_LOCKED


class InsufficientCapacity(ElectroMeshError):
    code = "insufficient_capacity"
    http_status = status.HTTP_503_SERVICE_UNAVAILABLE


class PricingError(ElectroMeshError):
    code = "pricing_error"
    http_status = status.HTTP_422_UNPROCESSABLE_ENTITY


class WorkunitRejected(ElectroMeshError):
    code = "workunit_rejected"
    http_status = status.HTTP_422_UNPROCESSABLE_ENTITY
