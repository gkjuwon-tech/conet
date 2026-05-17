"""Conet API exceptions."""

from __future__ import annotations


class ConetError(Exception):
    """Base exception for Conet API errors."""

    def __init__(self, message: str, status_code: int | None = None, details: dict | None = None):
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class AuthenticationError(ConetError):
    """Raised when API key is invalid or missing."""
    pass


class NotFoundError(ConetError):
    """Raised when a resource is not found."""
    pass


class ValidationError(ConetError):
    """Raised when request validation fails."""
    pass


class RateLimitError(ConetError):
    """Raised when rate limit is exceeded."""
    pass


class TimeoutError(ConetError):
    """Raised when request times out."""
    pass


class ServerError(ConetError):
    """Raised when server returns 5xx error."""
    pass
