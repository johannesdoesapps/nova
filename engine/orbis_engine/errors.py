from __future__ import annotations

STATUS = {
    "bad_request": 400,
    "unauthorized": 401,
    "forbidden": 403,
    "not_found": 404,
    "conflict": 409,
    "payload_too_large": 413,
    "rate_limited": 429,
    "budget_exceeded": 402,
    "not_configured": 503,
    "upstream_error": 502,
    "timeout": 504,
    "internal": 500,
}

RETRYABLE = {"timeout", "rate_limited", "upstream_error"}


class EngineError(Exception):
    """Error with a stable machine-readable code; rendered as {error:{code,message,details}}."""

    def __init__(self, code: str, message: str, details: object | None = None):
        super().__init__(message)
        self.code = code if code in STATUS else "internal"
        self.message = message
        self.details = details

    @property
    def status(self) -> int:
        return STATUS[self.code]

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE
